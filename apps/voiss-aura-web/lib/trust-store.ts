import "server-only";

import { resolve } from "node:path";
import type {
  AuditEvent,
  Finding,
  TrustAsset,
  TrustControl,
} from "@voiss/domain";
import {
  TrustStore,
  type ClaimReviewGateInput,
  type R002ClosureInput,
} from "@voiss/trust-engine";
import type { ServiceState } from "./service-status";

const occurredAt = "2026-07-24T00:00:00.000Z";
const initialAssets: TrustAsset[] = [
  {
    id: "asset-aura",
    kind: "aura_runtime",
    name: "AURA application",
    state: "unknown",
    evidence: [],
  },
  {
    id: "asset-codex",
    kind: "codex_runtime",
    name: "Codex CLI / app-server",
    state: "unknown",
    evidence: [],
  },
  {
    id: "asset-evidence-index",
    kind: "aura_runtime",
    name: "AURA evidence index",
    state: "unknown",
    evidence: [],
  },
  {
    id: "asset-asr-model",
    kind: "aura_runtime",
    name: "AURA ASR model identity",
    state: "unknown",
    evidence: [],
  },
  {
    id: "asset-summary-model",
    kind: "aura_runtime",
    name: "AURA summary model identity",
    state: "unknown",
    evidence: [],
  },
  {
    id: "asset-repo",
    kind: "repository",
    name: "Project AURA",
    state: "ready",
    evidence: [],
  },
  {
    id: "asset-worktree",
    kind: "repository",
    name: "Active Git worktree",
    state: "unknown",
    evidence: [],
  },
  {
    id: "asset-copilotkit",
    kind: "agent_run",
    name: "CopilotKit runtime",
    state: "ready",
    evidence: [],
  },
  {
    id: "asset-bridges",
    kind: "agent_run",
    name: "Local AURA and Codex bridges",
    state: "unknown",
    evidence: [],
  },
];
const initialControls: TrustControl[] = [
  {
    id: "CTRL-AURA-001",
    title: "AURA runtime readiness",
    state: "not_run",
    evidence: [],
  },
  {
    id: "CTRL-EVID-001",
    title: "Claim source completeness",
    state: "not_run",
    evidence: [],
  },
  {
    id: "CTRL-EVID-002",
    title: "Unsupported claim gate",
    state: "not_run",
    evidence: [],
  },
  {
    id: "CTRL-EVID-003",
    title: "Transcript-summary freshness",
    state: "not_run",
    evidence: [],
  },
  {
    id: "CTRL-CODEX-001",
    title: "Codex authentication isolation",
    state: "not_run",
    evidence: [],
  },
  {
    id: "CTRL-CODEX-002",
    title: "Worktree isolation",
    state: "not_run",
    evidence: [],
  },
  {
    id: "CTRL-CODEX-003",
    title: "Default network denial",
    state: "not_run",
    evidence: [],
  },
  {
    id: "CTRL-CODEX-004",
    title: "Consequential action approval",
    state: "not_run",
    evidence: [],
  },
  {
    id: "CTRL-AUDIT-001",
    title: "Audit chain continuity",
    state: "not_run",
    evidence: [],
  },
  {
    id: "CTRL-SUPPLY-001",
    title: "Model identity evidence",
    state: "not_run",
    evidence: [],
  },
  {
    id: "CTRL-REPRO-001",
    title: "Frozen dependency path",
    state: "not_run",
    evidence: [],
  },
];
const initialFindings: Finding[] = [
  {
    id: "R-001",
    title: "TranscriptionTab god-controller 需要持續拆分 headless boundary",
    severity: "high",
    state: "open",
    controlId: "CTRL-AURA-001",
    evidence: [],
    remediation:
      "延續headless service boundary，將下一個Qt orchestration責任移入可測試的application service。",
  },
  {
    id: "R-002",
    title: "ASR 工作佇列需要有界容量與背壓",
    severity: "high",
    state: "open",
    controlId: "CTRL-EVID-001",
    evidence: [],
    remediation:
      "以有界容量、背壓、durable audio與六項同一run驗證證據完成closure。",
  },
  {
    id: "R-003",
    title: "CI 與啟動路徑採用 frozen lock",
    severity: "high",
    state: "open",
    controlId: "CTRL-REPRO-001",
    evidence: [],
    remediation: "讓CI與操作runbook共同執行pnpm及uv frozen lock品質閘門。",
  },
  {
    id: "R-004",
    title: "模型 revision 與 digest 證據待下一層驗證",
    severity: "medium",
    state: "open",
    controlId: "CTRL-SUPPLY-001",
    evidence: [],
    remediation:
      "在啟動時保留模型revision、digest或明確unknown狀態，並連結runtime evidence。",
  },
  {
    id: "R-006",
    title: "隱私 provenance 進入一致的機器可驗證路徑",
    severity: "high",
    state: "open",
    controlId: "CTRL-CODEX-001",
    evidence: [],
    remediation:
      "以資料分類、去識別、retention owner與可驗證export provenance完成一致路徑。",
  },
  {
    id: "R-010",
    title: "Lint、typecheck 與 coverage threshold 納入 release evidence",
    severity: "medium",
    state: "open",
    controlId: "CTRL-REPRO-001",
    evidence: [],
    remediation:
      "將lint、typecheck、coverage、build與architecture check保留為target-source release evidence。",
  },
];

const globalTrust = globalThis as typeof globalThis & {
  voissTrustStore?: TrustStore;
};

function store(): TrustStore {
  if (globalTrust.voissTrustStore) return globalTrust.voissTrustStore;
  const configuredPath = process.env.VOISS_DB_PATH;
  const path = configuredPath
    ? resolve(/* turbopackIgnore: true */ configuredPath)
    : resolve(process.cwd(), ".voiss", "control-plane.sqlite");
  const created = new TrustStore(path);
  const assetIds = new Set(
    created.list<TrustAsset>("assets").map((item) => item.id),
  );
  const controlIds = new Set(
    created.list<TrustControl>("controls").map((item) => item.id),
  );
  const findingIds = new Set(
    created.list<Finding>("findings").map((item) => item.id),
  );
  initialAssets
    .filter((item) => !assetIds.has(item.id))
    .forEach((item) => created.upsertAsset(item));
  initialControls
    .filter((item) => !controlIds.has(item.id))
    .forEach((item) => created.upsertControl(item));
  initialFindings
    .filter((item) => !findingIds.has(item.id))
    .forEach((item) => created.upsertFinding(item));
  if (created.auditTimeline().length === 0) {
    created.appendAudit({
      correlationId: "control-plane-bootstrap",
      occurredAt,
      actor: "trust-engine",
      action: "control_plane.initialized",
      subject: "voiss-aura",
      detail: { schema: "voiss.trust.snapshot.v1" },
    });
  }
  globalTrust.voissTrustStore = created;
  return created;
}

function readinessControl(
  id: string,
  title: string,
  service: ServiceState,
): TrustControl {
  return {
    id,
    title,
    state: service.ready ? "pass" : "fail",
    checkedAt: new Date().toISOString(),
    evidence: [],
  };
}

export function syncRuntimeReadiness(status: {
  aura: ServiceState;
  codex: ServiceState;
}): void {
  const trust = store();
  trust.upsertAsset({
    ...initialAssets[0],
    state: status.aura.ready ? "ready" : "attention",
  });
  trust.upsertAsset({
    ...initialAssets[1],
    state: status.codex.ready ? "ready" : "attention",
  });
  trust.upsertControl(
    readinessControl("CTRL-AURA-001", "AURA runtime readiness", status.aura),
  );
  trust.upsertControl(
    readinessControl(
      "CTRL-CODEX-001",
      "Codex authentication and app-server readiness",
      status.codex,
    ),
  );
}

export function recordTrustEvent(input: {
  correlationId: string;
  actor: string;
  action: string;
  subject: string;
  detail?: Record<string, unknown>;
}): AuditEvent {
  return store().appendAudit({
    ...input,
    occurredAt: new Date().toISOString(),
    detail: input.detail ?? {},
  });
}

export function recordValidatedExport(
  correlationId: string,
  runId: string,
): void {
  store().recordValidatedExport(correlationId, runId);
}

export function recordClaimReviewGate(input: ClaimReviewGateInput): void {
  store().recordClaimReviewGate(input);
}

export function recordR002Closure(input: R002ClosureInput): boolean {
  return store().recordR002Closure(input);
}

export function trustSnapshot() {
  const trust = store();
  return {
    schema: "voiss.trust.snapshot.v1",
    assets: trust.list<TrustAsset>("assets"),
    controls: trust.list<TrustControl>("controls"),
    findings: trust.list<Finding>("findings"),
    audit: trust.auditTimeline(),
    auditChainValid: trust.verifyAuditChain(),
  };
}
