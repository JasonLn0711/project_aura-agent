import { NextResponse } from "next/server";
import {
  authorizeRead,
  correlationIdForSession,
  primaryWebOrigin,
} from "@/lib/security";

const EXPORT_ID = /^[A-Za-z0-9-]+$/;
const ARTIFACTS = new Set([
  "changes.patch",
  "evidence.json",
  "checksums.sha256",
]);
const MAX_ARTIFACT_BYTES = 12 * 1024 * 1024;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ exportId: string; filename: string }> },
) {
  const authorization = authorizeRead(request);
  if (authorization instanceof NextResponse) return authorization;
  if (process.env.VOISS_MODE !== "local") {
    return NextResponse.json({ error: "local_mode_required" }, { status: 409 });
  }
  const { exportId, filename } = await params;
  if (!EXPORT_ID.test(exportId) || !ARTIFACTS.has(filename)) {
    return NextResponse.json(
      { error: "artifact_not_allowed" },
      { status: 404 },
    );
  }
  const bridge = process.env.CODEX_BRIDGE_URL?.replace(/\/$/, "");
  const token = process.env.CODEX_BRIDGE_TOKEN;
  if (!bridge || !token) {
    return NextResponse.json(
      { error: "codex_bridge_not_configured" },
      { status: 503 },
    );
  }
  try {
    const response = await fetch(
      `${bridge}/v1/evidence/exports/${encodeURIComponent(exportId)}/${encodeURIComponent(filename)}`,
      {
        headers: {
          authorization: `Bearer ${token}`,
          origin: primaryWebOrigin(),
          "x-correlation-id": correlationIdForSession(authorization.sessionId),
        },
        cache: "no-store",
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!response.ok) {
      return NextResponse.json(
        { error: "artifact_unavailable" },
        { status: response.status },
      );
    }
    const declaredBytes = Number(response.headers.get("content-length") ?? 0);
    if (
      !Number.isSafeInteger(declaredBytes) ||
      declaredBytes > MAX_ARTIFACT_BYTES
    ) {
      return NextResponse.json(
        { error: "artifact_too_large" },
        { status: 502 },
      );
    }
    const body = await response.arrayBuffer();
    if (body.byteLength > MAX_ARTIFACT_BYTES) {
      return NextResponse.json(
        { error: "artifact_too_large" },
        { status: 502 },
      );
    }
    return new NextResponse(body, {
      status: 200,
      headers: {
        "cache-control": "private, no-store",
        "content-disposition": `attachment; filename="${filename}"`,
        "content-type":
          response.headers.get("content-type") ?? "application/octet-stream",
        "x-content-type-options": "nosniff",
      },
    });
  } catch {
    return NextResponse.json(
      { error: "codex_bridge_unavailable", recoverable: true },
      { status: 503 },
    );
  }
}
