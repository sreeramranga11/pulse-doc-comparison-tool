import express from "express";
import multer from "multer";
import dotenv from "dotenv";
import { diffWordsWithSpace } from "diff";
import { PulseClient, PulseError } from "pulse-ts-sdk";

dotenv.config();

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

const config = {
  port: process.env.PORT || 3000,
  baseUrl: process.env.PULSE_BASE_URL || "https://api.runpulse.com",
  apiKey: process.env.PULSE_API_KEY || "",
  debugEnabled: (process.env.PULSE_DEBUG_LOGS || "true").toLowerCase() === "true",
  pollIntervalMs: Number(process.env.PULSE_POLL_INTERVAL_MS || 2000),
  pollTimeoutMs: Number(process.env.PULSE_POLL_TIMEOUT_MS || 60000),
  useAsync: (process.env.PULSE_USE_ASYNC || "true").toLowerCase() === "true"
};

const logDebug = (collector, ...messages) => {
  if (!config.debugEnabled) return;
  const message = messages.map((entry) =>
    typeof entry === "string" ? entry : JSON.stringify(entry, null, 2)
  );
  collector.push(message.join(" "));
  console.log("[debug]", ...messages);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

const createPulseClient = (debugLogs) => {
  if (!config.apiKey) {
    throw new Error("Missing PULSE_API_KEY environment variable");
  }
  logDebug(debugLogs, "Initializing Pulse SDK client", { baseUrl: config.baseUrl });
  return new PulseClient({
    apiKey: config.apiKey,
    baseUrl: config.baseUrl
  });
};

const pollForResult = async (client, jobId, debugLogs) => {
  const deadline = Date.now() + config.pollTimeoutMs;
  while (Date.now() < deadline) {
    logDebug(debugLogs, "Polling job status", jobId);
    const payload = await client.jobs.getJob({ jobId });
    logDebug(debugLogs, "Poll response", payload);

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

const extractDocument = async (file, debugLogs) => {
  const client = createPulseClient(debugLogs);
  const fileUpload = {
    data: file.buffer,
    filename: file.originalname,
    contentType: file.mimetype
  };

  try {
    if (config.useAsync) {
      logDebug(debugLogs, "Submitting async extraction request", {
        name: file.originalname
      });
      const job = await client.extractAsync({ file: fileUpload });
      logDebug(debugLogs, "Async job enqueued", job);
      const finalPayload = await pollForResult(client, job.job_id, debugLogs);
      const resultPayload = finalPayload.result || finalPayload;
      return {
        payload: resultPayload,
        text: extractTextFromPayload(resultPayload),
        structuredOutput: resultPayload?.structured_output
      };
    }

    logDebug(debugLogs, "Submitting sync extraction request", {
      name: file.originalname
    });
    const payload = await client.extract({ file: fileUpload });
    logDebug(debugLogs, "Extraction response", payload);
    return {
      payload,
      text: extractTextFromPayload(payload),
      structuredOutput: payload?.structured_output
    };
  } catch (error) {
    if (error instanceof PulseError) {
      logDebug(debugLogs, "Pulse SDK error", {
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
      if (part.added) {
        return `<span class="diff-added">${part.value}</span>`;
      }
      if (part.removed) {
        return `<span class="diff-removed">${part.value}</span>`;
      }
      return `<span>${part.value}</span>`;
    })
    .join("");
};

const buildSideBySide = (diffParts) => {
  const left = [];
  const right = [];

  diffParts.forEach((part) => {
    if (part.added) {
      right.push(`<span class="diff-added">${part.value}</span>`);
      left.push(`<span class="diff-empty">${" ".repeat(part.value.length)}</span>`);
      return;
    }
    if (part.removed) {
      left.push(`<span class="diff-removed">${part.value}</span>`);
      right.push(`<span class="diff-empty">${" ".repeat(part.value.length)}</span>`);
      return;
    }
    left.push(`<span>${part.value}</span>`);
    right.push(`<span>${part.value}</span>`);
  });

  return {
    left: left.join(""),
    right: right.join("")
  };
};

app.use(express.static("public"));

app.post(
  "/api/compare",
  upload.fields([
    { name: "left", maxCount: 1 },
    { name: "right", maxCount: 1 }
  ]),
  async (req, res) => {
    const debugLogs = [];
    try {
      const leftFile = req.files?.left?.[0];
      const rightFile = req.files?.right?.[0];

      if (!leftFile || !rightFile) {
        return res.status(400).json({
          error: "Please upload both documents.",
          debug: debugLogs
        });
      }

      logDebug(debugLogs, "Starting comparison", {
        left: leftFile.originalname,
        right: rightFile.originalname
      });

      const [leftResult, rightResult] = await Promise.all([
        extractDocument(leftFile, debugLogs),
        extractDocument(rightFile, debugLogs)
      ]);

      const diffParts = diffWordsWithSpace(leftResult.text, rightResult.text);
      const sideBySide = buildSideBySide(diffParts);

      const additions = diffParts.filter((part) => part.added).length;
      const removals = diffParts.filter((part) => part.removed).length;

      res.json({
        summary: {
          additions,
          removals,
          totalParts: diffParts.length
        },
        inlineHtml: buildDiffHtml(diffParts),
        sideBySideHtml: sideBySide,
        extracted: {
          left: leftResult.text,
          right: rightResult.text
        },
        structuredOutput: {
          left: leftResult.structuredOutput || null,
          right: rightResult.structuredOutput || null
        },
        debug: debugLogs
      });
    } catch (error) {
      logDebug(debugLogs, "Comparison failed", error.message);
      res.status(500).json({
        error: error.message || "Unexpected error occurred",
        debug: debugLogs
      });
    }
  }
);

app.listen(config.port, () => {
  console.log(`Pulse comparison tool running on http://localhost:${config.port}`);
  if (config.debugEnabled) {
    console.log("Debug logging is enabled. Set PULSE_DEBUG_LOGS=false to disable.");
  }
});
