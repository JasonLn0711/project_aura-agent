import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { configuredAllowedOrigins, main } from "../src/cli.ts";

test("supports the generic allowed-origin alias while keeping service-specific precedence", () => {
  assert.deepEqual(
    configuredAllowedOrigins({
      VOISS_ALLOWED_ORIGINS: "http://127.0.0.1:3100,http://127.0.0.1:3100",
    }),
    ["http://127.0.0.1:3100"],
  );
  assert.deepEqual(
    configuredAllowedOrigins({
      VOISS_ALLOWED_ORIGINS: "http://127.0.0.1:3100",
      CODEX_ALLOWED_ORIGINS: "http://127.0.0.1:3200",
    }),
    ["http://127.0.0.1:3200"],
  );
});

test("rejects a relative observability log path before starting Codex", async () => {
  const repo = await mkdtemp(join(tmpdir(), "voiss-cli-repo-"));
  try {
    await assert.rejects(
      main({
        CODEX_BRIDGE_TOKEN: "bridge-token-1234",
        VOISS_ALLOWED_REPOSITORIES: repo,
        VOISS_OBSERVABILITY_LOG: "relative/codex.jsonl",
      }),
      /VOISS_OBSERVABILITY_LOG must be an absolute path/,
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
