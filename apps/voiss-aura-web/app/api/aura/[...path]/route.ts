import { NextResponse } from "next/server";
import {
  authorizeRead,
  correlationIdForSession,
  primaryWebOrigin,
} from "@/lib/security";

const SAFE_PATHS = [
  /^\/v1\/sessions$/,
  /^\/v1\/sessions\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/,
  /^\/v1\/sessions\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\/(segments|claims)$/,
  /^\/v1\/actions$/,
  /^\/v1\/evidence\/search$/,
  /^\/v1\/audit\/events$/,
];

export async function GET(
  request: Request,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const authorization = authorizeRead(request);
  if (authorization instanceof NextResponse) return authorization;
  const pathname = `/${(await params).path.join("/")}`;
  if (!SAFE_PATHS.some((pattern) => pattern.test(pathname))) {
    return NextResponse.json({ error: "path_not_allowed" }, { status: 404 });
  }
  if (process.env.VOISS_MODE !== "local") {
    return NextResponse.json({ error: "local_mode_required" }, { status: 409 });
  }
  const bridge = process.env.AURA_BRIDGE_URL?.replace(/\/$/, "");
  const token = process.env.AURA_BRIDGE_TOKEN;
  if (!bridge || !token) {
    return NextResponse.json(
      { error: "aura_bridge_not_configured" },
      { status: 503 },
    );
  }
  const source = new URL(request.url);
  const target = new URL(`${bridge}${pathname}`);
  source.searchParams.forEach((value, key) =>
    target.searchParams.append(key, value),
  );
  try {
    const response = await fetch(target, {
      headers: {
        authorization: `Bearer ${token}`,
        origin: primaryWebOrigin(),
        "x-correlation-id": correlationIdForSession(authorization.sessionId),
      },
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
    });
    const body = await response.text();
    return new NextResponse(body.slice(0, 5_000_000), {
      status: response.status,
      headers: { "content-type": "application/json" },
    });
  } catch {
    return NextResponse.json(
      { error: "aura_bridge_unavailable", recoverable: true },
      { status: 503 },
    );
  }
}
