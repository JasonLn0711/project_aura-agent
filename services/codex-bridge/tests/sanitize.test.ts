import assert from "node:assert/strict";
import { test } from "node:test";

import { sanitizeForEvent } from "../src/sanitize.ts";

test("redacts values under credential-bearing keys at every depth", () => {
  const sanitized = sanitizeForEvent(
    {
      token: "plain-secret-value",
      nested: {
        password: "pw",
        Authorization: "Basic hidden",
        useful: "kept",
      },
    },
    1024,
  );

  assert.deepEqual(sanitized, {
    token: "[REDACTED]",
    nested: {
      password: "[REDACTED]",
      Authorization: "[REDACTED]",
      useful: "kept",
    },
  });
});

test("redacts common credential environment assignments in command output", () => {
  const sanitized = String(
    sanitizeForEvent(
      [
        "CODEX_BRIDGE_TOKEN=bridge-capability",
        "SLACK_BOT_TOKEN=xoxb-secret",
        "OPENAI_API_KEY=sk-secret-value",
        "AWS_SECRET_ACCESS_KEY=aws-secret",
      ].join("\n"),
      2048,
    ),
  );

  assert.equal(sanitized.includes("bridge-capability"), false);
  assert.equal(sanitized.includes("xoxb-secret"), false);
  assert.equal(sanitized.includes("sk-secret-value"), false);
  assert.equal(sanitized.includes("aws-secret"), false);
  assert.equal((sanitized.match(/\[REDACTED\]/g) ?? []).length, 4);
});

test("truncates multibyte text on UTF-8 boundaries within every byte limit", () => {
  const input = "😀漢字".repeat(100);
  for (let limit = 0; limit <= 64; limit += 1) {
    const sanitized = String(sanitizeForEvent(input, limit));
    assert.equal(Buffer.byteLength(sanitized) <= limit, true, `limit ${limit}`);
    assert.equal(sanitized.includes("\uFFFD"), false, `limit ${limit}`);
  }
  assert.equal(
    String(sanitizeForEvent(input, 32)).includes("[TRUNCATED]"),
    true,
  );
});
