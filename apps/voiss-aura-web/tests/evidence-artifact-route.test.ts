import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "../app/api/evidence/[exportId]/[filename]/route";
import { createSessionResponse } from "../lib/security";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("evidence artifact browser boundary", () => {
  it("proxies one allowlisted artifact without exposing the bridge token", async () => {
    vi.stubEnv("VOISS_MODE", "local");
    vi.stubEnv("CODEX_BRIDGE_URL", "http://127.0.0.1:8770");
    vi.stubEnv("CODEX_BRIDGE_TOKEN", "server-only-token");
    const session = createSessionResponse();
    const cookie = session.headers.get("set-cookie")?.split(";")[0] ?? "";
    const bridgeFetch = vi.fn<typeof fetch>(
      async () =>
        new Response("diff --git a/a b/a\n", {
          status: 200,
          headers: {
            "content-length": "21",
            "content-type": "text/x-diff; charset=utf-8",
          },
        }),
    );
    vi.stubGlobal("fetch", bridgeFetch);

    const response = await GET(
      new Request("http://127.0.0.1:3000/api/evidence/run-1/changes.patch", {
        headers: { cookie },
      }),
      {
        params: Promise.resolve({
          exportId: "run-1",
          filename: "changes.patch",
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="changes.patch"',
    );
    expect(await response.text()).toContain("diff --git");
    expect(bridgeFetch).toHaveBeenCalledWith(
      "http://127.0.0.1:8770/v1/evidence/exports/run-1/changes.patch",
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: "Bearer server-only-token",
        }),
      }),
    );
    expect(JSON.stringify(await response.headers)).not.toContain(
      "server-only-token",
    );
  });

  it("rejects forged sessions and non-artifact paths before bridge access", async () => {
    vi.stubEnv("VOISS_MODE", "local");
    const bridgeFetch = vi.fn();
    vi.stubGlobal("fetch", bridgeFetch);

    const unauthorized = await GET(
      new Request("http://127.0.0.1:3000/api/evidence/run-1/evidence.json", {
        headers: { cookie: "voiss_session=attacker-chosen" },
      }),
      {
        params: Promise.resolve({
          exportId: "run-1",
          filename: "evidence.json",
        }),
      },
    );
    expect(unauthorized.status).toBe(401);

    const session = createSessionResponse();
    const cookie = session.headers.get("set-cookie")?.split(";")[0] ?? "";
    const rejected = await GET(
      new Request("http://127.0.0.1:3000/api/evidence/run-1/passwd", {
        headers: { cookie },
      }),
      { params: Promise.resolve({ exportId: "run-1", filename: "../passwd" }) },
    );
    expect(rejected.status).toBe(404);
    expect(bridgeFetch).not.toHaveBeenCalled();
  });
});
