import express from "express";
import multer from "multer";
import dotenv from "dotenv";
import { diffWordsWithSpace, diffLines } from "diff";
import { PulseClient, PulseError } from "pulse-ts-sdk";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

dotenv.config();

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const config = {
  port: process.env.PORT || 3000,
  baseUrl: process.env.PULSE_BASE_URL || "https://api.runpulse.com",
  apiKey: process.env.PULSE_API_KEY || "",
  debugEnabled: (process.env.PULSE_DEBUG_LOGS || "true").toLowerCase() === "true",
  pollIntervalMs: Number(process.env.PULSE_POLL_INTERVAL_MS || 2000),
  pollTimeoutMs: Number(process.env.PULSE_POLL_TIMEOUT_MS || 60000),
  useAsync: (process.env.PULSE_USE_ASYNC || "true").toLowerCase() === "true"
};

const openaiConfig = {
  apiKey: process.env.OPENAI_API_KEY || "",
  model: process.env.OPENAI_MODEL || "gpt-4o-mini",
  enabled: (process.env.OPENAI_INSIGHTS_ENABLED || "true").toLowerCase() === "true",
  timeoutMs: Number(process.env.OPENAI_TIMEOUT_MS || 12000)
};

const logDebug = (...messages) => {
  if (!config.debugEnabled) return;
  console.log("[debug]", ...messages);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const escapeHtml = (value) => {
  if (value == null) return "";
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
};

const WORD_RE = /[\p{L}\p{N}]+(?:[’'\-][\p{L}\p{N}]+)*/gu;
const LETTER_RE = /\p{L}/u;
const countWords = (value) => {
  if (!value) return 0;
  return (String(value).match(WORD_RE) || []).length;
};

const extractTextFromPayload = (payload) => {
  if (!payload) return "";
  return (
    payload.content ||
    payload.text ||
    payload.content ||
    payload.markdown ||
    payload?.document?.text ||
    payload?.document?.content ||
    payload?.document?.markdown ||
    payload?.result?.text ||
    payload?.result?.content ||
    payload?.result?.markdown ||
    payload?.output?.text ||
    payload?.output?.content ||
    ""
  );
};

const createPulseClient = () => {
  if (!config.apiKey) {
    throw new Error("Missing PULSE_API_KEY environment variable");
  }
  logDebug("Initializing Pulse SDK client", { baseUrl: config.baseUrl });
  return new PulseClient({
    headers: { "x-api-key": config.apiKey },
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
  });
};

const pollForResult = async (client, jobId) => {
  const deadline = Date.now() + config.pollTimeoutMs;
  while (Date.now() < deadline) {
    logDebug("Polling job status", jobId);
    const payload = await client.jobs.getJob({ jobId });
    logDebug("Poll response", payload);

    const status = payload.status;
    if (status === "completed" || payload.result) {
      return payload;
    }
    if (status === "failed" || status === "canceled") {
      throw new Error(payload.error || "Pulse extraction failed");
    }
    await sleep(config.pollIntervalMs);
  }
  throw new Error("Pulse extraction timed out while polling");
};

const extractDocument = async (file, structuredOutput) => {
  const client = createPulseClient();
  const fileUpload = {
    data: file.buffer,
    filename: file.originalname,
    contentType: file.mimetype
  };

  try {
    if (config.useAsync) {
      logDebug("Submitting async extraction request", {
        name: file.originalname
      });
      const job = await client.extractAsync({
        file: fileUpload,
        structuredOutput: structuredOutput || undefined
      });
      logDebug("Async job enqueued", job);
      const finalPayload = await pollForResult(client, job.job_id);
      const resultPayload = finalPayload.result || finalPayload;
      return {
        payload: resultPayload,
        text: extractTextFromPayload(resultPayload),
        structuredOutput:
          resultPayload?.structured_output ??
          resultPayload?.structuredOutput ??
          null
      };
    }

    logDebug("Submitting sync extraction request", {
      name: file.originalname
    });
    const payload = await client.extract({
      file: fileUpload,
      structuredOutput: structuredOutput || undefined
    });
    logDebug("Extraction response", payload);
    return {
      payload,
      text: extractTextFromPayload(payload),
      structuredOutput: payload?.structured_output ?? payload?.structuredOutput ?? null
    };
  } catch (error) {
    if (error instanceof PulseError) {
      logDebug("Pulse SDK error", {
        status: error.statusCode,
        message: error.message,
        body: error.body
      });
      throw new Error(error.message);
    }
    throw error;
  }
};

const buildDiffHtml = (diffParts) => {
  return diffParts
    .map((part) => {
      const safeValue = escapeHtml(part.value);
      if (part.added) {
        return `<span class="diff-added">${safeValue}</span>`;
      }
      if (part.removed) {
        return `<span class="diff-removed">${safeValue}</span>`;
      }
      return `<span>${safeValue}</span>`;
    })
    .join("");
};

const buildSideBySide = (diffParts) => {
  const left = [];
  const right = [];

  diffParts.forEach((part) => {
    const safeValue = escapeHtml(part.value);
    if (part.added) {
      right.push(`<span class="diff-added">${safeValue}</span>`);
      left.push(`<span class="diff-empty">${" ".repeat(part.value.length)}</span>`);
      return;
    }
    if (part.removed) {
      left.push(`<span class="diff-removed">${safeValue}</span>`);
      right.push(`<span class="diff-empty">${" ".repeat(part.value.length)}</span>`);
      return;
    }
    left.push(`<span>${safeValue}</span>`);
    right.push(`<span>${safeValue}</span>`);
  });

  return {
    left: left.join(""),
    right: right.join("")
  };
};

const splitLinesPreserve = (value) => {
  const stringValue = value ?? "";
  const lines = String(stringValue).split("\n");
  return lines;
};

const buildLineSideBySide = (diffParts) => {
  const leftLines = [];
  const rightLines = [];

  diffParts.forEach((part) => {
    const lines = splitLinesPreserve(part.value);
    // If the diff chunk ends with a newline, split() produces a trailing empty line.
    // Keep it to preserve vertical alignment.
    lines.forEach((line) => {
      const safeLine = escapeHtml(line);
      if (part.added) {
        leftLines.push(`<div class="diff-line diff-empty"></div>`);
        rightLines.push(`<div class="diff-line diff-added">${safeLine}</div>`);
        return;
      }
      if (part.removed) {
        leftLines.push(`<div class="diff-line diff-removed">${safeLine}</div>`);
        rightLines.push(`<div class="diff-line diff-empty"></div>`);
        return;
      }
      leftLines.push(`<div class="diff-line">${safeLine}</div>`);
      rightLines.push(`<div class="diff-line">${safeLine}</div>`);
    });
  });

  return {
    left: `<div class="diff-lines">${leftLines.join("")}</div>`,
    right: `<div class="diff-lines">${rightLines.join("")}</div>`
  };
};

const buildLineInline = (diffParts) => {
  const lines = [];
  diffParts.forEach((part) => {
    splitLinesPreserve(part.value).forEach((line) => {
      const safeLine = escapeHtml(line);
      if (part.added) {
        lines.push(`<div class="diff-line diff-added">${safeLine}</div>`);
        return;
      }
      if (part.removed) {
        lines.push(`<div class="diff-line diff-removed">${safeLine}</div>`);
        return;
      }
      lines.push(`<div class="diff-line">${safeLine}</div>`);
    });
  });
  return `<div class="diff-lines">${lines.join("")}</div>`;
};

const parseStructuredOutput = (req) => {
  const enabled = (req.body?.structured_enabled || "").toString().toLowerCase() === "true";
  if (!enabled) return null;

  const schemaRaw = req.body?.structured_schema;
  const schemaPrompt = (req.body?.structured_prompt || "").toString().trim();

  if (!schemaRaw) {
    throw new Error("Structured extraction enabled, but no schema was provided.");
  }

  let schema;
  try {
    schema = JSON.parse(schemaRaw);
  } catch {
    throw new Error("Structured schema must be valid JSON.");
  }

  if (!schema || typeof schema !== "object") {
    throw new Error("Structured schema must be a JSON object.");
  }

  return {
    schema,
    schemaPrompt: schemaPrompt || undefined
  };
  };

const diffStructured = (left, right) => {
  const changes = [];

  const walk = (path, a, b) => {
    if (a === undefined && b === undefined) return;
    if (a === undefined) {
      changes.push({ path, type: "added", left: null, right: b ?? null });
      return;
    }
    if (b === undefined) {
      changes.push({ path, type: "removed", left: a ?? null, right: null });
      return;
    }

    const aIsArray = Array.isArray(a);
    const bIsArray = Array.isArray(b);
    if (aIsArray || bIsArray) {
      if (!aIsArray || !bIsArray) {
        changes.push({ path, type: "changed", left: a ?? null, right: b ?? null });
        return;
      }
      const maxLen = Math.max(a.length, b.length);
      for (let i = 0; i < maxLen; i += 1) {
        walk(`${path}[${i}]`, a[i], b[i]);
      }
      return;
    }

    const aIsObj = a != null && typeof a === "object";
    const bIsObj = b != null && typeof b === "object";
    if (aIsObj || bIsObj) {
      if (!aIsObj || !bIsObj) {
        changes.push({ path, type: "changed", left: a ?? null, right: b ?? null });
        return;
      }
      const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
      for (const key of keys) {
        walk(path ? `${path}.${key}` : key, a[key], b[key]);
      }
      return;
    }

    if (a !== b) {
      changes.push({ path, type: "changed", left: a ?? null, right: b ?? null });
    }
  };

  walk("", left, right);
  return changes;
};

const insightsTemplatePath = path.join(__dirname, "prompts", "insights_prompt.jinja");
let insightsPromptTemplate = "";
try {
  insightsPromptTemplate = fs.readFileSync(insightsTemplatePath, "utf8");
} catch (error) {
  insightsPromptTemplate = "";
  logDebug("Unable to read insights prompt template", {
    path: insightsTemplatePath,
    message: error?.message || String(error)
  });
}

const renderTemplate = (template, variables) => {
  const safeTemplate = String(template || "");
  return safeTemplate.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key) => {
    const value = variables?.[key];
    return value == null ? "" : String(value);
  });
};

const truncateText = (value, maxLen) => {
  const text = String(value ?? "");
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen - 1)}…`;
};

const collapseWhitespace = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

const collectDiffSnippets = (diffParts, { maxSnippets = 12, maxLen = 220 } = {}) => {
  const seen = new Set();
  const added = [];
  const removed = [];

  for (const part of diffParts) {
    const bucket = part.added ? added : part.removed ? removed : null;
    if (!bucket) continue;
    if (bucket.length >= maxSnippets) continue;
    const cleaned = collapseWhitespace(part.value);
    if (!cleaned || cleaned.length < 4) continue;
    const snippet = truncateText(cleaned, maxLen);
    const key = snippet.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    bucket.push(snippet);
    if (added.length >= maxSnippets && removed.length >= maxSnippets) break;
  }

  return { added, removed };
};

const buildInsightsInput = ({ leftName, rightName, summary, diffParts, structuredDiff }) => {
  const snippets = collectDiffSnippets(diffParts);
  const structuredSample = (structuredDiff || []).slice(0, 30).map((c) => ({
    path: c.path || "",
    type: c.type || "changed",
    left: typeof c.left === "string" ? truncateText(c.left, 120) : c.left,
    right: typeof c.right === "string" ? truncateText(c.right, 120) : c.right
  }));

  return {
    meta: {
      left_name: leftName || "Document A",
      right_name: rightName || "Document B",
      diff_mode: summary?.diffMode || "words",
      unit: summary?.unit || "words",
      additions: Number(summary?.additions || 0),
      removals: Number(summary?.removals || 0),
      diff_chunks: Number(summary?.totalParts || 0),
      structured_changes: Number(structuredDiff?.length || 0)
    },
    excerpts: {
      added: snippets.added,
      removed: snippets.removed
    },
    structured_diff_sample: structuredSample
  };
};

const OPENAI_INSIGHTS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    overall_summary: {
      type: "string",
      description: "Concise, high-signal summary of what changed."
    },
    added_highlights: {
      type: "array",
      description: "Key additions found in the diff excerpts.",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string" },
          evidence: {
            type: "string",
            description: "Quote or paraphrase grounded in provided excerpts."
          }
        },
        required: ["title", "evidence"]
      }
    },
    removed_highlights: {
      type: "array",
      description: "Key removals found in the diff excerpts.",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string" },
          evidence: { type: "string" }
        },
        required: ["title", "evidence"]
      }
    },
    change_categories: {
      type: "array",
      description: "High-level categorization of changes.",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          category: {
            type: "string",
            enum: ["numbers", "dates", "money", "links", "people", "organizations", "sections", "formatting", "other"]
          },
          summary: { type: "string" }
        },
        required: ["category", "summary"]
      }
    },
    risks: {
      type: "array",
      description: "Potential risks or regressions implied by changes (if any).",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          severity: { type: "string", enum: ["Low", "Medium", "High"] },
          message: { type: "string" }
        },
        required: ["severity", "message"]
      }
    },
    suggested_checks: {
      type: "array",
      description: "Concrete checks a reviewer should perform.",
      items: { type: "string" }
    },
    confidence: { type: "string", enum: ["Low", "Medium", "High"] }
  },
  required: [
    "overall_summary",
    "added_highlights",
    "removed_highlights",
    "change_categories",
    "risks",
    "suggested_checks",
    "confidence"
  ]
};

const extractOpenAIOutputText = (payload) => {
  if (!payload) return "";
  if (typeof payload.output_text === "string") return payload.output_text;
  const output = Array.isArray(payload.output) ? payload.output : [];
  const chunks = [];
  for (const item of output) {
    const content = item?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (typeof part?.text === "string") chunks.push(part.text);
      if (typeof part?.content === "string") chunks.push(part.content);
    }
  }
  return chunks.join("\n").trim();
};

const generateInsightsWithOpenAI = async (insightsInput) => {
  if (!openaiConfig.enabled) {
    return { enabled: false, provider: "openai", error: "Insights disabled by OPENAI_INSIGHTS_ENABLED." };
  }
  if (!openaiConfig.apiKey) {
    return { enabled: false, provider: "openai", error: "Missing OPENAI_API_KEY." };
  }
  if (!insightsPromptTemplate) {
    return { enabled: false, provider: "openai", error: "Missing insights prompt template file." };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), openaiConfig.timeoutMs);
  try {
    const inputJson = JSON.stringify(insightsInput, null, 2);
    const prompt = renderTemplate(insightsPromptTemplate, { input_json: inputJson });

    logDebug("Generating OpenAI insights", { model: openaiConfig.model });
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${openaiConfig.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: openaiConfig.model,
        input: prompt,
        temperature: 0.2,
        text: {
          format: {
            type: "json_schema",
            name: "document_diff_insights",
            strict: true,
            schema: OPENAI_INSIGHTS_SCHEMA
          }
        }
      }),
      signal: controller.signal
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail =
        payload?.error?.message ||
        payload?.message ||
        `OpenAI request failed (${response.status} ${response.statusText})`;
      throw new Error(detail);
    }

    const text = extractOpenAIOutputText(payload);
    const parsed = typeof payload?.output_parsed === "object" ? payload.output_parsed : JSON.parse(text);

    return {
      enabled: true,
      provider: "openai",
      model: openaiConfig.model,
      result: parsed
    };
  } catch (error) {
    const message =
      error?.name === "AbortError"
        ? `Insights timed out after ${openaiConfig.timeoutMs}ms.`
        : error?.message || "OpenAI insights failed.";
    logDebug("OpenAI insights failed", { message });
    return { enabled: false, provider: "openai", error: message };
  } finally {
    clearTimeout(timeout);
  }
};

const countLogicalLines = (value) => {
  if (!value) return 0;
  const lines = String(value).split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") {
    return lines.length - 1;
  }
  return lines.length;
};

app.use(express.static("public"));

app.post(
  "/api/compare",
  upload.fields([
    { name: "left", maxCount: 1 },
    { name: "right", maxCount: 1 }
  ]),
  async (req, res) => {
    try {
      const leftFile = req.files?.left?.[0];
      const rightFile = req.files?.right?.[0];

      if (!leftFile || !rightFile) {
        return res.status(400).json({
          error: "Please upload both documents."
        });
      }

      const diffMode = (req.body?.diff_mode || "words").toString().toLowerCase();
      const structuredOutput = parseStructuredOutput(req);

      logDebug("Starting comparison", {
        left: leftFile.originalname,
        right: rightFile.originalname,
        diffMode,
        structured: Boolean(structuredOutput)
      });

      const [leftResult, rightResult] = await Promise.all([
        extractDocument(leftFile, structuredOutput),
        extractDocument(rightFile, structuredOutput)
      ]);

      const diffParts =
        diffMode === "lines"
          ? diffLines(leftResult.text, rightResult.text)
          : diffWordsWithSpace(leftResult.text, rightResult.text);

      const sideBySide =
        diffMode === "lines" ? buildLineSideBySide(diffParts) : buildSideBySide(diffParts);

      const additions =
        diffMode === "lines"
          ? diffParts
              .filter((part) => part.added)
              .reduce((total, part) => total + countLogicalLines(part.value), 0)
          : diffParts
              .filter((part) => part.added)
              .reduce((total, part) => total + countWords(part.value), 0);
      const removals =
        diffMode === "lines"
          ? diffParts
              .filter((part) => part.removed)
              .reduce((total, part) => total + countLogicalLines(part.value), 0)
          : diffParts
              .filter((part) => part.removed)
              .reduce((total, part) => total + countWords(part.value), 0);

      const structuredDiff =
        leftResult.structuredOutput && rightResult.structuredOutput
          ? diffStructured(leftResult.structuredOutput, rightResult.structuredOutput)
          : [];

      const insightsInput = buildInsightsInput({
        leftName: leftFile.originalname,
        rightName: rightFile.originalname,
        summary: {
          additions,
          removals,
          totalParts: diffParts.length,
          diffMode,
          unit: diffMode === "lines" ? "lines" : "words"
        },
        diffParts,
        structuredDiff
      });

      const insights = await generateInsightsWithOpenAI(insightsInput);

      res.json({
        summary: {
          additions,
          removals,
          totalParts: diffParts.length,
          diffMode,
          unit: diffMode === "lines" ? "lines" : "words"
        },
        inlineHtml: diffMode === "lines" ? buildLineInline(diffParts) : buildDiffHtml(diffParts),
        sideBySideHtml: sideBySide,
        extracted: {
          left: leftResult.text,
          right: rightResult.text
        },
        insights,
        structuredOutput: {
          left: leftResult.structuredOutput || null,
          right: rightResult.structuredOutput || null
        },
        structuredDiff: {
          total: structuredDiff.length,
          changes: structuredDiff.slice(0, 200)
        }
      });
    } catch (error) {
      const message = error?.message || "Unexpected error occurred";
      logDebug("Comparison failed", message);
      const status = message.toLowerCase().includes("schema") ? 400 : 500;
      res.status(status).json({ error: message });
    }
  }
);

app.listen(config.port, () => {
  console.log(`Pulse comparison tool running on http://localhost:${config.port}`);
  if (config.debugEnabled) {
    console.log("Debug logging is enabled. Set PULSE_DEBUG_LOGS=false to disable.");
  }
});
