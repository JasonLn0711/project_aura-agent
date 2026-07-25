import { NextResponse } from "next/server";
import { z } from "zod";
import {
  authorizeRead,
  correlationIdForSession,
  primaryWebOrigin,
} from "@/lib/security";

const QuerySchema = z
  .object({
    meeting_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
    start_ms: z.coerce.number().int().nonnegative(),
    end_ms: z.coerce.number().int().positive(),
  })
  .refine(
    (value) =>
      value.end_ms > value.start_ms && value.end_ms - value.start_ms <= 60_000,
  );

export async function GET(request: Request) {
  const authorization = authorizeRead(request);
  if (authorization instanceof NextResponse) return authorization;
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
  const query = QuerySchema.safeParse(Object.fromEntries(source.searchParams));
  if (!query.success)
    return NextResponse.json({ error: "invalid_audio_span" }, { status: 400 });
  try {
    const response = await fetch(`${bridge}/v1/evidence/audio-span`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        origin: primaryWebOrigin(),
        "x-correlation-id": correlationIdForSession(authorization.sessionId),
      },
      body: JSON.stringify(query.data),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok || !response.body) {
      return NextResponse.json(
        { error: "audio_span_unavailable" },
        { status: response.status },
      );
    }
    return new NextResponse(response.body, {
      status: 200,
      headers: {
        "content-type": "audio/wav",
        "content-disposition": "inline",
        "cache-control": "private, no-store",
      },
    });
  } catch {
    return NextResponse.json(
      { error: "aura_bridge_unavailable", recoverable: true },
      { status: 503 },
    );
  }
}
