import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { CodexObservability } from "../src/observability.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

test("observability logs are redacted and rotate within the two-file cap", async () => {
  const root = await mkdtemp(join(tmpdir(), "voiss-observability-"));
  tempDirs.push(root);
  const path = join(root, "metrics.jsonl");
  const observability = new CodexObservability(path, 4_096);

  for (let index = 0; index < 100; index += 1) {
    observability.record("test.event", `corr-${index}`, {
      authorization: "Bearer secret-token-123",
      value: "x".repeat(64),
    });
  }

  const [current, previous] = await Promise.all([
    readFile(path, "utf8"),
    readFile(`${path}.1`, "utf8"),
  ]);
  assert.equal(`${current}${previous}`.includes("secret-token-123"), false);
  assert.equal(
    current
      .trim()
      .split("\n")
      .every((line) => JSON.parse(line)),
    true,
  );
  assert.equal((await stat(path)).size <= 4_096, true);
  assert.equal((await stat(`${path}.1`)).size <= 4_096, true);
});
