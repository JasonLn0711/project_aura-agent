"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAgent } from "@copilotkit/react-core/v2";
import {
  EventType,
  type AgentSubscriber,
  type BaseEvent,
  type ResumeEntry,
} from "@ag-ui/client";
import type {
  Action,
  AuditEvent,
  Claim,
  Finding,
  MeetingSession,
  RunEvent,
  TrustAsset,
  TrustControl,
} from "@voiss/domain";
import { canDelegate } from "@voiss/domain";
import type { ServiceState } from "@/lib/service-status";
import {
  demoAssets,
  demoClaimActionLinks,
  demoControls,
  demoExpectedPatch,
  demoExpectedTests,
  demoFindings,
  demoRun,
  demoSession,
} from "@voiss/demo-fixtures";
import { useVoissSession } from "./providers";

type Screen =
  "control" | "sessions" | "actions" | "runs" | "trust" | "settings";
type RunStage =
  "idle" | "approval" | "running" | "completed" | "failed" | "stopped";
type RunDetailTab =
  | "overview"
  | "plan"
  | "activity"
  | "changes"
  | "validation"
  | "approvals"
  | "evidence";
type TrustDetailTab =
  "assets" | "controls" | "findings" | "remediations" | "audit";
type ApprovalDecision = "allow_once" | "allow_run_scope" | "deny";
type ApprovalRecord = {
  decision: ApprovalDecision;
  actor: string;
  at: string;
};
type AuditRow = {
  id: string;
  at: string;
  actor: string;
  action: string;
  subject: string;
  hash: string;
};
type SessionLoadState = "loading" | "ready" | "empty" | "unavailable";
type DataBoundaryState = {
  value: "local-only" | "cloud-enabled" | "unknown";
  label: "Local only" | "Cloud model enabled" | "Unknown/misconfigured";
  detail: string;
};
type ExportArtifact = {
  kind: string;
  filename: string;
  bytes: number;
  sha256?: string;
};
type LocalExport = {
  exportId: string;
  artifacts: ExportArtifact[];
};
type AuraSessionSummary = {
  session_id: string;
  title: string;
  started_at: string;
  ended_at: string;
  workflow: string;
  status: string;
  transcript_hash_state: "current" | "stale" | "missing";
  summary_state: string;
  reviewed_count: number;
  unreviewed_count: number;
  confirmed_action_count: number;
  local_path_available: boolean;
};

const navigation: Array<{ id: Screen; label: string; icon: string }> = [
  { id: "control", label: "Control Room", icon: "⌂" },
  { id: "sessions", label: "會議紀錄", icon: "◫" },
  { id: "actions", label: "行動項目", icon: "✓" },
  { id: "runs", label: "Agent Runs", icon: "▶" },
  { id: "trust", label: "信任與稽核", icon: "◇" },
  { id: "settings", label: "設定", icon: "⚙" },
];

const promptSuggestions = [
  "檢查 AURA 是否已準備好開始工作",
  "載入 VOISS 架構會議示範資料",
  "列出尚未確認的主張",
  "找出沒有來源證據的 action items",
  "找出 Max 本週承諾但尚未完成的工程行動",
  "針對 AURA R-002 產生唯讀修復計畫",
  "審查這次 Codex diff，先不要套用其他變更",
  "匯出這次執行的 evidence packet",
] as const;

const demoSessionSummary: AuraSessionSummary = {
  session_id: demoSession.id,
  title: demoSession.title,
  started_at: demoSession.occurredAt,
  ended_at: new Date(Date.parse(demoSession.occurredAt) + 36_000).toISOString(),
  workflow: "deterministic_demo",
  status: "ready",
  transcript_hash_state: "current",
  summary_state: "ready",
  reviewed_count: demoSession.claims.filter(
    (claim) => claim.status !== "pending",
  ).length,
  unreviewed_count: demoSession.claims.filter(
    (claim) => claim.status === "pending",
  ).length,
  confirmed_action_count: demoSession.actions.filter(canDelegate).length,
  local_path_available: true,
};

const initialAudit: AuditRow[] = [
  {
    id: "audit-001",
    at: "14:00:00",
    actor: "AURA Bridge",
    action: "session.loaded",
    subject: demoSession.id,
    hash: "2df7a9b3",
  },
];

const formatTime = (milliseconds: number) => {
  const seconds = Math.floor(milliseconds / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
};

const validationCommand =
  /\b(?:pytest|vitest|playwright|pnpm\s+(?:lint|typecheck|test|build)|git\s+diff\s+--check)\b/i;

function deriveDataBoundary(
  mode: "demo" | "local",
  codex: ServiceState,
): DataBoundaryState {
  if (mode === "demo") {
    return {
      value: "local-only",
      label: "Local only",
      detail:
        "Sanitized fixtures and scripted events remain in this browser session.",
    };
  }
  if (codex.ready && codex.signedIn === true) {
    return {
      value: "cloud-enabled",
      label: "Cloud model enabled",
      detail:
        "Reviewed action context may reach the signed-in Codex model; raw AURA audio remains local.",
    };
  }
  return {
    value: "unknown",
    label: "Unknown/misconfigured",
    detail:
      "Codex account or bridge status still needs confirmation before delegation.",
  };
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function boundedDetail(value: unknown): string | undefined {
  if (typeof value === "string") return value.slice(0, 2_000);
  if (value === undefined || value === null) return undefined;
  return JSON.stringify(value).slice(0, 2_000);
}

async function codexDiffReview(
  runId: string,
  status: RunStage,
  events: RunEvent[],
) {
  const patch = [...events]
    .reverse()
    .find((event) => event.type === "diff")?.detail;
  if (!runId || !patch) return { runId, status, available: false };
  const lines = patch.split("\n");
  const changedFiles = Array.from(
    new Set(
      lines.flatMap((line) => {
        const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
        return match ? [match[2]] : [];
      }),
    ),
  );
  const sha256 = Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(patch)),
    ),
  )
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return {
    runId,
    status,
    available: true,
    sha256,
    changedFiles,
    additions: lines.filter((line) => /^\+(?!\+\+)/.test(line)).length,
    deletions: lines.filter((line) => /^-(?!--)/.test(line)).length,
    classification: "displayed_trusted_diff_snapshot",
  };
}

export function agentEventToRunEvent(
  event: BaseEvent,
  runId: string,
): RunEvent | null {
  const occurredAt = new Date().toISOString();
  const raw = record(event);
  if (event.type === EventType.TEXT_MESSAGE_CONTENT) {
    return {
      id: `message:${String(raw.messageId ?? "codex")}`,
      runId,
      type: "message",
      status: "running",
      occurredAt,
      title: "Codex 回應",
      detail: boundedDetail(raw.delta),
    };
  }
  if (event.type === EventType.RUN_ERROR) {
    return {
      id: `error:${crypto.randomUUID()}`,
      runId,
      type: "error",
      status: "failed",
      occurredAt,
      title: "Codex run 發生錯誤",
      detail: boundedDetail(raw.message),
    };
  }
  if (event.type === EventType.RUN_FINISHED) {
    const interrupted = record(raw.outcome).type === "interrupt";
    return {
      id: `terminal:${runId}:${interrupted ? "approval" : "finished"}`,
      runId,
      type: interrupted ? "approval" : "completed",
      status: interrupted ? "waiting" : "completed",
      occurredAt,
      title: interrupted ? "等待明確核准" : "Codex turn 已完成",
    };
  }
  if (event.type !== EventType.ACTIVITY_SNAPSHOT) return null;

  const content = record(raw.content);
  const activity = typeof raw.activityType === "string" ? raw.activityType : "";
  const rawStatus =
    typeof content.status === "string" ? content.status : "running";
  const exitCode =
    typeof content.exitCode === "number" ? content.exitCode : null;
  const failed =
    /fail|error|reject/i.test(rawStatus) ||
    (exitCode !== null && exitCode !== 0);
  const completed = /complete|success|pass/i.test(rawStatus);
  const waiting = activity === "voiss.approval.request.v1";
  const command = typeof content.command === "string" ? content.command : "";
  const isValidation =
    activity === "voiss.codex.command.v1" && validationCommand.test(command);
  const type: RunEvent["type"] = isValidation
    ? "test"
    : activity === "voiss.codex.command.v1"
      ? "command"
      : activity === "voiss.codex.file_change.v1"
        ? "file_change"
        : activity === "voiss.codex.diff.v1"
          ? "diff"
          : waiting || activity === "voiss.approval.response.v1"
            ? "approval"
            : activity === "voiss.codex.plan.v1"
              ? "plan"
              : "message";
  const detail =
    type === "approval"
      ? {
          reason: content.reason,
          command: content.command,
          cwd: content.cwd,
          grantRoot: content.grantRoot,
        }
      : (content.output ??
        content.diff ??
        content.patch ??
        content.explanation ??
        content.plan ??
        content.changes ??
        content);
  return {
    id: typeof raw.messageId === "string" ? raw.messageId : crypto.randomUUID(),
    runId,
    type,
    status: failed
      ? "failed"
      : waiting
        ? "waiting"
        : completed
          ? "passed"
          : "running",
    occurredAt,
    title: isValidation
      ? command
      : type === "command"
        ? command || "Codex command"
        : type === "file_change"
          ? "檔案變更"
          : type === "diff"
            ? "Trusted diff 更新"
            : type === "approval"
              ? "Codex 要求核准"
              : type === "plan"
                ? "Codex 計畫更新"
                : "Codex runtime 狀態",
    detail: boundedDetail(detail),
  };
}

export function aggregateValidationEvidence(
  current: { validation: boolean; validationFailed: boolean },
  status: RunEvent["status"],
) {
  return {
    validation: current.validation || status === "passed",
    validationFailed: current.validationFailed || status === "failed",
  };
}

async function loadLocalSessionList(): Promise<AuraSessionSummary[]> {
  const sessionList = await fetch("/api/aura/v1/sessions", {
    cache: "no-store",
  });
  if (!sessionList.ok) throw new Error("session list unavailable");
  const listed = (await sessionList.json()) as {
    sessions?: AuraSessionSummary[];
  };
  if (!Array.isArray(listed.sessions)) throw new Error("invalid session list");
  return listed.sessions;
}

async function loadLocalSession(
  summary: AuraSessionSummary,
): Promise<MeetingSession> {
  const id = encodeURIComponent(summary.session_id);
  const [detailResponse, segmentsResponse, claimsResponse, actionsResponse] =
    await Promise.all([
      fetch(`/api/aura/v1/sessions/${id}`, { cache: "no-store" }),
      fetch(`/api/aura/v1/sessions/${id}/segments`, { cache: "no-store" }),
      fetch(`/api/aura/v1/sessions/${id}/claims`, { cache: "no-store" }),
      fetch(`/api/aura/v1/actions?meeting_id=${id}`, { cache: "no-store" }),
    ]);
  if (
    ![detailResponse, segmentsResponse, claimsResponse, actionsResponse].every(
      (response) => response.ok,
    )
  ) {
    throw new Error("AURA session contract unavailable");
  }
  const detail = (await detailResponse.json()) as {
    title: string;
    started_at: string;
    transcript_hash_state: string;
  };
  const segmentBody = (await segmentsResponse.json()) as {
    segments: Array<{
      segment_id: string;
      start_ms: number;
      end_ms: number;
      text: string;
      speaker: string;
      state: string;
    }>;
  };
  const claimBody = (await claimsResponse.json()) as {
    claims: Array<{
      claim_id: string;
      field: string;
      text: string;
      source_segment_ids: string[];
      support_status: string;
      review_status: string;
    }>;
  };
  const actionBody = (await actionsResponse.json()) as {
    actions: Array<{
      action_id: string;
      meeting_id: string;
      task: string;
      owner: string;
      deadline: string;
      source_segment_ids: string[];
      support_status: string;
      review_status: string;
      work_type?: string;
    }>;
  };
  const segments = segmentBody.segments.map((segment) => ({
    id: segment.segment_id,
    speaker: segment.speaker || "Speaker",
    startMs: segment.start_ms,
    endMs: segment.end_ms,
    text: segment.text,
    status: ["edited", "confirmed"].includes(segment.state)
      ? (segment.state as "edited" | "confirmed")
      : ("raw" as const),
  }));
  const evidenceFor = (sourceIds: string[]) =>
    sourceIds.map((sourceId) => {
      const segment = segments.find((item) => item.id === sourceId);
      return {
        id: sourceId,
        kind: "segment" as const,
        locator: `aura://${summary.session_id}/segments/${sourceId}`,
        startMs: segment?.startMs,
        endMs: segment?.endMs,
      };
    });
  const claims: Claim[] = claimBody.claims.map((claim) => ({
    id: claim.claim_id,
    field: claim.field,
    text: claim.text,
    status:
      claim.support_status === "unsupported"
        ? "unsupported"
        : ["confirmed", "edited", "rejected"].includes(claim.review_status)
          ? (claim.review_status as "confirmed" | "edited" | "rejected")
          : "pending",
    evidence: evidenceFor(claim.source_segment_ids),
  }));
  const actions: Action[] = actionBody.actions
    .filter((action) => action.meeting_id === summary.session_id)
    .map((action) => ({
      id: action.action_id,
      title: action.task,
      owner: action.owner || "待指派",
      status: action.review_status === "confirmed" ? "confirmed" : "proposed",
      support:
        action.support_status === "supported"
          ? "supported"
          : action.support_status === "unsupported"
            ? "unsupported"
            : "partial",
      workType: ["engineering", "non-engineering", "unknown"].includes(
        action.work_type ?? "",
      )
        ? (action.work_type as "engineering" | "non-engineering" | "unknown")
        : "unknown",
      dueDate: action.deadline || undefined,
      acceptance: [
        "依來源證據完成變更",
        "執行針對性驗證",
        "保留 diff 與測試證據",
      ],
      evidence: evidenceFor(action.source_segment_ids),
    }));
  const occurredAt = Number.isNaN(Date.parse(detail.started_at))
    ? new Date(0).toISOString()
    : new Date(detail.started_at).toISOString();
  return {
    id: summary.session_id,
    title: detail.title || summary.title,
    occurredAt,
    participants: [],
    freshness:
      detail.transcript_hash_state === "current"
        ? "fresh"
        : detail.transcript_hash_state === "stale"
          ? "stale"
          : "unknown",
    segments,
    claims,
    actions,
    audioUrl: `/api/aura-audio?meeting_id=${id}`,
  };
}

const statusLabel = (status: string) =>
  ({
    confirmed: "已確認",
    edited: "已編輯確認",
    rejected: "已拒絕",
    unsupported: "證據不足",
    pending: "待覆核",
    proposed: "待確認",
    delegated: "已委派",
    running: "執行中",
    validated: "已驗證",
    closed: "已結案",
    planned: "已規劃",
    in_progress: "處理中",
    waiting_approval: "等待核准",
    remediated: "已完成修復證據",
    accepted: "已接受",
    supported: "證據完整",
    partial: "部分證據",
    approval: "等待核准",
    completed: "完成",
    stopped: "已停止",
    idle: "待啟動",
  })[status] ?? status;

const tone = (status: string) => {
  if (
    [
      "confirmed",
      "edited",
      "validated",
      "closed",
      "remediated",
      "accepted",
      "supported",
      "pass",
      "ready",
      "completed",
    ].includes(status)
  )
    return "positive";
  if (
    ["unsupported", "rejected", "failed", "critical", "high", "fail"].includes(
      status,
    )
  )
    return "danger";
  if (
    [
      "pending",
      "partial",
      "proposed",
      "planned",
      "in_progress",
      "waiting_approval",
      "attention",
      "medium",
      "unknown",
      "not_run",
    ].includes(status)
  )
    return "warning";
  return "neutral";
};

export function ControlRoom() {
  const { csrfToken: csrf, correlationId, mode } = useVoissSession();
  const [screen, setScreen] = useState<Screen>("control");
  const [sessionSummaries, setSessionSummaries] = useState<
    AuraSessionSummary[]
  >(mode === "demo" ? [demoSessionSummary] : []);
  const [sessionLoadState, setSessionLoadState] = useState<SessionLoadState>(
    mode === "demo" ? "ready" : "loading",
  );
  const [selectedSessionId, setSelectedSessionId] = useState(
    mode === "demo" ? demoSession.id : "",
  );
  const [session, setSession] = useState<MeetingSession | null>(
    mode === "demo" ? demoSession : null,
  );
  const [claims, setClaims] = useState<Claim[]>(
    mode === "demo" ? demoSession.claims : [],
  );
  const [selectedActionId, setSelectedActionId] = useState(
    mode === "demo" ? demoSession.actions[0].id : "",
  );
  const [selectedClaimId, setSelectedClaimId] = useState(
    mode === "demo"
      ? (demoSession.claims.find((claim) => claim.status === "pending")?.id ??
          "")
      : "",
  );
  const [runStage, setRunStage] = useState<RunStage>("idle");
  const [writeActivated, setWriteActivated] = useState(false);
  const [forceTestFailure, setForceTestFailure] = useState(false);
  const [runEvents, setRunEvents] = useState<RunEvent[]>([]);
  const [activeRunId, setActiveRunId] = useState("");
  const [activeRunActionId, setActiveRunActionId] = useState("");
  const [approvalRecord, setApprovalRecord] = useState<ApprovalRecord | null>(
    null,
  );
  const [lastExport, setLastExport] = useState<LocalExport | null>(null);
  const [audit, setAudit] = useState<AuditRow[]>(
    mode === "demo" ? initialAudit : [],
  );
  const [trustAssets, setTrustAssets] = useState<TrustAsset[]>(
    mode === "demo" ? demoAssets : [],
  );
  const [trustControls, setTrustControls] = useState<TrustControl[]>(
    mode === "demo" ? demoControls : [],
  );
  const [trustFindings, setTrustFindings] = useState<Finding[]>(
    mode === "demo" ? demoFindings : [],
  );
  const [promptDraft, setPromptDraft] = useState("");
  const [agentReply, setAgentReply] = useState("");
  const [orchestratorActivity, setOrchestratorActivity] = useState<RunEvent[]>(
    [],
  );
  const [agentPanelOpen, setAgentPanelOpen] = useState(false);
  const [editingClaim, setEditingClaim] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [search, setSearch] = useState("");
  const [uiPersistenceReady, setUiPersistenceReady] = useState(false);
  const [notice, setNotice] = useState(
    mode === "demo"
      ? "Deterministic demo 已載入；所有事件皆為可重現的非正式環境證據。"
      : "AURA 會議資料載入中；Codex 委派維持關閉。",
  );
  const [services, setServices] = useState<{
    aura: ServiceState;
    codex: ServiceState;
  }>(
    mode === "demo"
      ? {
          aura: { ready: true, label: "Fixture ready" },
          codex: { ready: true, label: "Scripted agent" },
        }
      : {
          aura: { ready: false, label: "正在檢查" },
          codex: { ready: false, label: "正在檢查" },
        },
  );
  const dataBoundary = deriveDataBoundary(mode, services.codex);
  const runTimers = useRef<number[]>([]);
  const sessionRequest = useRef(0);
  const liveChecks = useRef({
    diff: false,
    validation: false,
    validationFailed: false,
  });
  const { agent, isReady: agentReady } = useAgent({
    agentId: mode === "demo" ? "demo_agent" : "codex_engineer",
    throttleMs: 40,
  });
  const { agent: orchestrator, isReady: orchestratorReady } = useAgent({
    agentId: "voiss_orchestrator",
    throttleMs: 40,
  });
  const delegationReady =
    agentReady &&
    (mode === "demo" ||
      (sessionLoadState === "ready" &&
        services.aura.ready &&
        services.codex.ready));
  const currentRunActive =
    Boolean(activeRunId) && (runStage === "approval" || runStage === "running");
  const activeRunLabel = currentRunActive
    ? `目前執行：${activeRunId.slice(0, 16)}… · ${statusLabel(runStage)}`
    : `${activeRunId ? 0 : (services.codex.activeRuns ?? 0)} active runs`;

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        const savedScreen = window.localStorage.getItem(
          "voiss.control-room.screen",
        );
        if (navigation.some((item) => item.id === savedScreen)) {
          setScreen(savedScreen as Screen);
        }
        setSearch(
          window.localStorage.getItem("voiss.control-room.search") ?? "",
        );
      } catch {
        // Browser storage is an optional convenience; trusted state stays server controlled.
      } finally {
        setUiPersistenceReady(true);
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!uiPersistenceReady) return;
    try {
      window.localStorage.setItem("voiss.control-room.screen", screen);
      window.localStorage.setItem("voiss.control-room.search", search);
    } catch {
      // Navigation remains fully usable when browser storage is unavailable.
    }
  }, [screen, search, uiPersistenceReady]);

  useEffect(() => {
    if (!selectedSessionId) return;
    try {
      window.localStorage.setItem(
        `voiss.control-room.${mode}.session`,
        selectedSessionId,
      );
    } catch {
      // Session selection is non-authoritative and may remain memory-only.
    }
  }, [mode, selectedSessionId]);

  const refreshTrust = useCallback(async () => {
    if (mode !== "local") return;
    const response = await fetch("/api/trust", { cache: "no-store" });
    if (!response.ok) return;
    const snapshot = (await response.json()) as {
      assets: TrustAsset[];
      controls: TrustControl[];
      findings: Finding[];
      audit: AuditEvent[];
      auditChainValid: boolean;
    };
    setTrustAssets(snapshot.assets);
    setTrustControls(snapshot.controls);
    setTrustFindings(snapshot.findings);
    setAudit(
      snapshot.audit.map((event) => ({
        id: event.id,
        at: new Date(event.occurredAt).toLocaleTimeString("zh-TW", {
          hour12: false,
        }),
        actor: event.actor,
        action: event.action,
        subject: event.subject,
        hash: event.hash.slice(0, 12),
      })),
    );
    if (!snapshot.auditChainValid) {
      setNotice("Audit chain 驗證需要人員覆核；寫入與匯出 gate 維持關閉。");
    }
  }, [mode]);

  useEffect(() => {
    const timer = window.setTimeout(() => void refreshTrust(), 0);
    return () => window.clearTimeout(timer);
  }, [refreshTrust]);

  useEffect(() => {
    void fetch("/api/status", { cache: "no-store" })
      .then((response) => response.json())
      .then((body: { aura: ServiceState; codex: ServiceState }) => {
        setServices({ aura: body.aura, codex: body.codex });
        if (!body.aura.ready || !body.codex.ready) {
          setNotice(
            mode === "local" && !body.aura.ready
              ? "AURA 會議資料尚未載入；本機 bridge 可復原，Codex 委派維持關閉。"
              : "本機 bridge 尚未連線；Control Room 保留可復原的唯讀狀態。",
          );
        }
      })
      .catch(() => setNotice("服務狀態暫時無法讀取；可重新整理後再驗證。"));
  }, [mode]);

  useEffect(() => {
    if (mode !== "local") return;
    let active = true;
    const requestId = ++sessionRequest.current;
    let preferredSessionId: string | null = null;
    try {
      preferredSessionId = window.localStorage.getItem(
        "voiss.control-room.local.session",
      );
    } catch {
      // Continue with the first current AURA session.
    }
    void loadLocalSessionList()
      .then(async (summaries) => {
        if (!active || requestId !== sessionRequest.current) return;
        setSessionSummaries(summaries);
        if (!summaries.length) {
          setSessionLoadState("empty");
          setNotice(
            "AURA 會議資料尚未載入；本機 bridge 可復原，本機模式維持唯讀，Demo 可透過 pnpm demo 另行啟動。",
          );
          return;
        }
        const summary =
          summaries.find((item) => item.session_id === preferredSessionId) ??
          summaries[0];
        setSelectedSessionId(summary.session_id);
        const loaded = await loadLocalSession(summary);
        if (!active || requestId !== sessionRequest.current) return;
        setSession(loaded);
        setClaims(loaded.claims);
        setSelectedClaimId(
          loaded.claims.find((claim) => claim.status === "pending")?.id ??
            loaded.claims[0]?.id ??
            "",
        );
        setSelectedActionId(loaded.actions[0]?.id ?? "");
        setSessionLoadState("ready");
        setNotice(
          `已從 AURA Bridge 載入 ${loaded.title}；canonical artifacts 維持唯一來源。`,
        );
      })
      .catch(() => {
        if (!active || requestId !== sessionRequest.current) return;
        setSessionSummaries([]);
        setSessionLoadState("unavailable");
        setSelectedSessionId("");
        setSession(null);
        setClaims([]);
        setSelectedClaimId("");
        setSelectedActionId("");
        setNotice(
          "AURA 會議資料尚未載入；本機 bridge 可復原，本機模式維持唯讀，Demo 可透過 pnpm demo 另行啟動。",
        );
      });
    return () => {
      active = false;
    };
  }, [mode]);

  useEffect(() => () => runTimers.current.forEach(window.clearTimeout), []);

  const selectedAction =
    session?.actions.find((action) => action.id === selectedActionId) ??
    session?.actions[0] ??
    null;
  const activeRunAction =
    session?.actions.find((action) => action.id === activeRunActionId) ??
    selectedAction;
  const selectedClaim =
    claims.find((claim) => claim.id === selectedClaimId) ??
    claims.find((claim) => claim.status === "pending") ??
    claims[0] ??
    null;

  const selectSession = async (sessionId: string) => {
    if (mode !== "local" || sessionId === selectedSessionId) return;
    const summary = sessionSummaries.find(
      (item) => item.session_id === sessionId,
    );
    if (!summary) return;
    const requestId = ++sessionRequest.current;
    setSessionLoadState("loading");
    setSelectedSessionId(sessionId);
    setSession(null);
    setClaims([]);
    setSelectedClaimId("");
    setSelectedActionId("");
    setEditingClaim(null);
    try {
      const loaded = await loadLocalSession(summary);
      if (requestId !== sessionRequest.current) return;
      setSession(loaded);
      setClaims(loaded.claims);
      setSelectedClaimId(
        loaded.claims.find((claim) => claim.status === "pending")?.id ??
          loaded.claims[0]?.id ??
          "",
      );
      setSelectedActionId(loaded.actions[0]?.id ?? "");
      setSessionLoadState("ready");
      setNotice(
        `已從 AURA Bridge 載入 ${loaded.title}；來源、摘要狀態與行動均依目前 artifact 呈現。`,
      );
    } catch {
      if (requestId !== sessionRequest.current) return;
      setSessionLoadState("unavailable");
      setNotice(
        "所選 AURA 會議資料尚未載入；本機委派維持關閉，可選擇其他會議重試。",
      );
    }
  };

  const mutation = async (payload: object): Promise<Response | undefined> => {
    if (!csrf) {
      setNotice("安全 session 建立中，請稍後再試。");
      return undefined;
    }
    const response = await fetch("/api/control-room", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-voiss-csrf": csrf,
        "x-correlation-id": correlationId,
      },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      setNotice(`操作保留在目前狀態（${response.status}）。`);
      return undefined;
    }
    return response;
  };

  const addAudit = (action: string, subject: string, actor = "Operator") => {
    if (mode === "local") {
      void refreshTrust();
      return;
    }
    setAudit((rows) => [
      ...rows,
      {
        id: `audit-${String(rows.length + 1).padStart(3, "0")}`,
        at: new Date().toLocaleTimeString("zh-TW", { hour12: false }),
        actor,
        action,
        subject,
        hash: `demo${String(rows.length + 1).padStart(4, "0")}`,
      },
    ]);
  };

  const askOrchestrator = async (suggestion?: string) => {
    const prompt = (suggestion ?? promptDraft).trim();
    if (!prompt) return;
    if (!orchestratorReady) {
      setNotice("VOISS Orchestrator 正在同步；既有可信任工作流程保持可用。");
      return;
    }
    const runId = crypto.randomUUID();
    setPromptDraft(prompt);
    setAgentReply("");
    setOrchestratorActivity([]);
    setAgentPanelOpen(true);
    const claimEvidenceRefs =
      selectedClaim?.evidence.map((item) => item.locator) ?? [];
    const actionEvidenceRefs =
      selectedAction?.evidence.map((item) => item.locator) ?? [];
    const diffReview = await codexDiffReview(activeRunId, runStage, runEvents);
    orchestrator.setState({
      mode,
      dataBoundary: dataBoundary.value,
      correlationId,
      selectedSessionId: session?.id ?? null,
      selectedClaimId: selectedClaim?.id ?? null,
      selectedActionId: selectedAction?.id ?? null,
      selectedClaimEvidenceRefs: claimEvidenceRefs,
      selectedActionEvidenceRefs: actionEvidenceRefs,
      sourceEvidenceRefs: Array.from(
        new Set([...claimEvidenceRefs, ...actionEvidenceRefs]),
      ),
      activeRunId: activeRunId || null,
      codexDiffReview: diffReview,
    });
    orchestrator.addMessage({
      id: `operator-command-${runId}`,
      role: "user",
      content: prompt,
    });
    void orchestrator.runAgent(
      { runId },
      {
        onEvent: ({ event }) => {
          const activity = agentEventToRunEvent(event, runId);
          if (activity) {
            setOrchestratorActivity((current) => {
              const existing = current.findIndex(
                (item) => item.id === activity.id,
              );
              if (existing < 0) return [...current, activity];
              const next = [...current];
              const previous = next[existing];
              next[existing] =
                activity.type === "message" && previous?.detail
                  ? {
                      ...activity,
                      detail:
                        `${previous.detail}${activity.detail ?? ""}`.slice(
                          0,
                          2_000,
                        ),
                    }
                  : activity;
              return next;
            });
          }
          if (event.type === EventType.TEXT_MESSAGE_CONTENT) {
            setAgentReply((current) =>
              `${current}${String(record(event).delta ?? "")}`.slice(0, 2_000),
            );
          } else if (event.type === EventType.RUN_ERROR) {
            setAgentReply(
              "Orchestrator 暫時無法完成回應；主工作流程與既有證據保持可檢視。",
            );
          }
        },
      },
    );
  };

  const recordObservation = (
    event:
      | "run.plan.completed"
      | "run.validation.completed"
      | "run.validation.incomplete"
      | "run.failed",
    subject: string,
  ) => {
    if (mode !== "local") return;
    void mutation({ type: "audit.observation", event, subject }).then(() =>
      refreshTrust(),
    );
  };

  const liveSubscriber = (
    runId: string,
    phase: "plan" | "write",
  ): AgentSubscriber => ({
    onEvent: ({ event }) => {
      const mapped = agentEventToRunEvent(event, runId);
      const item =
        mapped && phase === "plan" && mapped.type === "message"
          ? { ...mapped, type: "plan" as const, title: "Codex 唯讀計畫" }
          : mapped;
      if (item) {
        setRunEvents((current) => {
          const existing = current.findIndex((entry) => entry.id === item.id);
          if (existing < 0) return [...current, item];
          const next = [...current];
          const previous = next[existing];
          next[existing] =
            ["message", "plan"].includes(item.type) && previous?.detail
              ? {
                  ...item,
                  detail: `${previous.detail}${item.detail ?? ""}`.slice(
                    0,
                    2_000,
                  ),
                }
              : item;
          return next;
        });
        if (item.type === "diff" && item.status !== "failed")
          liveChecks.current.diff = true;
        if (item.type === "test") {
          liveChecks.current = {
            ...liveChecks.current,
            ...aggregateValidationEvidence(liveChecks.current, item.status),
          };
        }
      }
      if (event.type === EventType.RUN_ERROR) {
        setRunStage("failed");
        setNotice("Codex runtime 回報可復原錯誤；工作樹與既有證據維持可檢視。");
        recordObservation("run.failed", runId);
      }
      if (event.type !== EventType.RUN_FINISHED) return;
      if (record(record(event).outcome).type === "interrupt") {
        setRunStage("approval");
        setNotice("Codex 已暫停在具名命令或檔案核准點；請檢視範圍後決定。");
        return;
      }
      if (phase === "plan") {
        if (!selectedAction || !session) {
          setRunStage("failed");
          setNotice(
            "AURA 來源內容已變更；Codex 寫入 gate 維持關閉，請重新選擇行動。",
          );
          return;
        }
        setNotice("真實唯讀計畫已完成；正在建立不含寫入的具名核准要求。");
        recordObservation("run.plan.completed", runId);
        addAudit("run.plan.completed", runId, "Codex Engineer");
        startLiveRun(selectedAction, "write");
        return;
      }
      if (
        liveChecks.current.diff &&
        liveChecks.current.validation &&
        !liveChecks.current.validationFailed
      ) {
        setRunStage("completed");
        setNotice("真實 diff 與驗證皆已通過；evidence export gate 已開啟。");
        recordObservation("run.validation.completed", runId);
        addAudit("run.validated", runId, "Codex Engineer");
      } else {
        setRunStage("failed");
        setNotice(
          "Codex turn 已完成；diff 或驗證證據仍待補齊，finding 維持開放。",
        );
        recordObservation("run.validation.incomplete", runId);
        addAudit("run.validation_incomplete", runId, "Codex Engineer");
      }
    },
  });

  const startLiveRun = (action: Action, phase: "plan" | "write") => {
    if (!session) {
      setNotice("AURA 會議資料尚未載入；Codex 委派維持關閉。");
      return;
    }
    const runId = crypto.randomUUID();
    setActiveRunId(runId);
    liveChecks.current = {
      diff: false,
      validation: false,
      validationFailed: false,
    };
    setRunEvents((current) => (phase === "plan" ? [] : current));
    if (phase === "plan") setLastExport(null);
    setRunStage("running");
    setWriteActivated(false);
    agent.setState({
      mode: "local",
      dataBoundary: dataBoundary.value,
      selectedSessionId: session.id,
      selectedActionId: action.id,
      sourceEvidenceRefs: action.evidence.map((item) => item.locator),
      correlationId,
      codexMode: phase === "write" ? "write" : "read-only",
    });
    agent.addMessage({
      id: `operator-${runId}`,
      role: "user",
      content:
        phase === "plan"
          ? `針對已確認行動「${action.title}」建立唯讀工程計畫。只檢視 repository，不變更檔案；列出實作、測試、風險與驗收步驟。`
          : `在隔離工作樹完成已確認行動「${action.title}」。依驗收條件實作、執行相關測試、保留 diff；網路、push、merge 與 deploy 維持關閉。`,
    });
    void agent.runAgent({ runId }, liveSubscriber(runId, phase)).catch(() => {
      setRunStage("failed");
      setNotice("Codex stream 暫時中斷；目前事件與工作樹狀態已保留。");
    });
  };

  const resumeLiveRun = (
    decision: "allow_once" | "allow_run_scope" | "deny",
  ): boolean => {
    const interrupt = agent.pendingInterrupts[0];
    if (!interrupt || !selectedAction) return false;
    const resumeRunId = crypto.randomUUID();
    const resume: ResumeEntry = {
      interruptId: interrupt.id,
      status: "resolved",
      payload: { decision },
    };
    setActiveRunId(resumeRunId);
    setRunStage(decision === "deny" ? "stopped" : "running");
    setWriteActivated(decision !== "deny");
    void agent
      .runAgent(
        { runId: resumeRunId, resume: [resume] },
        liveSubscriber(resumeRunId, "write"),
      )
      .catch(() => {
        setRunStage("failed");
        setNotice("Codex 核准續跑暫時中斷；工作樹與事件證據保持可檢視。");
      });
    return true;
  };

  const reviewClaim = async (
    claim: Claim,
    decision: "confirmed" | "edited" | "rejected",
    text?: string,
  ) => {
    setSelectedClaimId(claim.id);
    if (!session) {
      setNotice("AURA 會議資料尚未載入；覆核功能維持關閉。");
      return;
    }
    if (claim.status === "unsupported" && decision === "confirmed") {
      setNotice("這項主張需先加入來源證據，確認路徑維持關閉。");
      return;
    }
    if (
      !(await mutation({
        type: "claim.review",
        sessionId: session.id,
        claimId: claim.id,
        decision,
        text,
      }))
    )
      return;
    if (mode === "local") {
      try {
        const summary = sessionSummaries.find(
          (item) => item.session_id === session.id,
        );
        if (!summary) throw new Error("selected session summary unavailable");
        const [loaded, summaries] = await Promise.all([
          loadLocalSession(summary),
          loadLocalSessionList(),
        ]);
        setSession(loaded);
        setClaims(loaded.claims);
        setSelectedClaimId(claim.id);
        setSelectedActionId(loaded.actions[0]?.id ?? "");
        setSessionSummaries(summaries);
        setSessionLoadState("ready");
      } catch {
        setNotice("覆核已寫入 AURA；最新 action register 重新載入中。");
        return;
      }
    } else {
      const nextClaim = (item: Claim): Claim =>
        item.id === claim.id
          ? { ...item, status: decision, text: text?.trim() || item.text }
          : item;
      const linkedActionId =
        demoClaimActionLinks[claim.id as keyof typeof demoClaimActionLinks] ??
        null;
      const linkedAction = session.actions.find(
        (action) => action.id === linkedActionId,
      );
      const linkedActionWasEligible = linkedAction
        ? canDelegate(linkedAction)
        : false;
      const linkedActionWillBeEligible = Boolean(
        linkedActionId && decision === "confirmed",
      );
      setClaims((current) => current.map(nextClaim));
      setSession((current) =>
        current
          ? {
              ...current,
              claims: current.claims.map(nextClaim),
              actions: current.actions.map((action) =>
                linkedActionId === action.id
                  ? {
                      ...action,
                      status:
                        decision === "confirmed" ? "confirmed" : "proposed",
                    }
                  : action,
              ),
            }
          : current,
      );
      setSessionSummaries((current) =>
        current.map((summary) =>
          summary.session_id === demoSession.id
            ? {
                ...summary,
                reviewed_count: Math.min(
                  demoSession.claims.length,
                  summary.reviewed_count + (claim.status === "pending" ? 1 : 0),
                ),
                unreviewed_count: Math.max(
                  0,
                  summary.unreviewed_count -
                    (claim.status === "pending" ? 1 : 0),
                ),
                confirmed_action_count:
                  summary.confirmed_action_count +
                  (linkedActionWillBeEligible && !linkedActionWasEligible
                    ? 1
                    : 0) -
                  (!linkedActionWillBeEligible && linkedActionWasEligible
                    ? 1
                    : 0),
              }
            : summary,
        ),
      );
    }
    setEditingClaim(null);
    setNotice(`已記錄「${claim.text}」的${statusLabel(decision)}決定。`);
    addAudit(`claim.${decision}`, claim.id);
  };

  const delegate = (action: Action) => {
    if (
      mode === "local" &&
      (sessionLoadState !== "ready" ||
        !session ||
        !services.aura.ready ||
        !session.actions.some((candidate) => candidate.id === action.id))
    ) {
      setRunEvents([]);
      setNotice("AURA 會議資料尚未載入或已失效；Codex 委派維持關閉。");
      return;
    }
    if (!canDelegate(action)) {
      setNotice("委派需具備已確認狀態、完整來源證據與 supported 判定。");
      return;
    }
    if (!agentReady) {
      setNotice("CopilotKit agent 正在同步；已確認行動保持待啟動狀態。");
      return;
    }
    if (mode === "local" && !services.codex.ready) {
      setRunEvents([]);
      setNotice("Codex Bridge 尚未就緒；已確認行動保持待啟動狀態。");
      return;
    }
    setSelectedActionId(action.id);
    setActiveRunActionId(action.id);
    setRunStage("approval");
    setWriteActivated(false);
    setForceTestFailure(false);
    setApprovalRecord(null);
    runTimers.current.forEach(window.clearTimeout);
    runTimers.current = [];
    setScreen("runs");
    addAudit("action.delegated", action.id);
    if (mode === "local") {
      void mutation({
        type: "audit.operator",
        event: "action.delegated",
        subject: action.id,
      }).then(() => refreshTrust());
      setNotice("正在啟動真實唯讀計畫；repository 寫入與網路權限維持關閉。");
      startLiveRun(action, "plan");
      return;
    }
    const demoExecutionId = `${demoRun.id}-${crypto.randomUUID()}`;
    setActiveRunId(demoExecutionId);
    setRunEvents(
      demoRun.events.map((event) => ({ ...event, runId: demoExecutionId })),
    );
    setNotice("唯讀計畫已完成；工作區寫入等待明確核准。");
    agent.addMessage({
      id: `operator-${demoExecutionId}`,
      role: "user",
      content: `依已確認行動 ${action.id} 建立唯讀工程計畫。`,
    });
    void agent.runAgent({ runId: demoExecutionId }).then(
      () =>
        setNotice("CopilotKit agent event stream 已完成；寫入仍等待明確核准。"),
      () =>
        setNotice("Agent stream 暫時中斷；固定核准節點與唯讀狀態保持可復原。"),
    );
  };

  const approveRun = async (decision: ApprovalDecision) => {
    if (mode === "local") {
      if (
        !(await mutation({
          type: "audit.operator",
          event: `approval.${decision}`,
          subject: activeRunId,
        }))
      )
        return;
      setApprovalRecord({
        decision,
        actor: "Operator",
        at: new Date().toISOString(),
      });
      addAudit(`approval.${decision}`, activeRunId);
      if (resumeLiveRun(decision)) {
        setNotice(
          decision === "deny"
            ? "具名 Codex 要求已拒絕；工作樹保留供檢視。"
            : "具名 Codex 要求已核准；事件串流繼續，網路仍關閉。",
        );
        return;
      }
      if (decision === "deny") {
        setRunStage("stopped");
        setWriteActivated(false);
        setNotice("具名核准要求尚未同步；primary checkout 保持未變更。");
        return;
      }
      setRunStage("approval");
      setWriteActivated(false);
      setNotice("具名核准要求尚未同步；請保留目前頁面後重試。");
      return;
    }
    if (
      !(await mutation({
        type: "run.approval",
        runId: activeRunId,
        approvalId: "approval-demo-001",
        decision,
      }))
    )
      return;
    setApprovalRecord({
      decision,
      actor: "Operator",
      at: new Date().toISOString(),
    });
    addAudit(`approval.${decision}`, activeRunId);
    if (decision === "deny") {
      setRunStage("stopped");
      setWriteActivated(false);
      setNotice("核准已拒絕；工作樹保持未變更。");
      return;
    }
    setRunStage("running");
    setWriteActivated(true);
    setNotice("已核准隔離工作樹內的明確範圍；網路權限維持關閉。");
    const events: RunEvent[] = [
      {
        id: "evt-003",
        runId: activeRunId,
        type: "command",
        status: "passed",
        occurredAt: "2026-07-24T06:01:12.000Z",
        title: "建立隔離工作樹",
        detail: `demo://worktrees/${activeRunId}`,
      },
      {
        id: "evt-004",
        runId: activeRunId,
        type: "file_change",
        status: "passed",
        occurredAt: "2026-07-24T06:01:14.000Z",
        title: "套用有界佇列變更",
        detail: "1 file changed, 1 insertion, 1 deletion",
      },
      forceTestFailure
        ? {
            id: "evt-005",
            runId: activeRunId,
            type: "test",
            status: "failed",
            occurredAt: "2026-07-24T06:01:18.000Z",
            title: "驗證發現失敗",
            detail:
              "1 test failed；finding 維持 open，證據匯出 gate 保持關閉。",
          }
        : {
            id: "evt-005",
            runId: activeRunId,
            type: "test",
            status: "passed",
            occurredAt: "2026-07-24T06:01:18.000Z",
            title: "驗證完成",
            detail: "12 tests passed；git diff --check passed",
          },
      forceTestFailure
        ? {
            id: "evt-006",
            runId: activeRunId,
            type: "error",
            status: "failed",
            occurredAt: "2026-07-24T06:01:19.000Z",
            title: "Run 等待修正與重新驗證",
            detail: "工作樹與 diff 保留供 operator 檢視。",
          }
        : {
            id: "evt-006",
            runId: activeRunId,
            type: "completed",
            status: "completed",
            occurredAt: "2026-07-24T06:01:19.000Z",
            title: "Run 已完成",
            detail: "Trusted diff 與驗證證據可供匯出。",
          },
    ];
    events.forEach((event, index) => {
      const timer = window.setTimeout(
        () => {
          setRunEvents((current) => [...current, event]);
          if (event.id === "evt-006" && forceTestFailure) {
            setRunStage("failed");
            setNotice(
              "測試失敗；finding 與 evidence export gate 維持開放，等待修正後重跑。",
            );
            addAudit("run.validation_failed", activeRunId, "Demo Agent");
          } else if (event.type === "completed") {
            setRunStage("completed");
            setNotice(
              "變更與驗證完成；R-002 維持開放，等待完整且同一 run 綁定的 closure evidence。",
            );
            addAudit("run.validated", activeRunId, "Demo Agent");
          }
        },
        500 * (index + 1),
      );
      runTimers.current.push(timer);
    });
  };

  const stopRun = async () => {
    const runId = activeRunId;
    if (!(await mutation({ type: "run.stop", runId }))) return;
    if (mode === "local") agent.abortRun();
    runTimers.current.forEach(window.clearTimeout);
    runTimers.current = [];
    setRunStage("stopped");
    setRunEvents((current) => [
      ...current,
      {
        id: `evt-${String(current.length + 1).padStart(3, "0")}`,
        runId,
        type: "completed",
        status: "stopped",
        occurredAt: new Date().toISOString(),
        title: "Operator 已停止 run",
      },
    ]);
    addAudit("run.stopped", runId);
    setNotice("停止要求已記錄；目前事件串流已關閉。");
  };

  const exportEvidence = async () => {
    if (!session || !selectedAction) {
      setNotice("請先載入 AURA 會議並選擇具備來源證據的行動。");
      return;
    }
    const response = await mutation({
      type: "evidence.export",
      correlationId,
      ...(mode === "local" ? { runId: activeRunId } : {}),
    });
    if (!response) return;
    if (mode === "local") {
      const manifest = (await response.json()) as LocalExport;
      const source = JSON.stringify(
        {
          schema: "voiss.codex.export-manifest.v1",
          classification: "live_codex_evidence",
          correlationId,
          runId: activeRunId,
          sourceSessionId: session.id,
          sourceAction: {
            id: selectedAction.id,
            title: selectedAction.title,
            owner: selectedAction.owner,
            evidence: selectedAction.evidence,
          },
          sourceEvidenceRefs: selectedAction.evidence.map(
            (item) => item.locator,
          ),
          ...manifest,
        },
        null,
        2,
      );
      const blob = new Blob([source], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${manifest.exportId}-manifest.json`;
      anchor.click();
      URL.revokeObjectURL(url);
      setLastExport(manifest);
      addAudit("evidence.exported", activeRunId);
      setNotice(
        `真實 patch 與證據封包已由 Bridge 匯出；manifest 已下載，三項實際 artifact 已開放下載。`,
      );
      return;
    }
    const evidence = {
      schema: "voiss.aura.evidence-packet.v1",
      mode,
      generatedAt: new Date().toISOString(),
      sourceSession: session.id,
      correlationId,
      action: selectedAction,
      claims,
      run: { ...demoRun, id: activeRunId, status: runStage, events: runEvents },
      controls: demoControls,
      findings: demoFindings,
      audit,
      expectedDemoPatch: demoExpectedPatch,
      expectedDemoTests: demoExpectedTests,
      classification: "deterministic_demo_evidence",
    };
    const source = JSON.stringify(evidence, null, 2);
    const digest = Array.from(
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source)),
      ),
    )
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    const blob = new Blob(
      [JSON.stringify({ ...evidence, sha256: digest }, null, 2)],
      {
        type: "application/json",
      },
    );
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${correlationId}-evidence.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    addAudit("evidence.exported", correlationId);
    setNotice(`證據封包已匯出；SHA-256 ${digest.slice(0, 12)}…`);
  };

  const resetDemoFixture = () => {
    if (mode !== "demo") return;
    agent.abortRun();
    runTimers.current.forEach(window.clearTimeout);
    runTimers.current = [];
    liveChecks.current = {
      diff: false,
      validation: false,
      validationFailed: false,
    };
    try {
      for (const key of Object.keys(window.localStorage)) {
        if (key.startsWith("voiss.control-room."))
          window.localStorage.removeItem(key);
      }
    } catch {
      // The in-memory fixture reset remains complete without browser storage.
    }
    setScreen("control");
    setSessionSummaries([demoSessionSummary]);
    setSessionLoadState("ready");
    setSelectedSessionId(demoSession.id);
    setSession(demoSession);
    setClaims(demoSession.claims);
    setSelectedActionId(demoSession.actions[0].id);
    setSelectedClaimId(
      demoSession.claims.find((claim) => claim.status === "pending")?.id ?? "",
    );
    setActiveRunId("");
    setActiveRunActionId("");
    setRunStage("idle");
    setWriteActivated(false);
    setForceTestFailure(false);
    setRunEvents([]);
    setApprovalRecord(null);
    setLastExport(null);
    setAudit(initialAudit);
    setTrustAssets(demoAssets);
    setTrustControls(demoControls);
    setTrustFindings(demoFindings);
    setPromptDraft("");
    setAgentReply("");
    setOrchestratorActivity([]);
    setAgentPanelOpen(false);
    setEditingClaim(null);
    setEditText("");
    setSearch("");
    setNotice("Deterministic fixture 已重設；所有狀態回到受控起點。");
  };

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        跳到主要內容
      </a>
      <aside className="sidebar" aria-label="主要導覽">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            VA
          </span>
          <div>
            <strong>VOISS AURA</strong>
            <small>Control Room</small>
          </div>
        </div>
        <nav>
          {navigation.map((item) => (
            <button
              className={screen === item.id ? "nav-item active" : "nav-item"}
              key={item.id}
              onClick={() => setScreen(item.id)}
              aria-current={screen === item.id ? "page" : undefined}
            >
              <span aria-hidden="true">{item.icon}</span>
              {item.label}
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">
          <span className={`mode-badge ${mode}`}>
            {mode === "demo" ? "DEMO MODE" : "LOCAL MODE"}
          </span>
          <small>
            {mode === "demo"
              ? "合成資料・腳本事件"
              : "本機 artifacts・真實 runtime"}
          </small>
        </div>
      </aside>

      <header className="topbar">
        <div className="context">
          <span className="eyebrow">ACTIVE CONTEXT</span>
          <strong>Project AURA</strong>
          <span className="separator" aria-hidden="true">
            /
          </span>
          <span>{selectedAction?.title ?? "等待 AURA 來源"}</span>
        </div>
        <div className="health" aria-label="服務狀態">
          <span className={`mode-badge ${mode}`}>{mode.toUpperCase()}</span>
          <span
            className={`context-chip data-boundary ${dataBoundary.value}`}
            aria-label={`資料邊界：${dataBoundary.label}`}
            title={dataBoundary.detail}
          >
            {dataBoundary.label}
          </span>
          <span className="context-chip">
            {services.codex.model ?? "model 待服務回報"} ·{" "}
            {services.codex.effort ?? "effort 待服務回報"}
          </span>
          <span className="context-chip">
            {services.codex.sandbox ?? "sandbox 待服務回報"} ·{" "}
            {services.codex.network === undefined
              ? "network 待服務回報"
              : services.codex.network
                ? "network on"
                : "network off"}
          </span>
          <span className="context-chip">{activeRunLabel}</span>
          <span
            className={`context-chip ${agent.pendingInterrupts.length ? "attention" : ""}`}
          >
            {agent.pendingInterrupts.length} approvals
          </span>
          <ServiceDot
            label="AURA"
            state={services.aura.label}
            ready={services.aura.ready}
          />
          <ServiceDot
            label="Codex"
            state={services.codex.label}
            ready={services.codex.ready}
          />
          <button
            className="icon-button"
            disabled={!session || !selectedAction}
            onClick={() => void exportEvidence()}
            aria-label="匯出證據封包"
            title="匯出證據封包"
          >
            ⇩
          </button>
        </div>
      </header>

      <main id="main-content">
        <div className="notice" role="status">
          <span aria-hidden="true">●</span>
          {notice}
        </div>
        {screen === "control" && (
          <ControlScreen
            session={session}
            controls={trustControls}
            findings={trustFindings}
            auditCount={audit.length}
            sessionCount={sessionSummaries.length}
            pendingApprovals={agent.pendingInterrupts.length}
            delegationReady={delegationReady}
            onOpen={setScreen}
            onDelegate={delegate}
            onPrompt={askOrchestrator}
          />
        )}
        {screen === "sessions" && (
          <SessionsScreen
            session={session}
            summaries={sessionSummaries}
            selectedSessionId={selectedSessionId}
            loadState={sessionLoadState}
            claims={claims}
            editingClaim={editingClaim}
            editText={editText}
            search={search}
            setSearch={setSearch}
            onSelectSession={(id) => void selectSession(id)}
            setEditingClaim={(claim) => {
              setEditingClaim(claim?.id ?? null);
              if (claim) setSelectedClaimId(claim.id);
              setEditText(claim?.text ?? "");
            }}
            onSelectClaim={setSelectedClaimId}
            setEditText={setEditText}
            reviewClaim={reviewClaim}
            onNotice={setNotice}
          />
        )}
        {screen === "actions" && (
          <ActionsScreen
            session={session}
            claims={claims}
            actions={session?.actions ?? []}
            selectedId={selectedActionId}
            activeRunId={activeRunId}
            activeRunActionId={activeRunActionId}
            runStage={runStage}
            delegationReady={delegationReady}
            onSelect={setSelectedActionId}
            onDelegate={delegate}
          />
        )}
        {screen === "runs" && (
          <RunsScreen
            action={activeRunAction}
            session={session}
            services={services}
            activeRunId={activeRunId}
            approvalRecord={approvalRecord}
            correlationId={correlationId}
            mode={mode}
            events={runEvents}
            stage={runStage}
            writeActivated={writeActivated}
            forceTestFailure={forceTestFailure}
            lastExport={lastExport}
            setForceTestFailure={setForceTestFailure}
            onApprove={approveRun}
            onStop={stopRun}
            onExport={exportEvidence}
          />
        )}
        {screen === "trust" && (
          <TrustScreen
            assets={trustAssets}
            controls={trustControls}
            findings={trustFindings}
            audit={audit}
            correlationId={correlationId}
            onDraftRemediation={(finding) =>
              void askOrchestrator(
                `針對 ${finding.id}「${finding.title}」草擬唯讀 remediation checklist；引用目前 control 與 evidence，所有變更仍需另行核准。`,
              )
            }
            onRefresh={() => void refreshTrust()}
          />
        )}
        {screen === "settings" && (
          <SettingsScreen
            mode={mode}
            services={services}
            dataBoundary={dataBoundary}
            onResetDemo={resetDemoFixture}
          />
        )}
        <section className="command-dock" aria-label="Global command bar">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              askOrchestrator();
            }}
          >
            <label className="sr-only" htmlFor="global-command">
              向 VOISS Orchestrator 詢問
            </label>
            <input
              id="global-command"
              value={promptDraft}
              onChange={(event) => setPromptDraft(event.target.value)}
              placeholder="詢問 readiness、證據、run 或 finding；所有 consequential actions 仍由可信任卡片核准"
            />
            <span
              className={`approval-summary ${agent.pendingInterrupts.length ? "attention" : ""}`}
            >
              {agent.pendingInterrupts.length
                ? `${agent.pendingInterrupts.length} 項待核准`
                : "目前無待核准項目"}
            </span>
            <button className="primary-button" type="submit">
              詢問
            </button>
            <button
              className="secondary-button"
              type="button"
              onClick={() => setAgentPanelOpen((open) => !open)}
            >
              {agentPanelOpen ? "收合 Agent" : "開啟 Agent"}
            </button>
          </form>
        </section>
        {agentPanelOpen && (
          <aside className="agent-panel" aria-label="VOISS Agent panel">
            <div className="panel-heading">
              <div>
                <span className="eyebrow">COPILOTKIT AGENT</span>
                <h2>VOISS Orchestrator</h2>
              </div>
              <button
                className="text-button"
                onClick={() => setAgentPanelOpen(false)}
              >
                收合
              </button>
            </div>
            <p>
              {agentReply ||
                "選擇建議或輸入問題；Agent 會提供受控路徑，實際變更仍經 evidence 與 approval gates。"}
            </p>
            {orchestratorActivity.length > 0 && (
              <section
                className="panel"
                aria-labelledby="orchestrator-activity-heading"
              >
                <div className="panel-heading">
                  <h3 id="orchestrator-activity-heading">
                    Trusted agent activity
                  </h3>
                  <span className="section-note">
                    {orchestratorActivity.length} events
                  </span>
                </div>
                <ol className="timeline">
                  {orchestratorActivity.map((event) => (
                    <li key={event.id}>
                      <span
                        className={`timeline-dot ${tone(event.status)}`}
                        aria-hidden="true"
                      />
                      <div>
                        <div className="row-meta">
                          <span>{event.type.toUpperCase()}</span>
                          <span className={`status ${tone(event.status)}`}>
                            {statusLabel(event.status)}
                          </span>
                        </div>
                        <strong>{event.title}</strong>
                        {event.detail && <p>{event.detail}</p>}
                      </div>
                    </li>
                  ))}
                </ol>
              </section>
            )}
            <div className="source-box">
              <strong>Current evidence context</strong>
              <code>{session?.id ?? "AURA session 尚未載入"}</code>
              <code>{selectedClaim?.id ?? "AURA claim 尚未選擇"}</code>
              <code>{selectedAction?.id ?? "AURA action 尚未選擇"}</code>
              {Array.from(
                new Set([
                  ...(selectedClaim?.evidence.map((item) => item.locator) ??
                    []),
                  ...(selectedAction?.evidence.map((item) => item.locator) ??
                    []),
                ]),
              ).map((locator) => (
                <code key={locator}>{locator}</code>
              ))}
            </div>
          </aside>
        )}
      </main>
    </div>
  );
}

function ServiceDot({
  label,
  state,
  ready,
}: {
  label: string;
  state: string;
  ready: boolean;
}) {
  return (
    <div className="service-dot">
      <span className={ready ? "ready" : "attention"} aria-hidden="true" />
      <div>
        <strong>{label}</strong>
        <small>{state}</small>
      </div>
    </div>
  );
}

function ControlScreen({
  session,
  controls,
  findings,
  auditCount,
  sessionCount,
  pendingApprovals,
  delegationReady,
  onOpen,
  onDelegate,
  onPrompt,
}: {
  session: MeetingSession | null;
  controls: TrustControl[];
  findings: Finding[];
  auditCount: number;
  sessionCount: number;
  pendingApprovals: number;
  delegationReady: boolean;
  onOpen: (screen: Screen) => void;
  onDelegate: (action: Action) => void;
  onPrompt: (prompt: string) => void;
}) {
  const actions = session?.actions ?? [];
  const claims = session?.claims ?? [];
  const readyActions = actions.filter(canDelegate);
  const primaryAction =
    actions.find((action) => action.id === demoRun.actionId) ??
    readyActions[0] ??
    null;
  const passingControls = controls.filter(
    (control) => control.state === "pass",
  ).length;
  const openFindings = findings.filter(
    (finding) => finding.state === "open",
  ).length;
  return (
    <div className="screen">
      <section className="hero">
        <div>
          <span className="eyebrow">EVIDENCE → EXECUTION</span>
          <h1>把會議證據，安全轉成可驗證的工程變更。</h1>
          <p>
            從來源片段與人員覆核開始，透過唯讀計畫、明確核准、隔離工作樹與驗證證據完成閉環。
          </p>
        </div>
        <dl className="hero-metrics">
          <div>
            <dt>待覆核主張</dt>
            <dd>
              {claims.filter((claim) => claim.status === "pending").length}
            </dd>
          </div>
          <div>
            <dt>已確認行動</dt>
            <dd>{readyActions.length}</dd>
          </div>
          <div>
            <dt>待核准</dt>
            <dd>{pendingApprovals}</dd>
          </div>
          <div>
            <dt>開放 findings</dt>
            <dd>{openFindings}</dd>
          </div>
        </dl>
      </section>

      <section aria-labelledby="workflow-heading">
        <div className="section-heading">
          <div>
            <span className="eyebrow">PRIMARY WORKFLOWS</span>
            <h2 id="workflow-heading">今日控制台</h2>
          </div>
          <span className="section-note">固定流程・所有變更需留證</span>
        </div>
        <div className="workflow-grid">
          <WorkflowTile
            index="01"
            title="Runtime readiness"
            detail="確認 AURA、Codex 與 repository 的本機啟用狀態。"
            meta={`${passingControls} / ${controls.length} controls pass`}
            onClick={() => onOpen("trust")}
          />
          <WorkflowTile
            index="02"
            title="Evidence review"
            detail="逐段檢視 transcript、audio span、claim 與來源狀態。"
            meta={`${claims.length} claims・${claims.filter((claim) => claim.status === "unsupported").length} blocked`}
            onClick={() => onOpen("sessions")}
          />
          <WorkflowTile
            index="03"
            title="Codex delegation"
            detail="將已確認行動送入唯讀計畫，再核准隔離工作樹。"
            meta={`${readyActions.length} actions ready`}
            onClick={() =>
              primaryAction && canDelegate(primaryAction) && delegationReady
                ? onDelegate(primaryAction)
                : onOpen("actions")
            }
          />
          <WorkflowTile
            index="04"
            title="Trust closure"
            detail="用 diff、tests、controls 與 audit 完成可追溯結案。"
            meta={`${openFindings} findings open`}
            onClick={() => onOpen("trust")}
          />
        </div>
      </section>

      <section className="context-strip" aria-label="目前工作摘要">
        <div>
          <span>Current session</span>
          <strong>{session?.title ?? "等待 AURA 載入"}</strong>
        </div>
        <div>
          <span>Recent sessions</span>
          <strong>{sessionCount} available</strong>
        </div>
        <div>
          <span>Actions due soon</span>
          <strong>
            {actions.filter((action) => Boolean(action.dueDate)).length}
          </strong>
        </div>
        <div>
          <span>Recent audit events</span>
          <strong>{auditCount}</strong>
        </div>
      </section>

      <section aria-labelledby="prompt-suggestions-heading">
        <div className="section-heading">
          <div>
            <span className="eyebrow">AGENT SHORTCUTS</span>
            <h2 id="prompt-suggestions-heading">Prompt suggestions</h2>
          </div>
          <span className="section-note">
            先產生可檢視路徑，再由 trusted UI 啟動動作
          </span>
        </div>
        <div className="prompt-suggestions">
          {promptSuggestions.map((prompt) => (
            <button key={prompt} onClick={() => onPrompt(prompt)}>
              {prompt}
            </button>
          ))}
        </div>
      </section>

      <div className="control-columns">
        <section className="panel" aria-labelledby="queue-heading">
          <div className="panel-heading">
            <h2 id="queue-heading">可執行行動</h2>
            <button className="text-button" onClick={() => onOpen("actions")}>
              查看全部 →
            </button>
          </div>
          <div className="action-list">
            {!actions.length && (
              <p>目前沒有可委派的 AURA 行動；載入並覆核來源後即可啟動。</p>
            )}
            {actions.map((action) => (
              <article className="action-row" key={action.id}>
                <div>
                  <div className="row-meta">
                    <span className={`status ${tone(action.status)}`}>
                      {statusLabel(action.status)}
                    </span>
                    <span>{action.owner}</span>
                    <span>{action.evidence.length} 份來源</span>
                  </div>
                  <h3>{action.title}</h3>
                </div>
                <button
                  className="compact-button"
                  disabled={!canDelegate(action) || !delegationReady}
                  onClick={() => onDelegate(action)}
                >
                  委派
                </button>
              </article>
            ))}
          </div>
        </section>
        <section
          className="panel readiness"
          aria-labelledby="readiness-heading"
        >
          <div className="panel-heading">
            <h2 id="readiness-heading">信任摘要</h2>
            <span className="score">
              {String(passingControls).padStart(2, "0")} /{" "}
              {String(controls.length).padStart(2, "0")}
            </span>
          </div>
          {controls.map((control) => (
            <div className="control-row" key={control.id}>
              <span
                className={`control-indicator ${control.state}`}
                aria-hidden="true"
              />
              <div>
                <strong>{control.id}</strong>
                <span>{control.title}</span>
              </div>
              <span className={`status ${tone(control.state)}`}>
                {control.state.toUpperCase()}
              </span>
            </div>
          ))}
        </section>
      </div>
    </div>
  );
}

function WorkflowTile({
  index,
  title,
  detail,
  meta,
  onClick,
}: {
  index: string;
  title: string;
  detail: string;
  meta: string;
  onClick: () => void;
}) {
  return (
    <button className="workflow-tile" onClick={onClick}>
      <span className="tile-index">{index}</span>
      <h3>{title}</h3>
      <p>{detail}</p>
      <span className="tile-meta">
        {meta}
        <b aria-hidden="true">↗</b>
      </span>
    </button>
  );
}

function SessionsScreen({
  session,
  summaries,
  selectedSessionId,
  loadState,
  claims,
  editingClaim,
  editText,
  search,
  setSearch,
  onSelectSession,
  setEditingClaim,
  onSelectClaim,
  setEditText,
  reviewClaim,
  onNotice,
}: {
  session: MeetingSession | null;
  summaries: AuraSessionSummary[];
  selectedSessionId: string;
  loadState: SessionLoadState;
  claims: Claim[];
  editingClaim: string | null;
  editText: string;
  search: string;
  setSearch: (value: string) => void;
  onSelectSession: (id: string) => void;
  setEditingClaim: (claim: Claim | null) => void;
  onSelectClaim: (id: string) => void;
  setEditText: (value: string) => void;
  reviewClaim: (
    claim: Claim,
    decision: "confirmed" | "edited" | "rejected",
    text?: string,
  ) => void;
  onNotice: (notice: string) => void;
}) {
  const [activeSegment, setActiveSegment] = useState("");
  const [speakerFilter, setSpeakerFilter] = useState("all");
  const [stateFilter, setStateFilter] = useState("all");
  const [playRequested, setPlayRequested] = useState(false);
  const audioRef = useRef<HTMLAudioElement>(null);
  const segments = useMemo(() => session?.segments ?? [], [session?.segments]);
  const speakers = useMemo(
    () =>
      Array.from(new Set(segments.map((segment) => segment.speaker))).sort(),
    [segments],
  );
  const states = useMemo(
    () => Array.from(new Set(segments.map((segment) => segment.status))).sort(),
    [segments],
  );
  const filteredSegments = useMemo(() => {
    const term = search.trim().toLocaleLowerCase("zh-Hant-TW");
    return segments.filter(
      (segment) =>
        (!term ||
          `${segment.speaker} ${segment.text}`
            .toLocaleLowerCase("zh-Hant-TW")
            .includes(term)) &&
        (speakerFilter === "all" || segment.speaker === speakerFilter) &&
        (stateFilter === "all" || segment.status === stateFilter),
    );
  }, [search, segments, speakerFilter, stateFilter]);
  const selectedSegment =
    segments.find((segment) => segment.id === activeSegment) ??
    segments[0] ??
    null;
  const audioUrl =
    session && selectedSegment
      ? session.id === demoSession.id
        ? `${session.audioUrl}#t=${selectedSegment.startMs / 1000},${selectedSegment.endMs / 1000}`
        : `/api/aura-audio?meeting_id=${encodeURIComponent(session.id)}&start_ms=${selectedSegment.startMs}&end_ms=${selectedSegment.endMs}`
      : undefined;

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const firstSegment = segments[0]?.id ?? "";
      try {
        const savedSegment = window.localStorage.getItem(
          "voiss.control-room.segment",
        );
        const savedSpeaker = window.localStorage.getItem(
          "voiss.control-room.speaker-filter",
        );
        const savedState = window.localStorage.getItem(
          "voiss.control-room.state-filter",
        );
        setActiveSegment(
          segments.some((segment) => segment.id === savedSegment)
            ? (savedSegment ?? firstSegment)
            : firstSegment,
        );
        setSpeakerFilter(
          segments.some((segment) => segment.speaker === savedSpeaker)
            ? (savedSpeaker ?? "all")
            : "all",
        );
        setStateFilter(
          segments.some((segment) => segment.status === savedState)
            ? (savedState ?? "all")
            : "all",
        );
      } catch {
        setActiveSegment(firstSegment);
        setSpeakerFilter("all");
        setStateFilter("all");
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [segments, session?.id]);

  useEffect(() => {
    if (!playRequested || !audioUrl) return;
    const audio = audioRef.current;
    if (!audio) return;
    audio.load();
    void audio
      .play()
      .catch(() =>
        onNotice("瀏覽器已保留音訊控制；請按播放鍵啟動所選來源片段。"),
      );
    setPlayRequested(false);
  }, [audioUrl, onNotice, playRequested]);

  const persistSelection = (key: string, value: string) => {
    try {
      window.localStorage.setItem(`voiss.control-room.${key}`, value);
    } catch {
      // UI selection remains available for the current browser session.
    }
  };

  const openSource = (segmentId: string, play = false) => {
    if (!segments.some((segment) => segment.id === segmentId)) {
      onNotice("這份來源目前未包含在已載入的會議片段中。");
      return;
    }
    setActiveSegment(segmentId);
    persistSelection("segment", segmentId);
    if (play) setPlayRequested(true);
  };

  const copySource = async () => {
    if (!session || !selectedSegment || !navigator.clipboard) {
      onNotice("此瀏覽器目前無法複製來源定位；畫面仍保留穩定來源參照。");
      return;
    }
    const locator = `aura://${session.id}/segments/${selectedSegment.id}`;
    try {
      await navigator.clipboard.writeText(locator);
      onNotice(`已複製來源定位：${locator}`);
    } catch {
      onNotice("來源定位複製尚未獲得瀏覽器權限；可直接選取畫面中的參照。");
    }
  };

  const nextPendingClaim = claims.find((claim) => claim.status === "pending");
  const nextPendingSegmentId = nextPendingClaim?.evidence[0]?.id;
  const freshness = (summary: AuraSessionSummary) =>
    summary.transcript_hash_state === "current"
      ? { label: "證據新鮮", tone: "positive" }
      : summary.transcript_hash_state === "stale"
        ? { label: "摘要已過期", tone: "danger" }
        : { label: "摘要待建立", tone: "warning" };
  const duration = (summary: AuraSessionSummary) => {
    const start = Date.parse(summary.started_at);
    const end = Date.parse(summary.ended_at);
    if (Number.isNaN(start) || Number.isNaN(end) || end < start)
      return "時長待 artifact 補充";
    return `${Math.max(1, Math.round((end - start) / 60_000))} 分鐘`;
  };

  const sessionRail = (
    <aside className="session-rail" aria-label="會議清單">
      <label className="search-field">
        <span className="sr-only">搜尋 transcript</span>
        <span aria-hidden="true">⌕</span>
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="搜尋內容或講者"
        />
      </label>
      {summaries.map((summary) => {
        const evidenceState = freshness(summary);
        return (
          <button
            className={
              selectedSessionId === summary.session_id
                ? "session-item active"
                : "session-item"
            }
            key={summary.session_id}
            onClick={() => onSelectSession(summary.session_id)}
            aria-pressed={selectedSessionId === summary.session_id}
          >
            <span className={`status ${evidenceState.tone}`}>
              {evidenceState.label}
            </span>
            <strong>{summary.title}</strong>
            <small>
              {new Date(summary.started_at).toLocaleDateString("zh-TW")}・
              {duration(summary)}
            </small>
            <small>
              {summary.workflow || "workflow 待補充"}・
              {summary.status || "狀態待補充"}
            </small>
            <small>
              摘要 {summary.summary_state || "待補充"}・
              {summary.local_path_available ? "本機來源可用" : "本機來源待啟用"}
            </small>
            <small>
              已覆核 {summary.reviewed_count}・待覆核 {summary.unreviewed_count}
              ・可委派 {summary.confirmed_action_count}
            </small>
          </button>
        );
      })}
    </aside>
  );

  if (!session) {
    return (
      <div className="screen">
        <PageHeading
          eyebrow="AURA EVIDENCE"
          title="會議紀錄"
          detail="逐段開啟 transcript、已驗證 audio span 與 claim 來源。"
        />
        <div className="session-layout">
          {sessionRail}
          <section
            className="transcript-panel"
            aria-labelledby="transcript-heading"
          >
            <div className="panel-heading">
              <div>
                <span className="eyebrow">SOURCE STATUS</span>
                <h2 id="transcript-heading">AURA 會議資料尚未載入</h2>
              </div>
              <span
                className={`status ${loadState === "loading" ? "warning" : "danger"}`}
              >
                {loadState === "loading" ? "載入中" : "委派關閉"}
              </span>
            </div>
            <p>
              本機畫面只採用目前 AURA Bridge 回傳的 session、claim 與
              action。Demo 是獨立啟動路徑，請以 <code>pnpm demo</code> 開啟。
            </p>
          </section>
        </div>
      </div>
    );
  }

  return (
    <div className="screen">
      <PageHeading
        eyebrow="AURA EVIDENCE"
        title="會議紀錄"
        detail="逐段開啟 transcript、已驗證 audio span 與 claim 來源。"
      />
      <div className="session-layout">
        {sessionRail}
        <section
          className="transcript-panel"
          aria-labelledby="transcript-heading"
        >
          <div className="panel-heading">
            <div>
              <span className="eyebrow">TRANSCRIPT + AUDIO</span>
              <h2 id="transcript-heading">來源片段</h2>
            </div>
            <span className="section-note">
              {filteredSegments.length} segments
            </span>
          </div>
          <div className="button-row" aria-label="來源片段工具">
            <label>
              講者
              <select
                aria-label="依講者篩選"
                value={speakerFilter}
                onChange={(event) => {
                  setSpeakerFilter(event.target.value);
                  persistSelection("speaker-filter", event.target.value);
                }}
              >
                <option value="all">全部講者</option>
                {speakers.map((speaker) => (
                  <option key={speaker} value={speaker}>
                    {speaker}
                  </option>
                ))}
              </select>
            </label>
            <label>
              狀態
              <select
                aria-label="依片段狀態篩選"
                value={stateFilter}
                onChange={(event) => {
                  setStateFilter(event.target.value);
                  persistSelection("state-filter", event.target.value);
                }}
              >
                <option value="all">全部狀態</option>
                {states.map((state) => (
                  <option key={state} value={state}>
                    {statusLabel(state)}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="secondary-button"
              disabled={!nextPendingSegmentId}
              onClick={() =>
                nextPendingSegmentId && openSource(nextPendingSegmentId)
              }
            >
              下一筆待覆核
            </button>
            <button
              className="secondary-button"
              disabled={!selectedSegment}
              onClick={() =>
                selectedSegment && openSource(selectedSegment.id, true)
              }
            >
              播放所選來源
            </button>
            <button
              className="secondary-button"
              disabled={!selectedSegment}
              onClick={() => void copySource()}
            >
              複製來源定位
            </button>
          </div>
          <audio
            ref={audioRef}
            aria-label="所選來源片段音訊"
            controls
            preload="metadata"
            src={audioUrl}
          >
            您的瀏覽器不支援 audio 元件。
          </audio>
          {selectedSegment && (
            <div className="source-box">
              <strong>所選來源片段</strong>
              <code>{`aura://${session.id}/segments/${selectedSegment.id}`}</code>
              <span>
                {formatTime(selectedSegment.startMs)}–
                {formatTime(selectedSegment.endMs)}
              </span>
            </div>
          )}
          <div className="segments">
            {filteredSegments.map((segment) => (
              <button
                key={segment.id}
                className={
                  activeSegment === segment.id ? "segment active" : "segment"
                }
                onClick={() => openSource(segment.id)}
              >
                <span className="segment-time">
                  {formatTime(segment.startMs)}–{formatTime(segment.endMs)}
                </span>
                <span className="segment-body">
                  <strong>{segment.speaker}</strong>
                  <span>{segment.text}</span>
                </span>
              </button>
            ))}
          </div>
        </section>
        <section className="claims-panel" aria-labelledby="claims-heading">
          <div className="panel-heading">
            <div>
              <span className="eyebrow">HUMAN REVIEW</span>
              <h2 id="claims-heading">Claims</h2>
            </div>
          </div>
          <div className="claims-list">
            {claims.map((claim) => (
              <article className="claim" key={claim.id}>
                <div className="claim-heading">
                  <span className={`status ${tone(claim.status)}`}>
                    {statusLabel(claim.status)}
                  </span>
                  <span>{claim.field}</span>
                </div>
                {editingClaim === claim.id ? (
                  <div className="edit-form">
                    <label>
                      確認後文字
                      <textarea
                        value={editText}
                        onChange={(event) => setEditText(event.target.value)}
                      />
                    </label>
                    <div className="button-row">
                      <button
                        className="primary-button"
                        onClick={() =>
                          void reviewClaim(claim, "edited", editText)
                        }
                      >
                        儲存編輯
                      </button>
                      <button
                        className="secondary-button"
                        onClick={() => setEditingClaim(null)}
                      >
                        取消
                      </button>
                    </div>
                  </div>
                ) : (
                  <p>{claim.text}</p>
                )}
                <div className="evidence-line">
                  <span aria-hidden="true">⌁</span>
                  {claim.evidence.length
                    ? `${claim.evidence.length} 份來源・${formatTime(claim.evidence[0].startMs ?? 0)}–${formatTime(claim.evidence[0].endMs ?? 0)}`
                    : claim.rationale}
                </div>
                {editingClaim !== claim.id && (
                  <div className="claim-actions">
                    {claim.evidence[0] && (
                      <>
                        <button
                          onClick={() => {
                            onSelectClaim(claim.id);
                            openSource(claim.evidence[0].id);
                          }}
                        >
                          ⌁ 查看來源
                        </button>
                        <button
                          onClick={() => {
                            onSelectClaim(claim.id);
                            openSource(claim.evidence[0].id, true);
                          }}
                        >
                          ▶ 播放來源
                        </button>
                      </>
                    )}
                    <button
                      disabled={claim.status === "unsupported"}
                      onClick={() => void reviewClaim(claim, "confirmed")}
                    >
                      ✓ 確認
                    </button>
                    <button onClick={() => setEditingClaim(claim)}>
                      ✎ 編輯
                    </button>
                    <button onClick={() => void reviewClaim(claim, "rejected")}>
                      × 拒絕
                    </button>
                  </div>
                )}
              </article>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

function ActionsScreen({
  session,
  claims,
  actions,
  selectedId,
  activeRunId,
  activeRunActionId,
  runStage,
  delegationReady,
  onSelect,
  onDelegate,
}: {
  session: MeetingSession | null;
  claims: Claim[];
  actions: Action[];
  selectedId: string;
  activeRunId: string;
  activeRunActionId: string;
  runStage: RunStage;
  delegationReady: boolean;
  onSelect: (id: string) => void;
  onDelegate: (action: Action) => void;
}) {
  const [ownerFilter, setOwnerFilter] = useState("all");
  const [dueFilter, setDueFilter] = useState("all");
  const [evidenceFilter, setEvidenceFilter] = useState("all");
  const [reviewFilter, setReviewFilter] = useState("all");
  const [workTypeFilter, setWorkTypeFilter] = useState("all");
  const [delegationFilter, setDelegationFilter] = useState("all");
  const owners = useMemo(
    () => Array.from(new Set(actions.map((action) => action.owner))).sort(),
    [actions],
  );
  const claimFor = (action: Action) => {
    const linkedClaimId = Object.entries(demoClaimActionLinks).find(
      ([, actionId]) => actionId === action.id,
    )?.[0];
    return (
      claims.find((claim) => claim.id === linkedClaimId) ??
      claims.find((claim) => claim.id === action.id) ??
      claims.find((claim) =>
        claim.evidence.some((reference) =>
          action.evidence.some(
            (actionReference) => actionReference.id === reference.id,
          ),
        ),
      )
    );
  };
  const reviewStatusFor = (action: Action) =>
    claimFor(action)?.status ??
    (action.status === "confirmed" ? "confirmed" : "pending");
  const workTypeFor = (action: Action) => action.workType ?? "unknown";
  const isDelegated = (action: Action) =>
    Boolean(activeRunId && activeRunActionId === action.id);
  const filteredActions = actions.filter(
    (action) =>
      (ownerFilter === "all" || action.owner === ownerFilter) &&
      (dueFilter === "all" ||
        (dueFilter === "due" ? Boolean(action.dueDate) : !action.dueDate)) &&
      (evidenceFilter === "all" || action.support === evidenceFilter) &&
      (reviewFilter === "all" || reviewStatusFor(action) === reviewFilter) &&
      (workTypeFilter === "all" || workTypeFor(action) === workTypeFilter) &&
      (delegationFilter === "all" ||
        (delegationFilter === "delegated"
          ? isDelegated(action)
          : !isDelegated(action))),
  );
  const selected =
    actions.find((action) => action.id === selectedId) ?? actions[0];
  if (!selected) {
    return (
      <div className="screen">
        <PageHeading
          eyebrow="DECISION REGISTER"
          title="行動項目"
          detail="已確認、證據完整的項目能進入工程委派。"
        />
        <section
          className="panel action-detail"
          aria-labelledby="empty-action-heading"
        >
          <h2 id="empty-action-heading">目前沒有可委派的 AURA 行動</h2>
          <p>
            載入 AURA 會議並完成人員覆核後，符合來源與 supported gate
            的行動會顯示於此。
          </p>
        </section>
      </div>
    );
  }
  const originalClaim = claimFor(selected);
  const supportingSegments = selected.evidence
    .map((reference) =>
      session?.segments.find((segment) => segment.id === reference.id),
    )
    .filter((segment): segment is MeetingSession["segments"][number] =>
      Boolean(segment),
    );
  const sourceAudioUrl = (segment: MeetingSession["segments"][number]) =>
    session?.id === demoSession.id
      ? `${session.audioUrl}#t=${segment.startMs / 1000},${segment.endMs / 1000}`
      : `/api/aura-audio?meeting_id=${encodeURIComponent(session?.id ?? "")}&start_ms=${segment.startMs}&end_ms=${segment.endMs}`;
  const selectedReviewStatus = reviewStatusFor(selected);
  const selectedDelegated = isDelegated(selected);
  return (
    <div className="screen">
      <PageHeading
        eyebrow="DECISION REGISTER"
        title="行動項目"
        detail="已確認且具完整來源的行動可進入工程委派，其餘項目保留明確 activation gate。"
      />
      <div className="master-detail">
        <section
          className="panel action-register"
          aria-labelledby="action-register-heading"
        >
          <div className="panel-heading">
            <h2 id="action-register-heading">Action register</h2>
            <span className="section-note">
              {filteredActions.length} / {actions.length} items
            </span>
          </div>
          <div className="button-row" aria-label="Action filters">
            <label>
              Owner
              <select
                aria-label="依 owner 篩選"
                value={ownerFilter}
                onChange={(event) => setOwnerFilter(event.target.value)}
              >
                <option value="all">全部 owner</option>
                {owners.map((owner) => (
                  <option key={owner} value={owner}>
                    {owner}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Due
              <select
                aria-label="依期限篩選"
                value={dueFilter}
                onChange={(event) => setDueFilter(event.target.value)}
              >
                <option value="all">全部期限</option>
                <option value="due">有期限</option>
                <option value="none">無期限</option>
              </select>
            </label>
            <label>
              Evidence
              <select
                aria-label="依證據狀態篩選"
                value={evidenceFilter}
                onChange={(event) => setEvidenceFilter(event.target.value)}
              >
                <option value="all">全部證據狀態</option>
                <option value="supported">supported</option>
                <option value="partial">partial</option>
                <option value="unsupported">unsupported</option>
              </select>
            </label>
            <label>
              Review
              <select
                aria-label="依覆核狀態篩選"
                value={reviewFilter}
                onChange={(event) => setReviewFilter(event.target.value)}
              >
                <option value="all">全部覆核狀態</option>
                <option value="pending">待覆核</option>
                <option value="confirmed">已確認</option>
                <option value="edited">已編輯確認</option>
                <option value="rejected">已拒絕</option>
              </select>
            </label>
            <label>
              Work type
              <select
                aria-label="依工作類型篩選"
                value={workTypeFilter}
                onChange={(event) => setWorkTypeFilter(event.target.value)}
              >
                <option value="all">全部工作類型</option>
                <option value="engineering">engineering</option>
                <option value="non-engineering">non-engineering</option>
                <option value="unknown">unknown / 待來源分類</option>
              </select>
            </label>
            <label>
              Delegation
              <select
                aria-label="依委派狀態篩選"
                value={delegationFilter}
                onChange={(event) => setDelegationFilter(event.target.value)}
              >
                <option value="all">全部委派狀態</option>
                <option value="delegated">已委派</option>
                <option value="not-delegated">未委派</option>
              </select>
            </label>
          </div>
          <table>
            <thead>
              <tr>
                <th>Action</th>
                <th>Meeting</th>
                <th>Owner</th>
                <th>Deadline</th>
                <th>Action status</th>
                <th>Support status</th>
                <th>Review status</th>
                <th>Sources</th>
                <th>Delegation</th>
                <th>Last agent run</th>
              </tr>
            </thead>
            <tbody>
              {filteredActions.map((action) => (
                <tr key={action.id}>
                  <td>
                    <button
                      className="text-button"
                      aria-pressed={selected.id === action.id}
                      onClick={() => onSelect(action.id)}
                    >
                      {action.title}
                    </button>
                  </td>
                  <td>{session?.title ?? "會議待載入"}</td>
                  <td>{action.owner}</td>
                  <td>{action.dueDate ?? "下一驗證層"}</td>
                  <td>
                    <span className={`status ${tone(action.status)}`}>
                      {statusLabel(action.status)}
                    </span>
                  </td>
                  <td>{statusLabel(action.support)}</td>
                  <td>{statusLabel(reviewStatusFor(action))}</td>
                  <td>{action.evidence.length}</td>
                  <td>
                    {isDelegated(action)
                      ? statusLabel(runStage)
                      : canDelegate(action) && delegationReady
                        ? "可委派"
                        : canDelegate(action)
                          ? "Runtime activation gate"
                          : "等待 gate"}
                  </td>
                  <td>
                    {isDelegated(action) ? (
                      <code>{activeRunId}</code>
                    ) : (
                      "尚未啟動"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!filteredActions.length && (
            <p>目前篩選條件下沒有 action；調整原生篩選器即可查看其他項目。</p>
          )}
        </section>
        <aside
          className="panel action-detail"
          aria-labelledby="action-detail-heading"
        >
          <span className="eyebrow">{selected.id}</span>
          <h2 id="action-detail-heading">{selected.title}</h2>
          <div className="detail-grid">
            <div>
              <span>Owner</span>
              <strong>{selected.owner}</strong>
            </div>
            <div>
              <span>Evidence</span>
              <strong>{selected.evidence.length} refs</strong>
            </div>
            <div>
              <span>Status</span>
              <strong>{statusLabel(selected.status)}</strong>
            </div>
            <div>
              <span>Support</span>
              <strong>{statusLabel(selected.support)}</strong>
            </div>
            <div>
              <span>Review</span>
              <strong>{statusLabel(selectedReviewStatus)}</strong>
            </div>
            <div>
              <span>Work type</span>
              <strong>{workTypeFor(selected)}</strong>
            </div>
          </div>
          <h3>Original claim</h3>
          <p>
            {originalClaim?.text ??
              "原始 claim wording 待 AURA source contract 提供。"}
          </p>
          <h3>Supporting segments and audio</h3>
          {supportingSegments.map((segment) => (
            <article className="claim" key={segment.id}>
              <div className="row-meta">
                <span>{segment.speaker}</span>
                <span>
                  {formatTime(segment.startMs)}–{formatTime(segment.endMs)}
                </span>
              </div>
              <p>{segment.text}</p>
              <a href={sourceAudioUrl(segment)}>播放來源音訊 {segment.id}</a>
            </article>
          ))}
          {supportingSegments[0] && (
            <audio
              aria-label="行動來源音訊"
              controls
              preload="metadata"
              src={sourceAudioUrl(supportingSegments[0])}
            />
          )}
          {!supportingSegments.length && (
            <p>Supporting segment 待目前 AURA session detail 載入。</p>
          )}
          <h3>Meeting context</h3>
          <p>
            {session
              ? `${session.title}・${new Date(session.occurredAt).toLocaleString("zh-TW")}・${statusLabel(session.freshness)}`
              : "AURA meeting context 待載入。"}
          </p>
          <h3>Proposed acceptance criteria</h3>
          <ol className="acceptance-list">
            {selected.acceptance.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ol>
          <h3>Proposed repository / workspace</h3>
          <p>
            Project AURA server-owned allowlist・核准後建立 per-run isolated
            worktree；實際 path 由 runtime event 回報。
          </p>
          <h3>Risk classification</h3>
          <p>
            待人員覆核・寫入風險由具名 approval scope 與 validation gate 管理。
          </p>
          <div className="source-box">
            <strong>來源定位</strong>
            {selected.evidence.length ? (
              selected.evidence.map((reference) => (
                <code key={reference.locator}>{reference.locator}</code>
              ))
            ) : (
              <code>等待來源證據</code>
            )}
          </div>
          <h3>Delegation gate</h3>
          <dl className="detail-grid">
            <div>
              <span>Action confirmed</span>
              <strong>
                {selected.status === "confirmed" ? "PASS" : "WAIT"}
              </strong>
            </div>
            <div>
              <span>Evidence supported</span>
              <strong>
                {selected.support === "supported" ? "PASS" : "WAIT"}
              </strong>
            </div>
            <div>
              <span>Source present</span>
              <strong>{selected.evidence.length ? "PASS" : "WAIT"}</strong>
            </div>
            <div>
              <span>Delegation</span>
              <strong>
                {selectedDelegated
                  ? statusLabel(runStage)
                  : canDelegate(selected) && delegationReady
                    ? "READY"
                    : "ACTIVATION GATE"}
              </strong>
            </div>
          </dl>
          <button
            className="primary-button wide"
            disabled={!canDelegate(selected) || !delegationReady}
            onClick={() => onDelegate(selected)}
          >
            Delegate to Codex
          </button>
          {!canDelegate(selected) && (
            <p className="scope-note">
              確認狀態、supported 判定與來源證據齊備後開啟委派。
            </p>
          )}
          {canDelegate(selected) && !delegationReady && (
            <p className="scope-note">
              AURA、Codex 與 CopilotKit runtime 就緒後開啟本機委派。
            </p>
          )}
        </aside>
      </div>
    </div>
  );
}

function RunsScreen({
  action,
  session,
  services,
  activeRunId,
  approvalRecord,
  correlationId,
  mode,
  events,
  stage,
  writeActivated,
  forceTestFailure,
  lastExport,
  setForceTestFailure,
  onApprove,
  onStop,
  onExport,
}: {
  action: Action | null;
  session: MeetingSession | null;
  services: { aura: ServiceState; codex: ServiceState };
  activeRunId: string;
  approvalRecord: ApprovalRecord | null;
  correlationId: string;
  mode: "demo" | "local";
  events: RunEvent[];
  stage: RunStage;
  writeActivated: boolean;
  forceTestFailure: boolean;
  lastExport: LocalExport | null;
  setForceTestFailure: (value: boolean) => void;
  onApprove: (decision: ApprovalDecision) => void;
  onStop: () => void;
  onExport: () => void;
}) {
  const [activeTab, setActiveTab] = useState<RunDetailTab>("overview");
  if (!action) {
    return (
      <div className="screen">
        <PageHeading
          eyebrow="CODEX EXECUTION"
          title="Agent Runs"
          detail="唯讀計畫、核准、命令、檔案變更與測試共用同一 correlation ID。"
        />
        <section className="panel">
          <h2>尚未啟動可信任執行</h2>
          <p>請先載入 AURA 會議、確認來源主張，並選擇符合委派 gate 的行動。</p>
        </section>
      </div>
    );
  }
  const latestPlan = events.filter((event) => event.type === "plan").at(-1);
  const latestApproval = events
    .filter((event) => event.type === "approval")
    .at(-1);
  const actualDiff = events
    .filter((event) => event.type === "diff")
    .map((event) => event.detail)
    .filter((detail): detail is string => Boolean(detail))
    .at(-1);
  const actualTests = events.filter((event) => event.type === "test");
  const latestTest = actualTests.at(-1);
  const latestFileChange = events
    .filter((event) => event.type === "file_change")
    .at(-1);
  const latestCommand = events
    .filter((event) => event.type === "command")
    .at(-1);
  const hasDemoDiff =
    mode === "demo" && Boolean(latestFileChange || actualDiff);
  const runStatus =
    !services.codex.ready && stage === "idle"
      ? "blocked"
      : stage === "idle"
        ? "draft"
        : stage === "approval"
          ? latestApproval
            ? "waiting for approval"
            : "planning"
          : stage === "running" && latestTest
            ? "testing"
            : stage;
  const worktree =
    mode === "demo"
      ? (latestCommand?.detail ??
        (writeActivated
          ? `demo://worktrees/${activeRunId}`
          : "核准後建立 demo isolated worktree"))
      : (latestCommand?.detail ??
        "等待 runtime 回報 isolated worktree locator");
  const planSteps =
    mode === "demo"
      ? [
          {
            title: "追蹤真實資料流",
            detail: "確認 producer、queue、consumer、停止與錯誤路徑。",
            state: latestPlan ? "completed" : "current",
          },
          {
            title: "加入有界容量與背壓",
            detail: "保留可調整容量，避免工作量尖峰持續累積。",
            state: latestFileChange
              ? "completed"
              : stage === "running"
                ? "current"
                : "queued",
          },
          {
            title: "用針對性測試驗證",
            detail: "涵蓋容量、等待、停止與既有行為。",
            state: latestTest
              ? latestTest.status === "failed"
                ? "failed"
                : "completed"
              : latestFileChange
                ? "current"
                : "queued",
          },
        ]
      : [];
  const currentPlanStep =
    stage === "approval"
      ? "等待 operator 核准具名寫入範圍"
      : stage === "running" && latestTest
        ? "驗證實作結果"
        : stage === "running"
          ? "執行已核准的實作範圍"
          : stage === "completed"
            ? "計畫項目已完成並通過驗證"
            : stage === "failed"
              ? "保留工作樹，依失敗證據修正與重驗"
              : stage === "stopped"
                ? "執行已停止，現有證據保持可檢視"
                : "等待 run 啟動";
  const validationEventFor = (pattern: RegExp) =>
    actualTests.find((event) =>
      pattern.test(`${event.title} ${event.detail ?? ""}`),
    );
  const testEvent =
    validationEventFor(
      /\b(?:test|pytest|vitest|playwright|unittest)\b|測試|驗證/i,
    ) ?? latestTest;
  const lintEvent = validationEventFor(/\blint\b/i);
  const typecheckEvent = validationEventFor(/\btypecheck\b|type check/i);
  const buildEvent = validationEventFor(/\bbuild\b/i);
  const diffCheckProven = Boolean(
    latestTest?.status === "passed" &&
    latestTest.detail?.includes("git diff --check passed"),
  );
  const validationRows = [
    {
      check: "Tests",
      status: testEvent?.status ?? "not run",
      result: testEvent
        ? mode === "demo" && testEvent.status === "passed"
          ? `${demoExpectedTests[0].command}: ${demoExpectedTests[0].summary}`
          : (testEvent.detail ?? testEvent.title)
        : "尚無 test result",
      reason: testEvent ? "runtime validation event" : "等待具名 test event",
    },
    {
      check: "Lint",
      status: lintEvent?.status ?? "not run",
      result: lintEvent?.detail ?? "尚無 lint result",
      reason: lintEvent
        ? "runtime validation event"
        : "目前 run 未回報 lint command",
    },
    {
      check: "Typecheck",
      status: typecheckEvent?.status ?? "not run",
      result: typecheckEvent?.detail ?? "尚無 typecheck result",
      reason: typecheckEvent
        ? "runtime validation event"
        : "目前 run 未回報 typecheck command",
    },
    {
      check: "Build",
      status: buildEvent?.status ?? "not run",
      result: buildEvent?.detail ?? "尚無 build result",
      reason: buildEvent
        ? "runtime validation event"
        : "目前 run 未回報 build command",
    },
    {
      check: "Diff check",
      status: diffCheckProven ? "passed" : "not run",
      result: diffCheckProven
        ? `${demoExpectedTests[1].command}: ${demoExpectedTests[1].summary}`
        : "尚無 git diff --check result",
      reason: diffCheckProven
        ? "runtime validation event"
        : "等待具名 diff-check event",
    },
  ];
  const runTabs: Array<{ id: RunDetailTab; label: string }> = [
    { id: "overview", label: "Overview" },
    { id: "plan", label: "Plan" },
    { id: "activity", label: "Activity" },
    { id: "changes", label: "Changes" },
    { id: "validation", label: "Validation" },
    { id: "approvals", label: "Approvals" },
    { id: "evidence", label: "Evidence Packet" },
  ];
  return (
    <div className="screen">
      <PageHeading
        eyebrow="CODEX EXECUTION"
        title="Agent Runs"
        detail="唯讀計畫、核准、命令、檔案變更與測試共用同一 correlation ID。"
      />
      <div className="run-header">
        <div>
          <span className={`status ${tone(runStatus)}`}>{runStatus}</span>
          <h2>{action.title}</h2>
          <code>{correlationId}</code>
        </div>
        <dl>
          <div>
            <dt>Requested model</dt>
            <dd>
              {mode === "demo"
                ? demoRun.modelRequested
                : (services.codex.model ?? "待服務回報")}
            </dd>
          </div>
          <div>
            <dt>Sandbox</dt>
            <dd>
              {writeActivated
                ? "workspace-write"
                : mode === "demo"
                  ? "read-only"
                  : (services.codex.sandbox ?? "read-only")}
            </dd>
          </div>
          <div>
            <dt>Network</dt>
            <dd>
              {services.codex.network === undefined
                ? mode === "demo"
                  ? "off"
                  : "待服務回報"
                : services.codex.network
                  ? "on"
                  : "off"}
            </dd>
          </div>
        </dl>
        <div className="run-actions">
          <button
            className="secondary-button"
            disabled={stage === "stopped" || stage === "completed"}
            onClick={() => void onStop()}
          >
            ■ 停止
          </button>
          <button
            className="secondary-button"
            disabled={stage !== "completed"}
            onClick={() => void onExport()}
          >
            ⇩ 匯出
          </button>
        </div>
      </div>
      <div className="run-layout">
        <aside
          className="panel timeline-panel"
          aria-labelledby="run-list-heading"
        >
          <div className="panel-heading">
            <h2 id="run-list-heading">Run list</h2>
            <span className={`status ${tone(runStatus)}`}>{runStatus}</span>
          </div>
          <button className="text-button wide" aria-current="true">
            <strong>{action.title}</strong>
            <code aria-label="Active run ID">
              {activeRunId || `draft:${action.id}`}
            </code>
          </button>
          <dl className="detail-grid">
            <div>
              <dt>Source action</dt>
              <dd>{action.id}</dd>
            </div>
            <div>
              <dt>Events</dt>
              <dd>{events.length}</dd>
            </div>
          </dl>
          <small aria-label="Supported run statuses">
            draft · planning · waiting for approval · running · testing ·
            completed · failed · stopped · blocked
          </small>
        </aside>
        <div className="run-main">
          <div
            className="button-row"
            role="tablist"
            aria-label="Agent run detail"
          >
            {runTabs.map((tab) => (
              <button
                key={tab.id}
                id={`run-tab-${tab.id}`}
                role="tab"
                aria-selected={activeTab === tab.id}
                aria-controls={`run-panel-${tab.id}`}
                className={
                  activeTab === tab.id ? "primary-button" : "secondary-button"
                }
                onClick={() => setActiveTab(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {activeTab === "overview" && (
            <section
              className="panel"
              role="tabpanel"
              id="run-panel-overview"
              aria-labelledby="run-tab-overview"
            >
              <div className="panel-heading">
                <h2>Run overview</h2>
                <span className={`status ${tone(runStatus)}`}>{runStatus}</span>
              </div>
              <dl className="detail-grid">
                <div>
                  <dt>Goal</dt>
                  <dd>{action.title}</dd>
                </div>
                <div>
                  <dt>Source meeting</dt>
                  <dd>{session?.title ?? "AURA meeting 待載入"}</dd>
                </div>
                <div>
                  <dt>Source action</dt>
                  <dd>
                    <code>{action.id}</code>
                  </dd>
                </div>
                <div>
                  <dt>Requested model</dt>
                  <dd>
                    {mode === "demo"
                      ? demoRun.modelRequested
                      : (services.codex.model ?? "待服務回報")}
                  </dd>
                </div>
                <div>
                  <dt>Observed model</dt>
                  <dd>
                    {mode === "demo"
                      ? demoRun.modelObserved
                      : (services.codex.model ?? "待 runtime 回報")}
                  </dd>
                </div>
                <div>
                  <dt>Profile / effort</dt>
                  <dd>
                    {mode === "demo"
                      ? demoRun.effort
                      : (services.codex.effort ?? "待服務回報")}
                  </dd>
                </div>
                <div>
                  <dt>Sandbox</dt>
                  <dd>
                    {writeActivated
                      ? "workspace-write"
                      : mode === "demo"
                        ? "read-only"
                        : (services.codex.sandbox ?? "read-only")}
                  </dd>
                </div>
                <div>
                  <dt>Network</dt>
                  <dd>
                    {services.codex.network === undefined
                      ? mode === "demo"
                        ? "off"
                        : "待服務回報"
                      : services.codex.network
                        ? "on"
                        : "off"}
                  </dd>
                </div>
                <div>
                  <dt>Repository</dt>
                  <dd>Project AURA server-owned allowlist</dd>
                </div>
                <div>
                  <dt>Worktree</dt>
                  <dd>
                    <code>{worktree}</code>
                  </dd>
                </div>
                <div>
                  <dt>Status</dt>
                  <dd>{runStatus}</dd>
                </div>
              </dl>
              <div className="source-box">
                <strong>Source evidence locators</strong>
                {action.evidence.map((reference) => (
                  <code key={reference.locator}>{reference.locator}</code>
                ))}
              </div>
            </section>
          )}

          {activeTab === "plan" && (
            <section
              className="panel plan-panel"
              role="tabpanel"
              id="run-panel-plan"
              aria-labelledby="run-tab-plan"
            >
              <div className="panel-heading">
                <h2>唯讀計畫</h2>
                <span
                  className={`status ${latestPlan || mode === "demo" ? "positive" : "warning"}`}
                >
                  {latestPlan || mode === "demo" ? "已串流" : "等待事件"}
                </span>
              </div>
              <p>
                <strong>Current step：</strong>
                {currentPlanStep}
              </p>
              {mode === "demo" ? (
                <ol className="plan-list">
                  {planSteps.map((step, index) => (
                    <li key={step.title}>
                      <span>{index + 1}</span>
                      <div>
                        <strong>{step.title}</strong>
                        <p>{step.detail}</p>
                        <small>{step.state}</small>
                      </div>
                    </li>
                  ))}
                </ol>
              ) : (
                <>
                  <p>
                    {latestPlan?.detail ??
                      "Codex read-only plan 將由 app-server event stream 填入。"}
                  </p>
                  <p className="scope-note">
                    Completed items 只依已接收的 plan 與 runtime events 標示。
                  </p>
                </>
              )}
            </section>
          )}

          {activeTab === "activity" && (
            <section
              className="panel timeline-panel"
              role="tabpanel"
              id="run-panel-activity"
              aria-labelledby="run-tab-activity"
            >
              <div className="panel-heading">
                <h2>Event timeline</h2>
                <span className="live-marker">
                  {stage === "running" ? "LIVE" : runStatus.toUpperCase()}
                </span>
              </div>
              <ol className="timeline">
                {events.map((event) => (
                  <li key={event.id}>
                    <span
                      className={`timeline-dot ${tone(event.status)}`}
                      aria-hidden="true"
                    />
                    <div>
                      <div className="row-meta">
                        <span>
                          {event.type.toUpperCase()} ·{" "}
                          {event.type === "approval"
                            ? "Operator / Codex"
                            : "Codex runtime"}
                        </span>
                        <time>
                          {new Date(event.occurredAt).toLocaleTimeString(
                            "zh-TW",
                            { hour12: false },
                          )}
                        </time>
                      </div>
                      <strong>{event.title}</strong>
                      <p>
                        {event.detail ??
                          "Normalized event payload 未提供 detail。"}
                      </p>
                    </div>
                  </li>
                ))}
              </ol>
              {!events.length && (
                <p>
                  等待 plan、tool call、file read、file write、command、test 或
                  status event。
                </p>
              )}
            </section>
          )}

          {activeTab === "changes" && (
            <section
              className="panel diff-panel"
              role="tabpanel"
              id="run-panel-changes"
              aria-labelledby="run-tab-changes"
            >
              <div className="panel-heading">
                <h2>Trusted diff</h2>
                <span className="section-note">
                  {hasDemoDiff
                    ? "1 file・+1 −1"
                    : actualDiff
                      ? "Codex terminal evidence"
                      : "尚無變更證據"}
                </span>
              </div>
              {hasDemoDiff || actualDiff ? (
                <>
                  <dl className="detail-grid">
                    <div>
                      <dt>Changed file</dt>
                      <dd>
                        {mode === "demo"
                          ? "src/aura/asr/threads.py"
                          : "isolated worktree event"}
                      </dd>
                    </div>
                    <div>
                      <dt>Additions / deletions</dt>
                      <dd>
                        {latestFileChange?.detail ?? "由 diff payload 提供"}
                      </dd>
                    </div>
                    <div>
                      <dt>Trust label</dt>
                      <dd>
                        {mode === "demo"
                          ? "deterministic fixture evidence"
                          : "observed runtime evidence"}
                      </dd>
                    </div>
                  </dl>
                  <pre
                    aria-label={
                      mode === "demo" ? "預期 demo diff" : "真實 Codex diff"
                    }
                  >
                    {mode === "demo" ? demoExpectedPatch : actualDiff}
                  </pre>
                </>
              ) : (
                <p>
                  Diff、changed files 與 additions/deletions 會在 runtime 回報
                  file-change 或 diff event 後顯示。
                </p>
              )}
            </section>
          )}

          {activeTab === "validation" && (
            <section
              className="panel tests-panel"
              role="tabpanel"
              id="run-panel-validation"
              aria-labelledby="run-tab-validation"
            >
              <div className="panel-heading">
                <h2>Validation</h2>
                <span
                  className={`status ${tone(latestTest?.status ?? "not_run")}`}
                >
                  {latestTest ? statusLabel(latestTest.status) : "NOT RUN"}
                </span>
              </div>
              <table>
                <thead>
                  <tr>
                    <th>Check</th>
                    <th>Status</th>
                    <th>Result</th>
                    <th>Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {validationRows.map((row) => (
                    <tr key={row.check}>
                      <td>{row.check}</td>
                      <td>
                        <span className={`status ${tone(row.status)}`}>
                          {row.status}
                        </span>
                      </td>
                      <td>{row.result}</td>
                      <td>{row.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {activeTab === "approvals" && (
            <section
              className={stage === "approval" ? "approval-box" : "panel"}
              role="tabpanel"
              id="run-panel-approvals"
              aria-labelledby="run-tab-approvals"
            >
              {stage === "approval" && (
                <div className="approval-icon" aria-hidden="true">
                  !
                </div>
              )}
              <div>
                <span className="eyebrow">TRUSTED APPROVAL</span>
                <h2 id="approval-heading">
                  {stage === "approval"
                    ? "啟用隔離工作樹寫入"
                    : "Approval record"}
                </h2>
                {stage === "approval" &&
                  (mode === "demo" ? (
                    <p>
                      計畫將只變更 <code>src/aura/asr/threads.py</code>{" "}
                      與對應測試。執行位置為獨立 Git worktree，網路維持關閉。
                    </p>
                  ) : (
                    <p>
                      {latestApproval?.detail ??
                        "唯讀計畫已完成；下一步只會啟用本 run 的隔離工作樹，實際命令與檔案要求仍逐項呈現。"}
                    </p>
                  ))}
                <dl className="approval-scope">
                  <div>
                    <dt>Request</dt>
                    <dd>
                      {latestApproval?.title ?? "workspace-write activation"}
                    </dd>
                  </div>
                  <div>
                    <dt>Request detail</dt>
                    <dd>
                      {latestApproval?.detail ??
                        "具名檔案與命令範圍待 runtime 回報"}
                    </dd>
                  </div>
                  <div>
                    <dt>Risk</dt>
                    <dd>bounded file change in isolated worktree</dd>
                  </div>
                  <div>
                    <dt>Scope</dt>
                    <dd>workspace-write · tests · git diff · network off</dd>
                  </div>
                  <div>
                    <dt>Decision</dt>
                    <dd>
                      {approvalRecord?.decision ??
                        (stage === "approval"
                          ? "pending"
                          : "尚無 decision evidence")}
                    </dd>
                  </div>
                  <div>
                    <dt>Actor</dt>
                    <dd>
                      {approvalRecord?.actor ??
                        (stage === "approval"
                          ? "Operator 待確認"
                          : "尚無 actor evidence")}
                    </dd>
                  </div>
                  <div>
                    <dt>Timestamp</dt>
                    <dd>
                      {approvalRecord
                        ? new Date(approvalRecord.at).toLocaleString("zh-TW")
                        : latestApproval
                          ? new Date(latestApproval.occurredAt).toLocaleString(
                              "zh-TW",
                            )
                          : "尚無 timestamp evidence"}
                    </dd>
                  </div>
                </dl>
                {stage === "approval" && (
                  <>
                    <div className="button-row">
                      <button
                        className="primary-button"
                        onClick={() => void onApprove("allow_once")}
                      >
                        允許這一次
                      </button>
                      <button
                        className="secondary-button"
                        onClick={() => void onApprove("allow_run_scope")}
                      >
                        允許本 run 範圍
                      </button>
                      <button
                        className="danger-button"
                        onClick={() => void onApprove("deny")}
                      >
                        拒絕
                      </button>
                    </div>
                    {mode === "demo" && (
                      <details className="demo-branch">
                        <summary>Demo validation branch</summary>
                        <label>
                          <input
                            type="checkbox"
                            checked={forceTestFailure}
                            onChange={(event) =>
                              setForceTestFailure(event.target.checked)
                            }
                          />
                          示範測試失敗與 finding 保持 open
                        </label>
                      </details>
                    )}
                  </>
                )}
              </div>
            </section>
          )}

          {activeTab === "evidence" && (
            <section
              className="panel"
              role="tabpanel"
              id="run-panel-evidence"
              aria-labelledby="run-tab-evidence"
            >
              <div className="panel-heading">
                <h2>Evidence Packet</h2>
                <span className="section-note">
                  {stage === "completed" ? "export ready" : "activation gate"}
                </span>
              </div>
              <dl className="detail-grid">
                <div>
                  <dt>Source meeting</dt>
                  <dd>
                    <code>{session?.id ?? "meeting evidence unavailable"}</code>
                  </dd>
                </div>
                <div>
                  <dt>Source action</dt>
                  <dd>
                    <code>{action.id}</code>
                  </dd>
                </div>
                <div>
                  <dt>Approval</dt>
                  <dd>
                    {approvalRecord
                      ? `${approvalRecord.decision} · ${approvalRecord.actor} · ${approvalRecord.at}`
                      : "pending / unavailable"}
                  </dd>
                </div>
                <div>
                  <dt>Commands</dt>
                  <dd>
                    {events
                      .filter((event) => event.type === "command")
                      .map((event) => event.title)
                      .join(" · ") || "尚無 command evidence"}
                  </dd>
                </div>
                <div>
                  <dt>Diff hash</dt>
                  <dd>
                    {actualDiff || hasDemoDiff
                      ? "由 export manifest 產生；UI 未建立替代 hash"
                      : "尚無 diff evidence"}
                  </dd>
                </div>
                <div>
                  <dt>Test results</dt>
                  <dd>
                    {actualTests
                      .map((event) => `${event.title}: ${event.status}`)
                      .join(" · ") || "尚無 test evidence"}
                  </dd>
                </div>
                <div>
                  <dt>Artifact export</dt>
                  <dd>
                    {stage === "completed"
                      ? "validated export 可啟動"
                      : "完成驗證後啟動"}
                  </dd>
                </div>
              </dl>
              <div className="source-box">
                <strong>Source evidence</strong>
                {action.evidence.map((reference) => (
                  <code key={reference.locator}>{reference.locator}</code>
                ))}
              </div>
              {mode === "local" && lastExport && (
                <div
                  className="artifact-links"
                  aria-label="可下載的實際 evidence artifacts"
                >
                  <strong>
                    Export <code>{lastExport.exportId}</code>
                  </strong>
                  {lastExport.artifacts.map((artifact) => (
                    <a
                      key={artifact.filename}
                      href={`/api/evidence/${encodeURIComponent(lastExport.exportId)}/${encodeURIComponent(artifact.filename)}`}
                      download={artifact.filename}
                    >
                      <span>{artifact.filename}</span>
                      <small>
                        {artifact.bytes.toLocaleString()} bytes
                        {artifact.sha256
                          ? ` · SHA-256 ${artifact.sha256.slice(0, 12)}…`
                          : ""}
                      </small>
                    </a>
                  ))}
                </div>
              )}
              <button
                className="primary-button wide"
                disabled={stage !== "completed"}
                onClick={() => void onExport()}
              >
                ⇩ 匯出 evidence packet
              </button>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

function TrustScreen({
  assets,
  controls,
  findings,
  audit,
  correlationId,
  onDraftRemediation,
  onRefresh,
}: {
  assets: TrustAsset[];
  controls: TrustControl[];
  findings: Finding[];
  audit: AuditRow[];
  correlationId: string;
  onDraftRemediation: (finding: Finding) => void;
  onRefresh: () => void;
}) {
  const [activeTab, setActiveTab] = useState<TrustDetailTab>("controls");
  const openFindings = findings.filter(
    (finding) => finding.state === "open",
  ).length;
  const tabs: Array<{ id: TrustDetailTab; label: string }> = [
    { id: "assets", label: "Assets" },
    { id: "controls", label: "Controls" },
    { id: "findings", label: "Findings" },
    { id: "remediations", label: "Remediations" },
    { id: "audit", label: "Audit Timeline" },
  ];
  return (
    <div className="screen">
      <PageHeading
        eyebrow="ASSURANCE LAYER"
        title="信任與稽核"
        detail="資產、控制、finding 與事件鏈使用相同 correlation context。"
      />
      <div
        className="button-row trust-tabs"
        role="tablist"
        aria-label="Trust and audit detail"
      >
        {tabs.map((tab) => (
          <button
            id={`trust-tab-${tab.id}`}
            key={tab.id}
            role="tab"
            aria-selected={activeTab === tab.id}
            aria-controls={`trust-panel-${tab.id}`}
            className={
              activeTab === tab.id ? "primary-button" : "secondary-button"
            }
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === "assets" && (
        <section
          className="panel trust-panel"
          role="tabpanel"
          id="trust-panel-assets"
          aria-labelledby="trust-tab-assets"
        >
          <div className="panel-heading">
            <h2>Protected assets</h2>
            <span className="score">
              {String(assets.length).padStart(2, "0")} assets
            </span>
          </div>
          <div className="trust-overview">
            {assets.map((asset) => (
              <div className="asset-line" key={asset.id}>
                <span
                  className={`asset-icon ${tone(asset.state)}`}
                  aria-hidden="true"
                >
                  {asset.kind.slice(0, 1).toUpperCase()}
                </span>
                <div>
                  <strong>{asset.name}</strong>
                  <span>{asset.kind}</span>
                </div>
                <span className={`status ${tone(asset.state)}`}>
                  {asset.state.toUpperCase()}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {activeTab === "controls" && (
        <section
          className="panel trust-panel"
          role="tabpanel"
          id="trust-panel-controls"
          aria-labelledby="trust-tab-controls"
        >
          <div className="panel-heading">
            <div>
              <span className="eyebrow">DETERMINISTIC + RUNTIME EVIDENCE</span>
              <h2>Control execution</h2>
            </div>
            <button className="secondary-button" onClick={onRefresh}>
              重新執行可用控制
            </button>
          </div>
          <table>
            <thead>
              <tr>
                <th>Control</th>
                <th>目的</th>
                <th>結果</th>
              </tr>
            </thead>
            <tbody>
              {controls.map((control) => (
                <tr key={control.id}>
                  <td>
                    <code>{control.id}</code>
                  </td>
                  <td>{control.title}</td>
                  <td>
                    <span className={`status ${tone(control.state)}`}>
                      {control.state.toUpperCase()}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="scope-note">
            Runtime readiness與audit
            continuity可立即重驗；repository、model與closure
            controls依其具名證據路徑啟動。
          </p>
        </section>
      )}

      {activeTab === "findings" && (
        <section
          className="panel trust-panel"
          role="tabpanel"
          id="trust-panel-findings"
          aria-labelledby="trust-tab-findings"
        >
          <div className="panel-heading">
            <h2>Architecture findings</h2>
            <span className="score">
              {String(openFindings).padStart(2, "0")} open
            </span>
          </div>
          {findings.map((finding) => (
            <article className="finding" key={finding.id}>
              <div>
                <code>{finding.id}</code>
                <span className={`status ${tone(finding.severity)}`}>
                  {finding.severity.toUpperCase()}
                </span>
              </div>
              <strong>{finding.title}</strong>
              <span>{statusLabel(finding.state)}</span>
              <code>{finding.controlId}</code>
            </article>
          ))}
        </section>
      )}

      {activeTab === "remediations" && (
        <section
          className="panel trust-panel"
          role="tabpanel"
          id="trust-panel-remediations"
          aria-labelledby="trust-tab-remediations"
        >
          <div className="panel-heading">
            <h2>Remediation work packages</h2>
            <span className="section-note">
              唯讀草案 → 明確核准 → 驗證 closure
            </span>
          </div>
          {findings.map((finding) => (
            <article className="finding remediation" key={finding.id}>
              <div>
                <code>{finding.id}</code>
                <span className={`status ${tone(finding.state)}`}>
                  {statusLabel(finding.state)}
                </span>
              </div>
              <strong>
                {finding.remediation ??
                  `依 ${finding.controlId} 蒐集具名證據並完成重驗。`}
              </strong>
              <span>
                Finding closure只接受同一 run
                的approval、validation、recollected evidence與closing actor。
              </span>
              <button
                className="secondary-button"
                onClick={() => onDraftRemediation(finding)}
              >
                草擬唯讀修復計畫
              </button>
            </article>
          ))}
        </section>
      )}

      {activeTab === "audit" && (
        <section
          className="panel audit-panel trust-panel"
          role="tabpanel"
          id="trust-panel-audit"
          aria-labelledby="trust-tab-audit"
        >
          <div className="panel-heading">
            <div>
              <span className="eyebrow">HASH-CHAINED TIMELINE</span>
              <h2>Audit events</h2>
            </div>
            <code>{correlationId}</code>
          </div>
          <table>
            <thead>
              <tr>
                <th>時間</th>
                <th>Actor</th>
                <th>Event</th>
                <th>Subject</th>
                <th>Hash</th>
              </tr>
            </thead>
            <tbody>
              {audit.map((row) => (
                <tr key={row.id}>
                  <td>{row.at}</td>
                  <td>{row.actor}</td>
                  <td>{row.action}</td>
                  <td>
                    <code>{row.subject}</code>
                  </td>
                  <td>
                    <code>{row.hash}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}

function SettingsScreen({
  mode,
  services,
  dataBoundary,
  onResetDemo,
}: {
  mode: "demo" | "local";
  services: { aura: ServiceState; codex: ServiceState };
  dataBoundary: DataBoundaryState;
  onResetDemo: () => void;
}) {
  const yesNoUnknown = (value: boolean | "unknown" | undefined) =>
    value === true ? "是" : value === false ? "否" : "待服務回報";
  const networkState =
    services.codex.network === undefined
      ? "待服務回報"
      : services.codex.network
        ? "on"
        : "off";
  return (
    <div className="screen settings-screen">
      <PageHeading
        eyebrow="LOCAL CONTROL PLANE"
        title="設定"
        detail="模式、bridges、repository 與資料生命週期都維持明確啟用狀態。"
      />
      <section className="panel settings-section">
        <h2>執行模式</h2>
        <label className="mode-option">
          <input type="radio" checked={mode === "demo"} readOnly />
          <span>
            <strong>Deterministic demo</strong>
            <small>使用合成資料、synthetic audio 與固定 agent events。</small>
          </span>
          <span className="mode-badge demo">READY</span>
        </label>
        <label className="mode-option">
          <input type="radio" checked={mode === "local"} readOnly />
          <span>
            <strong>Personal local</strong>
            <small>
              以 <code>pnpm dev</code> 明確啟動；需要兩個 loopback bridge
              與允許的 repository。
            </small>
          </span>
          <span
            className={`status ${mode === "local" ? "positive" : "neutral"}`}
          >
            {mode === "local" ? "ACTIVE" : "SEPARATE START"}
          </span>
        </label>
      </section>
      <section className="panel settings-section">
        <h2>Observed service status</h2>
        <dl className="settings-list">
          <div>
            <dt>AURA</dt>
            <dd>{services.aura.label}</dd>
          </div>
          <div>
            <dt>AURA Bridge</dt>
            <dd>server-owned loopback URL・browser 使用 typed proxy</dd>
          </div>
          <div>
            <dt>AURA capabilities</dt>
            <dd>read/search/audio span・validated claim review write</dd>
          </div>
          <div>
            <dt>Artifact root ready</dt>
            <dd>{yesNoUnknown(services.aura.artifactRootReady)}</dd>
          </div>
          <div>
            <dt>Evidence index ready</dt>
            <dd>{yesNoUnknown(services.aura.evidenceIndexReady)}</dd>
          </div>
          <div>
            <dt>Audit ready</dt>
            <dd>{yesNoUnknown(services.aura.auditReady)}</dd>
          </div>
          <div>
            <dt>Codex</dt>
            <dd>{services.codex.label}</dd>
          </div>
          <div>
            <dt>Installed</dt>
            <dd>{yesNoUnknown(services.codex.installed)}</dd>
          </div>
          <div>
            <dt>Signed in</dt>
            <dd>{yesNoUnknown(services.codex.signedIn)}</dd>
          </div>
          <div>
            <dt>Version</dt>
            <dd>{services.codex.version ?? "待服務回報"}</dd>
          </div>
          <div>
            <dt>Model / effort</dt>
            <dd>
              {services.codex.model ?? "待服務回報"} /{" "}
              {services.codex.effort ?? "待服務回報"}
            </dd>
          </div>
          <div>
            <dt>Sandbox / network</dt>
            <dd>
              {services.codex.sandbox ?? "待服務回報"} / {networkState}
            </dd>
          </div>
          <div>
            <dt>Active runs / app-server restarts</dt>
            <dd>
              {services.codex.activeRuns ?? 0} / {services.codex.restarts ?? 0}
            </dd>
          </div>
          <div>
            <dt>CODEX_HOME</dt>
            <dd>server-owned・瀏覽器不公開</dd>
          </div>
          <div>
            <dt>Repository roots</dt>
            <dd>server-owned allowlist・瀏覽器不公開</dd>
          </div>
          <div>
            <dt>VOISS_AGENT_DB_PATH</dt>
            <dd>server-owned・瀏覽器不公開</dd>
          </div>
          <div>
            <dt>VOISS_OBSERVABILITY_LOG</dt>
            <dd>server-owned・瀏覽器不公開</dd>
          </div>
        </dl>
        {mode === "local" &&
          (!services.codex.ready ||
            services.codex.installed !== true ||
            services.codex.signedIn !== true) && (
            <aside
              className="setup-guidance"
              aria-labelledby="codex-local-activation"
            >
              <h3 id="codex-local-activation">啟用 Codex 本機委派</h3>
              <p>
                本機委派會在官方 Codex client 已安裝並完成 ChatGPT 登入後啟用。
              </p>
              <ol>
                <li>
                  以 <code>codex --version</code> 確認安裝；尚未安裝時，依官方
                  Codex CLI 指引完成安裝。
                </li>
                <li>
                  在 terminal 執行 <code>codex</code>，使用官方 client 完成
                  ChatGPT 登入。
                </li>
                <li>啟動 Codex Bridge，再重新整理此頁確認登入與服務狀態。</li>
              </ol>
            </aside>
          )}
      </section>
      <section className="panel settings-section">
        <h2>Agent</h2>
        <dl className="settings-list">
          <div>
            <dt>Orchestrator backend</dt>
            <dd>
              CopilotKit Runtime・<code>voiss_orchestrator</code>
            </dd>
          </div>
          <div>
            <dt>Optional API credential</dt>
            <dd>P0 未啟用・官方 Codex subscription path 不需要 API key</dd>
          </div>
          <div>
            <dt>Tool allowlist</dt>
            <dd>
              AURA evidence read/review・Codex plan/run/resume/stop・validated
              export
            </dd>
          </div>
        </dl>
      </section>
      <section className="panel settings-section">
        <h2>Privacy</h2>
        <dl className="settings-list">
          <div>
            <dt>Data boundary</dt>
            <dd>
              <strong>{dataBoundary.label}</strong>・{dataBoundary.detail}
            </dd>
          </div>
          <div>
            <dt>Cloud model warning</dt>
            <dd>
              {dataBoundary.value === "cloud-enabled"
                ? "已啟用：reviewed action context 可由 signed-in Codex model 處理；raw AURA audio 保留在本機。"
                : "目前 cloud model path 尚未啟用；委派會在資料邊界確認後開放。"}
            </dd>
          </div>
          <div>
            <dt>Web origin</dt>
            <dd>
              <code>http://127.0.0.1:3000</code>
            </dd>
          </div>
          <div>
            <dt>AURA authority</dt>
            <dd>canonical artifacts + validated review logic</dd>
          </div>
          <div>
            <dt>Codex observed policy</dt>
            <dd>
              {services.codex.sandbox ?? "待服務回報"}・network {networkState}
              ・on-request approval
            </dd>
          </div>
          <div>
            <dt>Write boundary</dt>
            <dd>one isolated worktree per approved run</dd>
          </div>
          <div>
            <dt>Release authority</dt>
            <dd>local patch + evidence export</dd>
          </div>
          <div>
            <dt>Audit retention</dt>
            <dd>owner-controlled SQLite・redacted JSONL 採兩檔、每檔 5 MiB</dd>
          </div>
          <div>
            <dt>Export</dt>
            <dd>
              operator 明確啟動的 local manifest、patch、evidence 與 checksums
            </dd>
          </div>
        </dl>
      </section>
      <section className="panel settings-section">
        <h2>Developer</h2>
        <dl className="settings-list">
          <div>
            <dt>Event stream</dt>
            <dd>CopilotKit AG-UI・Codex Bridge NDJSON/SSE・cursor replay</dd>
          </div>
          <div>
            <dt>Raw diagnostics</dt>
            <dd>
              server-owned observability log・browser 僅呈現 bounded redacted
              events
            </dd>
          </div>
          <div>
            <dt>Fixture reset</dt>
            <dd>
              <button
                className="secondary-button"
                type="button"
                disabled={mode !== "demo"}
                onClick={onResetDemo}
              >
                重設 deterministic fixture
              </button>
              <small>
                {mode === "demo"
                  ? "重設 claim、action、run、approval、audit 與非敏感導覽狀態。"
                  : "Fixture reset 僅在 deterministic demo mode 啟用。"}
              </small>
            </dd>
          </div>
        </dl>
      </section>
      <section className="panel settings-section">
        <h2>必要環境變數</h2>
        <div className="code-list">
          <code>VOISS_MODE</code>
          <code>VOISS_WEB_ORIGINS</code>
          <code>AURA_BRIDGE_URL</code>
          <code>AURA_BRIDGE_TOKEN</code>
          <code>CODEX_BRIDGE_URL</code>
          <code>CODEX_BRIDGE_TOKEN</code>
          <code>VOISS_ALLOWED_REPOSITORIES</code>
          <code>VOISS_AGENT_DB_PATH</code>
          <code>VOISS_OBSERVABILITY_LOG</code>
        </div>
        <p className="scope-note">
          Token 與 Codex 認證保留在 server-side 或 Codex credential
          store，瀏覽器只接收正規化狀態。
        </p>
      </section>
    </div>
  );
}

function PageHeading({
  eyebrow,
  title,
  detail,
}: {
  eyebrow: string;
  title: string;
  detail: string;
}) {
  return (
    <div className="page-heading">
      <div>
        <span className="eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
      </div>
      <p>{detail}</p>
    </div>
  );
}
