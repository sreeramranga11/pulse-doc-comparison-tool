import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../src/app.js";

const postCompare = (app) =>
  request(app)
    .post("/api/compare")
    .attach("left", Buffer.from("x"), { filename: "a.pdf", contentType: "application/pdf" })
    .attach("right", Buffer.from("y"), { filename: "b.pdf", contentType: "application/pdf" });

test("insights are disabled when OPENAI_API_KEY is missing", async () => {
  const { app } = createApp({
    disableStatic: true,
    config: { debugEnabled: false },
    insightsPromptTemplate: "Input:\n{{ input_json }}\n",
    openaiConfig: { enabled: true, apiKey: "" },
    createPulseClient: () => ({
      extract: async () => ({ markdown: "hello world" })
    })
  });

  const res = await postCompare(app);
  assert.equal(res.status, 200);
  assert.equal(res.body.insights.enabled, false);
  assert.match(res.body.insights.error, /missing openai_api_key/i);
});

test("insights succeed with a stubbed OpenAI response", async () => {
  const fetchFn = async (url, options) => {
    if (String(url) !== "https://api.openai.com/v1/responses") {
      throw new Error(`Unexpected fetch: ${url}`);
    }
    assert.equal(options.method, "POST");
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({
        output_parsed: {
          overall_summary: "Added a line.",
          added_highlights: [{ title: "Addition", evidence: "brave" }],
          removed_highlights: [],
          change_categories: [{ category: "sections", summary: "Minor edits" }],
          risks: [{ severity: "Low", message: "No major risk" }],
          suggested_checks: ["Review formatting"],
          confidence: "High"
        }
      })
    };
  };

  let call = 0;
  const { app } = createApp({
    disableStatic: true,
    config: { debugEnabled: false },
    fetchFn,
    insightsPromptTemplate: "Input:\n{{ input_json }}\n",
    openaiConfig: { enabled: true, apiKey: "test-key", model: "gpt-4o-mini" },
    createPulseClient: () => ({
      extract: async () => {
        call += 1;
        return call === 1 ? { markdown: "hello world" } : { markdown: "hello brave world" };
      }
    })
  });

  const res = await postCompare(app);
  assert.equal(res.status, 200);
  assert.equal(res.body.insights.enabled, true);
  assert.equal(res.body.insights.provider, "openai");
  assert.equal(res.body.insights.result.confidence, "High");
  assert.match(res.body.insights.result.overall_summary, /added/i);
});
