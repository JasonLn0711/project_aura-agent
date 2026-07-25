import type {
  AgentRun,
  MeetingSession,
  TrustAsset,
  TrustControl,
  Finding,
} from "@voiss/domain";

const occurredAt = "2026-07-24T06:00:00.000Z";
const source = (id: string, startMs: number, endMs: number) => ({
  id,
  kind: "segment" as const,
  locator: `aura://demo-voiss-aura-architecture-review/segments/${id}`,
  startMs,
  endMs,
});

export const demoClaimActionLinks = {
  "claim-queue": "action-bound-asr-queue",
  "claim-lock": "action-freeze-dependencies",
  "claim-model": "action-record-model-identity",
} as const;

export const demoSession: MeetingSession = {
  id: "demo-voiss-aura-architecture-review",
  title: "VOISS × AURA 架構與可信任執行檢視",
  occurredAt,
  participants: ["Max", "Jason", "AURA 團隊"],
  freshness: "fresh",
  audioUrl: "/demo/voiss-aura-architecture-review.wav",
  segments: [
    {
      id: "seg-001",
      speaker: "Max",
      startMs: 0,
      endMs: 8_400,
      status: "confirmed",
      text: "先把會議證據接到可追溯的工程執行；AURA 維持 local-first，音訊、逐字稿與覆核紀錄留在本機，每一個決策都要看得到來源。",
    },
    {
      id: "seg-002",
      speaker: "Jason",
      startMs: 8_400,
      endMs: 18_200,
      status: "confirmed",
      text: "ASR 工作佇列目前沒有容量上限；本輪先加入有界佇列、背壓與可驗收的壓力測試。",
    },
    {
      id: "seg-003",
      speaker: "AURA 團隊",
      startMs: 18_200,
      endMs: 28_000,
      status: "confirmed",
      text: "壓力尖峰時 ASR queue backlog 會持續累積；依賴與 CI 要使用 frozen lock，模型識別也要記錄 revision 或 digest，才能重現。",
    },
    {
      id: "seg-004",
      speaker: "Max",
      startMs: 28_000,
      endMs: 36_000,
      status: "confirmed",
      text: "目標設備的可用 GPU 與 peak VRAM 是否符合本機推論需求，保留為現場探測與長時壓測後回答的問題。",
    },
  ],
  claims: [
    {
      id: "claim-queue",
      field: "architecture_risk",
      text: "目前 ASR 工作佇列未設定容量上限。",
      status: "pending",
      evidence: [source("seg-002", 8_400, 18_200)],
    },
    {
      id: "claim-queue-backlog",
      field: "architecture_observation",
      text: "壓力尖峰時 ASR queue backlog 會持續累積。",
      status: "confirmed",
      evidence: [source("seg-003", 18_200, 28_000)],
    },
    {
      id: "claim-local-first",
      field: "architecture_decision",
      text: "AURA 的音訊、逐字稿與覆核紀錄採 local-first 邊界。",
      status: "confirmed",
      evidence: [source("seg-001", 0, 8_400)],
    },
    {
      id: "claim-lock",
      field: "release_control",
      text: "依賴安裝與 CI 需以 frozen lock 執行。",
      status: "confirmed",
      evidence: [source("seg-003", 18_200, 28_000)],
    },
    {
      id: "claim-model",
      field: "model_provenance",
      text: "模型 revision 或 digest 是可重現性驗收證據。",
      status: "confirmed",
      evidence: [source("seg-003", 18_200, 28_000)],
    },
    {
      id: "claim-gpu",
      field: "runtime_readiness",
      text: "目標設備具備可用 GPU。",
      status: "unsupported",
      rationale:
        "會議只保留 GPU 與 peak VRAM 的 open question，尚未提供設備探測證據或峰值遙測。",
      evidence: [],
    },
  ],
  actions: [
    {
      id: "action-bound-asr-queue",
      title: "限制 ASR 佇列並加入背壓",
      owner: "Jason",
      status: "proposed",
      support: "supported",
      workType: "engineering",
      dueDate: "2026-07-31",
      acceptance: [
        "佇列容量可設定",
        "壓力測試證明峰值期間不持續成長",
        "停止流程可回收等待中的工作",
      ],
      evidence: [source("seg-002", 8_400, 18_200)],
    },
    {
      id: "action-freeze-dependencies",
      title: "將 CI 與安裝流程對齊 frozen lock",
      owner: "Jason",
      status: "confirmed",
      support: "supported",
      workType: "engineering",
      acceptance: ["CI 使用 frozen lock", "乾淨環境安裝可重現"],
      evidence: [source("seg-003", 18_200, 28_000)],
    },
    {
      id: "action-record-model-identity",
      title: "記錄模型 revision 與 digest 狀態",
      owner: "AURA 團隊",
      status: "proposed",
      support: "partial",
      workType: "engineering",
      acceptance: ["報告呈現模型 ID、revision、digest 與 unknown 狀態"],
      evidence: [source("seg-003", 18_200, 28_000)],
    },
  ],
};

export const demoFixtureAssetMetadata = {
  id: "asset-demo-voiss-aura-architecture-review-audio",
  classification: "synthetic_audio",
  sourceBoundary: "sanitized_synthetic",
  url: demoSession.audioUrl,
  mediaType: "audio/wav",
  sha256: "ee9b3e3fdef5f3d8dbcba900a918f77e102aa665024abdbbb35d2cf087ebcd5b",
  durationMs: 36_000,
  sampleRateHz: 16_000,
  channels: 1,
  sampleWidthBits: 16,
  generation: "deterministic_tone",
  containsSpeech: false,
  containsPrivateMeetingData: false,
} as const;

export const demoScenarioBFixture = {
  id: "goal-prompt-scenario-b",
  classification: "deterministic_demo_evidence",
  sourceBoundary: "sanitized_synthetic",
  deterministic: true,
  sessionId: demoSession.id,
  occurredAt,
  localFirstDecision: {
    claimId: "claim-local-first",
    sourceSegmentIds: ["seg-001"],
  },
  gpuVramOpenQuestion: {
    claimId: "claim-gpu",
    sourceSegmentIds: ["seg-004"],
  },
  queueIssue: {
    claimIds: ["claim-queue", "claim-queue-backlog"],
    sourceSegmentIds: ["seg-002", "seg-003"],
  },
  assets: [demoFixtureAssetMetadata.id],
} as const;

export const demoRun: AgentRun = {
  id: "run-demo-001",
  actionId: "action-bound-asr-queue",
  correlationId: "corr-demo-voiss-001",
  mode: "demo",
  modelRequested: "gpt-5.6-sol",
  modelObserved: "deterministic-demo-agent",
  effort: "max",
  status: "approval_required",
  worktree: "demo://worktrees/run-demo-001",
  events: [
    {
      id: "evt-001",
      runId: "run-demo-001",
      type: "plan",
      status: "completed",
      occurredAt: "2026-07-24T06:01:00.000Z",
      title: "唯讀計畫完成",
      detail: "追蹤佇列建立、producer、consumer、停止與測試路徑。",
    },
    {
      id: "evt-002",
      runId: "run-demo-001",
      type: "approval",
      status: "waiting",
      occurredAt: "2026-07-24T06:01:08.000Z",
      title: "等待一次性檔案變更核准",
      detail: "範圍：src/aura/asr/threads.py、tests/test_asr_threads.py",
    },
  ],
};

export const demoExpectedPatch = `diff --git a/src/aura/asr/threads.py b/src/aura/asr/threads.py
--- a/src/aura/asr/threads.py
+++ b/src/aura/asr/threads.py
@@ -237,1 +237,1 @@
-        self._work_queue = queue.Queue()
+        self._work_queue = queue.Queue(maxsize=self._queue_capacity)
`;

export const demoExpectedTests = [
  {
    command: "python -m unittest tests.test_asr_threads",
    status: "passed",
    summary: "12 tests passed",
  },
  {
    command: "git diff --check",
    status: "passed",
    summary: "no whitespace errors",
  },
] as const;

export const demoAssets: TrustAsset[] = [
  {
    id: "asset-aura",
    kind: "aura_runtime",
    name: "AURA application",
    state: "ready",
    evidence: [],
  },
  {
    id: "asset-evidence-index",
    kind: "aura_runtime",
    name: "AURA evidence index",
    state: "ready",
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
    id: "asset-codex",
    kind: "codex_runtime",
    name: "Codex CLI / app-server",
    state: "ready",
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
    state: "attention",
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
    state: "ready",
    evidence: [],
  },
  {
    id: "asset-session",
    kind: "session",
    name: demoSession.title,
    state: "ready",
    evidence: [],
  },
];

export const demoControls: TrustControl[] = [
  {
    id: "CTRL-AURA-001",
    title: "AURA runtime readiness",
    state: "pass",
    checkedAt: occurredAt,
    evidence: [],
  },
  {
    id: "CTRL-EVID-001",
    title: "Claim source completeness",
    state: "pass",
    checkedAt: occurredAt,
    evidence: [
      source("seg-002", 8_400, 18_200),
      source("seg-003", 18_200, 28_000),
    ],
  },
  {
    id: "CTRL-EVID-002",
    title: "Unsupported claim gate",
    state: "pass",
    checkedAt: occurredAt,
    evidence: [source("seg-004", 28_000, 36_000)],
  },
  {
    id: "CTRL-EVID-003",
    title: "Transcript-summary freshness",
    state: "pass",
    checkedAt: occurredAt,
    evidence: [],
  },
  {
    id: "CTRL-CODEX-001",
    title: "Codex authentication isolation",
    state: "pass",
    checkedAt: occurredAt,
    evidence: [],
  },
  {
    id: "CTRL-CODEX-002",
    title: "Worktree isolation",
    state: "pass",
    checkedAt: occurredAt,
    evidence: [],
  },
  {
    id: "CTRL-CODEX-003",
    title: "Default network denial",
    state: "pass",
    checkedAt: occurredAt,
    evidence: [],
  },
  {
    id: "CTRL-CODEX-004",
    title: "Consequential action approval",
    state: "pass",
    checkedAt: occurredAt,
    evidence: [],
  },
  {
    id: "CTRL-AUDIT-001",
    title: "Audit chain continuity",
    state: "unknown",
    checkedAt: occurredAt,
    evidence: [],
  },
  {
    id: "CTRL-SUPPLY-001",
    title: "Model identity evidence",
    state: "unknown",
    checkedAt: occurredAt,
    evidence: [],
  },
  {
    id: "CTRL-REPRO-001",
    title: "Frozen dependency path",
    state: "pass",
    checkedAt: occurredAt,
    evidence: [],
  },
];

export const demoFindings: Finding[] = [
  {
    id: "R-001",
    title: "TranscriptionTab god-controller 需要持續拆分 headless boundary",
    severity: "high",
    state: "open",
    controlId: "CTRL-AURA-001",
    evidence: [],
  },
  {
    id: "R-002",
    title: "ASR 工作佇列需要有界容量與背壓",
    severity: "high",
    state: "open",
    controlId: "CTRL-EVID-001",
    evidence: [
      source("seg-002", 8_400, 18_200),
      source("seg-003", 18_200, 28_000),
    ],
  },
  {
    id: "R-003",
    title: "CI 與啟動路徑採用 frozen lock",
    severity: "high",
    state: "remediated",
    controlId: "CTRL-REPRO-001",
    evidence: [source("seg-003", 18_200, 28_000)],
  },
  {
    id: "R-004",
    title: "模型 revision 與 digest 證據待下一層驗證",
    severity: "medium",
    state: "open",
    controlId: "CTRL-SUPPLY-001",
    evidence: [source("seg-003", 18_200, 28_000)],
  },
  {
    id: "R-006",
    title: "隱私 provenance 進入一致的機器可驗證路徑",
    severity: "high",
    state: "open",
    controlId: "CTRL-CODEX-001",
    evidence: [],
  },
  {
    id: "R-010",
    title: "Lint、typecheck 與 coverage threshold 納入 release evidence",
    severity: "medium",
    state: "open",
    controlId: "CTRL-REPRO-001",
    evidence: [source("seg-003", 18_200, 28_000)],
  },
];
