import { EventType, type BaseEvent, type RunAgentInput } from "@ag-ui/client";
import { toArray } from "rxjs";
import { describe, expect, it } from "vitest";
import {
  CODEX_ACTIVITY_TYPES,
  CodexBridgeAgent,
  type CodexApprovalResumeRequest,
  type CodexBridgeEvent,
  type CodexBridgeTransport,
  type CodexRunRequest,
  redactSensitiveText,
} from "../src/index";

const input = (overrides: Partial<RunAgentInput> = {}): RunAgentInput => ({
  threadId: "agui-thread-1",
  runId: "agui-run-1",
  state: { mode: "local" },
  messages: [
    {
      id: "user-1",
      role: "user",
      content: "Inspect the repository and prepare a read-only plan.",
    },
  ],
  tools: [],
  context: [],
  forwardedProps: {},
  ...overrides,
});

const completedTurn = (): CodexBridgeEvent => ({
  method: "turn/completed",
  params: {
    threadId: "codex-thread-1",
    turn: {
      id: "codex-turn-1",
      status: "completed",
    },
  },
});

class FixtureTransport implements CodexBridgeTransport {
  readonly runRequests: CodexRunRequest[] = [];
  readonly resumeRequests: CodexApprovalResumeRequest[] = [];

  constructor(
    private readonly runEvents: readonly CodexBridgeEvent[],
    private readonly resumeEvents: readonly CodexBridgeEvent[] = [
      completedTurn(),
    ],
  ) {}

  async *startRun(request: CodexRunRequest): AsyncIterable<CodexBridgeEvent> {
    this.runRequests.push(request);
    yield* this.runEvents;
  }

  async *resumeApproval(
    request: CodexApprovalResumeRequest,
  ): AsyncIterable<CodexBridgeEvent> {
    this.resumeRequests.push(request);
    yield* this.resumeEvents;
  }
}

const collect = async (
  agent: CodexBridgeAgent,
  runInput: RunAgentInput,
): Promise<BaseEvent[]> =>
  await new Promise((resolve, reject) => {
    agent.run(runInput).pipe(toArray()).subscribe({
      next: resolve,
      error: reject,
    });
  });

describe("CodexBridgeAgent", () => {
  it("advertises isolated, resumable, approval-gated execution", async () => {
    const capabilities = await new CodexBridgeAgent().getCapabilities();

    expect(capabilities.transport).toMatchObject({
      streaming: true,
      resumable: true,
    });
    expect(capabilities.execution).toMatchObject({
      codeExecution: true,
      sandboxed: true,
    });
    expect(capabilities.humanInTheLoop).toMatchObject({
      approvals: true,
      interrupts: true,
    });
    expect(capabilities.custom).toMatchObject({
      networkDefault: "off",
      writeBoundary: "isolated_worktree",
      remoteActions: false,
    });
  });

  it("preserves its bridge transport when CopilotKit clones it per request", async () => {
    const transport = new FixtureTransport([completedTurn()]);
    const agent = new CodexBridgeAgent({ transport }).clone();

    const events = await collect(agent, input());

    expect(transport.runRequests).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({
      type: EventType.RUN_FINISHED,
      outcome: { type: "success" },
    });
  });

  it("redacts credentials and local absolute paths before browser delivery", () => {
    const redacted = redactSensitiveText(
      "token=secret-value cwd=/home/operator/private C:\\Users\\operator\\repo https://example.com/docs",
    );

    expect(redacted).toContain("token=[REDACTED]");
    expect(redacted).toContain("cwd=[LOCAL_PATH]");
    expect(redacted).toContain("[LOCAL_PATH]");
    expect(redacted).toContain("https://example.com/docs");
    expect(redacted).not.toContain("/home/operator");
    expect(redacted).not.toContain("C:\\Users");
  });

  it("normalizes the current Codex app-server event families into one AG-UI envelope", async () => {
    const transport = new FixtureTransport([
      {
        method: "thread/started",
        params: { thread: { id: "codex-thread-1" } },
      },
      {
        method: "turn/started",
        params: {
          threadId: "codex-thread-1",
          turn: { id: "codex-turn-1", status: "inProgress" },
        },
      },
      {
        method: "item/agentMessage/delta",
        params: {
          threadId: "codex-thread-1",
          turnId: "codex-turn-1",
          itemId: "message-1",
          delta: "Plan ready.",
        },
      },
      {
        method: "item/completed",
        params: {
          threadId: "codex-thread-1",
          turnId: "codex-turn-1",
          completedAtMs: 1,
          item: {
            type: "agentMessage",
            id: "message-1",
            text: "Plan ready.",
          },
        },
      },
      {
        method: "turn/plan/updated",
        params: {
          threadId: "codex-thread-1",
          turnId: "codex-turn-1",
          explanation: "Inspect before changing files.",
          plan: [{ step: "Inspect", status: "completed" }],
        },
      },
      {
        method: "item/plan/delta",
        params: {
          threadId: "codex-thread-1",
          turnId: "codex-turn-1",
          itemId: "plan-1",
          delta: "Inspect /home/operator/private ",
        },
      },
      {
        method: "item/plan/delta",
        params: {
          threadId: "codex-thread-1",
          turnId: "codex-turn-1",
          itemId: "plan-1",
          delta: "then validate.",
        },
      },
      {
        method: "item/started",
        params: {
          threadId: "codex-thread-1",
          turnId: "codex-turn-1",
          startedAtMs: 2,
          item: {
            type: "commandExecution",
            id: "command-1",
            command: "pnpm test",
            cwd: "/workspace",
            status: "inProgress",
          },
        },
      },
      {
        method: "item/commandExecution/outputDelta",
        params: {
          threadId: "codex-thread-1",
          turnId: "codex-turn-1",
          itemId: "command-1",
          delta: "12 tests passed",
        },
      },
      {
        method: "item/completed",
        params: {
          threadId: "codex-thread-1",
          turnId: "codex-turn-1",
          completedAtMs: 3,
          item: {
            type: "commandExecution",
            id: "command-1",
            command: "pnpm test",
            cwd: "/workspace",
            status: "completed",
            aggregatedOutput: "12 tests passed",
            exitCode: 0,
            durationMs: 50,
          },
        },
      },
      {
        method: "item/completed",
        params: {
          threadId: "codex-thread-1",
          turnId: "codex-turn-1",
          completedAtMs: 4,
          item: {
            type: "fileChange",
            id: "file-1",
            status: "completed",
            changes: [
              {
                path: "src/example.ts",
                kind: "update",
                diff: "+export const ready = true;",
              },
            ],
          },
        },
      },
      {
        method: "turn/diff/updated",
        params: {
          threadId: "codex-thread-1",
          turnId: "codex-turn-1",
          diff: "+export const ready = true;",
        },
      },
      completedTurn(),
    ]);
    const events = await collect(new CodexBridgeAgent({ transport }), input());

    expect(events[0]).toMatchObject({
      type: EventType.RUN_STARTED,
      threadId: "agui-thread-1",
      runId: "agui-run-1",
    });
    expect(events.at(-1)).toMatchObject({
      type: EventType.RUN_FINISHED,
      outcome: { type: "success" },
    });
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        EventType.STATE_SNAPSHOT,
        EventType.STEP_STARTED,
        EventType.TEXT_MESSAGE_START,
        EventType.TEXT_MESSAGE_CONTENT,
        EventType.TEXT_MESSAGE_END,
        EventType.TOOL_CALL_START,
        EventType.TOOL_CALL_ARGS,
        EventType.TOOL_CALL_END,
        EventType.TOOL_CALL_RESULT,
        EventType.STEP_FINISHED,
      ]),
    );
    const activityTypes = events
      .filter((event) => event.type === EventType.ACTIVITY_SNAPSHOT)
      .map((event) => event.activityType);
    expect(activityTypes).toEqual(
      expect.arrayContaining([
        CODEX_ACTIVITY_TYPES.plan,
        CODEX_ACTIVITY_TYPES.command,
        CODEX_ACTIVITY_TYPES.fileChange,
        CODEX_ACTIVITY_TYPES.diff,
      ]),
    );
    const streamedPlan = events
      .filter(
        (event) =>
          event.type === EventType.ACTIVITY_SNAPSHOT &&
          event.activityType === CODEX_ACTIVITY_TYPES.plan &&
          event.messageId === "agui-run-1:plan:plan-1",
      )
      .at(-1);
    expect(streamedPlan).toMatchObject({
      content: {
        text: "Inspect [LOCAL_PATH] then validate.",
        status: "inProgress",
      },
    });
  });

  it("pauses for approval and resumes the exact pending Codex request id", async () => {
    const transport = new FixtureTransport([
      {
        id: 47,
        method: "item/fileChange/requestApproval",
        params: {
          threadId: "codex-thread-1",
          turnId: "codex-turn-1",
          itemId: "file-1",
          startedAtMs: 10,
          reason: "Apply the reviewed patch.",
        },
      },
    ]);
    const agent = new CodexBridgeAgent({ transport });
    const interrupted = await collect(agent, input());
    const finished = interrupted.at(-1);

    expect(finished).toMatchObject({
      type: EventType.RUN_FINISHED,
      outcome: {
        type: "interrupt",
        interrupts: [
          {
            id: "codex-request:number:47",
            reason: "codex_file_change_approval",
          },
        ],
      },
    });

    const resumed = await collect(
      agent,
      input({
        runId: "agui-run-2",
        resume: [
          {
            interruptId: "codex-request:number:47",
            status: "resolved",
            payload: { decision: "allow_once" },
          },
        ],
      }),
    );

    expect(transport.resumeRequests).toEqual([
      {
        threadId: "agui-thread-1",
        runId: "agui-run-2",
        interruptId: "codex-request:number:47",
        pendingRequestId: 47,
        decision: "accept",
        authorizationScope: "once",
      },
    ]);
    expect(
      resumed.some(
        (event) =>
          event.type === EventType.ACTIVITY_SNAPSHOT &&
          event.activityType === CODEX_ACTIVITY_TYPES.approvalResponse,
      ),
    ).toBe(true);
    expect(resumed.at(-1)).toMatchObject({
      type: EventType.RUN_FINISHED,
      outcome: { type: "success" },
    });
  });

  it("surfaces unknown Codex methods without leaking their payload", async () => {
    const transport = new FixtureTransport([
      {
        method: "future/credential/rotated",
        params: {
          token: "must-not-reach-ag-ui",
          nested: { secret: "also-private" },
        },
      },
      completedTurn(),
    ]);
    const events = await collect(new CodexBridgeAgent({ transport }), input());
    const unknown = events.find(
      (event) =>
        event.type === EventType.ACTIVITY_SNAPSHOT &&
        event.activityType === CODEX_ACTIVITY_TYPES.unknown,
    );

    expect(unknown).toMatchObject({
      type: EventType.ACTIVITY_SNAPSHOT,
      content: {
        category: "unmapped",
        method: "future/credential/rotated",
      },
    });
    expect(JSON.stringify(unknown)).not.toContain("must-not-reach-ag-ui");
    expect(JSON.stringify(unknown)).not.toContain("also-private");
  });
});
