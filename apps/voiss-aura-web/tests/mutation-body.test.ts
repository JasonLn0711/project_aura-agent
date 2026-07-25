import { afterEach, describe, expect, it, vi } from "vitest";
import { createSessionResponse } from "../lib/security";

const copilotBoundary = vi.hoisted(() => ({
  handle: vi.fn(async () =>
    Response.json({ forwarded: true }, { status: 202 }),
  ),
}));

vi.mock("server-only", () => ({}));

vi.mock("@copilotkit/runtime/v2", () => ({
  CopilotRuntime: class {},
  createCopilotRuntimeHandler: () => copilotBoundary.handle,
}));

vi.mock("@copilotkit/sqlite-runner", () => ({
  SqliteAgentRunner: class {},
}));

vi.mock("@voiss/agent-runtime", () => ({
  createNamedAgents: () => ({}),
}));

vi.mock("@voiss/ag-ui-codex-adapter", () => ({
  HttpCodexBridgeTransport: class {},
}));

vi.mock("@/lib/trust-store", () => ({
  recordTrustEvent: vi.fn(),
  recordValidatedExport: vi.fn(),
}));
vi.mock("../lib/trust-store", () => ({
  recordTrustEvent: vi.fn(),
  recordValidatedExport: vi.fn(),
}));

import { POST as postControlRoom } from "../app/api/control-room/route";
import { POST as postCopilotKit } from "../app/api/copilotkit/[...path]/route";

async function authenticatedHeaders() {
  const session = createSessionResponse();
  const body = (await session.json()) as { csrfToken: string };
  return {
    origin: "http://127.0.0.1:3000",
    cookie: session.headers.get("set-cookie")?.split(";")[0] ?? "",
    "x-voiss-csrf": body.csrfToken,
  };
}

function chunkedRequest(
  url: string,
  headers: Record<string, string>,
  payload: string,
  onCancel: () => void,
) {
  const bytes = new TextEncoder().encode(payload);
  let offset = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.byteLength) {
        controller.close();
        return;
      }
      const end = Math.min(offset + 8 * 1024, bytes.byteLength);
      controller.enqueue(bytes.slice(offset, end));
      offset = end;
    },
    cancel() {
      onCancel();
    },
  });
  return new Request(url, {
    method: "POST",
    headers,
    body,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

afterEach(() => {
  copilotBoundary.handle.mockClear();
  vi.unstubAllEnvs();
});

describe("chunked Web mutation body boundary", () => {
  it("rejects and cancels an oversized control-room body without Content-Length before JSON parsing", async () => {
    const headers = await authenticatedHeaders();
    let cancelled = false;
    const request = chunkedRequest(
      "http://127.0.0.1:3000/api/control-room",
      headers,
      JSON.stringify({
        type: "audit.operator",
        event: "action.delegated",
        subject: "action-1",
        padding: "x".repeat(256 * 1024),
      }),
      () => {
        cancelled = true;
      },
    );

    expect(request.headers.has("content-length")).toBe(false);
    const response = await postControlRoom(request);

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: "request_too_large",
    });
    expect(cancelled).toBe(true);
  });

  it("rejects and cancels an oversized CopilotKit body without Content-Length before forwarding", async () => {
    const headers = await authenticatedHeaders();
    let cancelled = false;
    const request = chunkedRequest(
      "http://127.0.0.1:3000/api/copilotkit",
      headers,
      JSON.stringify({ payload: "x".repeat(256 * 1024) }),
      () => {
        cancelled = true;
      },
    );

    expect(request.headers.has("content-length")).toBe(false);
    const response = await postCopilotKit(request);

    expect(response.status).toBe(413);
    expect(copilotBoundary.handle).not.toHaveBeenCalled();
    expect(cancelled).toBe(true);
  });
});
