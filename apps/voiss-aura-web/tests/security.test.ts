import { afterEach, describe, expect, it, vi } from "vitest";
import {
  authorizeMutation,
  authorizeRead,
  correlationIdForSession,
  createSessionResponse,
  primaryWebOrigin,
} from "../lib/security";

afterEach(() => vi.unstubAllEnvs());

describe("web session boundary", () => {
  it("rejects forged or tampered session cookies at both read and mutation boundaries", async () => {
    const issued = createSessionResponse();
    const body = (await issued.json()) as { csrfToken: string };
    const issuedCookie = issued.headers.get("set-cookie")?.split(";")[0] ?? "";
    const [name, value] = issuedCookie.split("=");
    const replacement = value.endsWith("a") ? "b" : "a";
    const tamperedCookie = `${name}=${value.slice(0, -1)}${replacement}`;

    for (const cookie of ["voiss_session=attacker-chosen", tamperedCookie]) {
      const read = authorizeRead(
        new Request("http://127.0.0.1:3000/api/aura/v1/sessions", {
          headers: { cookie },
        }),
      );
      expect(read).toBeInstanceOf(Response);
      expect((read as Response).status).toBe(401);

      const mutation = authorizeMutation(
        new Request("http://127.0.0.1:3000/api/control-room", {
          method: "POST",
          headers: {
            origin: "http://127.0.0.1:3000",
            cookie,
            "x-voiss-csrf": body.csrfToken,
            "content-length": "0",
          },
        }),
      );
      expect(mutation).toBeInstanceOf(Response);
      expect((mutation as Response).status).toBe(403);
    }
  });

  it("requires an exact local origin and a valid httpOnly session CSRF token", async () => {
    const session = createSessionResponse();
    const body = (await session.json()) as {
      csrfToken: string;
      correlationId: string;
    };
    const setCookie = session.headers.get("set-cookie") ?? "";
    const cookie = setCookie.split(";")[0] ?? "";

    expect(setCookie).toMatch(/;\s*HttpOnly/i);
    expect(setCookie).toMatch(/;\s*SameSite=strict/i);
    expect(setCookie).toMatch(/;\s*Path=\//i);
    expect(setCookie).toMatch(/;\s*Max-Age=28800/i);

    const accepted = authorizeMutation(
      new Request("http://127.0.0.1:3000/api/control-room", {
        method: "POST",
        headers: {
          origin: "http://127.0.0.1:3000",
          cookie,
          "x-voiss-csrf": body.csrfToken,
          "content-length": "10",
        },
      }),
    );
    expect(accepted).not.toBeInstanceOf(Response);
    expect(body.correlationId).toBe("corr-demo-voiss-001");

    const denied = authorizeMutation(
      new Request("http://127.0.0.1:3000/api/control-room", {
        method: "POST",
        headers: { origin: "https://example.com" },
      }),
    );
    expect(denied).toBeInstanceOf(Response);
    expect((denied as Response).status).toBe(403);
  });

  it("derives the same opaque correlation id for local browser and bridge reads", async () => {
    vi.stubEnv("VOISS_MODE", "local");
    const session = createSessionResponse();
    const body = (await session.json()) as { correlationId: string };
    const cookie = session.headers.get("set-cookie")?.split(";")[0] ?? "";
    const authorized = authorizeRead(
      new Request("http://127.0.0.1:3000/api/aura/v1/sessions", {
        headers: { cookie },
      }),
    );

    expect(authorized).not.toBeInstanceOf(Response);
    expect(body.correlationId).toBe(
      correlationIdForSession((authorized as { sessionId: string }).sessionId),
    );
    expect(body.correlationId).toMatch(/^corr-[a-f0-9]{32}$/);
  });

  it("accepts the documented generic origin alias when the web-specific value is absent", async () => {
    vi.stubEnv("VOISS_WEB_ORIGINS", "");
    vi.stubEnv("VOISS_ALLOWED_ORIGINS", "http://127.0.0.1:3123");
    const session = createSessionResponse();
    const body = (await session.json()) as { csrfToken: string };
    const cookie = session.headers.get("set-cookie")?.split(";")[0] ?? "";
    const accepted = authorizeMutation(
      new Request("http://127.0.0.1:3123/api/control-room", {
        method: "POST",
        headers: {
          origin: "http://127.0.0.1:3123",
          cookie,
          "x-voiss-csrf": body.csrfToken,
          "content-length": "0",
        },
      }),
    );

    expect(accepted).not.toBeInstanceOf(Response);
    expect(primaryWebOrigin()).toBe("http://127.0.0.1:3123");
  });
});
