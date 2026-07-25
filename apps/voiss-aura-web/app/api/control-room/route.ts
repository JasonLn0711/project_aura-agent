import { NextResponse } from "next/server";
import { z } from "zod";
import { authorizeMutation, guardMutationBody } from "@/lib/security";
import {
  recordClaimReviewGate,
  recordTrustEvent,
  recordValidatedExport,
} from "@/lib/trust-store";

const MutationSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("claim.review"),
    sessionId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
    claimId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
    decision: z.enum(["confirmed", "edited", "rejected"]),
    text: z.string().max(2_000).optional(),
  }),
  z.object({
    type: z.literal("run.approval"),
    runId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
    approvalId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
    decision: z.enum(["allow_once", "allow_run_scope", "deny"]),
  }),
  z.object({
    type: z.literal("run.stop"),
    runId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
  }),
  z.object({
    type: z.literal("evidence.export"),
    correlationId: z.string().min(1).max(160),
    runId: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)
      .optional(),
  }),
  z.object({
    type: z.literal("audit.operator"),
    event: z.enum([
      "action.delegated",
      "approval.allow_once",
      "approval.allow_run_scope",
      "approval.deny",
    ]),
    subject: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
  }),
  z.object({
    type: z.literal("audit.observation"),
    event: z.enum([
      "run.plan.completed",
      "run.validation.completed",
      "run.validation.incomplete",
      "run.failed",
    ]),
    subject: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
  }),
]);

export async function POST(request: Request) {
  const authorization = authorizeMutation(request);
  if (authorization instanceof NextResponse) return authorization;
  const bodyRejection = await guardMutationBody(request);
  if (bodyRejection) return bodyRejection;

  let payload: z.infer<typeof MutationSchema>;
  try {
    payload = MutationSchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  if (process.env.VOISS_MODE !== "local") {
    return NextResponse.json({
      accepted: true,
      mode: "demo",
      correlationId: "corr-demo-voiss-001",
      mutation: payload.type,
    });
  }
  const correlationId = request.headers.get("x-correlation-id");
  if (
    !correlationId ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(correlationId)
  ) {
    return NextResponse.json(
      { error: "invalid_correlation_id" },
      { status: 400 },
    );
  }
  if (
    payload.type === "audit.operator" ||
    payload.type === "audit.observation"
  ) {
    recordTrustEvent({
      correlationId,
      actor: payload.type === "audit.operator" ? "operator" : "control-room",
      action: payload.event,
      subject: payload.subject,
      detail: {
        classification:
          payload.type === "audit.operator"
            ? "operator_intent"
            : "normalized_runtime_observation",
      },
    });
    return NextResponse.json({ accepted: true, correlationId });
  }

  const endpoint = payload.type.startsWith("claim.")
    ? process.env.AURA_BRIDGE_URL
    : process.env.CODEX_BRIDGE_URL;
  const bridgeToken = payload.type.startsWith("claim.")
    ? process.env.AURA_BRIDGE_TOKEN
    : process.env.CODEX_BRIDGE_TOKEN;
  if (!endpoint || !bridgeToken) {
    return NextResponse.json(
      { error: "bridge_not_configured" },
      { status: 503 },
    );
  }
  const base = endpoint.replace(/\/$/, "");
  const target =
    payload.type === "claim.review"
      ? `${base}/v1/sessions/${encodeURIComponent(payload.sessionId)}/claims/${encodeURIComponent(payload.claimId)}/review`
      : payload.type === "run.approval"
        ? `${base}/v1/approvals/resume`
        : payload.type === "run.stop"
          ? `${base}/v1/runs/${encodeURIComponent(payload.runId)}/stop`
          : `${base}/v1/evidence/export`;
  const bridgePayload =
    payload.type === "claim.review"
      ? { decision: payload.decision, edited_text: payload.text }
      : payload;
  let response: Response;
  try {
    response = await fetch(target, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${bridgeToken}`,
        "x-correlation-id": correlationId,
      },
      body: JSON.stringify(bridgePayload),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return NextResponse.json(
      { error: "bridge_unavailable", recoverable: true },
      { status: 503 },
    );
  }
  const body = await response.text();
  if (payload.type === "claim.review" && payload.decision === "confirmed") {
    if (response.ok) {
      let reviewed: Record<string, unknown> = {};
      try {
        reviewed = JSON.parse(body) as Record<string, unknown>;
      } catch {
        // The authoritative bridge response remains fail-closed below.
      }
      recordClaimReviewGate({
        correlationId,
        sessionId: payload.sessionId,
        claimId: payload.claimId,
        outcome: "confirmed",
        sourceComplete:
          Array.isArray(reviewed.source_segment_ids) &&
          reviewed.source_segment_ids.length > 0,
        supported: reviewed.support_status === "supported",
        fresh: reviewed.review_status === "confirmed",
      });
    } else if (response.status === 409) {
      recordClaimReviewGate({
        correlationId,
        sessionId: payload.sessionId,
        claimId: payload.claimId,
        outcome: "blocked",
      });
    }
  }
  if (response.ok) {
    if (payload.type === "evidence.export" && payload.runId) {
      recordValidatedExport(correlationId, payload.runId);
    } else {
      const subject =
        payload.type === "claim.review"
          ? payload.claimId
          : (payload.runId ?? "latest-export");
      recordTrustEvent({
        correlationId,
        actor: "operator",
        action: payload.type,
        subject,
        detail:
          payload.type === "claim.review"
            ? { decision: payload.decision, sessionId: payload.sessionId }
            : payload.type === "run.approval"
              ? { decision: payload.decision, approvalId: payload.approvalId }
              : {},
      });
    }
  }
  return new NextResponse(body.slice(0, 64 * 1024), {
    status: response.status,
    headers: {
      "content-type":
        response.headers.get("content-type") ?? "application/json",
    },
  });
}
