import { realpath } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";

import {
  JsonRpcProcess,
  RpcRequestTimeoutError,
  type RpcWireId,
} from "./rpc.ts";
import { sanitizeForEvent } from "./sanitize.ts";
import { createIsolatedWorktree, isInside } from "./worktree.ts";
import {
  collectPatch,
  exportEvidencePacket,
  readEvidenceArtifact,
  type EvidenceArtifact,
  type EvidenceExport,
} from "./export.ts";

export type AccountStatus = {
  signedIn: boolean;
  type: string | null;
  planType: string | null;
  requiresOpenaiAuth: boolean;
};

export type BridgeStatus = {
  connected: boolean;
  serverVersion: string;
  account: AccountStatus;
  restartCount: number;
};

export type CodexBridgeOptions = {
  command?: string;
  args?: string[];
  requestTimeoutMs?: number;
  allowedRepoRoots?: string[];
  worktreeRoot?: string;
  runTimeoutMs?: number;
  approvalTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  restartLimit?: number;
  restartDelayMs?: number;
  maxIncomingBytes?: number;
  outputLimitBytes?: number;
  exportRoot?: string;
  patchLimitBytes?: number;
  eventHistoryLimit?: number;
  eventHistoryBytes?: number;
};

type InitializeResponse = {
  userAgent: string;
};

type AccountResponse = {
  account: { type: string; planType?: string | null } | null;
  requiresOpenaiAuth: boolean;
};

export type BridgeEventType =
  | "run.started"
  | "turn.started"
  | "item.started"
  | "item.completed"
  | "plan.delta"
  | "plan.updated"
  | "command.output"
  | "file.patch"
  | "diff.updated"
  | "message.delta"
  | "turn.completed"
  | "run.error"
  | "approval.requested"
  | "approval.timed_out"
  | "approval.resolved";

export type BridgeEvent = {
  type: BridgeEventType;
  runId: string;
  threadId: string;
  turnId: string | null;
  timestamp: string;
  data: unknown;
};

export type RunStatus = "completed" | "interrupted" | "failed";

export type RunResult = {
  runId: string;
  threadId: string;
  turnId: string;
  status: RunStatus;
};

export type RunHandle = {
  runId: string;
  threadId: string;
  turnId: string;
  mode: "read-only" | "write";
  cwd: string;
  completion: Promise<RunResult>;
};

export type ReadOnlyPlanInput = {
  repo: string;
  prompt: string;
  threadId?: string;
  runId?: string;
};

export type ApprovalDecision = "allow_once" | "allow_run_scope" | "deny";

export type RunEvidenceContext = {
  correlationId: string;
  sourceSessionId: string;
  sourceActionId: string;
  sourceEvidenceRefs: string[];
};

export type WriteRunInput = {
  repo: string;
  prompt: string;
  approval: ApprovalDecision;
  approvalId?: string;
  baseRef?: string;
  runId?: string;
  evidenceContext?: RunEvidenceContext;
};

type RunState = {
  runId: string;
  threadId: string;
  turnId: string;
  status: "running" | RunStatus;
  mode: "read-only" | "write";
  cwd: string;
  repoRoot: string;
  baseCommit: string | null;
  timer: NodeJS.Timeout | null;
  completion: Promise<RunResult>;
  resolve: (result: RunResult) => void;
  reject: (error: Error) => void;
  branch: string | null;
  events: BridgeEvent[];
  eventBytes: number;
  approvals: ApprovalRecord[];
  approvalOverflow: boolean;
  authorizedKinds: Set<"command" | "file">;
  observedModel: string;
  observedEffort: string | null;
  observedSandbox: Record<string, unknown>;
  frozenPatch: string | null;
  frozenPatchSha256: string | null;
  evidenceCaptureError: string | null;
  terminalizing: boolean;
  timeoutError: BridgeTimeoutError | null;
  validationChecks: ValidationCheck[];
  validationOverflow: boolean;
  mutationGeneration: number;
  evidenceContext: RunEvidenceContext | null;
};

type ApprovalRecord = {
  approvalId: string | null;
  kind: "write_activation" | "command" | "file";
  decision: ApprovalDecision;
  reason?: string;
  actor: "operator" | "bridge";
  decidedAt: string;
};

type ValidationCheck = {
  itemId: string | null;
  command: string;
  cwd: string | null;
  status: string | null;
  exitCode: number | null;
  outcome: "passed" | "failed";
  patchSha256: string | null;
  mutationGeneration: number;
};

type ValidationSummary = {
  gate: "passed" | "failed" | "missing";
  passed: number;
  failed: number;
  stale: number;
  frozenPatchSha256: string;
  overflow: boolean;
  terminalMutationGeneration: number;
  checks: Array<ValidationCheck & { matchesFrozenPatch: boolean }>;
};

type PendingApproval = {
  id: string;
  serverId: RpcWireId;
  run: RunState;
  kind: "command" | "file";
  timer: NodeJS.Timeout;
};

type ThreadResponse = {
  thread: { id: string };
  model: string;
  cwd: string;
  runtimeWorkspaceRoots: string[];
  approvalPolicy: string;
  approvalsReviewer: string;
  sandbox: Record<string, unknown>;
  reasoningEffort: string | null;
};

type TurnResponse = {
  turn: { id: string };
};

const MODEL = "gpt-5.6-sol";
const BASE_NETWORK_OFF_CONFIG = {
  model_reasoning_effort: "max",
  web_search: "disabled",
  features: {
    apps: false,
    remote_plugin: false,
    multi_agent: false,
    hooks: false,
    goals: false,
    memories: false,
  },
  sandbox_workspace_write: { network_access: false },
} as const;

export class BridgeTimeoutError extends Error {
  constructor(runId: string) {
    super(`Codex run timed out: ${runId}`);
    this.name = "BridgeTimeoutError";
  }
}

export class CodexBridge {
  readonly #rpc: JsonRpcProcess;
  readonly #allowedRepoRoots: string[];
  readonly #worktreeRoot: string | undefined;
  readonly #runTimeoutMs: number;
  readonly #approvalTimeoutMs: number;
  readonly #restartLimit: number;
  readonly #restartDelayMs: number;
  readonly #outputLimitBytes: number;
  readonly #exportRoot: string | undefined;
  readonly #patchLimitBytes: number;
  readonly #eventHistoryLimit: number;
  readonly #eventHistoryBytes: number;
  readonly #listeners = new Set<(event: BridgeEvent) => void>();
  readonly #runsByThread = new Map<string, RunState>();
  readonly #runsById = new Map<string, RunState>();
  readonly #pendingApprovals = new Map<string, PendingApproval>();
  readonly #history = new Map<string, RunState>();
  #status: BridgeStatus | null = null;
  #restartCount = 0;
  #connecting = false;
  #closing = false;
  #startPromise: Promise<BridgeStatus> | null = null;
  #restartFailure: Error | null = null;
  #notificationChain: Promise<void> = Promise.resolve();

  constructor(options: CodexBridgeOptions = {}) {
    this.#allowedRepoRoots = options.allowedRepoRoots ?? [];
    this.#worktreeRoot = options.worktreeRoot;
    this.#runTimeoutMs = options.runTimeoutMs ?? 120_000;
    this.#approvalTimeoutMs = options.approvalTimeoutMs ?? 5 * 60_000;
    this.#restartLimit = options.restartLimit ?? 1;
    this.#restartDelayMs = options.restartDelayMs ?? 100;
    this.#outputLimitBytes = options.outputLimitBytes ?? 64 * 1024;
    this.#exportRoot = options.exportRoot;
    this.#patchLimitBytes = options.patchLimitBytes ?? 5 * 1024 * 1024;
    this.#eventHistoryLimit = options.eventHistoryLimit ?? 1_000;
    this.#eventHistoryBytes = options.eventHistoryBytes ?? 4 * 1024 * 1024;
    this.#rpc = new JsonRpcProcess({
      command: options.command ?? "codex",
      args: options.args ?? [
        "app-server",
        "--stdio",
        "--disable",
        "apps",
        "--disable",
        "remote_plugin",
        "--disable",
        "multi_agent",
        "--disable",
        "hooks",
        "--disable",
        "goals",
        "--disable",
        "memories",
      ],
      ...(options.requestTimeoutMs === undefined
        ? {}
        : { requestTimeoutMs: options.requestTimeoutMs }),
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.maxIncomingBytes === undefined
        ? {}
        : { maxIncomingBytes: options.maxIncomingBytes }),
    });
    this.#rpc.onNotification((method, params) => {
      this.#notificationChain = this.#notificationChain
        .then(() => this.#handleNotification(method, params))
        .catch((error: unknown) => {
          const failure = asError(error);
          for (const run of this.#runsById.values()) {
            this.#emit(run, "run.error", {
              code: "notification_processing_failed",
              message: failure.message,
              willRetry: false,
            });
          }
          this.#rpc.terminate();
        });
    });
    this.#rpc.onRequest((id, method, params) => {
      void this.#handleServerRequest(id, method, params).catch(() => {
        try {
          this.#rpc.respond(id, { decision: "decline" });
        } catch {
          // A failed/stopped process already revoked the request capability.
        }
      });
    });
    this.#rpc.onExit((error, expected) => {
      if (!expected) this.#processExited(error);
    });
    this.#rpc.onProtocolError((error) => {
      for (const run of this.#runsById.values()) {
        this.#emit(run, "run.error", {
          code: "malformed_json",
          message: error.message,
        });
      }
    });
  }

  async start(): Promise<BridgeStatus> {
    if (this.#status) return this.#status;
    if (this.#restartFailure) throw this.#restartFailure;
    if (this.#startPromise) return this.#startPromise;
    this.#closing = false;
    const startPromise = this.#connectWithRetries();
    this.#startPromise = startPromise;
    try {
      return await startPromise;
    } finally {
      if (this.#startPromise === startPromise) this.#startPromise = null;
    }
  }

  async #initialize(): Promise<BridgeStatus> {
    const initialized = (await this.#rpc.request("initialize", {
      clientInfo: {
        name: "voiss-aura-control-room",
        title: "VOISS AURA Control Room",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
        mcpServerOpenaiFormElicitation: false,
        optOutNotificationMethods: null,
      },
    })) as InitializeResponse;
    if (!/\/0\.145\.0(?:\s|\(|$)/.test(initialized.userAgent)) {
      throw new Error(
        `Unsupported Codex app-server version: ${initialized.userAgent}`,
      );
    }
    this.#rpc.notify("initialized");
    const account = (await this.#rpc.request("account/read", {
      refreshToken: false,
    })) as AccountResponse;
    this.#status = {
      connected: true,
      serverVersion: initialized.userAgent,
      restartCount: this.#restartCount,
      account: {
        signedIn: account.account !== null,
        type: account.account?.type ?? null,
        planType: account.account?.planType ?? null,
        requiresOpenaiAuth: account.requiresOpenaiAuth,
      },
    };
    return this.#status;
  }

  subscribe(listener: (event: BridgeEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async startReadOnlyPlan(input: ReadOnlyPlanInput): Promise<RunHandle> {
    await this.start();
    if (input.threadId && this.#runsByThread.has(input.threadId)) {
      throw new Error(
        `Codex thread already has an active run: ${input.threadId}`,
      );
    }
    const cwd = await this.#allowedRepo(input.repo);
    const runId = this.#claimRunId(input.runId);
    const config = await this.#networkOffConfig(cwd);
    const threadParams = {
      threadId: input.threadId,
      model: MODEL,
      cwd,
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: "read-only",
      config,
    };
    const thread = (await this.#rpc.request(
      input.threadId ? "thread/resume" : "thread/start",
      input.threadId
        ? threadParams
        : {
            model: threadParams.model,
            cwd: threadParams.cwd,
            approvalPolicy: threadParams.approvalPolicy,
            approvalsReviewer: threadParams.approvalsReviewer,
            sandbox: threadParams.sandbox,
            config: threadParams.config,
          },
    )) as ThreadResponse;
    validateThreadRuntime(thread, cwd, "read-only");
    if (input.threadId && thread.thread.id !== input.threadId) {
      throw new Error("Codex resumed a different thread than requested.");
    }
    let resolve!: (result: RunResult) => void;
    let reject!: (error: Error) => void;
    const completion = new Promise<RunResult>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    void completion.catch(() => undefined);
    const run: RunState = {
      runId,
      threadId: thread.thread.id,
      turnId: "",
      status: "running",
      mode: "read-only",
      cwd,
      repoRoot: cwd,
      baseCommit: null,
      timer: null,
      completion,
      resolve,
      reject,
      branch: null,
      events: [],
      eventBytes: 0,
      approvals: [],
      approvalOverflow: false,
      authorizedKinds: new Set(),
      observedModel: thread.model,
      observedEffort: thread.reasoningEffort,
      observedSandbox: thread.sandbox,
      frozenPatch: null,
      frozenPatchSha256: null,
      evidenceCaptureError: null,
      terminalizing: false,
      timeoutError: null,
      validationChecks: [],
      validationOverflow: false,
      mutationGeneration: 0,
      evidenceContext: null,
    };
    if (this.#runsByThread.has(run.threadId)) {
      throw new Error(
        `Codex thread already has an active run: ${run.threadId}`,
      );
    }
    this.#runsByThread.set(run.threadId, run);
    this.#runsById.set(run.runId, run);
    this.#armTimeout(run);
    this.#emit(run, "run.started", {
      mode: "read-only",
      cwd,
      requestedModel: MODEL,
      model: thread.model,
      effort: thread.reasoningEffort,
      networkAccess: false,
    });
    try {
      const response = (await this.#rpc.request("turn/start", {
        threadId: run.threadId,
        input: [{ type: "text", text: input.prompt, text_elements: [] }],
        cwd,
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandboxPolicy: { type: "readOnly", networkAccess: false },
        model: MODEL,
        effort: "max",
      })) as TurnResponse;
      run.turnId = response.turn.id;
    } catch (error) {
      run.status = "failed";
      this.#dropRun(run);
      run.reject(asError(error));
      if (error instanceof RpcRequestTimeoutError) this.#rpc.terminate();
      throw error;
    }
    return {
      runId,
      threadId: run.threadId,
      turnId: run.turnId,
      mode: "read-only",
      cwd,
      completion,
    };
  }

  async startWriteRun(input: WriteRunInput): Promise<RunHandle> {
    if (input.approval === "deny") {
      throw new Error("Write run was denied.");
    }
    await this.start();
    const repoRoot = await this.#allowedRepo(input.repo);
    const runId = this.#claimRunId(input.runId);
    const worktree = await createIsolatedWorktree(
      repoRoot,
      runId,
      input.baseRef,
      this.#worktreeRoot,
    );
    const networkOffConfig = await this.#networkOffConfig(worktree.path);
    const config = {
      ...networkOffConfig,
      sandbox_workspace_write: {
        writable_roots: [worktree.path],
        network_access: false,
        exclude_tmpdir_env_var: true,
        exclude_slash_tmp: true,
      },
    };
    const response = (await this.#rpc.request("thread/start", {
      model: MODEL,
      cwd: worktree.path,
      runtimeWorkspaceRoots: [worktree.path],
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: "workspace-write",
      config,
      developerInstructions:
        "Work only inside the provided isolated worktree. Produce local edits, tests, diffs, and evidence with network access disabled. Remote Git operations, merge, deployment, publication, and external messages are outside this run's authority.",
    })) as ThreadResponse;
    validateThreadRuntime(response, worktree.path, "write");
    let resolve!: (result: RunResult) => void;
    let reject!: (error: Error) => void;
    const completion = new Promise<RunResult>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    void completion.catch(() => undefined);
    const run: RunState = {
      runId,
      threadId: response.thread.id,
      turnId: "",
      status: "running",
      mode: "write",
      cwd: worktree.path,
      repoRoot,
      baseCommit: worktree.baseCommit,
      timer: null,
      completion,
      resolve,
      reject,
      branch: worktree.branch,
      events: [],
      eventBytes: 0,
      approvals: [
        {
          approvalId: input.approvalId ?? null,
          kind: "write_activation",
          decision: input.approval,
          reason: "isolated_workspace_write",
          actor: "operator",
          decidedAt: new Date().toISOString(),
        },
      ],
      approvalOverflow: false,
      authorizedKinds: new Set(),
      observedModel: response.model,
      observedEffort: response.reasoningEffort,
      observedSandbox: response.sandbox,
      frozenPatch: null,
      frozenPatchSha256: null,
      evidenceCaptureError: null,
      terminalizing: false,
      timeoutError: null,
      validationChecks: [],
      validationOverflow: false,
      mutationGeneration: 0,
      evidenceContext: input.evidenceContext ?? null,
    };
    if (this.#runsByThread.has(run.threadId)) {
      throw new Error(
        `Codex thread already has an active run: ${run.threadId}`,
      );
    }
    this.#runsByThread.set(run.threadId, run);
    this.#runsById.set(run.runId, run);
    this.#armTimeout(run);
    this.#emit(run, "run.started", {
      mode: "write",
      cwd: worktree.path,
      branch: worktree.branch,
      baseCommit: worktree.baseCommit,
      requestedModel: MODEL,
      model: response.model,
      effort: response.reasoningEffort,
      networkAccess: false,
      activation: input.approval,
    });
    try {
      const turn = (await this.#rpc.request("turn/start", {
        threadId: run.threadId,
        input: [{ type: "text", text: input.prompt, text_elements: [] }],
        cwd: worktree.path,
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: [worktree.path],
          networkAccess: false,
          excludeTmpdirEnvVar: true,
          excludeSlashTmp: true,
        },
        model: MODEL,
        effort: "max",
      })) as TurnResponse;
      run.turnId = turn.turn.id;
    } catch (error) {
      run.status = "failed";
      this.#dropRun(run);
      run.reject(asError(error));
      if (error instanceof RpcRequestTimeoutError) this.#rpc.terminate();
      throw error;
    }
    return {
      runId,
      threadId: run.threadId,
      turnId: run.turnId,
      mode: "write",
      cwd: run.cwd,
      completion,
    };
  }

  resolveApproval(id: string, decision: ApprovalDecision): void {
    const approval = this.#pendingApprovals.get(id);
    if (!approval) throw new Error(`Unknown or resolved approval: ${id}`);
    clearTimeout(approval.timer);
    this.#pendingApprovals.delete(id);
    const codexDecision = decision === "deny" ? "decline" : "accept";
    this.#rpc.respond(approval.serverId, { decision: codexDecision });
    if (decision === "allow_run_scope") {
      approval.run.authorizedKinds.add(approval.kind);
    }
    if (
      ![...this.#pendingApprovals.values()].some(
        (pending) => pending.run === approval.run,
      )
    ) {
      this.#armTimeout(approval.run);
    }
    recordApproval(approval.run, {
      approvalId: id,
      kind: approval.kind,
      decision,
    });
    this.#emit(approval.run, "approval.resolved", {
      approvalId: id,
      kind: approval.kind,
      decision,
    });
  }

  async interrupt(runId: string): Promise<void> {
    const run = this.#runsById.get(runId);
    if (!run) throw new Error(`Unknown or completed run: ${runId}`);
    if (!run.turnId) throw new Error(`Run has no active turn: ${runId}`);
    for (const [approvalId, approval] of this.#pendingApprovals) {
      if (approval.run !== run) continue;
      clearTimeout(approval.timer);
      this.#pendingApprovals.delete(approvalId);
      this.#rpc.respond(approval.serverId, { decision: "decline" });
      recordApproval(run, {
        approvalId,
        kind: approval.kind,
        decision: "deny",
        reason: "run_interrupted",
      });
      this.#emit(run, "approval.resolved", {
        approvalId,
        kind: approval.kind,
        decision: "deny",
        reason: "run_interrupted",
      });
    }
    await this.#rpc.request("turn/interrupt", {
      threadId: run.threadId,
      turnId: run.turnId,
    });
  }

  async archiveThread(threadId: string): Promise<void> {
    await this.start();
    if (this.#runsByThread.has(threadId)) {
      throw new Error(
        `Cannot archive a thread with an active run: ${threadId}`,
      );
    }
    await this.#rpc.request("thread/archive", { threadId });
  }

  async exportRun(runId: string): Promise<EvidenceExport> {
    if (!this.#exportRoot)
      throw new Error("Evidence export root is not configured.");
    const run = this.#runsById.get(runId) ?? this.#history.get(runId);
    if (!run) throw new Error(`Unknown run: ${runId}`);
    if (run.status === "running") {
      throw new Error(
        "Evidence export is available after the run reaches terminal state.",
      );
    }
    if (run.mode !== "write" || run.status !== "completed") {
      throw new Error("Evidence export requires a completed write run.");
    }
    if (run.evidenceCaptureError) {
      throw new Error(
        `Run evidence capture failed: ${run.evidenceCaptureError}`,
      );
    }
    if (!run.frozenPatchSha256) {
      throw new Error("Run evidence does not have a terminal patch snapshot.");
    }
    const validation = validationSummary(
      run.validationChecks,
      run.frozenPatchSha256,
      run.validationOverflow,
      run.mutationGeneration,
    );
    if (validation.gate !== "passed") {
      throw new Error(
        validation.gate === "failed"
          ? "Evidence export requires every recognized validation command to pass."
          : "Evidence export requires at least one recognized validation command.",
      );
    }
    return exportEvidencePacket({
      exportRoot: this.#exportRoot,
      runId,
      cwd: run.cwd,
      baseCommit: run.baseCommit,
      patch: run.frozenPatch ?? "",
      patchLimitBytes: this.#patchLimitBytes,
      evidence: {
        schemaVersion: "voiss.codex.evidence.v1",
        exportedAt: new Date().toISOString(),
        run: {
          id: run.runId,
          mode: run.mode,
          status: run.status,
          threadId: run.threadId,
          turnId: run.turnId,
          repoRoot: run.repoRoot,
          cwd: run.cwd,
          branch: run.branch,
          baseCommit: run.baseCommit,
          requestedModel: MODEL,
          observedModel: run.observedModel,
          observedEffort: run.observedEffort,
          observedSandbox: run.observedSandbox,
          networkAccess: false,
          patchCapturedAtTerminal: true,
          frozenPatchSha256: run.frozenPatchSha256,
        },
        approvals: run.approvals,
        approvalOverflow: run.approvalOverflow,
        context: run.evidenceContext,
        validation,
        events: run.events,
        authority: {
          push: false,
          merge: false,
          deploy: false,
          externalMessages: false,
        },
      },
    });
  }

  async readExportArtifact(
    exportId: string,
    filename: string,
  ): Promise<EvidenceArtifact> {
    if (!this.#exportRoot)
      throw new Error("Evidence export root is not configured.");
    return readEvidenceArtifact({
      exportRoot: this.#exportRoot,
      exportId,
      filename,
      maxBytes: Math.max(
        this.#patchLimitBytes,
        this.#eventHistoryBytes + this.#outputLimitBytes + 1024 * 1024,
      ),
    });
  }

  async close(): Promise<void> {
    this.#closing = true;
    this.#clearApprovalTimers();
    for (const approval of this.#pendingApprovals.values()) {
      try {
        this.#rpc.respond(approval.serverId, { decision: "decline" });
      } catch {
        // Closing still revokes every local approval capability.
      }
    }
    this.#pendingApprovals.clear();
    for (const run of this.#runsById.values()) {
      run.status = "failed";
      this.#dropRun(run);
      run.reject(new Error("Codex bridge closed before the run completed."));
    }
    this.#status = null;
    await this.#rpc.close();
  }

  async #connectWithRetries(): Promise<BridgeStatus> {
    this.#connecting = true;
    try {
      for (;;) {
        this.#rpc.start();
        try {
          return await this.#initialize();
        } catch (error) {
          await this.#rpc.close();
          if (!this.#consumeRestart(asError(error))) {
            throw this.#restartFailure ?? error;
          }
          await new Promise((resolve) =>
            setTimeout(resolve, this.#restartDelayMs),
          );
        }
      }
    } finally {
      this.#connecting = false;
    }
  }

  #processExited(error: Error): void {
    this.#status = null;
    this.#clearApprovalTimers();
    for (const run of [...this.#runsById.values()]) {
      run.status = "failed";
      this.#emit(run, "run.error", {
        code: "app_server_exited",
        message: error.message,
      });
      const failure = run.timeoutError ?? error;
      this.#dropRun(run);
      run.reject(failure);
    }
    this.#pendingApprovals.clear();
    if (!this.#closing && !this.#connecting && this.#consumeRestart(error)) {
      const restart = setTimeout(() => {
        if (this.#closing) return;
        void this.start().catch(() => {
          // The next caller receives the retained readiness failure.
        });
      }, this.#restartDelayMs);
      restart.unref();
    }
  }

  #consumeRestart(cause: Error): boolean {
    if (this.#closing) return false;
    if (this.#restartCount >= this.#restartLimit) {
      this.#restartFailure = new Error(
        `Codex app-server restart budget exhausted after ${this.#restartCount} restart(s): ${cause.message}`,
        { cause },
      );
      return false;
    }
    this.#restartCount += 1;
    return true;
  }

  async #allowedRepo(candidate: string): Promise<string> {
    const resolved = await realpath(candidate);
    for (const allowed of this.#allowedRepoRoots) {
      if (resolved === (await realpath(allowed))) return resolved;
    }
    throw new Error(`Repository is not allowlisted: ${candidate}`);
  }

  #claimRunId(requested?: string): string {
    const runId = requested ?? randomUUID();
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        runId,
      ) ||
      this.#runsById.has(runId) ||
      this.#history.has(runId)
    ) {
      throw new Error("Invalid or reused internal Codex run id.");
    }
    return runId;
  }

  async #networkOffConfig(cwd: string): Promise<Record<string, unknown>> {
    const response = (await this.#rpc.request("config/read", {
      cwd,
      includeLayers: false,
    })) as { config?: { mcp_servers?: unknown } };
    const configured =
      response.config?.mcp_servers &&
      typeof response.config.mcp_servers === "object" &&
      !Array.isArray(response.config.mcp_servers)
        ? (response.config.mcp_servers as Record<string, unknown>)
        : {};
    const disabledMcpServers = Object.fromEntries(
      Object.keys(configured).map((name) => [name, { enabled: false }]),
    );
    return {
      ...BASE_NETWORK_OFF_CONFIG,
      mcp_servers: disabledMcpServers,
      shell_environment_policy: {
        inherit: "none",
        ignore_default_excludes: false,
        include_only: [],
        set: Object.fromEntries(
          [
            "PATH",
            "HOME",
            "USER",
            "LOGNAME",
            "SHELL",
            "LANG",
            "LC_ALL",
            "LC_CTYPE",
            "TERM",
          ].flatMap((name) => {
            const value = this.#rpc.env[name];
            return value === undefined ? [] : [[name, value]];
          }),
        ),
      },
    };
  }

  #emit(run: RunState, type: BridgeEventType, data: unknown): void {
    let event: BridgeEvent = {
      type,
      runId: run.runId,
      threadId: run.threadId,
      turnId: run.turnId || null,
      timestamp: new Date().toISOString(),
      data: sanitizeForEvent(data, this.#outputLimitBytes),
    };
    const perEventLimit = Math.max(this.#outputLimitBytes, 1024);
    if (byteLength(event) > perEventLimit) {
      event = {
        ...event,
        data: {
          code: "event_payload_truncated",
          message:
            "Codex Bridge event payload exceeded its retained byte limit.",
        },
      };
    }
    const bytes = byteLength(event);
    run.events.push(event);
    run.eventBytes += bytes;
    while (
      run.events.length > this.#eventHistoryLimit ||
      run.eventBytes > this.#eventHistoryBytes
    ) {
      const removed = run.events.shift();
      if (!removed) break;
      run.eventBytes -= byteLength(removed);
    }
    for (const listener of this.#listeners) listener(event);
  }

  async #handleNotification(method: string, params: unknown): Promise<void> {
    if (!params || typeof params !== "object") return;
    const value = params as Record<string, unknown>;
    if (method === "account/updated") {
      if (!this.#status) return;
      const signedIn =
        typeof value.authMode === "string" && value.authMode.length > 0;
      this.#status = {
        ...this.#status,
        account: {
          ...this.#status.account,
          signedIn,
          type: signedIn ? String(value.authMode) : null,
          planType:
            signedIn && typeof value.planType === "string"
              ? value.planType
              : null,
        },
      };
      return;
    }
    const threadId =
      typeof value.threadId === "string"
        ? value.threadId
        : typeof (value.thread as { id?: unknown } | undefined)?.id === "string"
          ? String((value.thread as { id: string }).id)
          : null;
    if (!threadId) return;
    const run = this.#runsByThread.get(threadId);
    if (!run) return;
    const notificationTurnId =
      typeof value.turnId === "string"
        ? value.turnId
        : typeof (value.turn as { id?: unknown } | undefined)?.id === "string"
          ? String((value.turn as { id: string }).id)
          : null;
    if (notificationTurnId && run.turnId && notificationTurnId !== run.turnId) {
      return;
    }
    if (method === "model/rerouted") {
      const observed =
        typeof value.toModel === "string" ? value.toModel : "unknown";
      run.observedModel = observed;
      if (observed !== MODEL) {
        run.status = "failed";
        this.#emit(run, "run.error", {
          code: "model_rerouted",
          message: `Codex rerouted the fixed model from ${MODEL} to ${observed}.`,
          requestedModel: MODEL,
          observedModel: observed,
          willRetry: false,
        });
        if (run.turnId) {
          void this.#rpc
            .request("turn/interrupt", {
              threadId: run.threadId,
              turnId: run.turnId,
            })
            .catch(() => undefined);
        } else {
          this.#rpc.terminate();
        }
      }
      return;
    }
    if (method === "turn/started") {
      const turn = value.turn as { id?: unknown } | undefined;
      if (typeof turn?.id === "string") run.turnId = turn.id;
    }
    const map: Partial<Record<string, BridgeEventType>> = {
      "turn/started": "turn.started",
      "item/started": "item.started",
      "item/completed": "item.completed",
      "item/plan/delta": "plan.delta",
      "turn/plan/updated": "plan.updated",
      "item/commandExecution/outputDelta": "command.output",
      "item/fileChange/patchUpdated": "file.patch",
      "turn/diff/updated": "diff.updated",
      "item/agentMessage/delta": "message.delta",
      error: "run.error",
    };
    const type = map[method];
    const item =
      value.item && typeof value.item === "object" && !Array.isArray(value.item)
        ? (value.item as Record<string, unknown>)
        : null;
    if (
      method === "item/fileChange/patchUpdated" ||
      ((method === "item/started" || method === "item/completed") &&
        (item?.type === "fileChange" || commandExecutionMayMutate(item)))
    ) {
      run.mutationGeneration += 1;
    }
    if (method === "item/completed") {
      const check = await validationCheck(
        value,
        run,
        this.#outputLimitBytes,
        this.#patchLimitBytes,
        run.mutationGeneration,
      );
      if (check) {
        if (run.validationChecks.length >= 100) {
          run.validationOverflow = true;
        } else {
          run.validationChecks.push(check);
        }
      }
    }
    if (type) this.#emit(run, type, value);
    if (method !== "turn/completed") return;
    if (run.terminalizing) return;
    run.terminalizing = true;
    if (run.timer) clearTimeout(run.timer);
    run.timer = null;
    this.#clearApprovalTimers(run);
    const turn = value.turn as { id?: string; status?: RunStatus } | undefined;
    run.turnId = turn?.id ?? run.turnId;
    run.status =
      run.status === "failed" ? "failed" : (turn?.status ?? "failed");
    const result: RunResult = {
      runId: run.runId,
      threadId: run.threadId,
      turnId: run.turnId,
      status: run.status,
    };
    if (run.mode === "write" && run.baseCommit) {
      try {
        run.frozenPatch = await collectPatch(
          run.cwd,
          run.baseCommit,
          this.#patchLimitBytes,
        );
        run.frozenPatchSha256 = sha256(run.frozenPatch);
      } catch (error) {
        run.evidenceCaptureError = asError(error).message;
      }
    } else {
      run.frozenPatch = "";
      run.frozenPatchSha256 = sha256("");
    }
    if (
      this.#runsById.get(run.runId) !== run ||
      this.#runsByThread.get(run.threadId) !== run
    ) {
      return;
    }
    this.#emit(run, "turn.completed", {
      ...result,
      notification: value,
      evidenceCaptured: run.evidenceCaptureError === null,
      validation: {
        passed: run.validationChecks.filter(
          (check) => check.outcome === "passed",
        ).length,
        failed: run.validationChecks.filter(
          (check) => check.outcome === "failed",
        ).length,
      },
    });
    this.#dropRun(run);
    run.resolve(result);
  }

  #armTimeout(run: RunState): void {
    run.timer = setTimeout(() => {
      void this.#timeout(run);
    }, this.#runTimeoutMs);
  }

  async #timeout(run: RunState): Promise<void> {
    if (!this.#runsById.has(run.runId) || run.terminalizing) return;
    run.terminalizing = true;
    run.status = "failed";
    run.timeoutError = new BridgeTimeoutError(run.runId);
    if (run.timer) clearTimeout(run.timer);
    run.timer = null;
    this.#emit(run, "run.error", {
      code: "timeout",
      message: `Run exceeded ${this.#runTimeoutMs} ms.`,
      willRetry: false,
    });
    if (run.turnId) {
      try {
        await this.#rpc.request("turn/interrupt", {
          threadId: run.threadId,
          turnId: run.turnId,
        });
      } catch {
        // The timeout result remains authoritative even when interruption races exit.
      }
    } else {
      this.#rpc.terminate();
    }
    if (!this.#runsById.has(run.runId)) return;
    this.#dropRun(run);
    run.reject(run.timeoutError);
  }

  #dropRun(run: RunState): void {
    if (run.timer) clearTimeout(run.timer);
    run.timer = null;
    this.#clearApprovalTimers(run);
    for (const [approvalId, approval] of this.#pendingApprovals) {
      if (approval.run !== run) continue;
      this.#pendingApprovals.delete(approvalId);
      try {
        this.#rpc.respond(approval.serverId, { decision: "decline" });
      } catch {
        // The process may already be gone; deleting the local capability is final.
      }
    }
    this.#runsById.delete(run.runId);
    if (this.#runsByThread.get(run.threadId) === run) {
      this.#runsByThread.delete(run.threadId);
    }
    this.#history.set(run.runId, run);
    while (this.#history.size > 100) {
      const oldest = this.#history.keys().next().value;
      if (typeof oldest !== "string") break;
      this.#history.delete(oldest);
    }
  }

  #clearApprovalTimers(run?: RunState): void {
    for (const approval of this.#pendingApprovals.values()) {
      if (run && approval.run !== run) continue;
      clearTimeout(approval.timer);
    }
  }

  async #handleServerRequest(
    serverId: RpcWireId,
    method: string,
    params: unknown,
  ): Promise<void> {
    if (
      method !== "item/commandExecution/requestApproval" &&
      method !== "item/fileChange/requestApproval"
    ) {
      this.#rpc.respondError(
        serverId,
        -32601,
        "Server request is outside VOISS P0 scope.",
      );
      return;
    }
    if (!params || typeof params !== "object") {
      this.#rpc.respond(serverId, { decision: "decline" });
      return;
    }
    const value = params as Record<string, unknown>;
    const run =
      typeof value.threadId === "string"
        ? this.#runsByThread.get(value.threadId)
        : undefined;
    const kind =
      method === "item/commandExecution/requestApproval" ? "command" : "file";
    if (
      !run ||
      run.status !== "running" ||
      run.terminalizing ||
      typeof value.turnId !== "string" ||
      value.turnId.length === 0 ||
      typeof value.itemId !== "string" ||
      value.itemId.length === 0 ||
      typeof value.startedAtMs !== "number" ||
      !Number.isFinite(value.startedAtMs) ||
      (kind === "command" &&
        (!Object.prototype.hasOwnProperty.call(value, "environmentId") ||
          (value.environmentId !== null &&
            typeof value.environmentId !== "string"))) ||
      (run.turnId && value.turnId !== run.turnId)
    ) {
      this.#rpc.respond(serverId, { decision: "decline" });
      if (run) {
        recordApproval(run, {
          approvalId: null,
          kind,
          decision: "deny",
          reason: "invalid_turn",
        });
        this.#emit(run, "approval.resolved", {
          kind,
          decision: "deny",
          reason: "invalid_turn",
        });
      }
      return;
    }
    if (!run.turnId) {
      run.turnId = value.turnId;
    }
    const inScope = await this.#approvalInScope(run, kind, value);
    const stillActive =
      this.#runsById.get(run.runId) === run &&
      this.#runsByThread.get(run.threadId) === run &&
      run.status === "running" &&
      !run.terminalizing &&
      run.turnId === value.turnId;
    if (!inScope || !stillActive) {
      this.#rpc.respond(serverId, { decision: "decline" });
      if (stillActive) {
        recordApproval(run, {
          approvalId: null,
          kind,
          decision: "deny",
          reason: "outside_scope",
        });
        this.#emit(run, "approval.resolved", {
          kind,
          decision: "deny",
          reason: "outside_scope",
        });
      }
      return;
    }
    if (run.authorizedKinds.has(kind)) {
      this.#rpc.respond(serverId, { decision: "accept" });
      recordApproval(run, {
        approvalId: null,
        kind,
        decision: "allow_run_scope",
        reason: "run_scope",
      });
      this.#emit(run, "approval.resolved", {
        kind,
        decision: "allow_run_scope",
        reason: "run_scope",
      });
      return;
    }
    const id = randomUUID();
    if (run.timer) clearTimeout(run.timer);
    run.timer = null;
    const timer = setTimeout(() => {
      const approval = this.#pendingApprovals.get(id);
      if (
        !approval ||
        approval.run !== run ||
        run.status !== "running" ||
        run.terminalizing ||
        this.#runsById.get(run.runId) !== run ||
        this.#runsByThread.get(run.threadId) !== run
      ) {
        return;
      }
      this.#emit(run, "approval.timed_out", {
        approvalId: id,
        kind,
        timeoutMs: this.#approvalTimeoutMs,
      });
    }, this.#approvalTimeoutMs);
    timer.unref();
    this.#pendingApprovals.set(id, { id, serverId, run, kind, timer });
    this.#emit(run, "approval.requested", {
      approvalId: id,
      kind,
      reason: typeof value.reason === "string" ? value.reason : null,
      command:
        kind === "command" && typeof value.command === "string"
          ? value.command
          : null,
      cwd: typeof value.cwd === "string" ? value.cwd : run.cwd,
      requestParams: value,
    });
  }

  async #approvalInScope(
    run: RunState,
    kind: "command" | "file",
    params: Record<string, unknown>,
  ): Promise<boolean> {
    if (
      !isNullableString(params.reason) ||
      (kind === "file" && !isNullableString(params.grantRoot)) ||
      (kind === "command" &&
        (!isNullableString(params.approvalId) ||
          !isNullableString(params.command) ||
          !isNullableString(params.cwd)))
    ) {
      return false;
    }
    if (params.networkApprovalContext != null) return false;
    if (
      (Array.isArray(params.proposedNetworkPolicyAmendments) &&
        params.proposedNetworkPolicyAmendments.length > 0) ||
      (!Array.isArray(params.proposedNetworkPolicyAmendments) &&
        params.proposedNetworkPolicyAmendments != null) ||
      params.proposedExecpolicyAmendment != null
    ) {
      return false;
    }
    if (
      kind === "command" &&
      (params.environmentId !== null ||
        params.additionalPermissions != null ||
        (params.availableDecisions != null &&
          (!Array.isArray(params.availableDecisions) ||
            !params.availableDecisions.includes("accept"))) ||
        (params.commandActions != null &&
          !Array.isArray(params.commandActions)))
    ) {
      return false;
    }
    if (run.mode !== "write") return false;
    const requestedRoot =
      kind === "file"
        ? params.grantRoot
        : typeof params.cwd === "string"
          ? params.cwd
          : run.cwd;
    const candidate =
      typeof requestedRoot === "string" ? requestedRoot : run.cwd;
    let canonicalCandidate: string;
    try {
      canonicalCandidate = await realpath(resolve(run.cwd, candidate));
    } catch {
      return false;
    }
    if (!isInside(run.cwd, canonicalCandidate)) return false;
    if (kind !== "command") return true;
    const command = params.command;
    if (typeof command !== "string" || !isSafeEscalationCommand(command)) {
      return false;
    }
    const actions = Array.isArray(params.commandActions)
      ? params.commandActions
      : [];
    for (const action of actions) {
      if (!action || typeof action !== "object") return false;
      const value = action as Record<string, unknown>;
      if (
        value.type !== "read" &&
        value.type !== "listFiles" &&
        value.type !== "search"
      ) {
        return false;
      }
      if (value.command !== command) return false;
      if (
        (value.type === "read" &&
          (typeof value.name !== "string" || typeof value.path !== "string")) ||
        (value.type === "listFiles" &&
          value.path !== null &&
          typeof value.path !== "string") ||
        (value.type === "search" &&
          ((value.query !== null && typeof value.query !== "string") ||
            (value.path !== null && typeof value.path !== "string")))
      ) {
        return false;
      }
      let actionPath = canonicalCandidate;
      if (typeof value.path === "string") {
        try {
          actionPath = await realpath(resolve(canonicalCandidate, value.path));
        } catch {
          return false;
        }
      }
      if (!isInside(run.cwd, actionPath)) return false;
    }
    return true;
  }
}

const SAFE_ESCALATION_COMMANDS = [
  /^git(?: +-C +\.)? +(?:status|diff|log|show)(?: +[-A-Za-z0-9_./:=@]+)*$/,
];

function isNullableString(value: unknown): value is string | null | undefined {
  return value == null || typeof value === "string";
}

function isSafeEscalationCommand(command: string): boolean {
  if (
    command !== command.trim() ||
    /[\u0000-\u001F\u007F]/.test(command) ||
    !SAFE_ESCALATION_COMMANDS.some((pattern) => pattern.test(command))
  ) {
    return false;
  }
  const tokens = command.split(/ +/);
  return !tokens.some(
    (token) =>
      token === "--ext-diff" ||
      token === "--no-index" ||
      token === "--textconv" ||
      token === "--paginate" ||
      token === "--output" ||
      token.startsWith("/") ||
      token.startsWith("../") ||
      token.startsWith("--output="),
  );
}

async function validationCheck(
  notification: Record<string, unknown>,
  run: RunState,
  outputLimitBytes: number,
  patchLimitBytes: number,
  mutationGeneration: number,
): Promise<ValidationCheck | null> {
  const item =
    notification.item &&
    typeof notification.item === "object" &&
    !Array.isArray(notification.item)
      ? (notification.item as Record<string, unknown>)
      : null;
  if (!item || item.type !== "commandExecution") return null;
  const command = typeof item.command === "string" ? item.command : "";
  const cwd = typeof item.cwd === "string" ? item.cwd : null;
  const commandScope = await validationCommandScope(command, cwd, run.cwd);
  if (!commandScope.recognized) return null;
  const status = typeof item.status === "string" ? item.status : null;
  const exitCode =
    typeof item.exitCode === "number" && Number.isInteger(item.exitCode)
      ? item.exitCode
      : null;
  let passed = commandScope.inScope && status === "completed" && exitCode === 0;
  let patchSha256: string | null = null;
  if (passed && run.mode === "write" && run.baseCommit) {
    try {
      patchSha256 = sha256(
        await collectPatch(run.cwd, run.baseCommit, patchLimitBytes),
      );
    } catch {
      passed = false;
    }
  }
  return {
    itemId: typeof item.id === "string" ? item.id : null,
    command: String(sanitizeForEvent(command, outputLimitBytes)),
    cwd: cwd === null ? null : String(sanitizeForEvent(cwd, outputLimitBytes)),
    status,
    exitCode,
    outcome: passed ? "passed" : "failed",
    patchSha256,
    mutationGeneration,
  };
}

function validationSummary(
  checks: ValidationCheck[],
  frozenPatchSha256: string,
  overflow: boolean,
  terminalMutationGeneration: number,
): ValidationSummary {
  const passed = checks.filter((check) => check.outcome === "passed").length;
  const failed = checks.length - passed;
  const stale = checks.filter(
    (check) =>
      check.outcome === "passed" &&
      (check.patchSha256 !== frozenPatchSha256 ||
        check.mutationGeneration !== terminalMutationGeneration),
  ).length;
  const hasFinalPatchPass = checks.some(
    (check) =>
      check.outcome === "passed" &&
      check.patchSha256 === frozenPatchSha256 &&
      check.mutationGeneration === terminalMutationGeneration,
  );
  return {
    gate:
      checks.length === 0
        ? "missing"
        : overflow || failed > 0 || !hasFinalPatchPass
          ? "failed"
          : "passed",
    passed,
    failed,
    stale,
    frozenPatchSha256,
    overflow,
    terminalMutationGeneration,
    checks: checks.map((check) => ({
      ...check,
      matchesFrozenPatch:
        check.patchSha256 === frozenPatchSha256 &&
        check.mutationGeneration === terminalMutationGeneration,
    })),
  };
}

function commandExecutionMayMutate(
  item: Record<string, unknown> | null,
): boolean {
  if (item?.type !== "commandExecution") return false;
  const actions = Array.isArray(item.commandActions) ? item.commandActions : [];
  if (
    actions.length > 0 &&
    actions.every(
      (action) =>
        action !== null &&
        typeof action === "object" &&
        ["read", "listFiles", "search"].includes(
          String((action as Record<string, unknown>).type),
        ),
    )
  ) {
    return false;
  }
  const command = typeof item.command === "string" ? item.command : "";
  const payload = unwrapLoginShellCommand(command);
  return !payload
    .split(" && ")
    .every(
      (part) =>
        /^git status(?: (?:--short|-s|--porcelain(?:=v[12])?|--branch|-b|--untracked-files=(?:no|normal|all)))*$/.test(
          part,
        ) || /^git diff(?: [A-Za-z0-9_./:=,+@%~-]+)*$/.test(part),
    );
}

function unwrapLoginShellCommand(command: string): string {
  return (
    /^(?:\/(?:usr\/)?bin\/)?(?:ba|z)?sh -lc '([^'\r\n]*)'$/.exec(
      command,
    )?.[1] ?? command
  );
}

async function validationCommandScope(
  command: string,
  itemCwd: string | null,
  runCwd: string,
): Promise<{ recognized: boolean; inScope: boolean }> {
  const payload = unwrapLoginShellCommand(command);
  if (
    payload !== payload.trim() ||
    /[\u0000-\u001F\u007F;&|`$<>]/.test(payload)
  ) {
    return { recognized: false, inScope: false };
  }
  const tokens = payload.split(/ +/).filter(Boolean);
  if (
    tokens.length === 0 ||
    tokens.some((token) => NON_VALIDATING_FLAGS.has(token.toLowerCase()))
  ) {
    return { recognized: false, inScope: false };
  }
  let recognized = false;
  if (
    tokens[0] === "pytest" ||
    ((tokens[0] === "python" || tokens[0] === "python3") &&
      tokens[1] === "-m" &&
      tokens[2] === "pytest") ||
    (tokens[0] === "uv" &&
      tokens[1] === "run" &&
      (tokens[2] === "pytest" ||
        ((tokens[2] === "python" || tokens[2] === "python3") &&
          tokens[3] === "-m" &&
          tokens[4] === "pytest")))
  ) {
    recognized = true;
  }
  if (
    !recognized &&
    ((tokens[0] === "vitest" &&
      (tokens[1] === undefined ||
        tokens[1] === "run" ||
        tokens[1].startsWith("-"))) ||
      (tokens[0] === "playwright" && tokens[1] === "test") ||
      (tokens[0] === "npx" && tokens[1] === "vitest") ||
      (tokens[0] === "npx" &&
        tokens[1] === "playwright" &&
        tokens[2] === "test") ||
      (tokens[0] === "pnpm" &&
        tokens[1] === "exec" &&
        tokens[2] === "vitest") ||
      (tokens[0] === "pnpm" &&
        tokens[1] === "exec" &&
        tokens[2] === "playwright" &&
        tokens[3] === "test") ||
      (tokens[0] === "pnpm" && tokens[1] === "vitest") ||
      (tokens[0] === "pnpm" &&
        tokens[1] === "playwright" &&
        tokens[2] === "test"))
  ) {
    recognized = true;
  } else if (!recognized && tokens[0] === "git") {
    let index = 1;
    if (tokens[index] === "-C") index += 2;
    recognized =
      tokens[index] === "diff" && tokens.slice(index + 1).includes("--check");
  } else if (!recognized && tokens[0] === "pnpm") {
    let index = 1;
    while (index < tokens.length) {
      const token = tokens[index] as string;
      if (
        token === "--filter" ||
        token === "-F" ||
        token === "--dir" ||
        token === "-C"
      ) {
        index += 2;
        continue;
      }
      if (token.startsWith("--filter=") || token.startsWith("--dir=")) {
        index += 1;
        continue;
      }
      if (token === "--workspace-root" || token === "-w") {
        index += 1;
        continue;
      }
      if (token === "run") {
        index += 1;
        break;
      }
      if (token.startsWith("-")) {
        index += 1;
        continue;
      }
      break;
    }
    recognized =
      tokens[index] === "lint" ||
      tokens[index] === "typecheck" ||
      tokens[index] === "test" ||
      tokens[index] === "build";
  }
  if (!recognized) return { recognized: false, inScope: false };
  if (!itemCwd) return { recognized: true, inScope: false };
  let canonicalCwd: string;
  try {
    canonicalCwd = await realpath(itemCwd);
  } catch {
    return { recognized: true, inScope: false };
  }
  if (canonicalCwd !== runCwd) {
    return { recognized: true, inScope: false };
  }
  const pathTargets = commandPathTargets(tokens);
  for (const target of pathTargets) {
    const absolute = resolve(canonicalCwd, target);
    if (!isInside(runCwd, absolute)) {
      return { recognized: true, inScope: false };
    }
    try {
      if (!isInside(runCwd, await realpath(absolute))) {
        return { recognized: true, inScope: false };
      }
    } catch {
      return { recognized: true, inScope: false };
    }
  }
  return { recognized: true, inScope: true };
}

const NON_VALIDATING_FLAGS = new Set([
  "-h",
  "--help",
  "-v",
  "--version",
  "--collect-only",
  "--co",
  "--fixtures",
  "--fixtures-per-test",
  "--markers",
  "--list",
  "--list-tests",
  "--if-present",
  "--passwithnotests",
  "--pass-with-no-tests",
]);

function commandPathTargets(tokens: string[]): string[] {
  const targets: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] as string;
    if (
      token === "-C" ||
      token === "--dir" ||
      token === "--rootdir" ||
      token === "--config" ||
      token === "-c"
    ) {
      const target = tokens[index + 1];
      if (target) targets.push(target);
      index += 1;
      continue;
    }
    for (const prefix of ["--dir=", "--rootdir=", "--config="]) {
      if (token.startsWith(prefix)) {
        targets.push(token.slice(prefix.length));
      }
    }
    if (token.startsWith("/") || token === ".." || token.startsWith("../")) {
      targets.push(token);
    }
  }
  return targets;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

function recordApproval(
  run: RunState,
  approval: Omit<ApprovalRecord, "actor" | "decidedAt"> &
    Partial<Pick<ApprovalRecord, "actor" | "decidedAt">>,
): void {
  if (run.approvals.length >= 100) {
    run.approvalOverflow = true;
    return;
  }
  run.approvals.push({
    ...approval,
    actor: approval.actor ?? "operator",
    decidedAt: approval.decidedAt ?? new Date().toISOString(),
  });
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function validateThreadRuntime(
  response: ThreadResponse,
  cwd: string,
  mode: "read-only" | "write",
): void {
  if (
    response.model !== MODEL ||
    response.reasoningEffort !== "max" ||
    response.cwd !== cwd ||
    response.approvalPolicy !== "on-request" ||
    response.approvalsReviewer !== "user"
  ) {
    throw new Error(
      "Codex thread runtime did not retain the requested policy.",
    );
  }
  const expectedType = mode === "read-only" ? "readOnly" : "workspaceWrite";
  if (
    response.sandbox.type !== expectedType ||
    response.sandbox.networkAccess !== false
  ) {
    throw new Error(
      "Codex thread sandbox did not retain network-off isolation.",
    );
  }
  if (mode === "write") {
    const extraRoots = response.sandbox.writableRoots;
    if (
      response.runtimeWorkspaceRoots.length !== 1 ||
      response.runtimeWorkspaceRoots[0] !== cwd ||
      !Array.isArray(extraRoots) ||
      extraRoots.length > 1 ||
      (extraRoots.length === 1 && extraRoots[0] !== cwd) ||
      response.sandbox.excludeTmpdirEnvVar !== true ||
      response.sandbox.excludeSlashTmp !== true
    ) {
      throw new Error("Codex write sandbox did not retain its isolated root.");
    }
  }
}

export { JsonRpcProcess };
