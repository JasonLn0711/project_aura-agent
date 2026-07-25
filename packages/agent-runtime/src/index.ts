import {
  AbstractAgent,
  EventType,
  type BaseEvent,
  type RunAgentInput,
} from "@ag-ui/client";
import {
  CodexBridgeAgent,
  type CodexBridgeTransport,
} from "@voiss/ag-ui-codex-adapter";
import {
  demoExpectedPatch,
  demoExpectedTests,
  demoRun,
  demoSession,
} from "@voiss/demo-fixtures";
import { from, mergeMap, Observable, of } from "rxjs";

export const VOISS_AGENT_IDS = {
  orchestrator: "voiss_orchestrator",
  codexEngineer: "codex_engineer",
  demo: "demo_agent",
} as const;

const identifier = { type: "string", minLength: 1, maxLength: 128 } as const;
const objectParameters = (
  properties: Record<string, unknown>,
  required: string[] = [],
) => ({
  type: "object",
  additionalProperties: false,
  properties,
  required,
});

export const VOISS_TOOL_CONTRACTS = {
  searchEvidence: {
    description:
      "Search current meeting, segment, action, or aggregate evidence.",
    parameters: objectParameters(
      {
        query: { type: "string", minLength: 1, maxLength: 500 },
        scope: { enum: ["meetings", "segments", "actions", "all"] },
        limit: { type: "integer", minimum: 1, maximum: 50 },
      },
      ["query"],
    ),
  },
  getSession: {
    description: "Read one canonical AURA session.",
    parameters: objectParameters({ sessionId: identifier }, ["sessionId"]),
  },
  getClaimEvidence: {
    description: "Read a claim and its current supporting evidence.",
    parameters: objectParameters(
      {
        sessionId: identifier,
        claimId: identifier,
      },
      ["sessionId", "claimId"],
    ),
  },
  reviewClaim: {
    description:
      "Submit a bounded claim review through trusted operator controls.",
    parameters: objectParameters(
      {
        sessionId: identifier,
        claimId: identifier,
        decision: { enum: ["confirmed", "rejected", "edited"] },
        editedText: { type: "string", maxLength: 2_000 },
      },
      ["sessionId", "claimId", "decision"],
    ),
  },
  getConfirmedActions: {
    description: "List confirmed actions eligible for evidence review.",
    parameters: objectParameters({ meetingId: identifier }),
  },
  openAudioSpan: {
    description: "Open a validated source-audio span for review.",
    parameters: objectParameters(
      {
        meetingId: identifier,
        startMs: { type: "integer", minimum: 0 },
        endMs: { type: "integer", minimum: 1 },
        track: { type: "string", maxLength: 128 },
      },
      ["meetingId", "startMs", "endMs"],
    ),
  },
  draftCodexGoal: {
    description:
      "Draft a source-linked engineering goal without writing files.",
    parameters: objectParameters(
      {
        actionId: identifier,
        repositoryId: identifier,
      },
      ["actionId", "repositoryId"],
    ),
  },
  startCodexPlan: {
    description: "Start an isolated, network-off, read-only Codex plan.",
    parameters: objectParameters(
      {
        goal: { type: "string", minLength: 1, maxLength: 8_000 },
        repositoryId: identifier,
        sourceEvidenceRefs: {
          type: "array",
          minItems: 1,
          maxItems: 64,
          items: { type: "string", minLength: 1, maxLength: 512 },
        },
      },
      ["goal", "repositoryId", "sourceEvidenceRefs"],
    ),
  },
  requestRunWriteApproval: {
    description: "Request a named write scope for one isolated run.",
    parameters: objectParameters(
      {
        runId: identifier,
        scope: {
          type: "array",
          minItems: 1,
          maxItems: 64,
          items: { type: "string", minLength: 1, maxLength: 512 },
        },
      },
      ["runId", "scope"],
    ),
  },
  respondToApproval: {
    description: "Record one trusted operator approval decision.",
    parameters: objectParameters(
      {
        approvalId: identifier,
        decision: { enum: ["allow_once", "allow_run_scope", "deny"] },
      },
      ["approvalId", "decision"],
    ),
  },
  stopAgentRun: {
    description: "Stop one active agent run.",
    parameters: objectParameters({ runId: identifier }, ["runId"]),
  },
  exportRunEvidence: {
    description: "Export a validated run evidence packet.",
    parameters: objectParameters(
      {
        runId: identifier,
        format: { enum: ["markdown", "json", "zip", "patch"] },
      },
      ["runId", "format"],
    ),
  },
  runControls: {
    description: "Evaluate selected trust controls or assets.",
    parameters: objectParameters({
      controlIds: { type: "array", maxItems: 64, items: identifier },
      assetIds: { type: "array", maxItems: 64, items: identifier },
    }),
  },
  listFindings: {
    description: "List trust findings by bounded status or severity.",
    parameters: objectParameters({
      status: { type: "string", maxLength: 32 },
      severity: { enum: ["low", "medium", "high", "critical"] },
    }),
  },
  draftRemediation: {
    description: "Draft a remediation plan for one finding.",
    parameters: objectParameters({ findingId: identifier }, ["findingId"]),
  },
  closeFinding: {
    description:
      "Request deterministic finding closure from validated evidence.",
    parameters: objectParameters(
      {
        findingId: identifier,
        evidenceRefs: {
          type: "array",
          minItems: 1,
          maxItems: 64,
          items: { type: "string", minLength: 1, maxLength: 512 },
        },
      },
      ["findingId", "evidenceRefs"],
    ),
  },
} as const;

type VoissToolName = keyof typeof VOISS_TOOL_CONTRACTS;

export const ORCHESTRATOR_ACTIVITY_SCHEMA = "voiss.orchestrator.evidence.v1";

export type OrchestratorIntent =
  | "readiness"
  | "demo_data"
  | "unconfirmed_claims"
  | "unsupported_actions"
  | "max_commitments"
  | "r002_plan"
  | "codex_diff_review"
  | "evidence_export"
  | "consequential_action"
  | "evidence_route";

export type OrchestratorResolution = {
  schema: typeof ORCHESTRATOR_ACTIVITY_SCHEMA;
  intent: OrchestratorIntent;
  mode: "demo" | "local";
  summary: string;
  facts: Array<{
    label: string;
    value: string | number | boolean;
  }>;
  evidenceRefs: string[];
  scopeControls: {
    readOnly: true;
    mutationExecuted: false;
    nextAction: string;
  };
};

export type OrchestratorResolver = (
  input: RunAgentInput,
) => OrchestratorResolution | Promise<OrchestratorResolution>;

type ScriptedAgentOptions = {
  agentId: (typeof VOISS_AGENT_IDS)[keyof typeof VOISS_AGENT_IDS];
  description: string;
  activityType: string;
  stepName: string;
  tools: readonly VoissToolName[];
  content: (input: RunAgentInput) => Record<string, unknown>;
  message: (input: RunAgentInput) => string;
};

/**
 * Credential-free deterministic agent used for local orchestration and demos.
 */
class ScriptedAgent extends AbstractAgent {
  constructor(protected readonly options: ScriptedAgentOptions) {
    super({
      agentId: options.agentId,
      description: options.description,
    });
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    return of(
      ...this.events(
        input,
        this.options.content(input),
        this.options.message(input),
      ),
    );
  }

  protected events(
    input: RunAgentInput,
    content: Record<string, unknown>,
    message: string,
  ): BaseEvent[] {
    const messageId = `${this.options.agentId}:${input.runId}:message`;
    const activityId = `${this.options.agentId}:${input.runId}:activity`;
    return [
      {
        type: EventType.RUN_STARTED,
        threadId: input.threadId,
        runId: input.runId,
        parentRunId: input.parentRunId,
      },
      {
        type: EventType.ACTIVITY_SNAPSHOT,
        messageId: activityId,
        activityType: this.options.activityType,
        content,
        replace: true,
      },
      {
        type: EventType.STEP_STARTED,
        stepName: this.options.stepName,
      },
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId,
        role: "assistant",
      },
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId,
        delta: message,
      },
      {
        type: EventType.TEXT_MESSAGE_END,
        messageId,
      },
      {
        type: EventType.STEP_FINISHED,
        stepName: this.options.stepName,
      },
      {
        type: EventType.RUN_FINISHED,
        threadId: input.threadId,
        runId: input.runId,
        outcome: { type: "success" },
      },
    ];
  }

  async getCapabilities() {
    return {
      identity: {
        type: "voiss_control_room_agent",
        name: this.options.agentId,
        version: "1",
        description: this.options.description,
      },
      tools: {
        supported: this.options.tools.length > 0,
        clientProvided: false,
        parallelCalls: false,
        items: this.options.tools.map((name) => ({
          name,
          ...VOISS_TOOL_CONTRACTS[name],
        })),
      },
      state: {
        snapshots: true,
        deltas: false,
        persistentState: true,
      },
      transport: {
        streaming: true,
        resumable: true,
      },
      humanInTheLoop: {
        supported: true,
        approvals: true,
      },
    };
  }
}

export class DemoAgent extends ScriptedAgent {
  constructor() {
    super({
      agentId: VOISS_AGENT_IDS.demo,
      description:
        "Replays the sanitized VOISS AURA evidence-to-execution fixture without credentials or external services.",
      activityType: "voiss.demo.run.v1",
      stepName: "replay-deterministic-demo",
      tools: [
        "getSession",
        "getClaimEvidence",
        "getConfirmedActions",
        "openAudioSpan",
        "listFindings",
        "runControls",
        "exportRunEvidence",
      ],
      content: () => ({
        mode: "demo",
        sessionId: demoSession.id,
        runId: demoRun.id,
        actionId: demoRun.actionId,
        runStatus: demoRun.status,
        expectedPatch: demoExpectedPatch,
        expectedTests: demoExpectedTests,
        classification: "deterministic_fixture",
      }),
      message: () =>
        "示範資料已就緒：會議證據、確認行動、唯讀計畫、核准節點、預期差異與測試證據可完整重播。",
    });
  }
}

export class VoissOrchestratorAgent extends ScriptedAgent {
  constructor(
    private readonly resolver: OrchestratorResolver = resolveDemoOrchestrator,
  ) {
    super({
      agentId: VOISS_AGENT_IDS.orchestrator,
      description:
        "Prepares a safe evidence-to-execution route using local state and trusted UI controls.",
      activityType: ORCHESTRATOR_ACTIVITY_SCHEMA,
      stepName: "prepare-safe-delegation-route",
      tools: [
        "searchEvidence",
        "getSession",
        "getClaimEvidence",
        "getConfirmedActions",
        "draftCodexGoal",
        "runControls",
        "listFindings",
        "draftRemediation",
      ],
      content: () => ({}),
      message: () => "",
    });
  }

  override run(input: RunAgentInput): Observable<BaseEvent> {
    return from(Promise.resolve(this.resolver(input))).pipe(
      mergeMap((result) =>
        of(...this.events(input, result, orchestratorMessage(result))),
      ),
    );
  }
}

export class CodexEngineerAgent extends CodexBridgeAgent {
  constructor(transport?: CodexBridgeTransport) {
    super({
      agentId: VOISS_AGENT_IDS.codexEngineer,
      description:
        "Plans, implements, tests, and reports reviewed work through the loopback VOISS Codex Bridge.",
      transport,
    });
  }
}

export const voiss_orchestrator = new VoissOrchestratorAgent();
export const codex_engineer = new CodexEngineerAgent();
export const demo_agent = new DemoAgent();

export function createNamedAgents(
  options: {
    codexTransport?: CodexBridgeTransport;
    orchestratorResolver?: OrchestratorResolver;
  } = {},
): Record<
  (typeof VOISS_AGENT_IDS)[keyof typeof VOISS_AGENT_IDS],
  AbstractAgent
> {
  return {
    [VOISS_AGENT_IDS.orchestrator]: new VoissOrchestratorAgent(
      options.orchestratorResolver,
    ),
    [VOISS_AGENT_IDS.codexEngineer]: new CodexEngineerAgent(
      options.codexTransport,
    ),
    [VOISS_AGENT_IDS.demo]: new DemoAgent(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function classifyOrchestratorIntent(
  input: RunAgentInput,
): OrchestratorIntent {
  const prompt = lastUserPrompt(input).toLocaleLowerCase("zh-TW");
  if (/就緒|準備度|readiness|service status|health/.test(prompt)) {
    return "readiness";
  }
  if (/示範|demo|fixture/.test(prompt)) return "demo_data";
  if (/未確認.*claim|unconfirmed claim|待確認.*主張/.test(prompt)) {
    return "unconfirmed_claims";
  }
  if (
    /沒有.*來源|無來源|without source|unsupported action|缺少.*證據/.test(
      prompt,
    )
  ) {
    return "unsupported_actions";
  }
  if (/max/.test(prompt) && /承諾|commitment|決定|decision/.test(prompt)) {
    return "max_commitments";
  }
  if (/r-?002|有界佇列|bounded queue/.test(prompt)) return "r002_plan";
  if (/codex.*diff|diff.*codex|差異/.test(prompt)) {
    return "codex_diff_review";
  }
  if (/匯出|export/.test(prompt)) return "evidence_export";
  if (
    /部署|deploy|push|merge|傳送|send|刪除|delete|核准|approve|寫入|write/.test(
      prompt,
    )
  ) {
    return "consequential_action";
  }
  return "evidence_route";
}

export function lastUserPrompt(input: RunAgentInput): string {
  for (let index = input.messages.length - 1; index >= 0; index -= 1) {
    const message = input.messages[index];
    if (message?.role !== "user") continue;
    if (typeof message.content === "string")
      return message.content.slice(0, 2_000);
  }
  return "";
}

function inputMode(input: RunAgentInput): "demo" | "local" {
  return isRecord(input.state) && input.state.mode === "local"
    ? "local"
    : "demo";
}

function selectedEvidenceRefs(input: RunAgentInput): string[] {
  if (
    !isRecord(input.state) ||
    !Array.isArray(input.state.sourceEvidenceRefs)
  ) {
    return [];
  }
  return input.state.sourceEvidenceRefs
    .filter((item): item is string => typeof item === "string")
    .slice(0, 64);
}

function resolveDemoOrchestrator(input: RunAgentInput): OrchestratorResolution {
  const intent = classifyOrchestratorIntent(input);
  const claimRows = demoSession.claims.filter(
    (claim) => claim.status !== "confirmed",
  );
  const unsupportedActions = demoSession.actions.filter(
    (action) =>
      action.evidence.length === 0 || action.support === "unsupported",
  );
  const maxSegments = demoSession.segments.filter(
    (segment) => segment.speaker === "Max",
  );
  const evidenceRefs = selectedEvidenceRefs(input);
  const base = {
    schema: ORCHESTRATOR_ACTIVITY_SCHEMA,
    intent,
    mode: inputMode(input),
    scopeControls: {
      readOnly: true,
      mutationExecuted: false,
      nextAction: "使用可信任 Control Room 控制項啟動任何狀態變更。",
    },
  } as const;
  if (intent === "readiness") {
    return {
      ...base,
      summary: "示範服務與證據 fixture 已就緒，可重播完整唯讀流程。",
      facts: [
        { label: "session_count", value: 1 },
        { label: "claim_count", value: demoSession.claims.length },
        { label: "run_status", value: demoRun.status },
      ],
      evidenceRefs: [`aura-session:${demoSession.id}`, "demo-run:run-demo-001"],
    };
  }
  if (intent === "unconfirmed_claims") {
    return {
      ...base,
      summary: `目前有 ${claimRows.length} 個尚待確認或缺少支持的主張。`,
      facts: claimRows.slice(0, 20).map((claim) => ({
        label: claim.id,
        value: claim.status,
      })),
      evidenceRefs: claimRows.flatMap((claim) =>
        claim.evidence.map((item) => item.locator),
      ),
    };
  }
  if (intent === "unsupported_actions") {
    return {
      ...base,
      summary: `目前有 ${unsupportedActions.length} 個 action 缺少可委派來源證據。`,
      facts: unsupportedActions.map((action) => ({
        label: action.id,
        value: action.support,
      })),
      evidenceRefs: [`aura-session:${demoSession.id}`],
    };
  }
  if (intent === "max_commitments") {
    return {
      ...base,
      summary: `找到 ${maxSegments.length} 段 Max 的來源發言，供承諾與決策覆核。`,
      facts: maxSegments.map((segment) => ({
        label: segment.id,
        value: segment.text,
      })),
      evidenceRefs: maxSegments.map(
        (segment) => `aura-segment:${demoSession.id}/${segment.id}`,
      ),
    };
  }
  if (intent === "r002_plan") {
    return {
      ...base,
      summary:
        "R-002 的唯讀計畫聚焦有界容量、背壓、持久音訊、provisional 行為、遙測與相關測試證據。",
      facts: [
        { label: "finding", value: "R-002" },
        { label: "state", value: "open" },
      ],
      evidenceRefs: [
        "trust-finding:R-002",
        "aura-segment:demo-voiss-aura-architecture-review/seg-002",
      ],
    };
  }
  if (
    intent === "evidence_export" ||
    intent === "consequential_action" ||
    intent === "codex_diff_review"
  ) {
    return {
      ...base,
      summary:
        "此操作由 Agent Runs 的可信任靜態控制項承接；orchestrator 已保留為唯讀，尚未執行狀態變更。",
      facts: [{ label: "requested_intent", value: intent }],
      evidenceRefs:
        evidenceRefs.length > 0 ? evidenceRefs : [`demo-run:${demoRun.id}`],
    };
  }
  return {
    ...base,
    summary: "已依目前選取內容整理來源證據與安全委派路徑。",
    facts: [
      { label: "session_id", value: demoSession.id },
      {
        label: "route",
        value: "evidence → goal → read-only plan → trusted approval",
      },
    ],
    evidenceRefs:
      evidenceRefs.length > 0
        ? evidenceRefs
        : [`aura-session:${demoSession.id}`],
  };
}

function orchestratorMessage(result: OrchestratorResolution): string {
  const references = result.evidenceRefs.slice(0, 3).join("、");
  return references ? `${result.summary} 證據：${references}` : result.summary;
}
