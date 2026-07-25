import { z } from "zod";

export const EvidenceRefSchema = z.object({
  id: z.string().min(1),
  kind: z.enum([
    "segment",
    "audio_span",
    "claim",
    "action",
    "artifact",
    "run",
    "control",
  ]),
  locator: z.string().min(1),
  sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  startMs: z.number().int().nonnegative().optional(),
  endMs: z.number().int().positive().optional(),
});

export const SegmentSchema = z.object({
  id: z.string().min(1),
  speaker: z.string().min(1),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().positive(),
  text: z.string().min(1),
  status: z.enum(["raw", "edited", "confirmed"]),
});

export const ClaimSchema = z.object({
  id: z.string().min(1),
  field: z.string().min(1),
  text: z.string().min(1),
  status: z.enum(["pending", "confirmed", "edited", "rejected", "unsupported"]),
  evidence: z.array(EvidenceRefSchema),
  rationale: z.string().optional(),
});

export const ActionSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  owner: z.string().min(1),
  status: z.enum([
    "proposed",
    "confirmed",
    "delegated",
    "running",
    "validated",
    "closed",
  ]),
  support: z.enum(["supported", "partial", "unsupported"]),
  workType: z.enum(["engineering", "non-engineering", "unknown"]).optional(),
  dueDate: z.string().optional(),
  acceptance: z.array(z.string().min(1)),
  evidence: z.array(EvidenceRefSchema),
});

export const MeetingSessionSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  occurredAt: z.string().datetime(),
  participants: z.array(z.string().min(1)),
  freshness: z.enum(["fresh", "stale", "unknown"]),
  segments: z.array(SegmentSchema),
  claims: z.array(ClaimSchema),
  actions: z.array(ActionSchema),
  audioUrl: z.string().min(1),
});

export const ApprovalSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  category: z.enum(["command", "file_change"]),
  summary: z.string().min(1),
  decision: z.enum(["pending", "allow_once", "allow_run_scope", "deny"]),
  requestedAt: z.string().datetime(),
  resolvedAt: z.string().datetime().optional(),
});

export const RunEventSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  type: z.enum([
    "plan",
    "command",
    "file_change",
    "test",
    "approval",
    "diff",
    "message",
    "error",
    "completed",
  ]),
  status: z.enum([
    "queued",
    "running",
    "waiting",
    "passed",
    "failed",
    "stopped",
    "completed",
  ]),
  occurredAt: z.string().datetime(),
  title: z.string().min(1),
  detail: z.string().optional(),
});

export const AgentRunSchema = z.object({
  id: z.string().min(1),
  actionId: z.string().min(1),
  correlationId: z.string().min(1),
  mode: z.enum(["demo", "local"]),
  modelRequested: z.string(),
  modelObserved: z.string().optional(),
  effort: z.string(),
  status: z.enum([
    "planning",
    "approval_required",
    "running",
    "stopped",
    "validated",
    "failed",
  ]),
  worktree: z.string().optional(),
  events: z.array(RunEventSchema),
});

export const TrustAssetSchema = z.object({
  id: z.string().min(1),
  kind: z.enum([
    "repository",
    "aura_runtime",
    "codex_runtime",
    "session",
    "agent_run",
    "export",
  ]),
  name: z.string().min(1),
  state: z.enum(["ready", "attention", "unknown"]),
  evidence: z.array(EvidenceRefSchema),
});

export const TrustControlSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  state: z.enum(["pass", "fail", "unknown", "not_run"]),
  checkedAt: z.string().datetime().optional(),
  evidence: z.array(EvidenceRefSchema),
});

export const FindingSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  severity: z.enum(["low", "medium", "high", "critical"]),
  state: z.enum([
    "open",
    "planned",
    "in_progress",
    "waiting_approval",
    "remediated",
    "accepted",
  ]),
  controlId: z.string().min(1),
  evidence: z.array(EvidenceRefSchema),
  remediation: z.string().min(1).optional(),
});

export const AuditEventSchema = z.object({
  id: z.string().min(1),
  correlationId: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  occurredAt: z.string().datetime(),
  actor: z.string().min(1),
  action: z.string().min(1),
  subject: z.string().min(1),
  detail: z.record(z.string(), z.unknown()),
  previousHash: z.string(),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
});

export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;
export type Segment = z.infer<typeof SegmentSchema>;
export type Claim = z.infer<typeof ClaimSchema>;
export type Action = z.infer<typeof ActionSchema>;
export type MeetingSession = z.infer<typeof MeetingSessionSchema>;
export type Approval = z.infer<typeof ApprovalSchema>;
export type RunEvent = z.infer<typeof RunEventSchema>;
export type AgentRun = z.infer<typeof AgentRunSchema>;
export type TrustAsset = z.infer<typeof TrustAssetSchema>;
export type TrustControl = z.infer<typeof TrustControlSchema>;
export type Finding = z.infer<typeof FindingSchema>;
export type AuditEvent = z.infer<typeof AuditEventSchema>;

export function canDelegate(action: Action): boolean {
  return (
    action.status === "confirmed" &&
    action.support === "supported" &&
    action.evidence.length > 0
  );
}
