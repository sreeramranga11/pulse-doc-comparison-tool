import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import request from "supertest";
import { createApp } from "../src/app.js";

const shouldRun =
  process.env.RUN_INTEGRATION_TESTS === "true" && Boolean(process.env.PULSE_API_KEY);

test("integration: compares two real documents via Pulse API", { skip: !shouldRun }, async () => {
  const { app } = createApp({
    disableStatic: true,
    config: { debugEnabled: false },
    openaiConfig: { enabled: false }
  });

  const leftPath = path.join("test_files", "resume1_img.png");
  const rightPath = path.join("test_files", "resume2_img.png");

  const res = await request(app)
    .post("/api/compare")
    .attach("left", leftPath)
    .attach("right", rightPath)
    .field("diff_mode", "lines");

  assert.equal(res.status, 200);
  assert.equal(typeof res.body.extracted.left, "string");
  assert.equal(typeof res.body.extracted.right, "string");
  assert.ok(res.body.extracted.left.length > 20);
  assert.ok(res.body.extracted.right.length > 20);
  assert.ok(res.body.summary.totalParts > 0);
});
