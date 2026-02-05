import express from "express";
import multer from "multer";
import dotenv from "dotenv";
import { diffWordsWithSpace } from "diff";

dotenv.config();

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

const config = {
  port: process.env.PORT || 3000,
  baseUrl: process.env.PULSE_BASE_URL || "https://api.runpulse.com/v1",
  extractEndpoint: process.env.PULSE_EXTRACT_ENDPOINT || "/documents/extract",
  apiKey: process.env.PULSE_API_KEY || "",
  debugEnabled: (process.env.PULSE_DEBUG_LOGS || "true").toLowerCase() === "true",
  pollIntervalMs: Number(process.env.PULSE_POLL_INTERVAL_MS || 2000),
  pollTimeoutMs: Number(process.env.PULSE_POLL_TIMEOUT_MS || 60000)
};

const logDebug = (collector, ...messages) => {
  if (!config.debugEnabled) return;
  const message = messages.map((entry) =>
    typeof entry === "string" ? entry : JSON.stringify(entry, null, 2)
  );
  collector.push(message.join(" "));
  console.log("[debug]", ...messages);
};

const buildExtractUrl = () => {
  if (config.extractEndpoint.startsWith("http")) {
    return config.extractEndpoint;
  }
  return `${config.baseUrl.replace(/\/$/, "")}${config.extractEndpoint}`;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const extractTextFromPayload = (payload) => {
  if (!payload) return "";
  return (
    payload.text ||
    payload.content ||
    payload.markdown ||
    payload?.document?.text ||
    payload?.document?.content ||
    payload?.document?.markdown ||
    payload?.result?.text ||
    payload?.result?.content ||
    payload?.output?.text ||
    payload?.output?.content ||
    ""
  );
};

const pollForResult = async (statusUrl, debugLogs) => {
  const deadline = Date.now() + config.pollTimeoutMs;
  while (Date.now() < deadline) {
    logDebug(debugLogs, "Polling status", statusUrl);
    const response = await fetch(statusUrl, {
      headers: {
        Authorization: `Bearer ${config.apiKey}`
      }
    });
    const payload = await response.json();
    logDebug(debugLogs, "Poll response", payload);

    const status = payload.status || payload.state || payload?.document?.status;
    if (status === "completed" || status === "succeeded" || payload.result) {
      return payload;
    }
    if (status === "failed" || status === "error") {
      throw new Error(payload.message || "Pulse extraction failed");
    }
    await sleep(config.pollIntervalMs);
  }
  throw new Error("Pulse extraction timed out while polling");
};

const extractDocument = async (file, debugLogs) => {
  if (!config.apiKey) {
    throw new Error("Missing PULSE_API_KEY environment variable");
  }

  const url = buildExtractUrl();
  logDebug(debugLogs, "Submitting extraction request", { url, name: file.originalname });

  const formData = new FormData();
  formData.append("file", new Blob([file.buffer]), file.originalname);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`
    },
    body: formData
  });

  if (!response.ok) {
    const errorText = await response.text();
    logDebug(debugLogs, "Extraction error response", errorText);
    throw new Error(`Pulse extraction failed (${response.status})`);
  }

  const payload = await response.json();
  logDebug(debugLogs, "Extraction response", payload);

  const statusUrl = payload.statusUrl || payload.status_url || payload.polling_url;
  const status = payload.status || payload.state || payload?.document?.status;

  if (statusUrl || (status && status !== "completed" && status !== "succeeded")) {
    const pollUrl = statusUrl || `${config.baseUrl.replace(/\/$/, "")}/documents/${payload.id}`;
    const finalPayload = await pollForResult(pollUrl, debugLogs);
    return {
      payload: finalPayload,
      text: extractTextFromPayload(finalPayload)
    };
  }

  return {
    payload,
    text: extractTextFromPayload(payload)
  };
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
