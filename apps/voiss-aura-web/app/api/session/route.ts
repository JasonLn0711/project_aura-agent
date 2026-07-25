import { createSessionResponse } from "@/lib/security";

export const dynamic = "force-dynamic";

export function GET() {
  return createSessionResponse();
}
