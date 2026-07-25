import { NextResponse } from "next/server";
import { readServiceStatus } from "@/lib/service-status";

export async function GET() {
  return NextResponse.json({
    ...(await readServiceStatus()),
    credentialsRequired: false,
  });
}
