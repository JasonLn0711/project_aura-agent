import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";

const SESSION_COOKIE = "voiss_session";
const MAX_BODY_BYTES = 64 * 1024;
const WINDOW_MS = 60_000;
const MAX_MUTATIONS_PER_WINDOW = 60;
const globalSecurity = globalThis as typeof globalThis & {
  voissSessionSecret?: string;
};
const secret =
  process.env.VOISS_SESSION_SECRET ??
  globalSecurity.voissSessionSecret ??
  (globalSecurity.voissSessionSecret = randomBytes(32).toString("hex"));
const attempts = new Map<string, { count: number; resetAt: number }>();
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SESSION_SIGNATURE_PATTERN = /^[a-f0-9]{64}$/;

function token(sessionId: string): string {
  return createHmac("sha256", secret).update(sessionId).digest("hex");
}

export function correlationIdForSession(sessionId: string): string {
  return `corr-${createHmac("sha256", secret)
    .update(`correlation:${sessionId}`)
    .digest("hex")
    .slice(0, 32)}`;
}

function equal(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function configuredOrigins(): string[] {
  return (
    process.env.VOISS_WEB_ORIGINS ||
    process.env.VOISS_ALLOWED_ORIGINS ||
    "http://127.0.0.1:3000,http://localhost:3000"
  )
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function allowedOrigins(): Set<string> {
  return new Set(configuredOrigins());
}

export function primaryWebOrigin(): string {
  return new URL(configuredOrigins()[0] ?? "http://127.0.0.1:3000").origin;
}

function signedSession(sessionId: string): string {
  return `${sessionId}.${token(`session-cookie:${sessionId}`)}`;
}

function sessionFrom(request: Request): string | undefined {
  const cookie = request.headers.get("cookie") ?? "";
  const value = cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${SESSION_COOKIE}=`))
    ?.slice(SESSION_COOKIE.length + 1);
  if (!value) return undefined;
  const separator = value.lastIndexOf(".");
  if (separator <= 0) return undefined;
  const sessionId = value.slice(0, separator);
  const signature = value.slice(separator + 1);
  if (
    !SESSION_ID_PATTERN.test(sessionId) ||
    !SESSION_SIGNATURE_PATTERN.test(signature) ||
    !equal(signature, token(`session-cookie:${sessionId}`))
  ) {
    return undefined;
  }
  return sessionId;
}

export function createSessionResponse(): NextResponse {
  const sessionId = randomBytes(32).toString("base64url");
  const mode = process.env.VOISS_MODE === "local" ? "local" : "demo";
  const response = NextResponse.json({
    csrfToken: token(sessionId),
    mode,
    correlationId:
      mode === "local"
        ? correlationIdForSession(sessionId)
        : "corr-demo-voiss-001",
  });
  response.cookies.set(SESSION_COOKIE, signedSession(sessionId), {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 8 * 60 * 60,
  });
  return response;
}

export function authorizeMutation(
  request: Request,
): { sessionId: string } | NextResponse {
  const origin = request.headers.get("origin");
  if (!origin || !allowedOrigins().has(origin)) {
    return NextResponse.json({ error: "origin_not_allowed" }, { status: 403 });
  }
  const length = Number(request.headers.get("content-length") ?? "0");
  if (!Number.isFinite(length) || length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "request_too_large" }, { status: 413 });
  }
  const sessionId = sessionFrom(request);
  const csrf = request.headers.get("x-voiss-csrf");
  if (!sessionId || !csrf || !equal(csrf, token(sessionId))) {
    return NextResponse.json(
      { error: "invalid_session_or_csrf" },
      { status: 403 },
    );
  }

  const now = Date.now();
  const current = attempts.get(sessionId);
  const next =
    !current || current.resetAt <= now
      ? { count: 1, resetAt: now + WINDOW_MS }
      : { count: current.count + 1, resetAt: current.resetAt };
  attempts.set(sessionId, next);
  if (next.count > MAX_MUTATIONS_PER_WINDOW) {
    return NextResponse.json(
      { error: "rate_limited" },
      {
        status: 429,
        headers: {
          "Retry-After": String(Math.ceil((next.resetAt - now) / 1000)),
        },
      },
    );
  }
  return { sessionId };
}

export async function guardMutationBody(
  request: Request,
): Promise<NextResponse | undefined> {
  let probe: Request;
  try {
    probe = request.clone();
  } catch {
    return NextResponse.json(
      { error: "invalid_request_body" },
      { status: 400 },
    );
  }
  if (!probe.body) return undefined;

  const reader = probe.body.getReader();
  let receivedBytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return undefined;
      receivedBytes += chunk.value.byteLength;
      if (receivedBytes <= MAX_BODY_BYTES) continue;

      const cancelOriginal =
        request.body && !request.body.locked
          ? request.body.cancel("request_too_large")
          : Promise.resolve();
      await Promise.allSettled([
        reader.cancel("request_too_large"),
        cancelOriginal,
      ]);
      return NextResponse.json({ error: "request_too_large" }, { status: 413 });
    }
  } catch {
    const cancelOriginal =
      request.body && !request.body.locked
        ? request.body.cancel("invalid_request_body")
        : Promise.resolve();
    await Promise.allSettled([
      reader.cancel("invalid_request_body"),
      cancelOriginal,
    ]);
    return NextResponse.json(
      { error: "invalid_request_body" },
      { status: 400 },
    );
  }
}

export function authorizeRead(
  request: Request,
): { sessionId: string } | NextResponse {
  const sessionId = sessionFrom(request);
  return sessionId
    ? { sessionId }
    : NextResponse.json({ error: "session_required" }, { status: 401 });
}
