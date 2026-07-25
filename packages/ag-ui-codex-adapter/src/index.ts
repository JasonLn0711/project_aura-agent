import {
  AbstractAgent,
  EventType,
  type BaseEvent,
  type ResumeEntry,
  type RunAgentInput,
} from "@ag-ui/client";
import { Observable } from "rxjs";
import { z } from "zod";

export const CODEX_ACTIVITY_TYPES = {
  run: "voiss.codex.run.v1",
  plan: "voiss.codex.plan.v1",
  command: "voiss.codex.command.v1",
  fileChange: "voiss.codex.file_change.v1",
  diff: "voiss.codex.diff.v1",
  approvalRequest: "voiss.approval.request.v1",
  approvalResponse: "voiss.approval.response.v1",
  unknown: "voiss.codex.unknown_event.v1",
} as const;

const CodexRequestIdSchema = z.union([z.string(), z.number()]);
const JsonRecordSchema = z.record(z.string(), z.unknown());

export const CodexBridgeEventSchema = z
  .object({
    method: z.string(),
    params: JsonRecordSchema.default({}),
    id: CodexRequestIdSchema.optional(),
  })
  .passthrough();

export type CodexRequestId = z.infer<typeof CodexRequestIdSchema>;
export type CodexBridgeEvent = z.infer<typeof CodexBridgeEventSchema>;

export type CodexRunRequest = {
  threadId: string;
  runId: string;
  messages: RunAgentInput["messages"];
  state: unknown;
  forwardedProps: unknown;
};

export type CodexApprovalDecision = "accept" | "decline" | "cancel";

export type CodexApprovalResumeRequest = {
  threadId: string;
  runId: string;
  interruptId: string;
  pendingRequestId: CodexRequestId;
  decision: CodexApprovalDecision;
  authorizationScope: "once" | "run" | "none";
};

export interface CodexBridgeTransport {
  startRun(
    request: CodexRunRequest,
    signal?: AbortSignal,
  ): AsyncIterable<CodexBridgeEvent>;
  resumeApproval(
    request: CodexApprovalResumeRequest,
    signal?: AbortSignal,
  ): AsyncIterable<CodexBridgeEvent>;
}

export type HttpCodexBridgeTransportOptions = {
  runEndpoint: string | URL;
  resumeEndpoint: string | URL;
  headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>);
  fetch?: typeof globalThis.fetch;
};

export class CodexBridgeTransportError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "CodexBridgeTransportError";
  }
}

/**
 * Server-side HTTP boundary for the loopback VOISS Codex Bridge.
 *
 * Both endpoints return newline-delimited JSON or SSE `data:` records carrying
 * the bridge's normalized app-server `{method, params, id?}` envelope.
 */
export class HttpCodexBridgeTransport implements CodexBridgeTransport {
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(private readonly options: HttpCodexBridgeTransportOptions) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  async *startRun(
    request: CodexRunRequest,
    signal?: AbortSignal,
  ): AsyncIterable<CodexBridgeEvent> {
    yield* this.postStream(this.options.runEndpoint, request, signal);
  }

  async *resumeApproval(
    request: CodexApprovalResumeRequest,
    signal?: AbortSignal,
  ): AsyncIterable<CodexBridgeEvent> {
    yield* this.postStream(this.options.resumeEndpoint, request, signal);
  }

  private async *postStream(
    endpoint: string | URL,
    body: unknown,
    signal?: AbortSignal,
  ): AsyncIterable<CodexBridgeEvent> {
    const configuredHeaders =
      typeof this.options.headers === "function"
        ? await this.options.headers()
        : this.options.headers;
    const headers = new Headers(configuredHeaders);
    headers.set("accept", "application/x-ndjson, text/event-stream");
    headers.set("content-type", "application/json");

    const response = await this.fetchImpl(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      throw new CodexBridgeTransportError(
        `Codex Bridge returned HTTP ${response.status}.`,
        response.status,
      );
    }
    if (!response.body) {
      throw new CodexBridgeTransportError(
        "Codex Bridge returned no event stream.",
        response.status,
      );
    }

    for await (const line of readUtf8Lines(response.body)) {
      const payload = line.startsWith("data:")
        ? line.slice("data:".length).trim()
        : line.trim();
      if (
        payload.length === 0 ||
        payload === "[DONE]" ||
        payload.startsWith(":") ||
        payload.startsWith("event:") ||
        payload.startsWith("id:")
      ) {
        continue;
      }

      let decoded: unknown;
      try {
        decoded = JSON.parse(payload);
      } catch {
        throw new CodexBridgeTransportError(
          "Codex Bridge emitted malformed JSON.",
        );
      }
      yield parseCodexBridgeEvent(decoded);
    }
  }
}

async function* readUtf8Lines(
  stream: ReadableStream<Uint8Array>,
): AsyncIterable<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let reachedEnd = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        reachedEnd = true;
        break;
      }
      buffered += decoder.decode(value, { stream: true });
      let newline = buffered.indexOf("\n");
      while (newline >= 0) {
        yield buffered.slice(0, newline).replace(/\r$/, "");
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf("\n");
      }
    }
    buffered += decoder.decode();
    if (buffered.length > 0) {
      yield buffered.replace(/\r$/, "");
    }
  } finally {
    if (!reachedEnd) {
      await reader.cancel().catch(() => undefined);
    }
    reader.releaseLock();
  }
}

export function parseCodexBridgeEvent(value: unknown): CodexBridgeEvent {
  if (
    isRecord(value) &&
    (value.kind === "notification" || value.kind === "server_request") &&
    isRecord(value.event)
  ) {
    return CodexBridgeEventSchema.parse(value.event);
  }
  return CodexBridgeEventSchema.parse(value);
}

const INTERRUPT_PREFIX = "codex-request:";

export function encodePendingRequestId(id: CodexRequestId): string {
  const kind = typeof id === "number" ? "number" : "string";
  return `${INTERRUPT_PREFIX}${kind}:${encodeURIComponent(String(id))}`;
}

export function decodePendingRequestId(interruptId: string): CodexRequestId {
  const match = /^codex-request:(number|string):(.*)$/.exec(interruptId);
  if (!match) {
    throw new Error("The interrupt is not a Codex approval request.");
  }
  const decoded = decodeURIComponent(match[2]);
  if (match[1] === "number") {
    const numeric = Number(decoded);
    if (!Number.isFinite(numeric)) {
      throw new Error("The Codex approval request id is invalid.");
    }
    return numeric;
  }
  return decoded;
}

const ApprovalPayloadSchema = z.object({
  decision: z.enum(["allow_once", "allow_run_scope", "deny"]),
});

export function approvalResumeRequest(
  input: Pick<RunAgentInput, "threadId" | "runId">,
  resume: ResumeEntry,
): CodexApprovalResumeRequest {
  const pendingRequestId = decodePendingRequestId(resume.interruptId);
  const run = { threadId: input.threadId, runId: input.runId };
  if (resume.status === "cancelled") {
    return {
      ...run,
      interruptId: resume.interruptId,
      pendingRequestId,
      decision: "cancel",
      authorizationScope: "none",
    };
  }

  const payload = ApprovalPayloadSchema.parse(resume.payload);
  if (payload.decision === "deny") {
    return {
      ...run,
      interruptId: resume.interruptId,
      pendingRequestId,
      decision: "decline",
      authorizationScope: "none",
    };
  }

  return {
    ...run,
    interruptId: resume.interruptId,
    pendingRequestId,
    // Run-scoped authorization stays in the bridge policy store. The response
    // to this exact Codex request remains the narrow `accept` decision.
    decision: "accept",
    authorizationScope: payload.decision === "allow_run_scope" ? "run" : "once",
  };
}

type NormalizedBatch = {
  events: BaseEvent[];
  terminal: boolean;
};

type NormalizerContext = {
  input: RunAgentInput;
};

export class CodexEventNormalizer {
  private readonly openMessages = new Set<string>();
  private readonly commandOutput = new Map<string, string>();
  private readonly commandDetails = new Map<
    string,
    { command: string; cwd?: string }
  >();
  private readonly planText = new Map<string, string>();
  private unknownIndex = 0;
  private activeTurnStep: string | undefined;

  constructor(private readonly context: NormalizerContext) {}

  normalize(event: CodexBridgeEvent): NormalizedBatch {
    switch (event.method) {
      case "thread/started":
        return this.threadStarted(event);
      case "turn/started":
        return this.turnStarted(event);
      case "item/agentMessage/delta":
        return this.agentMessageDelta(event);
      case "item/plan/delta":
        return this.planDelta(event);
      case "turn/plan/updated":
        return this.planUpdated(event);
      case "item/started":
        return this.itemStarted(event);
      case "item/completed":
        return this.itemCompleted(event);
      case "item/commandExecution/outputDelta":
        return this.commandOutputDelta(event);
      case "item/fileChange/patchUpdated":
        return this.filePatchUpdated(event);
      case "turn/diff/updated":
        return this.diffUpdated(event);
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval":
        return this.approvalRequested(event);
      case "serverRequest/resolved":
        return this.serverRequestResolved(event);
      case "turn/completed":
        return this.turnCompleted(event);
      case "error":
        return this.runError(event);
      default:
        return this.unknownEvent(event);
    }
  }

  private threadStarted(event: CodexBridgeEvent): NormalizedBatch {
    const thread = recordAt(event.params, "thread");
    const codexThreadId =
      stringAt(thread, "id") ?? stringAt(event.params, "threadId") ?? null;
    const previousState = isRecord(this.context.input.state)
      ? this.context.input.state
      : {};

    return batch([
      {
        type: EventType.STATE_SNAPSHOT,
        snapshot: {
          ...previousState,
          activeRunId: this.context.input.runId,
          codexThreadId,
          codexRunStatus: "planning",
        },
      },
      this.activity(
        CODEX_ACTIVITY_TYPES.run,
        `${this.context.input.runId}:thread`,
        {
          status: "planning",
          codexThreadId,
        },
      ),
    ]);
  }

  private turnStarted(event: CodexBridgeEvent): NormalizedBatch {
    const turn = recordAt(event.params, "turn");
    const turnId =
      stringAt(turn, "id") ??
      stringAt(event.params, "turnId") ??
      "unknown-turn";
    this.activeTurnStep = `codex-turn:${turnId}`;

    return batch([
      {
        type: EventType.STEP_STARTED,
        stepName: this.activeTurnStep,
      },
      {
        type: EventType.STATE_DELTA,
        delta: [{ op: "add", path: "/codexRunStatus", value: "running" }],
      },
    ]);
  }

  private agentMessageDelta(event: CodexBridgeEvent): NormalizedBatch {
    const itemId = stringAt(event.params, "itemId") ?? "codex-message";
    const delta = redactSensitiveText(stringAt(event.params, "delta") ?? "");
    const events: BaseEvent[] = [];
    if (!this.openMessages.has(itemId)) {
      this.openMessages.add(itemId);
      events.push({
        type: EventType.TEXT_MESSAGE_START,
        messageId: itemId,
        role: "assistant",
      });
    }
    if (delta.length > 0) {
      events.push({
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: itemId,
        delta,
      });
    }
    return batch(events);
  }

  private planUpdated(event: CodexBridgeEvent): NormalizedBatch {
    const turnId = stringAt(event.params, "turnId") ?? "current";
    const plan = redactPlan(event.params.plan);
    return batch([
      this.activity(
        CODEX_ACTIVITY_TYPES.plan,
        `${this.context.input.runId}:plan:${turnId}`,
        {
          explanation: redactSensitiveText(
            stringAt(event.params, "explanation") ?? "",
          ),
          plan,
          status: "updated",
        },
      ),
      {
        type: EventType.STATE_DELTA,
        delta: [{ op: "add", path: "/codexRunStatus", value: "planning" }],
      },
    ]);
  }

  private planDelta(event: CodexBridgeEvent): NormalizedBatch {
    const itemId = stringAt(event.params, "itemId") ?? "codex-plan";
    const text = `${this.planText.get(itemId) ?? ""}${redactSensitiveText(
      stringAt(event.params, "delta") ?? "",
    )}`.slice(0, 16_000);
    this.planText.set(itemId, text);
    return batch([
      this.activity(
        CODEX_ACTIVITY_TYPES.plan,
        `${this.context.input.runId}:plan:${itemId}`,
        { text, status: "inProgress" },
      ),
    ]);
  }

  private itemStarted(event: CodexBridgeEvent): NormalizedBatch {
    const item = recordAt(event.params, "item");
    const type = stringAt(item, "type");
    if (type === "agentMessage") {
      const itemId = stringAt(item, "id") ?? "codex-message";
      if (this.openMessages.has(itemId)) {
        return batch([]);
      }
      this.openMessages.add(itemId);
      return batch([
        {
          type: EventType.TEXT_MESSAGE_START,
          messageId: itemId,
          role: "assistant",
        },
      ]);
    }
    if (type === "commandExecution") {
      return this.commandStarted(item);
    }
    if (type === "fileChange") {
      return batch([this.fileChangeActivity(item, "inProgress")]);
    }
    if (type === "plan") {
      const itemId = stringAt(item, "id") ?? "item";
      this.planText.set(
        itemId,
        redactSensitiveText(stringAt(item, "text") ?? ""),
      );
      return batch([
        this.activity(
          CODEX_ACTIVITY_TYPES.plan,
          `${this.context.input.runId}:plan:${itemId}`,
          {
            text: this.planText.get(itemId) ?? "",
            status: "inProgress",
          },
        ),
      ]);
    }
    return this.unknownEvent({
      method: `${event.method}:${type ?? "unknown_item"}`,
      params: {},
    });
  }

  private itemCompleted(event: CodexBridgeEvent): NormalizedBatch {
    const item = recordAt(event.params, "item");
    const type = stringAt(item, "type");
    if (type === "agentMessage") {
      return this.agentMessageCompleted(item);
    }
    if (type === "commandExecution") {
      return this.commandCompleted(item);
    }
    if (type === "fileChange") {
      return batch([
        this.fileChangeActivity(item, stringAt(item, "status") ?? "completed"),
      ]);
    }
    if (type === "plan") {
      const itemId = stringAt(item, "id") ?? "item";
      const text =
        redactSensitiveText(stringAt(item, "text") ?? "") ||
        this.planText.get(itemId) ||
        "";
      this.planText.delete(itemId);
      return batch([
        this.activity(
          CODEX_ACTIVITY_TYPES.plan,
          `${this.context.input.runId}:plan:${itemId}`,
          {
            text,
            status: "completed",
          },
        ),
      ]);
    }
    return this.unknownEvent({
      method: `${event.method}:${type ?? "unknown_item"}`,
      params: {},
    });
  }

  private agentMessageCompleted(
    item: Record<string, unknown>,
  ): NormalizedBatch {
    const itemId = stringAt(item, "id") ?? "codex-message";
    const events: BaseEvent[] = [];
    if (!this.openMessages.has(itemId)) {
      this.openMessages.add(itemId);
      events.push({
        type: EventType.TEXT_MESSAGE_START,
        messageId: itemId,
        role: "assistant",
      });
      const text = redactSensitiveText(stringAt(item, "text") ?? "");
      if (text.length > 0) {
        events.push({
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: itemId,
          delta: text,
        });
      }
    }
    events.push({
      type: EventType.TEXT_MESSAGE_END,
      messageId: itemId,
    });
    this.openMessages.delete(itemId);
    return batch(events);
  }

  private commandStarted(item: Record<string, unknown>): NormalizedBatch {
    const itemId = stringAt(item, "id") ?? "codex-command";
    const command = redactSensitiveText(stringAt(item, "command") ?? "");
    const cwd = redactSensitiveText(stringAt(item, "cwd") ?? "");
    this.commandDetails.set(itemId, { command, cwd: cwd || undefined });
    this.commandOutput.set(itemId, "");

    return batch([
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: itemId,
        toolCallName: "codex_command",
      },
      {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: itemId,
        delta: JSON.stringify({ command, cwd: cwd || undefined }),
      },
      this.commandActivity(itemId, {
        command,
        cwd: cwd || undefined,
        output: "",
        status: stringAt(item, "status") ?? "inProgress",
      }),
    ]);
  }

  private commandOutputDelta(event: CodexBridgeEvent): NormalizedBatch {
    const itemId = stringAt(event.params, "itemId") ?? "codex-command";
    const previous = this.commandOutput.get(itemId) ?? "";
    const output =
      previous + redactSensitiveText(stringAt(event.params, "delta") ?? "");
    this.commandOutput.set(itemId, output);
    const details = this.commandDetails.get(itemId) ?? { command: "" };

    return batch([
      this.commandActivity(itemId, {
        ...details,
        output,
        status: "inProgress",
      }),
    ]);
  }

  private commandCompleted(item: Record<string, unknown>): NormalizedBatch {
    const itemId = stringAt(item, "id") ?? "codex-command";
    const details = this.commandDetails.get(itemId) ?? {
      command: redactSensitiveText(stringAt(item, "command") ?? ""),
      cwd: redactSensitiveText(stringAt(item, "cwd") ?? "") || undefined,
    };
    const output = redactSensitiveText(
      stringAt(item, "aggregatedOutput") ??
        this.commandOutput.get(itemId) ??
        "",
    );
    const status = stringAt(item, "status") ?? "completed";
    const result = {
      status,
      output,
      exitCode: numberAt(item, "exitCode"),
      durationMs: numberAt(item, "durationMs"),
    };
    this.commandDetails.delete(itemId);
    this.commandOutput.delete(itemId);

    return batch([
      {
        type: EventType.TOOL_CALL_END,
        toolCallId: itemId,
      },
      {
        type: EventType.TOOL_CALL_RESULT,
        messageId: `${itemId}:result`,
        toolCallId: itemId,
        content: JSON.stringify(result),
        role: "tool",
      },
      this.commandActivity(itemId, {
        ...details,
        ...result,
      }),
    ]);
  }

  private commandActivity(
    itemId: string,
    content: Record<string, unknown>,
  ): BaseEvent {
    return this.activity(
      CODEX_ACTIVITY_TYPES.command,
      `${this.context.input.runId}:command:${itemId}`,
      { itemId, ...content },
    );
  }

  private fileChangeActivity(
    item: Record<string, unknown>,
    fallbackStatus: string,
  ): BaseEvent {
    const itemId = stringAt(item, "id") ?? "codex-file-change";
    return this.activity(
      CODEX_ACTIVITY_TYPES.fileChange,
      `${this.context.input.runId}:file:${itemId}`,
      {
        itemId,
        status: stringAt(item, "status") ?? fallbackStatus,
        changes: redactFileChanges(item.changes),
      },
    );
  }

  private filePatchUpdated(event: CodexBridgeEvent): NormalizedBatch {
    const itemId = stringAt(event.params, "itemId") ?? "codex-file-change";
    return batch([
      this.activity(
        CODEX_ACTIVITY_TYPES.fileChange,
        `${this.context.input.runId}:file:${itemId}`,
        {
          itemId,
          status: "inProgress",
          patch: redactSensitiveText(
            stringAt(event.params, "patch") ??
              stringAt(event.params, "delta") ??
              "",
          ),
        },
      ),
    ]);
  }

  private diffUpdated(event: CodexBridgeEvent): NormalizedBatch {
    const turnId = stringAt(event.params, "turnId") ?? "current";
    return batch([
      this.activity(
        CODEX_ACTIVITY_TYPES.diff,
        `${this.context.input.runId}:diff:${turnId}`,
        {
          turnId,
          diff: redactSensitiveText(stringAt(event.params, "diff") ?? ""),
        },
      ),
    ]);
  }

  private approvalRequested(event: CodexBridgeEvent): NormalizedBatch {
    if (event.id === undefined) {
      return this.runErrorMessage(
        "Codex approval request is missing its request id.",
        "CODEX_APPROVAL_ID_MISSING",
      );
    }

    const isFileChange = event.method === "item/fileChange/requestApproval";
    const interruptId = encodePendingRequestId(event.id);
    const reason = isFileChange
      ? "codex_file_change_approval"
      : "codex_command_approval";
    const message =
      stringAt(event.params, "reason") ??
      (isFileChange
        ? "Review and approve this file change."
        : "Review and approve this command.");
    const events = this.closeOpenMessages();
    events.push(
      this.activity(
        CODEX_ACTIVITY_TYPES.approvalRequest,
        `${this.context.input.runId}:approval:${interruptId}`,
        {
          interruptId,
          requestType: event.method,
          itemId: stringAt(event.params, "itemId") ?? null,
          reason: redactSensitiveText(message),
          command: redactOptional(event.params.command),
          cwd: redactOptional(event.params.cwd),
          grantRoot: redactOptional(event.params.grantRoot),
        },
      ),
      {
        type: EventType.RUN_FINISHED,
        threadId: this.context.input.threadId,
        runId: this.context.input.runId,
        outcome: {
          type: "interrupt",
          interrupts: [
            {
              id: interruptId,
              reason,
              message: redactSensitiveText(message),
              responseSchema: {
                type: "object",
                properties: {
                  decision: {
                    type: "string",
                    enum: ["allow_once", "allow_run_scope", "deny"],
                  },
                },
                required: ["decision"],
                additionalProperties: false,
              },
              metadata: {
                pendingRequestId: event.id,
                requestMethod: event.method,
                itemId: stringAt(event.params, "itemId") ?? null,
              },
            },
          ],
        },
      },
    );
    return { events, terminal: true };
  }

  private serverRequestResolved(event: CodexBridgeEvent): NormalizedBatch {
    const requestId = event.params.requestId ?? event.params.id ?? "unknown";
    return batch([
      this.activity(
        CODEX_ACTIVITY_TYPES.approvalResponse,
        `${this.context.input.runId}:approval-response:${String(requestId)}`,
        {
          pendingRequestId: requestId,
          status: "resolved",
        },
      ),
    ]);
  }

  private turnCompleted(event: CodexBridgeEvent): NormalizedBatch {
    const turn = recordAt(event.params, "turn");
    const status = stringAt(turn, "status") ?? "completed";
    const events = this.closeOpenMessages();
    if (this.activeTurnStep) {
      events.push({
        type: EventType.STEP_FINISHED,
        stepName: this.activeTurnStep,
      });
      this.activeTurnStep = undefined;
    }

    if (status === "failed") {
      const error = recordAt(turn, "error");
      events.push({
        type: EventType.RUN_ERROR,
        message: redactSensitiveText(
          stringAt(error, "message") ?? "The Codex turn failed.",
        ),
        code: "CODEX_TURN_FAILED",
      });
      return { events, terminal: true };
    }

    if (status === "interrupted") {
      events.push(
        this.activity(
          CODEX_ACTIVITY_TYPES.run,
          `${this.context.input.runId}:stopped`,
          { status: "stopped" },
        ),
      );
    }
    events.push({
      type: EventType.RUN_FINISHED,
      threadId: this.context.input.threadId,
      runId: this.context.input.runId,
      result: { codexTurnStatus: status },
      outcome: { type: "success" },
    });
    return { events, terminal: true };
  }

  private runError(event: CodexBridgeEvent): NormalizedBatch {
    const error = recordAt(event.params, "error");
    return this.runErrorMessage(
      stringAt(error, "message") ??
        stringAt(event.params, "message") ??
        "Codex reported an error.",
      "CODEX_APP_SERVER_ERROR",
    );
  }

  private runErrorMessage(message: string, code: string): NormalizedBatch {
    return {
      events: [
        ...this.closeOpenMessages(),
        {
          type: EventType.RUN_ERROR,
          message: redactSensitiveText(message),
          code,
        },
      ],
      terminal: true,
    };
  }

  private unknownEvent(event: CodexBridgeEvent): NormalizedBatch {
    const index = this.unknownIndex++;
    return batch([
      this.activity(
        CODEX_ACTIVITY_TYPES.unknown,
        `${this.context.input.runId}:unknown:${index}`,
        {
          category: "unmapped",
          method: event.method,
        },
      ),
    ]);
  }

  private closeOpenMessages(): BaseEvent[] {
    const events: BaseEvent[] = [];
    for (const messageId of this.openMessages) {
      events.push({
        type: EventType.TEXT_MESSAGE_END,
        messageId,
      });
    }
    this.openMessages.clear();
    return events;
  }

  private activity(
    activityType: string,
    messageId: string,
    content: Record<string, unknown>,
  ): BaseEvent {
    return {
      type: EventType.ACTIVITY_SNAPSHOT,
      activityType,
      messageId,
      content,
      replace: true,
    };
  }
}

export type CodexBridgeAgentOptions = {
  transport?: CodexBridgeTransport;
  agentId?: string;
  description?: string;
};

export class CodexBridgeAgent extends AbstractAgent {
  private transport?: CodexBridgeTransport;

  constructor(options: CodexBridgeAgentOptions = {}) {
    super({
      agentId: options.agentId ?? "codex_engineer",
      description:
        options.description ??
        "Plans and executes reviewed engineering work through the local Codex Bridge.",
    });
    this.transport = options.transport;
  }

  override clone(): this {
    const cloned = super.clone() as this;
    cloned.transport = this.transport;
    return cloned;
  }

  async getCapabilities() {
    return {
      identity: {
        type: "voiss_codex_bridge_agent",
        name: this.agentId ?? "codex_engineer",
        version: "1",
        description: this.description,
      },
      state: {
        snapshots: true,
        deltas: true,
        persistentState: true,
      },
      transport: {
        streaming: true,
        resumable: true,
      },
      execution: {
        codeExecution: true,
        sandboxed: true,
      },
      humanInTheLoop: {
        supported: true,
        approvals: true,
        interventions: true,
        interrupts: true,
      },
      custom: {
        networkDefault: "off",
        writeBoundary: "isolated_worktree",
        remoteActions: false,
      },
    };
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable((subscriber) => {
      const controller = new AbortController();

      void this.streamRun(input, controller.signal, (event) => {
        if (!subscriber.closed) {
          subscriber.next(event);
        }
      })
        .catch((error: unknown) => {
          if (subscriber.closed || controller.signal.aborted) {
            return;
          }
          subscriber.next({
            type: EventType.RUN_ERROR,
            message: safeErrorMessage(error),
            code:
              error instanceof z.ZodError
                ? "CODEX_BRIDGE_CONTRACT_ERROR"
                : "CODEX_BRIDGE_ERROR",
          });
        })
        .finally(() => {
          if (!subscriber.closed) {
            subscriber.complete();
          }
        });

      return () => controller.abort();
    });
  }

  private async streamRun(
    input: RunAgentInput,
    signal: AbortSignal,
    emit: (event: BaseEvent) => void,
  ): Promise<void> {
    emit({
      type: EventType.RUN_STARTED,
      threadId: input.threadId,
      runId: input.runId,
      parentRunId: input.parentRunId,
    });

    if (!this.transport) {
      emit({
        type: EventType.RUN_ERROR,
        message:
          "Codex Bridge is not configured. Demo and orchestration agents remain available.",
        code: "CODEX_BRIDGE_UNAVAILABLE",
      });
      return;
    }

    const codexResumes = (input.resume ?? []).filter((entry) =>
      entry.interruptId.startsWith(INTERRUPT_PREFIX),
    );
    if (codexResumes.length > 1) {
      throw new Error("Only one Codex approval can be resumed per run.");
    }

    let stream: AsyncIterable<CodexBridgeEvent>;
    if (codexResumes.length === 1) {
      const request = approvalResumeRequest(input, codexResumes[0]);
      emit({
        type: EventType.ACTIVITY_SNAPSHOT,
        activityType: CODEX_ACTIVITY_TYPES.approvalResponse,
        messageId: `${input.runId}:approval-response:${request.interruptId}`,
        content: {
          interruptId: request.interruptId,
          pendingRequestId: request.pendingRequestId,
          decision: request.decision,
          authorizationScope: request.authorizationScope,
        },
        replace: true,
      });
      stream = this.transport.resumeApproval(request, signal);
    } else {
      stream = this.transport.startRun(
        {
          threadId: input.threadId,
          runId: input.runId,
          messages: input.messages,
          state: input.state,
          forwardedProps: input.forwardedProps,
        },
        signal,
      );
    }

    const normalizer = new CodexEventNormalizer({ input });
    let terminal = false;
    for await (const rawEvent of stream) {
      if (signal.aborted) {
        return;
      }
      const normalized = normalizer.normalize(
        CodexBridgeEventSchema.parse(rawEvent),
      );
      for (const event of normalized.events) {
        emit(event);
      }
      if (normalized.terminal) {
        terminal = true;
        break;
      }
    }

    if (!terminal && !signal.aborted) {
      emit({
        type: EventType.RUN_ERROR,
        message: "Codex Bridge stream ended before a terminal event.",
        code: "CODEX_BRIDGE_STREAM_INCOMPLETE",
      });
    }
  }
}

function batch(events: BaseEvent[]): NormalizedBatch {
  return { events, terminal: false };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordAt(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const value = record[key];
  return isRecord(value) ? value : {};
}

function stringAt(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function numberAt(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function redactOptional(value: unknown): string | null {
  return typeof value === "string" ? redactSensitiveText(value) : null;
}

function redactFileChanges(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((change) => {
    if (!isRecord(change)) {
      return { kind: "unknown" };
    }
    return {
      path: redactOptional(change.path),
      kind: stringAt(change, "kind") ?? "unknown",
      diff: redactOptional(change.diff),
    };
  });
}

function redactPlan(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry) => {
    if (!isRecord(entry)) {
      return { step: "Unknown plan step", status: "unknown" };
    }
    return {
      step: redactSensitiveText(stringAt(entry, "step") ?? ""),
      status: stringAt(entry, "status") ?? "unknown",
    };
  });
}

export function redactSensitiveText(value: string): string {
  return value
    .replace(
      /(\b(?:api[_-]?key|token|secret|password)\b\s*[:=]\s*)([^\s,;"']+)/gi,
      "$1[REDACTED]",
    )
    .replace(
      /(\bauthorization\b\s*:\s*bearer\s+)([^\s,;"']+)/gi,
      "$1[REDACTED]",
    )
    .replace(
      /(?<![A-Za-z0-9])(?:[A-Za-z]:[\\/]|\\\\)[^\s"'`<>]*/g,
      "[LOCAL_PATH]",
    )
    .replace(/(?<![A-Za-z0-9:/])\/(?!\/)[^\s"'`<>]*/g, "[LOCAL_PATH]");
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof CodexBridgeTransportError) {
    return error.message;
  }
  if (error instanceof z.ZodError) {
    return "Codex Bridge emitted an event that does not match the pinned contract.";
  }
  if (error instanceof Error) {
    return redactSensitiveText(error.message);
  }
  return "Codex Bridge failed with an unknown error.";
}
