import { afterEach, describe, expect, it, vi } from "vitest";
import { readServiceStatus } from "../lib/service-status";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("service status", () => {
  it("returns only normalized readiness metadata from local bridges", async () => {
    vi.stubEnv("VOISS_MODE", "local");
    vi.stubEnv("AURA_BRIDGE_URL", "http://127.0.0.1:8765");
    vi.stubEnv("AURA_BRIDGE_TOKEN", "aura-secret-token");
    vi.stubEnv("CODEX_BRIDGE_URL", "http://127.0.0.1:8770");
    vi.stubEnv("CODEX_BRIDGE_TOKEN", "codex-secret-token");
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              status: "ready",
              artifact_root_ready: true,
              evidence_index_ready: true,
              audit_ready: true,
            }),
            { status: 200 },
          ),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              ready: true,
              serverVersion: "codex-cli/0.145.0",
              restartCount: 2,
              activeRuns: 1,
              account: { signedIn: true, accessToken: "must-not-leak" },
              policy: {
                model: "gpt-5.6-sol",
                effort: "max",
                defaultSandbox: "read-only",
                networkAccess: false,
              },
            }),
            { status: 200 },
          ),
        ),
    );

    const status = await readServiceStatus();

    expect(status.aura).toMatchObject({
      ready: true,
      artifactRootReady: true,
      evidenceIndexReady: true,
      auditReady: true,
    });
    expect(status.codex).toMatchObject({
      ready: true,
      installed: true,
      signedIn: true,
      version: "codex-cli/0.145.0",
      model: "gpt-5.6-sol",
      effort: "max",
      sandbox: "read-only",
      network: false,
      activeRuns: 1,
      restarts: 2,
    });
    expect(JSON.stringify(status)).not.toContain("must-not-leak");
    expect(JSON.stringify(status)).not.toContain("secret-token");
  });
});
