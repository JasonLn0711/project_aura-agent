import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { realpath, stat } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { basename, isAbsolute } from "node:path";

import type { TrustStore } from "@voiss/trust-engine";
import {
  CodexBridge,
  type ApprovalDecision,
  type BridgeEvent,
  type RunEvidenceContext,
  type RunHandle,
} from "./index.ts";
import { CodexObservability } from "./observability.ts";
import { sanitizeForEvent } from "./sanitize.ts";
import { DirtyRepositoryError } from "./worktree.ts";

const LOOPBACK_HOST = "127.0.0.1";
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export type CodexHttpServerOptions = {
  bridge: CodexBridge;
  token: string;
  allowedOrigins: string[];
  defaultRepo: string;
  maxBodyBytes?: number;
  maxEventBytes?: number;
  approvalTimeoutMs?: number;
  observabilityLogPath?: string;
  metadataStore?: TrustStore;
};

export type CodexHttpAddress = {
  host: typeof LOOPBACK_HOST;
  port: number;
  url: string;
};

type ProtocolEnvelope = {
  method: string;
  params: Record<string, unknown>;
  id?: string;
};

type RunSession = {
  handle: RunHandle;
  aguiThreadId: string;
  externalRunIds: Set<string>;
  pendingApprovals: Set<string>;
  correlationId: string;
  commandItems: Set<string>;
  fileChangeItems: Set<string>;
  terminal: boolean;
  startedAt: string;
  repoRoot: string;
  evidenceContext: RunEvidenceContext | null;
  eventSequence: number;
};

type PersistedRun = {
  id: string;
  voissRunIds: string[];
  codexThreadId: string;
  aguiThreadId: string;
  repository: string;
  worktree: string;
  mode: RunHandle["mode"];
  model: "gpt-5.6-sol";
  profile: "max";
  sourceSessionId: string | null;
  sourceActionId: string | null;
  sourceEvidenceIds: string[];
  startedAt: string;
  endedAt: string | null;
  status: "running" | "completed" | "interrupted" | "failed" | "blocked";
  correlationId: string;
};

type PersistedThread = {
  id: string;
  repository: string;
  cwd: string;
  model: "gpt-5.6-sol";
  profile: "max";
  lastRunId: string;
  status: "active" | "idle" | "blocked" | "archived";
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
};

type PendingWriteActivation = {
  id: string;
  aguiThreadId: string;
  externalRunId: string;
  prompt: string;
  repo: string;
  baseRef?: string;
  evidenceContext?: RunEvidenceContext;
  correlationId: string;
  timer: NodeJS.Timeout | null;
  timedOutAt: string | null;
};

class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

class EventQueue {
  readonly #values: Array<{ event: BridgeEvent; bytes: number }> = [];
  readonly #waiters: Array<(event: BridgeEvent | null) => void> = [];
  readonly #maxItems: number;
  readonly #maxBytes: number;
  readonly #onOverflow: () => void;
  #bytes = 0;
  #closed = false;

  constructor(maxItems: number, maxBytes: number, onOverflow: () => void) {
    this.#maxItems = maxItems;
    this.#maxBytes = maxBytes;
    this.#onOverflow = onOverflow;
  }

  push(event: BridgeEvent): void {
    if (this.#closed) return;
    const bytes = byteLength(event);
    if (
      this.#values.length >= this.#maxItems ||
      this.#bytes + bytes > this.#maxBytes
    ) {
      const overflow: BridgeEvent = {
        type: "run.error",
        runId: event.runId,
        threadId: event.threadId,
        turnId: event.turnId,
        timestamp: new Date().toISOString(),
        data: {
          code: "stream_buffer_overflow",
          message: "Codex Bridge stream buffer reached its configured limit.",
        },
      };
      this.#values.length = 0;
      this.#bytes = 0;
      this.#closed = true;
      this.#onOverflow();
      const waiter = this.#waiters.shift();
      if (waiter) waiter(overflow);
      else this.#values.push({ event: overflow, bytes: byteLength(overflow) });
      for (const pending of this.#waiters.splice(0)) pending(null);
      return;
    }
    const waiter = this.#waiters.shift();
    if (waiter) waiter(event);
    else {
      this.#values.push({ event, bytes });
      this.#bytes += bytes;
    }
  }

  next(): Promise<BridgeEvent | null> {
    const value = this.#values.shift();
    if (value) {
      this.#bytes -= value.bytes;
      return Promise.resolve(value.event);
    }
    if (this.#closed) return Promise.resolve(null);
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter(null);
  }
}

export class CodexHttpServer {
  readonly #bridge: CodexBridge;
  readonly #tokenDigest: Buffer;
  readonly #allowedOrigins: Set<string>;
  readonly #defaultRepo: string;
  readonly #maxBodyBytes: number;
  readonly #maxEventBytes: number;
  readonly #approvalTimeoutMs: number;
  readonly #server: Server;
  readonly #sessionsByInternal = new Map<string, RunSession>();
  readonly #sessionsByExternal = new Map<string, RunSession>();
  readonly #pendingApprovals = new Map<string, RunSession>();
  readonly #pendingWriteActivations = new Map<string, PendingWriteActivation>();
  readonly #pendingWriteByExternal = new Map<string, PendingWriteActivation>();
  readonly #exportableByExternal = new Map<string, RunSession>();
  readonly #ownedThreads = new Map<string, string>();
  readonly #startingRuns = new Set<string>();
  readonly #trackedEvents = new WeakSet<BridgeEvent>();
  readonly #correlationIds = new WeakMap<IncomingMessage, string>();
  readonly #observability: CodexObservability;
  readonly #metadataStore: TrustStore | undefined;
  readonly #unsubscribeTracking: () => void;
  #latestExportable: RunSession | null = null;

  constructor(options: CodexHttpServerOptions) {
    if (Buffer.byteLength(options.token) < 16) {
      throw new Error("CODEX_BRIDGE_TOKEN must contain at least 16 bytes.");
    }
    if (!options.defaultRepo) {
      throw new Error("A default allowlisted repository is required.");
    }
    this.#bridge = options.bridge;
    this.#tokenDigest = digest(options.token);
    this.#allowedOrigins = new Set(
      options.allowedOrigins.map(validateLoopbackOrigin),
    );
    this.#defaultRepo = options.defaultRepo;
    this.#maxBodyBytes = options.maxBodyBytes ?? 256 * 1024;
    this.#maxEventBytes = options.maxEventBytes ?? 256 * 1024;
    this.#approvalTimeoutMs = options.approvalTimeoutMs ?? 5 * 60_000;
    if (
      !Number.isSafeInteger(this.#approvalTimeoutMs) ||
      this.#approvalTimeoutMs < 1
    ) {
      throw new Error("approvalTimeoutMs must be a positive integer.");
    }
    this.#observability = new CodexObservability(options.observabilityLogPath);
    this.#metadataStore = options.metadataStore;
    this.#reconcilePersistedLifecycle();
    this.#restoreThreadCapabilities();
    this.#unsubscribeTracking = this.#bridge.subscribe((event) => {
      this.#trackEvent(event);
    });
    this.#server = createServer((request, response) => {
      void this.#handle(request, response).catch((error: unknown) => {
        reportInternalError(error);
        if (response.headersSent) {
          response.destroy();
          return;
        }
        this.#json(response, 500, { error: "internal_error" });
      });
    });
  }

  async listen(port = 8770): Promise<CodexHttpAddress> {
    if (!Number.isInteger(port) || port < 0 || port > 65_535) {
      throw new Error("CODEX_BRIDGE_PORT must be an integer from 0 to 65535.");
    }
    if (this.#server.listening)
      throw new Error("Codex HTTP server is already listening.");
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      this.#server.once("error", onError);
      this.#server.listen(port, LOOPBACK_HOST, () => {
        this.#server.off("error", onError);
        resolve();
      });
    });
    const address = this.#server.address();
    if (!address || typeof address === "string") {
      throw new Error("Codex HTTP server did not expose a TCP address.");
    }
    return {
      host: LOOPBACK_HOST,
      port: address.port,
      url: `http://${LOOPBACK_HOST}:${address.port}`,
    };
  }

  async close(): Promise<void> {
    const stoppedAt = new Date().toISOString();
    for (const activation of [...this.#pendingWriteActivations.values()]) {
      this.#removeWriteActivation(activation, "stopped");
    }
    for (const session of new Set(this.#sessionsByInternal.values())) {
      if (session.terminal) continue;
      for (const approvalId of session.pendingApprovals) {
        const approval = this.#metadataStore?.getMetadata<
          Record<string, unknown>
        >("approvals", approvalId);
        this.#metadataStore?.upsertMetadata("approvals", approvalId, {
          ...approval,
          decision: "stopped",
          decidedAt: stoppedAt,
        });
      }
      session.pendingApprovals.clear();
      session.terminal = true;
      this.#persistRun(session, "interrupted", stoppedAt);
      this.#persistThreadBlocked(session, stoppedAt);
    }
    this.#unsubscribeTracking();
    if (!this.#server.listening) return;
    await new Promise<void>((resolve, reject) => {
      this.#server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
      this.#server.closeAllConnections();
    });
  }

  async #handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    this.#baseHeaders(response);
    response.setHeader("x-correlation-id", this.#correlationId(request));
    const origin = request.headers.origin;
    if (origin !== undefined) {
      if (!this.#allowedOrigins.has(origin)) {
        this.#json(response, 403, { error: "origin_forbidden" });
        return;
      }
      response.setHeader("access-control-allow-origin", origin);
      response.setHeader("vary", "Origin");
    }
    if (request.method === "OPTIONS") {
      if (origin === undefined) {
        this.#json(response, 403, { error: "origin_required" });
        return;
      }
      response.statusCode = 204;
      response.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
      response.setHeader(
        "access-control-allow-headers",
        "authorization, content-type, x-correlation-id",
      );
      response.end();
      return;
    }
    if (!this.#authorized(request.headers.authorization)) {
      response.setHeader("www-authenticate", "Bearer");
      this.#json(response, 401, { error: "unauthorized" });
      return;
    }

    const url = new URL(request.url ?? "/", `http://${LOOPBACK_HOST}`);
    try {
      if (request.method === "GET" && url.pathname === "/v1/status") {
        await this.#status(response);
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/runs") {
        await this.#startRun(request, response);
        return;
      }
      if (
        request.method === "POST" &&
        url.pathname === "/v1/approvals/resume"
      ) {
        await this.#resumeApproval(request, response);
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/evidence/export") {
        await this.#exportEvidence(request, response);
        return;
      }
      const artifact = /^\/v1\/evidence\/exports\/([^/]+)\/([^/]+)$/.exec(
        url.pathname,
      );
      if (request.method === "GET" && artifact) {
        await this.#downloadEvidenceArtifact(
          response,
          decodePathSegment(artifact[1] ?? ""),
          decodePathSegment(artifact[2] ?? ""),
        );
        return;
      }
      const replay = /^\/v1\/runs\/([^/]+)\/events$/.exec(url.pathname);
      if (request.method === "GET" && replay) {
        this.#replayRunEvents(
          response,
          decodePathSegment(replay[1] ?? ""),
          url,
        );
        return;
      }
      const stop = /^\/v1\/runs\/([^/]+)\/stop$/.exec(url.pathname);
      if (request.method === "POST" && stop) {
        await this.#stopRun(
          request,
          response,
          decodePathSegment(stop[1] ?? ""),
        );
        return;
      }
      const archive = /^\/v1\/threads\/([^/]+)\/archive$/.exec(url.pathname);
      if (request.method === "POST" && archive) {
        await this.#archiveThread(
          request,
          response,
          decodePathSegment(archive[1] ?? ""),
        );
        return;
      }
      this.#json(response, 404, { error: "not_found" });
    } catch (error) {
      if (response.headersSent) throw error;
      if (error instanceof HttpError) {
        this.#json(response, error.status, { error: error.code });
      } else if (error instanceof DirtyRepositoryError) {
        this.#json(response, 409, { error: error.code });
      } else {
        reportInternalError(error);
        this.#json(response, 500, { error: "internal_error" });
      }
    }
  }

  async #status(response: ServerResponse): Promise<void> {
    let status;
    try {
      status = await this.#bridge.start();
    } catch {
      throw new HttpError(503, "codex_unavailable");
    }
    const activeRuns = new Set(
      [...this.#sessionsByInternal.values()]
        .filter((session) => !session.terminal)
        .map((session) => session.handle.runId),
    ).size;
    this.#json(response, status.account.signedIn ? 200 : 503, {
      ready: status.connected && status.account.signedIn,
      ...status,
      activeRuns,
      observability: this.#observability.snapshot(
        activeRuns,
        status.restartCount,
      ),
      policy: {
        model: "gpt-5.6-sol",
        effort: "max",
        defaultSandbox: "read-only",
        sandboxBackend: "managed-bubblewrap",
        networkAccess: false,
        remoteActions: false,
      },
    });
  }

  async #startRun(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const body = await this.#readJson(request);
    const externalRunId = requiredId(body.runId, "invalid_run_id");
    const aguiThreadId = requiredId(body.threadId, "invalid_thread_id");
    if (
      this.#sessionsByExternal.has(externalRunId) ||
      this.#pendingWriteByExternal.has(externalRunId) ||
      this.#startingRuns.has(externalRunId) ||
      this.#exportableByExternal.has(externalRunId)
    ) {
      throw new HttpError(409, "run_id_in_use");
    }
    const prompt = promptFromMessages(body.messages);
    const state = record(body.state);
    const repo =
      typeof state.repo === "string" ? state.repo : this.#defaultRepo;
    const mode = state.codexMode ?? "read-only";
    if (mode !== "read-only" && mode !== "write") {
      throw new HttpError(400, "invalid_codex_mode");
    }
    const evidenceContext = optionalEvidenceContext(state);
    const correlationId =
      evidenceContext?.correlationId ?? this.#correlationId(request);
    response.setHeader("x-correlation-id", correlationId);
    if (mode === "write") {
      await this.#stageWriteActivation(request, response, {
        aguiThreadId,
        externalRunId,
        prompt,
        repo,
        correlationId,
        ...(typeof state.baseRef === "string"
          ? { baseRef: state.baseRef }
          : {}),
        ...(evidenceContext === undefined ? {} : { evidenceContext }),
      });
      return;
    }

    const internalRunId = randomUUID();
    const queue = this.#eventQueue(() => {
      this.#interruptAfterStreamFailure(internalRunId);
    });
    const unsubscribe = this.#bridge.subscribe((event) => {
      if (event.runId === internalRunId) queue.push(event);
    });
    this.#observeStreamClose(
      request,
      response,
      queue,
      correlationId,
      internalRunId,
    );
    this.#startingRuns.add(externalRunId);
    try {
      const resumeThreadId =
        typeof state.codexThreadId === "string"
          ? state.codexThreadId
          : undefined;
      if (resumeThreadId !== undefined) {
        let canonicalRepo: string;
        try {
          canonicalRepo = await realpath(repo);
        } catch {
          throw new HttpError(400, "invalid_repository");
        }
        if (this.#ownedThreads.get(resumeThreadId) !== canonicalRepo) {
          throw new HttpError(403, "thread_capability_required");
        }
      }
      const handle = await this.#bridge.startReadOnlyPlan({
        repo,
        prompt,
        runId: internalRunId,
        ...(resumeThreadId === undefined ? {} : { threadId: resumeThreadId }),
      });
      const startedAt = new Date().toISOString();
      const session: RunSession = {
        handle,
        aguiThreadId,
        externalRunIds: new Set([externalRunId]),
        pendingApprovals: new Set(),
        correlationId,
        commandItems: new Set(),
        fileChangeItems: new Set(),
        terminal: false,
        startedAt,
        repoRoot: handle.cwd,
        evidenceContext: evidenceContext ?? null,
        eventSequence: 0,
      };
      this.#observability.runStarted(handle.runId, correlationId);
      this.#sessionsByInternal.set(handle.runId, session);
      this.#sessionsByExternal.set(externalRunId, session);
      this.#rememberThread(
        handle.threadId,
        handle.cwd,
        handle.cwd,
        handle.runId,
        startedAt,
      );
      this.#persistRun(session);
      void handle.completion.catch(() => undefined);
      this.#streamHeaders(request, response);
      await this.#pump(response, queue, session);
    } finally {
      this.#startingRuns.delete(externalRunId);
      unsubscribe();
      queue.close();
    }
  }

  async #resumeApproval(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const body = await this.#readJson(request);
    const trustedControl = body.type === "run.approval";
    if (body.type !== undefined && !trustedControl) {
      throw new HttpError(400, "invalid_approval_request");
    }
    const approvalId = requiredId(
      trustedControl ? body.approvalId : body.pendingRequestId,
      "invalid_approval_id",
    );
    const externalRunId = requiredId(body.runId, "invalid_run_id");
    const decision = approvalDecision(body, trustedControl);
    const activation = this.#pendingWriteActivations.get(approvalId);
    if (activation) {
      await this.#resumeWriteActivation(
        request,
        response,
        body,
        trustedControl,
        externalRunId,
        decision,
        activation,
      );
      return;
    }
    const session = this.#pendingApprovals.get(approvalId);
    if (
      !session ||
      session.terminal ||
      !session.pendingApprovals.has(approvalId)
    ) {
      throw new HttpError(404, "approval_not_pending");
    }
    if (trustedControl && !session.externalRunIds.has(externalRunId)) {
      throw new HttpError(404, "approval_not_pending");
    }
    if (!trustedControl) {
      validateAdapterResume(body, session.aguiThreadId, approvalId);
    }
    const mapped = this.#sessionsByExternal.get(externalRunId);
    if (
      (mapped && mapped !== session) ||
      this.#pendingWriteByExternal.has(externalRunId) ||
      this.#startingRuns.has(externalRunId) ||
      this.#exportableByExternal.has(externalRunId)
    ) {
      throw new HttpError(409, "run_id_in_use");
    }
    const queue = this.#eventQueue(() => {
      this.#interruptAfterStreamFailure(session.handle.runId);
    });
    const unsubscribe = this.#bridge.subscribe((event) => {
      if (event.runId === session.handle.runId) queue.push(event);
    });
    response.setHeader("x-correlation-id", session.correlationId);
    this.#observeStreamClose(
      request,
      response,
      queue,
      session.correlationId,
      session.handle.runId,
    );
    try {
      this.#bridge.resolveApproval(approvalId, decision);
      this.#pendingApprovals.delete(approvalId);
      session.pendingApprovals.delete(approvalId);
      session.externalRunIds.add(externalRunId);
      this.#sessionsByExternal.set(externalRunId, session);
      this.#persistRun(session);
      this.#streamHeaders(request, response);
      await this.#pump(response, queue, session);
    } finally {
      unsubscribe();
      queue.close();
    }
  }

  async #stageWriteActivation(
    request: IncomingMessage,
    response: ServerResponse,
    input: {
      aguiThreadId: string;
      externalRunId: string;
      prompt: string;
      repo: string;
      correlationId: string;
      baseRef?: string;
      evidenceContext?: RunEvidenceContext;
    },
  ): Promise<void> {
    try {
      await this.#bridge.start();
    } catch {
      throw new HttpError(503, "codex_unavailable");
    }
    const id = randomUUID();
    const activation: PendingWriteActivation = {
      id,
      ...input,
      timer: null,
      timedOutAt: null,
    };
    const timer = setTimeout(() => {
      this.#markWriteActivationTimedOut(activation);
    }, this.#approvalTimeoutMs);
    timer.unref();
    activation.timer = timer;
    this.#pendingWriteActivations.set(id, activation);
    this.#pendingWriteByExternal.set(input.externalRunId, activation);
    this.#metadataStore?.upsertMetadata("approvals", id, {
      id,
      voissRunId: input.externalRunId,
      kind: "write_activation",
      decision: "pending",
      correlationId: input.correlationId,
      requestedAt: new Date().toISOString(),
      decidedAt: null,
    });
    this.#observability.approvalRequested(id, input.correlationId);
    this.#streamHeaders(request, response);
    await this.#writeEnvelope(response, {
      method: "item/fileChange/requestApproval",
      id,
      params: {
        threadId: input.aguiThreadId,
        itemId: `write-activation:${id}`,
        reason:
          "Activate an isolated workspace-write run with network access disabled.",
        grantRoot: "[isolated worktree created after approval]",
        scope: {
          sandbox: "workspace-write",
          networkAccess: false,
          remoteActions: false,
        },
      },
    });
    this.#endStream(response);
  }

  async #resumeWriteActivation(
    request: IncomingMessage,
    response: ServerResponse,
    body: Record<string, unknown>,
    trustedControl: boolean,
    externalRunId: string,
    decision: ApprovalDecision,
    activation: PendingWriteActivation,
  ): Promise<void> {
    if (trustedControl) {
      if (externalRunId !== activation.externalRunId) {
        throw new HttpError(404, "approval_not_pending");
      }
    } else {
      validateAdapterResume(body, activation.aguiThreadId, activation.id);
    }
    const mapped = this.#sessionsByExternal.get(externalRunId);
    const pending = this.#pendingWriteByExternal.get(externalRunId);
    const reservationIds = new Set([activation.externalRunId, externalRunId]);
    if (
      mapped ||
      (pending && pending !== activation) ||
      (externalRunId !== activation.externalRunId &&
        this.#pendingWriteByExternal.has(externalRunId)) ||
      [...reservationIds].some(
        (id) =>
          this.#startingRuns.has(id) || this.#exportableByExternal.has(id),
      )
    ) {
      throw new HttpError(409, "run_id_in_use");
    }
    this.#removeWriteActivation(activation, decision);
    response.setHeader("x-correlation-id", activation.correlationId);
    if (decision === "deny") {
      this.#streamHeaders(request, response);
      await this.#writeEnvelope(response, {
        method: "serverRequest/resolved",
        params: {
          threadId: activation.aguiThreadId,
          requestId: activation.id,
          decision: "deny",
        },
      });
      await this.#writeEnvelope(response, {
        method: "turn/completed",
        params: {
          threadId: activation.aguiThreadId,
          turn: { id: null, status: "interrupted" },
        },
      });
      this.#endStream(response);
      return;
    }

    const internalRunId = randomUUID();
    const queue = this.#eventQueue(() => {
      this.#interruptAfterStreamFailure(internalRunId);
    });
    const unsubscribe = this.#bridge.subscribe((event) => {
      if (event.runId === internalRunId) queue.push(event);
    });
    this.#observeStreamClose(
      request,
      response,
      queue,
      activation.correlationId,
      internalRunId,
    );
    for (const id of reservationIds) this.#startingRuns.add(id);
    try {
      const handle = await this.#bridge.startWriteRun({
        repo: activation.repo,
        prompt: activation.prompt,
        approval: decision,
        approvalId: activation.id,
        runId: internalRunId,
        ...(activation.baseRef === undefined
          ? {}
          : { baseRef: activation.baseRef }),
        ...(activation.evidenceContext === undefined
          ? {}
          : { evidenceContext: activation.evidenceContext }),
      });
      const startedAt = new Date().toISOString();
      const repoRoot = await realpath(activation.repo);
      const session: RunSession = {
        handle,
        aguiThreadId: activation.aguiThreadId,
        externalRunIds: new Set([activation.externalRunId, externalRunId]),
        pendingApprovals: new Set(),
        correlationId: activation.correlationId,
        commandItems: new Set(),
        fileChangeItems: new Set(),
        terminal: false,
        startedAt,
        repoRoot,
        evidenceContext: activation.evidenceContext ?? null,
        eventSequence: 0,
      };
      this.#observability.runStarted(handle.runId, activation.correlationId);
      this.#sessionsByInternal.set(handle.runId, session);
      this.#rememberThread(
        handle.threadId,
        repoRoot,
        handle.cwd,
        handle.runId,
        startedAt,
      );
      for (const id of session.externalRunIds) {
        this.#sessionsByExternal.set(id, session);
      }
      this.#persistRun(session);
      void handle.completion.catch(() => undefined);
      queue.push({
        type: "approval.resolved",
        runId: handle.runId,
        threadId: handle.threadId,
        turnId: handle.turnId || null,
        timestamp: new Date().toISOString(),
        data: {
          approvalId: activation.id,
          kind: "write_activation",
          decision,
        },
      });
      this.#streamHeaders(request, response);
      await this.#pump(response, queue, session);
    } finally {
      for (const id of reservationIds) this.#startingRuns.delete(id);
      unsubscribe();
      queue.close();
    }
  }

  #removeWriteActivation(
    activation: PendingWriteActivation,
    decision: ApprovalDecision | "expired" | "stopped" = "expired",
  ): void {
    this.#observability.approvalResolved(
      activation.id,
      activation.correlationId,
      decision,
    );
    const previous = this.#metadataStore?.getMetadata<Record<string, unknown>>(
      "approvals",
      activation.id,
    );
    this.#metadataStore?.upsertMetadata("approvals", activation.id, {
      ...previous,
      id: activation.id,
      voissRunId: activation.externalRunId,
      kind: "write_activation",
      decision,
      status: "resolved",
      correlationId: activation.correlationId,
      decidedAt: new Date().toISOString(),
    });
    if (activation.timer) clearTimeout(activation.timer);
    activation.timer = null;
    this.#pendingWriteActivations.delete(activation.id);
    if (
      this.#pendingWriteByExternal.get(activation.externalRunId) === activation
    ) {
      this.#pendingWriteByExternal.delete(activation.externalRunId);
    }
  }

  #markWriteActivationTimedOut(activation: PendingWriteActivation): void {
    if (this.#pendingWriteActivations.get(activation.id) !== activation) return;
    const timedOutAt = new Date().toISOString();
    activation.timer = null;
    activation.timedOutAt = timedOutAt;
    const previous = this.#metadataStore?.getMetadata<Record<string, unknown>>(
      "approvals",
      activation.id,
    );
    this.#metadataStore?.upsertMetadata("approvals", activation.id, {
      ...previous,
      decision: "timed_out",
      status: "paused",
      timedOutAt,
      decidedAt: null,
    });
  }

  #reconcilePersistedLifecycle(): void {
    if (!this.#metadataStore) return;
    const reconciledAt = new Date().toISOString();
    const runs = this.#metadataStore.listMetadata<PersistedRun>("agent_runs");
    for (const run of runs) {
      if (run.status !== "running") continue;
      this.#metadataStore.upsertMetadata("agent_runs", run.id, {
        ...run,
        status: "blocked",
        endedAt: reconciledAt,
      } satisfies PersistedRun);
    }
    for (const approval of this.#metadataStore.listMetadata<
      Record<string, unknown>
    >("approvals")) {
      if (
        approval.decision !== "pending" &&
        approval.decision !== "timed_out"
      ) {
        continue;
      }
      const id = typeof approval.id === "string" ? approval.id : null;
      if (!id) continue;
      this.#metadataStore.upsertMetadata("approvals", id, {
        ...approval,
        decision: "blocked",
        status: "service_restarted",
        decidedAt: reconciledAt,
      });
    }
    for (const thread of this.#metadataStore.listMetadata<PersistedThread>(
      "codex_threads",
    )) {
      if (thread.status !== "active") continue;
      this.#metadataStore.upsertMetadata("codex_threads", thread.id, {
        ...thread,
        status: "blocked",
        updatedAt: reconciledAt,
      } satisfies PersistedThread);
    }
  }

  #restoreThreadCapabilities(): void {
    const runs = new Map(
      (this.#metadataStore?.listMetadata<PersistedRun>("agent_runs") ?? []).map(
        (run) => [run.id, run],
      ),
    );
    for (const thread of this.#metadataStore?.listMetadata<PersistedThread>(
      "codex_threads",
    ) ?? []) {
      const lastRun = runs.get(thread.lastRunId);
      if (
        thread.status !== "idle" ||
        !lastRun ||
        !["completed", "interrupted", "failed"].includes(lastRun.status) ||
        !ID_PATTERN.test(thread.id) ||
        !isAbsolute(thread.cwd)
      ) {
        continue;
      }
      this.#ownedThreads.set(thread.id, thread.cwd);
    }
  }

  #rememberThread(
    threadId: string,
    repository: string,
    cwd: string,
    runId: string,
    occurredAt: string,
  ): void {
    this.#ownedThreads.set(threadId, cwd);
    const previous = this.#metadataStore?.getMetadata<PersistedThread>(
      "codex_threads",
      threadId,
    );
    this.#metadataStore?.upsertMetadata("codex_threads", threadId, {
      id: threadId,
      repository,
      cwd,
      model: "gpt-5.6-sol",
      profile: "max",
      lastRunId: runId,
      status: "active",
      createdAt: previous?.createdAt ?? occurredAt,
      updatedAt: occurredAt,
      archivedAt: null,
    } satisfies PersistedThread);
    while (this.#ownedThreads.size > 1_000) {
      const oldest = this.#ownedThreads.keys().next().value;
      if (typeof oldest !== "string") break;
      this.#ownedThreads.delete(oldest);
    }
  }

  #persistRun(
    session: RunSession,
    status: PersistedRun["status"] = "running",
    endedAt: string | null = null,
  ): void {
    const context = session.evidenceContext;
    const run: PersistedRun = {
      id: session.handle.runId,
      voissRunIds: [...session.externalRunIds].sort(),
      codexThreadId: session.handle.threadId,
      aguiThreadId: session.aguiThreadId,
      repository: session.repoRoot,
      worktree: session.handle.cwd,
      mode: session.handle.mode,
      model: "gpt-5.6-sol",
      profile: "max",
      sourceSessionId: context?.sourceSessionId ?? null,
      sourceActionId: context?.sourceActionId ?? null,
      sourceEvidenceIds: context?.sourceEvidenceRefs ?? [],
      startedAt: session.startedAt,
      endedAt,
      status,
      correlationId: session.correlationId,
    };
    this.#metadataStore?.upsertMetadata("agent_runs", run.id, run);
    this.#metadataStore?.upsertMetadata("repositories", session.repoRoot, {
      id: session.repoRoot,
      canonicalPath: session.repoRoot,
      lastRunId: run.id,
      updatedAt: endedAt ?? session.startedAt,
    });
    this.#metadataStore?.upsertMetadata("workspaces", run.id, {
      id: run.id,
      path: session.handle.cwd,
      repository: session.repoRoot,
      isolated: session.handle.mode === "write",
      status,
      updatedAt: endedAt ?? session.startedAt,
    });
    if (context) {
      this.#metadataStore?.upsertMetadata("actions", context.sourceActionId, {
        id: context.sourceActionId,
        sessionId: context.sourceSessionId,
        evidenceRefs: context.sourceEvidenceRefs,
        lastRunId: run.id,
        updatedAt: endedAt ?? session.startedAt,
      });
    }
  }

  #persistEvent(session: RunSession, event: BridgeEvent): void {
    if (!this.#metadataStore) return;
    session.eventSequence += 1;
    const id = `${event.runId}:${String(session.eventSequence).padStart(6, "0")}`;
    this.#metadataStore.upsertMetadata("run_events", id, {
      id,
      sequence: session.eventSequence,
      runId: event.runId,
      voissRunIds: [...session.externalRunIds].sort(),
      threadId: event.threadId,
      correlationId: session.correlationId,
      type: event.type,
      occurredAt: event.timestamp,
      data: sanitizeForEvent(event.data, 4_096),
    });
  }

  #persistThreadIdle(session: RunSession, occurredAt: string): void {
    const thread = this.#metadataStore?.getMetadata<PersistedThread>(
      "codex_threads",
      session.handle.threadId,
    );
    if (!thread) return;
    this.#metadataStore?.upsertMetadata("codex_threads", thread.id, {
      ...thread,
      status: "idle",
      updatedAt: occurredAt,
    } satisfies PersistedThread);
  }

  #persistThreadBlocked(session: RunSession, occurredAt: string): void {
    const thread = this.#metadataStore?.getMetadata<PersistedThread>(
      "codex_threads",
      session.handle.threadId,
    );
    if (!thread) return;
    this.#metadataStore?.upsertMetadata("codex_threads", thread.id, {
      ...thread,
      status: "blocked",
      updatedAt: occurredAt,
    } satisfies PersistedThread);
    this.#ownedThreads.delete(thread.id);
  }

  async #archiveThread(
    request: IncomingMessage,
    response: ServerResponse,
    threadId: string,
  ): Promise<void> {
    requiredId(threadId, "invalid_thread_id");
    if (hasRequestBody(request)) {
      await this.#readJson(request);
    }
    if (
      !this.#ownedThreads.has(threadId) ||
      [...this.#sessionsByInternal.values()].some(
        (session) => !session.terminal && session.handle.threadId === threadId,
      )
    ) {
      throw new HttpError(409, "thread_not_archivable");
    }
    try {
      await this.#bridge.archiveThread(threadId);
    } catch {
      throw new HttpError(409, "thread_archive_failed");
    }
    const archivedAt = new Date().toISOString();
    const thread = this.#metadataStore?.getMetadata<PersistedThread>(
      "codex_threads",
      threadId,
    );
    if (thread) {
      this.#metadataStore?.upsertMetadata("codex_threads", threadId, {
        ...thread,
        status: "archived",
        updatedAt: archivedAt,
        archivedAt,
      } satisfies PersistedThread);
    }
    this.#ownedThreads.delete(threadId);
    this.#json(response, 200, { archived: true, threadId, archivedAt });
  }

  async #stopRun(
    request: IncomingMessage,
    response: ServerResponse,
    externalRunId: string,
  ): Promise<void> {
    requiredId(externalRunId, "invalid_run_id");
    if (hasRequestBody(request)) {
      await this.#readJson(request);
    }
    const activation = this.#pendingWriteByExternal.get(externalRunId);
    if (activation) {
      this.#removeWriteActivation(activation, "stopped");
      this.#json(response, 202, {
        accepted: true,
        runId: externalRunId,
        status: "cancelled",
      });
      return;
    }
    const session = this.#sessionsByExternal.get(externalRunId);
    if (!session || session.terminal)
      throw new HttpError(404, "run_not_active");
    try {
      await this.#bridge.interrupt(session.handle.runId);
    } catch {
      throw new HttpError(409, "run_not_interruptible");
    }
    this.#json(response, 202, {
      accepted: true,
      runId: externalRunId,
      status: "stopping",
    });
  }

  #replayRunEvents(response: ServerResponse, runId: string, url: URL): void {
    requiredId(runId, "invalid_run_id");
    if (!this.#metadataStore) {
      throw new HttpError(503, "metadata_unavailable");
    }
    const run = this.#metadataStore
      .listMetadata<PersistedRun>("agent_runs")
      .find(
        (candidate) =>
          candidate.id === runId || candidate.voissRunIds.includes(runId),
      );
    if (!run) throw new HttpError(404, "run_not_found");
    const after = boundedQueryInteger(
      url.searchParams.get("after"),
      0,
      0,
      1_000_000,
    );
    const limit = boundedQueryInteger(
      url.searchParams.get("limit"),
      200,
      1,
      200,
    );
    const events = this.#metadataStore
      .listMetadata<Record<string, unknown>>("run_events")
      .filter((event) => event.runId === run.id)
      .filter((event) => numericCount(event.sequence) > after)
      .sort(
        (left, right) =>
          numericCount(left.sequence) - numericCount(right.sequence),
      )
      .slice(0, limit);
    this.#json(response, 200, {
      runId,
      internalRunId: run.id,
      status: run.status,
      events,
      nextCursor:
        events.length > 0 ? numericCount(events.at(-1)?.sequence) : after,
    });
  }

  async #exportEvidence(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const body = await this.#readJson(request);
    if (body.type !== undefined && body.type !== "evidence.export") {
      throw new HttpError(400, "invalid_export_request");
    }
    const correlationId =
      body.correlationId === undefined
        ? null
        : requiredCorrelationId(body.correlationId);
    let session: RunSession | undefined | null;
    let externalRunId: string | null = null;
    if (body.runId !== undefined) {
      externalRunId = requiredId(body.runId, "invalid_run_id");
      session = this.#exportableByExternal.get(externalRunId);
    } else {
      session = this.#latestExportable;
    }
    if (!session || !session.terminal || session.handle.mode !== "write") {
      throw new HttpError(409, "no_exportable_run");
    }
    try {
      const exported = await this.#bridge.exportRun(session.handle.runId);
      const [patch, evidence, checksums] = await Promise.all([
        stat(exported.patchPath),
        stat(exported.evidencePath),
        stat(exported.checksumsPath),
      ]);
      const exportId = basename(exported.directory);
      const payload = {
        exported: true,
        classification: "live_codex_evidence",
        correlationId,
        exportId,
        runId: externalRunId ?? [...session.externalRunIds][0] ?? null,
        artifacts: [
          {
            kind: "patch",
            filename: basename(exported.patchPath),
            bytes: patch.size,
            sha256: exported.patchSha256,
          },
          {
            kind: "evidence",
            filename: basename(exported.evidencePath),
            bytes: evidence.size,
            sha256: exported.evidenceSha256,
          },
          {
            kind: "checksums",
            filename: basename(exported.checksumsPath),
            bytes: checksums.size,
          },
        ],
      };
      this.#metadataStore?.upsertMetadata("exports", exportId, {
        ...payload,
        internalRunId: session.handle.runId,
        voissRunIds: [...session.externalRunIds].sort(),
        exportedAt: new Date().toISOString(),
      });
      this.#json(response, 200, payload);
    } catch (error) {
      reportInternalError(error);
      throw new HttpError(409, "export_unavailable");
    }
  }

  async #downloadEvidenceArtifact(
    response: ServerResponse,
    exportId: string,
    filename: string,
  ): Promise<void> {
    try {
      const artifact = await this.#bridge.readExportArtifact(
        exportId,
        filename,
      );
      response.statusCode = 200;
      response.setHeader("cache-control", "private, no-store");
      response.setHeader(
        "content-disposition",
        `attachment; filename="${artifact.filename}"`,
      );
      response.setHeader("content-length", artifact.content.byteLength);
      response.setHeader("content-type", artifact.contentType);
      response.setHeader("x-content-type-options", "nosniff");
      response.end(artifact.content);
    } catch {
      throw new HttpError(404, "artifact_not_found");
    }
  }

  async #pump(
    response: ServerResponse,
    queue: EventQueue,
    session: RunSession,
  ): Promise<void> {
    const sse = this.#isSse(response);
    while (!response.destroyed) {
      const event = await queue.next();
      if (!event) break;
      this.#trackEvent(event);
      const envelope = protocolEnvelope(event);
      const serialized = JSON.stringify(envelope);
      if (Buffer.byteLength(serialized) > this.#maxEventBytes) {
        const limited = JSON.stringify({
          method: "error",
          params: {
            threadId: event.threadId,
            error: {
              code: "bridge_event_too_large",
              message: "Codex Bridge event exceeded the output limit.",
            },
          },
        });
        await writeResponse(
          response,
          sse ? `data: ${limited}\n\n` : `${limited}\n`,
        );
        this.#interruptAfterStreamFailure(session.handle.runId);
        break;
      }
      await writeResponse(
        response,
        sse ? `data: ${serialized}\n\n` : `${serialized}\n`,
      );
      if (event.type === "approval.requested" || isTerminalEvent(event)) {
        break;
      }
    }
    this.#endStream(response);
    if (session.terminal) this.#forgetSession(session);
  }

  #trackEvent(event: BridgeEvent): void {
    const session = this.#sessionsByInternal.get(event.runId);
    if (!session) return;
    if (this.#trackedEvents.has(event)) return;
    this.#trackedEvents.add(event);
    const data = record(event.data);
    this.#persistEvent(session, event);
    if (event.type === "approval.requested") {
      if (
        typeof data.approvalId === "string" &&
        ID_PATTERN.test(data.approvalId)
      ) {
        session.pendingApprovals.add(data.approvalId);
        this.#pendingApprovals.set(data.approvalId, session);
        this.#metadataStore?.upsertMetadata("approvals", data.approvalId, {
          id: data.approvalId,
          runId: session.handle.runId,
          voissRunIds: [...session.externalRunIds].sort(),
          threadId: session.handle.threadId,
          kind: data.kind ?? "unknown",
          decision: "pending",
          correlationId: session.correlationId,
          requestedAt: event.timestamp,
          decidedAt: null,
        });
        this.#observability.approvalRequested(
          data.approvalId,
          session.correlationId,
        );
      }
    }
    if (
      event.type === "approval.resolved" &&
      typeof data.approvalId === "string"
    ) {
      const previous = this.#metadataStore?.getMetadata<
        Record<string, unknown>
      >("approvals", data.approvalId);
      this.#metadataStore?.upsertMetadata("approvals", data.approvalId, {
        ...previous,
        id: data.approvalId,
        runId: session.handle.runId,
        voissRunIds: [...session.externalRunIds].sort(),
        threadId: session.handle.threadId,
        kind: data.kind ?? previous?.kind ?? "unknown",
        decision: data.decision ?? "resolved",
        correlationId: session.correlationId,
        decidedAt: event.timestamp,
      });
      this.#observability.approvalResolved(
        data.approvalId,
        session.correlationId,
        typeof data.decision === "string" ? data.decision : "resolved",
      );
    }
    if (
      event.type === "approval.timed_out" &&
      typeof data.approvalId === "string"
    ) {
      const previous = this.#metadataStore?.getMetadata<
        Record<string, unknown>
      >("approvals", data.approvalId);
      this.#metadataStore?.upsertMetadata("approvals", data.approvalId, {
        ...previous,
        decision: "timed_out",
        status: "paused",
        timedOutAt: event.timestamp,
        decidedAt: null,
      });
    }
    const item = record(data.item);
    const itemId =
      typeof item.id === "string"
        ? item.id
        : typeof data.itemId === "string"
          ? data.itemId
          : null;
    if (
      (item.type === "commandExecution" || event.type === "command.output") &&
      itemId &&
      !session.commandItems.has(itemId)
    ) {
      session.commandItems.add(itemId);
      this.#observability.command(session.correlationId);
    }
    if (
      (item.type === "fileChange" || event.type === "file.patch") &&
      itemId &&
      !session.fileChangeItems.has(itemId)
    ) {
      session.fileChangeItems.add(itemId);
      this.#observability.fileChange(session.correlationId);
    }
    if (isTerminalEvent(event)) {
      session.terminal = true;
      for (const approvalId of session.pendingApprovals) {
        this.#pendingApprovals.delete(approvalId);
        const approval = this.#metadataStore?.getMetadata<
          Record<string, unknown>
        >("approvals", approvalId);
        this.#metadataStore?.upsertMetadata("approvals", approvalId, {
          ...approval,
          decision: "run_terminal",
          decidedAt: event.timestamp,
        });
        this.#observability.approvalResolved(
          approvalId,
          session.correlationId,
          "run_terminal",
        );
      }
      session.pendingApprovals.clear();
      const validation = record(data.validation);
      this.#observability.validation(
        session.correlationId,
        numericCount(validation.passed),
        numericCount(validation.failed),
      );
      const status =
        event.type === "turn.completed" &&
        (data.status === "completed" ||
          data.status === "interrupted" ||
          data.status === "failed")
          ? data.status
          : "blocked";
      this.#persistRun(session, status, event.timestamp);
      if (event.type === "turn.completed") {
        this.#persistThreadIdle(session, event.timestamp);
      } else {
        this.#persistThreadBlocked(session, event.timestamp);
      }
      this.#metadataStore?.upsertMetadata(
        "validation_results",
        session.handle.runId,
        {
          id: session.handle.runId,
          runId: session.handle.runId,
          voissRunIds: [...session.externalRunIds].sort(),
          correlationId: session.correlationId,
          status:
            numericCount(validation.failed) > 0
              ? "failed"
              : numericCount(validation.passed) > 0
                ? "passed"
                : "missing",
          passed: numericCount(validation.passed),
          failed: numericCount(validation.failed),
          checkedAt: event.timestamp,
        },
      );
      this.#observability.runFinished(
        session.handle.runId,
        session.correlationId,
        status,
      );
      if (
        event.type === "turn.completed" &&
        data.status === "completed" &&
        session.handle.mode === "write"
      ) {
        this.#latestExportable = session;
        for (const externalRunId of session.externalRunIds) {
          this.#exportableByExternal.set(externalRunId, session);
        }
        while (this.#exportableByExternal.size > 100) {
          const oldest = this.#exportableByExternal.keys().next().value;
          if (typeof oldest !== "string") break;
          this.#exportableByExternal.delete(oldest);
        }
      }
      this.#forgetSession(session);
    }
  }

  #forgetSession(session: RunSession): void {
    this.#sessionsByInternal.delete(session.handle.runId);
    for (const externalRunId of session.externalRunIds) {
      if (this.#sessionsByExternal.get(externalRunId) === session) {
        this.#sessionsByExternal.delete(externalRunId);
      }
    }
  }

  #streamHeaders(request: IncomingMessage, response: ServerResponse): void {
    const accept = request.headers.accept ?? "";
    const sse =
      accept.includes("text/event-stream") &&
      !accept.includes("application/x-ndjson");
    response.statusCode = 200;
    response.setHeader(
      "content-type",
      sse
        ? "text/event-stream; charset=utf-8"
        : "application/x-ndjson; charset=utf-8",
    );
    response.setHeader("x-accel-buffering", "no");
    response.flushHeaders();
  }

  #eventQueue(onOverflow: () => void): EventQueue {
    return new EventQueue(
      256,
      Math.min(this.#maxEventBytes * 4, 4 * 1024 * 1024),
      onOverflow,
    );
  }

  #interruptAfterStreamFailure(runId: string): void {
    void this.#bridge.interrupt(runId).catch(() => undefined);
  }

  async #writeEnvelope(
    response: ServerResponse,
    envelope: ProtocolEnvelope,
  ): Promise<void> {
    const serialized = JSON.stringify(envelope);
    if (Buffer.byteLength(serialized) > this.#maxEventBytes) {
      throw new HttpError(500, "bridge_event_too_large");
    }
    await writeResponse(
      response,
      this.#isSse(response) ? `data: ${serialized}\n\n` : `${serialized}\n`,
    );
  }

  #endStream(response: ServerResponse): void {
    if (response.destroyed || response.writableEnded) return;
    if (this.#isSse(response)) response.write("data: [DONE]\n\n");
    response.end();
  }

  #isSse(response: ServerResponse): boolean {
    return (
      response.getHeader("content-type") === "text/event-stream; charset=utf-8"
    );
  }

  #observeStreamClose(
    request: IncomingMessage,
    response: ServerResponse,
    queue: EventQueue,
    correlationId: string,
    runId: string,
  ): void {
    response.once("close", () => {
      queue.close();
      const accept = request.headers.accept ?? "";
      if (
        !response.writableEnded &&
        accept.includes("text/event-stream") &&
        !accept.includes("application/x-ndjson")
      ) {
        this.#observability.sseDisconnected(correlationId, runId);
        this.#interruptAfterStreamFailure(runId);
      }
    });
  }

  #correlationId(request: IncomingMessage): string {
    const retained = this.#correlationIds.get(request);
    if (retained) return retained;
    const supplied = request.headers["x-correlation-id"];
    const candidate = Array.isArray(supplied) ? supplied[0] : supplied;
    const correlationId =
      typeof candidate === "string" &&
      /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(candidate)
        ? candidate
        : randomUUID();
    this.#correlationIds.set(request, correlationId);
    return correlationId;
  }

  async #readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
    const contentType = request.headers["content-type"] ?? "";
    if (!contentType.toLowerCase().startsWith("application/json")) {
      throw new HttpError(415, "content_type_required");
    }
    const declared = Number(request.headers["content-length"] ?? "0");
    if (Number.isFinite(declared) && declared > this.#maxBodyBytes) {
      request.resume();
      throw new HttpError(413, "request_too_large");
    }
    const body = await new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      let settled = false;
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      request.on("data", (chunk: Buffer) => {
        if (settled) return;
        bytes += chunk.byteLength;
        if (bytes > this.#maxBodyBytes) {
          chunks.length = 0;
          request.resume();
          fail(new HttpError(413, "request_too_large"));
          return;
        }
        chunks.push(chunk);
      });
      request.once("end", () => {
        if (settled) return;
        settled = true;
        resolve(Buffer.concat(chunks).toString("utf8"));
      });
      request.once("aborted", () =>
        fail(new HttpError(400, "request_aborted")),
      );
      request.once("error", () => fail(new HttpError(400, "request_error")));
    });
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new HttpError(400, "invalid_json");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new HttpError(400, "invalid_request");
    }
    return parsed as Record<string, unknown>;
  }

  #authorized(header: string | undefined): boolean {
    if (!header?.startsWith("Bearer ")) return false;
    const candidate = digest(header.slice("Bearer ".length));
    return timingSafeEqual(candidate, this.#tokenDigest);
  }

  #baseHeaders(response: ServerResponse): void {
    response.setHeader("cache-control", "no-store");
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("referrer-policy", "no-referrer");
  }

  #json(
    response: ServerResponse,
    status: number,
    value: Record<string, unknown>,
  ): void {
    response.statusCode = status;
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.end(`${JSON.stringify(value)}\n`);
  }
}

function numericCount(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
}

function boundedQueryInteger(
  value: string | null,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new HttpError(400, "invalid_cursor");
  }
  return parsed;
}

function hasRequestBody(request: IncomingMessage): boolean {
  if (request.headers["transfer-encoding"] !== undefined) return true;
  const length = Number(request.headers["content-length"] ?? 0);
  return Number.isFinite(length) && length > 0;
}

function reportInternalError(error: unknown): void {
  const detail =
    error instanceof Error
      ? { name: error.name, message: error.message }
      : { name: "UnknownError", message: String(error) };
  process.stderr.write(
    `${JSON.stringify({
      level: "error",
      component: "codex-bridge",
      code: "internal_error",
      detail: sanitizeForEvent(detail, 4_096),
    })}\n`,
  );
}

function protocolEnvelope(event: BridgeEvent): ProtocolEnvelope {
  const data = record(event.data);
  const direct: Partial<Record<BridgeEvent["type"], string>> = {
    "turn.started": "turn/started",
    "item.started": "item/started",
    "item.completed": "item/completed",
    "plan.delta": "item/plan/delta",
    "plan.updated": "turn/plan/updated",
    "command.output": "item/commandExecution/outputDelta",
    "file.patch": "item/fileChange/patchUpdated",
    "diff.updated": "turn/diff/updated",
    "message.delta": "item/agentMessage/delta",
  };
  if (event.type === "run.started") {
    return {
      method: "thread/started",
      params: {
        threadId: event.threadId,
        thread: { id: event.threadId },
        ...data,
      },
    };
  }
  if (event.type === "approval.requested") {
    const params = record(data.requestParams);
    return {
      method:
        data.kind === "file"
          ? "item/fileChange/requestApproval"
          : "item/commandExecution/requestApproval",
      params: { ...params, threadId: event.threadId },
      ...(typeof data.approvalId === "string" ? { id: data.approvalId } : {}),
    };
  }
  if (event.type === "approval.resolved") {
    return {
      method: "serverRequest/resolved",
      params: {
        threadId: event.threadId,
        requestId: data.approvalId ?? null,
        ...data,
      },
    };
  }
  if (event.type === "approval.timed_out") {
    return {
      method: "bridge/approvalTimedOut",
      params: {
        threadId: event.threadId,
        requestId: data.approvalId ?? null,
        ...data,
      },
    };
  }
  if (event.type === "turn.completed") {
    const notification = record(data.notification);
    if (Object.keys(record(notification.turn)).length > 0) {
      return {
        method: "turn/completed",
        params: notification,
      };
    }
    return {
      method: "turn/completed",
      params: {
        threadId: event.threadId,
        turn: {
          id: event.turnId,
          status: data.status ?? "failed",
        },
      },
    };
  }
  if (event.type === "run.error") {
    const originalError = record(data.error);
    return {
      method: "error",
      params: {
        threadId: event.threadId,
        ...data,
        error:
          Object.keys(originalError).length > 0
            ? originalError
            : { message: data.message ?? "Codex Bridge run failed." },
      },
    };
  }
  return {
    method: direct[event.type] ?? "bridge/unknown",
    params: { threadId: event.threadId, ...data },
  };
}

function approvalDecision(
  body: Record<string, unknown>,
  trustedControl: boolean,
): ApprovalDecision {
  if (trustedControl) {
    if (
      body.decision === "allow_once" ||
      body.decision === "allow_run_scope" ||
      body.decision === "deny"
    ) {
      return body.decision;
    }
    throw new HttpError(400, "invalid_approval_decision");
  }
  if (body.decision === "decline" || body.decision === "cancel") return "deny";
  if (body.decision !== "accept") {
    throw new HttpError(400, "invalid_approval_decision");
  }
  if (body.authorizationScope === "run") return "allow_run_scope";
  if (body.authorizationScope === "once") return "allow_once";
  throw new HttpError(400, "invalid_approval_scope");
}

function validateAdapterResume(
  body: Record<string, unknown>,
  aguiThreadId: string,
  approvalId: string,
): void {
  const expectedInterruptId = `codex-request:string:${encodeURIComponent(approvalId)}`;
  if (
    body.threadId !== aguiThreadId ||
    body.interruptId !== expectedInterruptId
  ) {
    throw new HttpError(404, "approval_not_pending");
  }
}

function isTerminalEvent(event: BridgeEvent): boolean {
  return (
    event.type === "turn.completed" ||
    (event.type === "run.error" && record(event.data).willRetry !== true)
  );
}

function promptFromMessages(value: unknown): string {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
    throw new HttpError(400, "invalid_messages");
  }
  for (let index = value.length - 1; index >= 0; index -= 1) {
    const message = record(value[index]);
    if (message.role !== "user") continue;
    const content = message.content;
    let prompt: string;
    if (typeof content === "string") {
      prompt = content;
    } else if (Array.isArray(content)) {
      prompt = content
        .map((part) => {
          const item = record(part);
          return typeof item.text === "string" ? item.text : "";
        })
        .filter(Boolean)
        .join("\n");
    } else {
      continue;
    }
    if (!prompt.trim() || Buffer.byteLength(prompt) > 32 * 1024) {
      throw new HttpError(400, "invalid_prompt");
    }
    return prompt;
  }
  throw new HttpError(400, "user_message_required");
}

function requiredId(value: unknown, code: string): string {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    throw new HttpError(400, code);
  }
  return value;
}

function requiredCorrelationId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value)
  ) {
    throw new HttpError(400, "invalid_correlation_id");
  }
  return value;
}

function optionalEvidenceContext(
  state: Record<string, unknown>,
): RunEvidenceContext | undefined {
  const supplied = [
    state.correlationId,
    state.selectedSessionId,
    state.selectedActionId,
    state.sourceEvidenceRefs,
  ].some((value) => value !== undefined);
  if (!supplied) return undefined;
  if (
    !Array.isArray(state.sourceEvidenceRefs) ||
    state.sourceEvidenceRefs.length === 0 ||
    state.sourceEvidenceRefs.length > 64 ||
    !state.sourceEvidenceRefs.every(
      (value) =>
        typeof value === "string" &&
        Buffer.byteLength(value) <= 512 &&
        !/[\u0000-\u001f\u007f]/.test(value),
    )
  ) {
    throw new HttpError(400, "invalid_source_evidence_refs");
  }
  return {
    correlationId: requiredCorrelationId(state.correlationId),
    sourceSessionId: requiredId(
      state.selectedSessionId,
      "invalid_source_session_id",
    ),
    sourceActionId: requiredId(
      state.selectedActionId,
      "invalid_source_action_id",
    ),
    sourceEvidenceRefs: [...new Set(state.sourceEvidenceRefs as string[])],
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function byteLength(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value));
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

function validateLoopbackOrigin(value: string): string {
  let origin: URL;
  try {
    origin = new URL(value);
  } catch {
    throw new Error(`Invalid allowed Origin: ${value}`);
  }
  if (
    origin.origin !== value ||
    origin.protocol !== "http:" ||
    !origin.port ||
    (origin.hostname !== "127.0.0.1" &&
      origin.hostname !== "localhost" &&
      origin.hostname !== "[::1]")
  ) {
    throw new Error(
      `Allowed Origin must be an exact loopback HTTP origin: ${value}`,
    );
  }
  return value;
}

function decodePathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new HttpError(400, "invalid_run_id");
  }
}

async function writeResponse(
  response: ServerResponse,
  value: string,
): Promise<void> {
  if (response.write(value)) return;
  await Promise.race([once(response, "drain"), once(response, "close")]);
}
