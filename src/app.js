import express from "express";
import multer from "multer";
import dotenv from "dotenv";
import { diffWordsWithSpace, diffLines } from "diff";
import { PulseClient, PulseError } from "pulse-ts-sdk";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

dotenv.config();

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

const WORD_RE = /[\p{L}\p{N}]+(?:[’'\-][\p{L}\p{N}]+)*/gu;

export const createApp = (overrides = {}) => {
  const upload = multer({ storage: multer.memoryStorage() });

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const rootDir = path.resolve(__dirname, "..");

  const config = {
    port: process.env.PORT || 3000,
    baseUrl: process.env.PULSE_BASE_URL || "https://api.runpulse.com",
    apiKey: process.env.PULSE_API_KEY || "",
    debugEnabled: (process.env.PULSE_DEBUG_LOGS || "true").toLowerCase() === "true",
    pollIntervalMs: Number(process.env.PULSE_POLL_INTERVAL_MS || 2000),
    pollTimeoutMs: Number(process.env.PULSE_POLL_TIMEOUT_MS || 60000),
    largeFileThresholdBytes: Math.max(
      1,
      Number(process.env.PULSE_LARGE_FILE_THRESHOLD_MB || 10) * 1024 * 1024
    ),
    ...overrides.config
  };

  const openaiConfig = {
    apiKey: process.env.OPENAI_API_KEY || "",
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    enabled: (process.env.OPENAI_INSIGHTS_ENABLED || "true").toLowerCase() === "true",
    timeoutMs: Number(process.env.OPENAI_TIMEOUT_MS || 12000),
    ...overrides.openaiConfig
  };

  const fetchFn = overrides.fetchFn || globalThis.fetch;

  const logDebug =
    overrides.logDebug ||
    ((...messages) => {
      if (!config.debugEnabled) return;
      console.log("[debug]", ...messages);
    });

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

  const countWords = (value) => {
    if (!value) return 0;
    return (String(value).match(WORD_RE) || []).length;
  };

  const extractTextFromPayload = (payload) => {
    if (!payload) return "";
    return (
      payload.content ||
      payload.text ||
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

  const fetchJsonWithTimeout = async (url, timeoutMs = 20000) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchFn(url, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: controller.signal
      });
      const text = await response.text();
      if (!response.ok) {
        throw new HttpError(
          502,
          `Failed to fetch extraction result (${response.status} ${response.statusText})`
        );
      }
      try {
        return JSON.parse(text);
      } catch {
        throw new HttpError(502, "Extraction result URL did not return valid JSON.");
      }
    } finally {
      clearTimeout(timeout);
    }
  };

  const resolveUrlBackedResult = async (payload) => {
    if (!payload || typeof payload !== "object") return payload;

    const url =
      payload.url ||
      payload.result?.url ||
      payload.output?.url ||
      payload?.data?.url ||
      "";

    const isUrlBacked = payload.is_url === true || payload.isUrl === true;
    if (!url || typeof url !== "string") return payload;

    if (!isUrlBacked && !url.startsWith("https://")) {
      return payload;
    }

    if (!url.startsWith("https://")) {
      throw new HttpError(502, "Pulse result URL must be https.");
    }

    let safeUrlForLogs = url;
    try {
      const parsed = new URL(url);
      safeUrlForLogs = `${parsed.origin}${parsed.pathname}`;
    } catch {
      safeUrlForLogs = url.slice(0, 80);
    }
    logDebug("Fetching URL-backed extraction result", { url: safeUrlForLogs });
    const resolved = await fetchJsonWithTimeout(url);
    if (!resolved || typeof resolved !== "object") return payload;

    return {
      ...resolved,
      extraction_url: resolved.extraction_url ?? payload.extraction_url ?? null,
      page_count: resolved.page_count ?? payload.page_count ?? null,
      url
    };
  };

  const createPulseClient = () => {
    if (typeof overrides.createPulseClient === "function") {
      return overrides.createPulseClient();
    }
    if (!config.apiKey) {
      throw new HttpError(500, "Missing PULSE_API_KEY environment variable");
    }
    logDebug("Initializing Pulse SDK client", { baseUrl: config.baseUrl });
    return new PulseClient({
      headers: { "x-api-key": config.apiKey },
      apiKey: config.apiKey,
      baseUrl: config.baseUrl
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
        throw new HttpError(502, payload.error || "Pulse extraction failed");
      }
      await sleep(config.pollIntervalMs);
    }
    throw new HttpError(504, "Pulse extraction timed out while polling");
  };

  const getFileSizeBytes = (file) => {
    if (!file) return 0;
    if (typeof file.size === "number") return file.size;
    if (file.buffer && typeof file.buffer.length === "number") return file.buffer.length;
    return 0;
  };

  const isLargeFile = (file) => getFileSizeBytes(file) >= config.largeFileThresholdBytes;

  const extractDocument = async (file, structuredOutput, useAsync) => {
    const client = createPulseClient();
    const fileUpload = {
      data: file.buffer,
      filename: file.originalname,
      contentType: file.mimetype
    };

    try {
      if (useAsync) {
        logDebug("Submitting async extraction request", { name: file.originalname });
        const job = await client.extractAsync({
          file: fileUpload,
          structuredOutput: structuredOutput || undefined
        });
        logDebug("Async job enqueued", job);
        const finalPayload = await pollForResult(client, job.job_id);
        const resultPayload = await resolveUrlBackedResult(finalPayload.result || finalPayload);
        return {
          payload: resultPayload,
          text: extractTextFromPayload(resultPayload),
          structuredOutput:
            resultPayload?.structured_output ??
            resultPayload?.structuredOutput ??
            null
        };
      }

      logDebug("Submitting sync extraction request", { name: file.originalname });
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
      if (error instanceof HttpError) throw error;
      if (error instanceof PulseError) {
        logDebug("Pulse SDK error", {
          status: error.statusCode,
          message: error.message,
          body: error.body
        });
        const statusCode = typeof error.statusCode === "number" ? error.statusCode : 502;
        const status = statusCode >= 500 ? 502 : statusCode;
        throw new HttpError(status, error.message || "Pulse extraction failed");
      }
      if (typeof error?.statusCode === "number") {
        const status = error.statusCode >= 500 ? 502 : error.statusCode;
        throw new HttpError(status, error.message || "Upstream request failed");
      }
      throw error;
    }
  };

  const buildDiffHtml = (diffParts) =>
    diffParts
      .map((part) => {
        const safeValue = escapeHtml(part.value);
        if (part.added) return `<span class="diff-added">${safeValue}</span>`;
        if (part.removed) return `<span class="diff-removed">${safeValue}</span>`;
        return `<span>${safeValue}</span>`;
      })
      .join("");

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

    return { left: left.join(""), right: right.join("") };
  };

  const splitLinesPreserve = (value) => String(value ?? "").split("\n");

  const buildLineSideBySide = (diffParts) => {
    const leftLines = [];
    const rightLines = [];

    diffParts.forEach((part) => {
      splitLinesPreserve(part.value).forEach((line) => {
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
        if (part.added) return lines.push(`<div class="diff-line diff-added">${safeLine}</div>`);
        if (part.removed) return lines.push(`<div class="diff-line diff-removed">${safeLine}</div>`);
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
      throw new HttpError(400, "Structured extraction enabled, but no schema was provided.");
    }

    let schema;
    try {
      schema = JSON.parse(schemaRaw);
    } catch {
      throw new HttpError(400, "Structured schema must be valid JSON.");
    }

    if (!schema || typeof schema !== "object") {
      throw new HttpError(400, "Structured schema must be a JSON object.");
    }

    return { schema, schemaPrompt: schemaPrompt || undefined };
  };

  const diffStructured = (left, right) => {
    const changes = [];

    const walk = (pathKey, a, b) => {
      if (a === undefined && b === undefined) return;
      if (a === undefined) return changes.push({ path: pathKey, type: "added", left: null, right: b ?? null });
      if (b === undefined) return changes.push({ path: pathKey, type: "removed", left: a ?? null, right: null });

      const aIsArray = Array.isArray(a);
      const bIsArray = Array.isArray(b);
      if (aIsArray || bIsArray) {
        if (!aIsArray || !bIsArray) return changes.push({ path: pathKey, type: "changed", left: a ?? null, right: b ?? null });
        const maxLen = Math.max(a.length, b.length);
        for (let i = 0; i < maxLen; i += 1) walk(`${pathKey}[${i}]`, a[i], b[i]);
        return;
      }

      const aIsObj = a != null && typeof a === "object";
      const bIsObj = b != null && typeof b === "object";
      if (aIsObj || bIsObj) {
        if (!aIsObj || !bIsObj) return changes.push({ path: pathKey, type: "changed", left: a ?? null, right: b ?? null });
        const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
        for (const key of keys) walk(pathKey ? `${pathKey}.${key}` : key, a[key], b[key]);
        return;
      }

      if (a !== b) changes.push({ path: pathKey, type: "changed", left: a ?? null, right: b ?? null });
    };

    walk("", left, right);
    return changes;
  };

  const insightsTemplatePath = path.join(rootDir, "prompts", "insights_prompt.jinja");
  let insightsPromptTemplate = typeof overrides.insightsPromptTemplate === "string" ? overrides.insightsPromptTemplate : "";
  if (!insightsPromptTemplate) {
    try {
      insightsPromptTemplate = fs.readFileSync(insightsTemplatePath, "utf8");
    } catch (error) {
      insightsPromptTemplate = "";
      logDebug("Unable to read insights prompt template", {
        path: insightsTemplatePath,
        message: error?.message || String(error)
      });
    }
  }

  const renderTemplate = (template, variables) =>
    String(template || "").replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key) => {
      const value = variables?.[key];
      return value == null ? "" : String(value);
    });

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
      overall_summary: { type: "string" },
      added_highlights: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: { title: { type: "string" }, evidence: { type: "string" } },
          required: ["title", "evidence"]
        }
      },
      removed_highlights: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: { title: { type: "string" }, evidence: { type: "string" } },
          required: ["title", "evidence"]
        }
      },
      change_categories: {
        type: "array",
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
      suggested_checks: { type: "array", items: { type: "string" } },
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
      return {
        enabled: false,
        provider: "openai",
        error: "Insights disabled by OPENAI_INSIGHTS_ENABLED."
      };
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
      const response = await fetchFn("https://api.openai.com/v1/responses", {
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
    if (lines.length > 1 && lines[lines.length - 1] === "") return lines.length - 1;
    return lines.length;
  };

  const app = express();
  if (!overrides.disableStatic) {
    app.use(express.static(path.join(rootDir, "public")));
  }

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
          return res.status(400).json({ error: "Please upload both documents." });
        }

        const diffMode = (req.body?.diff_mode || "words").toString().toLowerCase();
        const structuredOutput = parseStructuredOutput(req);

        const useAsyncLeft = isLargeFile(leftFile);
        const useAsyncRight = isLargeFile(rightFile);

        logDebug("Starting comparison", {
          left: leftFile.originalname,
          right: rightFile.originalname,
          diffMode,
          structured: Boolean(structuredOutput),
          extractionMode: {
            left: useAsyncLeft ? "async" : "sync",
            right: useAsyncRight ? "async" : "sync"
          },
          largeDetected: { left: useAsyncLeft, right: useAsyncRight }
        });

        const [leftResult, rightResult] = await Promise.all([
          extractDocument(leftFile, structuredOutput, useAsyncLeft),
          extractDocument(rightFile, structuredOutput, useAsyncRight)
        ]);

        const diffParts =
          diffMode === "lines"
            ? diffLines(leftResult.text, rightResult.text)
            : diffWordsWithSpace(leftResult.text, rightResult.text);

        const sideBySide =
          diffMode === "lines" ? buildLineSideBySide(diffParts) : buildSideBySide(diffParts);

        const additions =
          diffMode === "lines"
            ? diffParts.filter((part) => part.added).reduce((total, part) => total + countLogicalLines(part.value), 0)
            : diffParts.filter((part) => part.added).reduce((total, part) => total + countWords(part.value), 0);
        const removals =
          diffMode === "lines"
            ? diffParts.filter((part) => part.removed).reduce((total, part) => total + countLogicalLines(part.value), 0)
            : diffParts.filter((part) => part.removed).reduce((total, part) => total + countWords(part.value), 0);

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
        const status = error instanceof HttpError && typeof error.status === "number" ? error.status : 500;
        res.status(status).json({ error: message });
      }
    }
  );

  return { app, config, openaiConfig, HttpError };
};
