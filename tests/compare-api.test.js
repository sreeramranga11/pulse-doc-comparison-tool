import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../src/app.js";

const makeApp = (overrides = {}) => {
  const merged = {
    ...overrides,
    config: { debugEnabled: false, ...(overrides.config || {}) }
  };
  const { app } = createApp({
    disableStatic: true,
    openaiConfig: { enabled: false },
    ...merged
  });
  return app;
};

const postCompare = (app, { left, right, fields = {} }) => {
  let req = request(app).post("/api/compare");
  if (left) req = req.attach("left", left.data, { filename: left.name, contentType: left.type });
  if (right) req = req.attach("right", right.data, { filename: right.name, contentType: right.type });
  for (const [k, v] of Object.entries(fields)) req = req.field(k, String(v));
  return req;
};

test("POST /api/compare requires both files", async () => {
  const app = makeApp();
  const res = await postCompare(app, {
    left: { data: Buffer.from("x"), name: "a.pdf", type: "application/pdf" },
    right: null
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /upload both/i);
});

test("structured schema must be valid JSON", async () => {
  const app = makeApp({
    createPulseClient: () => ({
      extract: async () => ({ markdown: "ok" })
    })
  });

  const res = await postCompare(app, {
    left: { data: Buffer.from("a"), name: "a.pdf", type: "application/pdf" },
    right: { data: Buffer.from("b"), name: "b.pdf", type: "application/pdf" },
    fields: {
      structured_enabled: "true",
      structured_schema: "{not-json",
      structured_prompt: "hi"
    }
  });

  assert.equal(res.status, 400);
  assert.match(res.body.error, /valid json/i);
});

test("word diff returns additions/removals and inline html", async () => {
  let call = 0;
  const app = makeApp({
    createPulseClient: () => ({
      extract: async () => {
        call += 1;
        return call === 1
          ? { markdown: "hello world" }
          : { markdown: "hello brave world" };
      }
    })
  });

  const res = await postCompare(app, {
    left: { data: Buffer.from("x"), name: "a.pdf", type: "application/pdf" },
    right: { data: Buffer.from("y"), name: "b.pdf", type: "application/pdf" },
    fields: { diff_mode: "words" }
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.summary.unit, "words");
  assert.equal(res.body.summary.additions, 1);
  assert.equal(res.body.summary.removals, 0);
  assert.match(res.body.inlineHtml, /diff-added/);
  assert.equal(typeof res.body.extracted.left, "string");
  assert.equal(typeof res.body.extracted.right, "string");
});

test("line diff returns line counts and line-based HTML", async () => {
  let call = 0;
  const app = makeApp({
    createPulseClient: () => ({
      extract: async () => {
        call += 1;
        return call === 1 ? { markdown: "a\nb\n" } : { markdown: "a\nc\n" };
      }
    })
  });

  const res = await postCompare(app, {
    left: { data: Buffer.from("x"), name: "a.pdf", type: "application/pdf" },
    right: { data: Buffer.from("y"), name: "b.pdf", type: "application/pdf" },
    fields: { diff_mode: "lines" }
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.summary.unit, "lines");
  assert.equal(res.body.summary.additions, 1);
  assert.equal(res.body.summary.removals, 1);
  assert.match(res.body.inlineHtml, /diff-line/);
});

test("large-file detection uses async only for the large side", async () => {
  const calls = { extract: 0, extractAsync: 0 };

  const app = makeApp({
    config: { largeFileThresholdBytes: 5 },
    createPulseClient: () => ({
      extract: async () => {
        calls.extract += 1;
        return { markdown: "small" };
      },
      extractAsync: async () => {
        calls.extractAsync += 1;
        return { job_id: "job-1" };
      },
      jobs: {
        getJob: async () => ({
          status: "completed",
          result: { markdown: "large" }
        })
      }
    })
  });

  const res = await postCompare(app, {
    left: { data: Buffer.from("123456"), name: "large.pdf", type: "application/pdf" },
    right: { data: Buffer.from("1"), name: "small.png", type: "image/png" },
    fields: { diff_mode: "words" }
  });

  assert.equal(res.status, 200);
  assert.deepEqual(calls, { extract: 1, extractAsync: 1 });
  assert.equal(res.body.extracted.left, "large");
  assert.equal(res.body.extracted.right, "small");
});

test("async URL-backed results are fetched and resolved", async () => {
  const calls = { resultFetch: 0 };

  const fetchFn = async (url) => {
    if (String(url).startsWith("https://example.com/data.json")) {
      calls.resultFetch += 1;
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () => JSON.stringify({ markdown: "from-url" })
      };
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  };

  const app = makeApp({
    config: { largeFileThresholdBytes: 2 },
    fetchFn,
    createPulseClient: () => ({
      extractAsync: async () => ({ job_id: "job-2" }),
      extract: async () => ({ markdown: "sync" }),
      jobs: {
        getJob: async () => ({
          status: "completed",
          result: { is_url: true, url: "https://example.com/data.json?Signature=secret" }
        })
      }
    })
  });

  const res = await postCompare(app, {
    left: { data: Buffer.from("xxx"), name: "large.pdf", type: "application/pdf" },
    right: { data: Buffer.from("y"), name: "small.pdf", type: "application/pdf" }
  });

  assert.equal(res.status, 200);
  assert.equal(calls.resultFetch, 1);
  assert.equal(res.body.extracted.left, "from-url");
});

test("poll timeout returns 504", async () => {
  const app = makeApp({
    config: { largeFileThresholdBytes: 1, pollTimeoutMs: 10, pollIntervalMs: 2 },
    createPulseClient: () => ({
      extractAsync: async () => ({ job_id: "job-timeout" }),
      extract: async () => ({ markdown: "sync" }),
      jobs: {
        getJob: async () => ({ status: "processing" })
      }
    })
  });

  const res = await postCompare(app, {
    left: { data: Buffer.from("xx"), name: "large.pdf", type: "application/pdf" },
    right: { data: Buffer.from("y"), name: "small.pdf", type: "application/pdf" }
  });

  assert.equal(res.status, 504);
  assert.match(res.body.error, /timed out/i);
});

test("unsupported file type returns 400 with a helpful message", async () => {
  const app = makeApp({
    createPulseClient: () => ({
      extract: async () => {
        const err = new Error("FILE_001: Invalid file type");
        err.statusCode = 400;
        throw err;
      }
    })
  });

  const res = await postCompare(app, {
    left: { data: Buffer.from("x"), name: "bad.exe", type: "application/octet-stream" },
    right: { data: Buffer.from("y"), name: "ok.pdf", type: "application/pdf" }
  });

  assert.equal(res.status, 400);
  assert.equal(typeof res.body.error, "string");
});

test("corrupted document returns 400", async () => {
  const app = makeApp({
    createPulseClient: () => ({
      extract: async () => {
        const err = new Error("FILE_003: File corrupted");
        err.statusCode = 400;
        throw err;
      }
    })
  });

  const res = await postCompare(app, {
    left: { data: Buffer.from("x"), name: "corrupted.pdf", type: "application/pdf" },
    right: { data: Buffer.from("y"), name: "ok.pdf", type: "application/pdf" }
  });

  assert.equal(res.status, 400);
  assert.match(res.body.error, /corrupted/i);
});

test("missing PULSE_API_KEY yields a 500 configuration error", async () => {
  const app = makeApp({
    config: { apiKey: "" }
  });

  const res = await postCompare(app, {
    left: { data: Buffer.from("x"), name: "a.pdf", type: "application/pdf" },
    right: { data: Buffer.from("y"), name: "b.pdf", type: "application/pdf" }
  });

  assert.equal(res.status, 500);
  assert.match(res.body.error, /pulse_api_key/i);
});

test("Pulse downtime is surfaced as a 502", async () => {
  const app = makeApp({
    createPulseClient: () => ({
      extract: async () => {
        const err = new Error("Pulse unavailable");
        err.statusCode = 503;
        throw err;
      }
    })
  });

  const res = await postCompare(app, {
    left: { data: Buffer.from("x"), name: "a.pdf", type: "application/pdf" },
    right: { data: Buffer.from("y"), name: "b.pdf", type: "application/pdf" }
  });

  assert.equal(res.status, 502);
  assert.equal(typeof res.body.error, "string");
});

test("structured diff is returned when Pulse provides structured_output", async () => {
  let call = 0;
  const app = makeApp({
    createPulseClient: () => ({
      extract: async () => {
        call += 1;
        if (call === 1) {
          return { markdown: "x", structured_output: { invoice_number: "1", total: 10 } };
        }
        return { markdown: "y", structured_output: { invoice_number: "2", total: 10 } };
      }
    })
  });

  const res = await postCompare(app, {
    left: { data: Buffer.from("x"), name: "a.pdf", type: "application/pdf" },
    right: { data: Buffer.from("y"), name: "b.pdf", type: "application/pdf" },
    fields: {
      structured_enabled: "true",
      structured_schema: JSON.stringify({
        type: "object",
        properties: { invoice_number: { type: "string" }, total: { type: "number" } },
        required: ["invoice_number", "total"]
      }),
      structured_prompt: "Extract invoice number and total."
    }
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.structuredDiff.total, 1);
  assert.equal(res.body.structuredDiff.changes[0].path, "invoice_number");
});
