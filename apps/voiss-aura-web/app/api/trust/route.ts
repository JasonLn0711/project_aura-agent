import { NextResponse } from "next/server";
import { authorizeRead } from "@/lib/security";
import { readServiceStatus } from "@/lib/service-status";
import { syncRuntimeReadiness, trustSnapshot } from "@/lib/trust-store";

export async function GET(request: Request) {
  const authorization = authorizeRead(request);
  if (authorization instanceof NextResponse) return authorization;
  if (process.env.VOISS_MODE !== "local") {
    return NextResponse.json({ error: "local_mode_required" }, { status: 409 });
  }
  const status = await readServiceStatus();
  syncRuntimeReadiness(status);
  return NextResponse.json(trustSnapshot(), {
    headers: { "cache-control": "private, no-store" },
  });
}
