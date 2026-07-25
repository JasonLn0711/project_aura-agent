import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { request as httpRequest } from "node:http";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

import { TrustStore } from "@voiss/trust-engine";
import { CodexBridge } from "../src/index.ts";
import { CodexHttpServer } from "../src/server.ts";

const fakeServer = fileURLToPath(
  new URL("./fake-app-server.ts", import.meta.url),
);
const TOKEN = "voiss-test-token-123456";
const ORIGIN = "http://127.0.0.1:3000";
const bridges: CodexBridge[] = [];
const servers: CodexHttpServer[] = [];
const tempDirs: string[] = [];
const exec = promisify(execFile);

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(bridges.splice(0).map((bridge) => bridge.close()));
  await Promise.all(
    tempDirs
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function harness(
  options: {
    maxBodyBytes?: number;
    maxEventBytes?: number;
    approvalTimeoutMs?: number;
    metadataStore?: TrustStore;
    repo?: string;
  } = {},
) {
  const repo =
    options.repo ?? (await mkdtemp(join(tmpdir(), "voiss-codex-http-repo-")));
  if (!options.repo) {
    tempDirs.push(repo);
    await exec("git", ["init", "-b", "main"], { cwd: repo });
    await writeFile(join(repo, "README.md"), "baseline\n");
    await exec("git", ["add", "README.md"], { cwd: repo });
    await exec(
      "git",
      [
        "-c",
        "user.name=VOISS Test",
        "-c",
        "user.email=voiss@example.test",
        "commit",
        "-m",
        "baseline",
      ],
      { cwd: repo },
    );
  }
  const exportRoot = await mkdtemp(join(tmpdir(), "voiss-codex-http-export-"));
  tempDirs.push(exportRoot);
  const observabilityLog = join(exportRoot, "observability.jsonl");
  const bridge = new CodexBridge({
    command: process.execPath,
    args: ["--experimental-strip-types", fakeServer],
    allowedRepoRoots: [repo],
    exportRoot,
    runTimeoutMs: 3_000,
    ...(options.approvalTimeoutMs === undefined
      ? {}
      : { approvalTimeoutMs: options.approvalTimeoutMs }),
  });
  bridges.push(bridge);
  const server = new CodexHttpServer({
    bridge,
    token: TOKEN,
    allowedOrigins: [ORIGIN],
    defaultRepo: repo,
    observabilityLogPath: observabilityLog,
    ...(options.metadataStore === undefined
      ? {}
      : { metadataStore: options.metadataStore }),
    ...(options.maxBodyBytes === undefined
      ? {}
      : { maxBodyBytes: options.maxBodyBytes }),
    ...(options.maxEventBytes === undefined
      ? {}
      : { maxEventBytes: options.maxEventBytes }),
    ...(options.approvalTimeoutMs === undefined
      ? {}
      : { approvalTimeoutMs: options.approvalTimeoutMs }),
  });
  servers.push(server);
  const address = await server.listen(0);
  return {
    bridge,
    server,
    baseUrl: address.url,
    exportRoot,
    observabilityLog,
    repo,
  };
}

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return {
    authorization: `Bearer ${TOKEN}`,
    "content-type": "application/json",
    ...extra,
  };
}

function runBody(prompt: string, state: Record<string, unknown> = {}) {
  return {
    threadId: "agui-thread-1",
    runId: `agui-run-${prompt.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
    messages: [{ id: "user-1", role: "user", content: prompt }],
    state,
    forwardedProps: {},
  };
}

async function events(
  response: Response,
): Promise<Array<Record<string, unknown>>> {
  const body = await response.text();
  return body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const payload = line.startsWith("data:")
        ? line.slice("data:".length).trim()
        : line;
      if (payload === "[DONE]") return null;
      return JSON.parse(payload) as Record<string, unknown>;
    })
    .filter((event): event is Record<string, unknown> => event !== null);
}

async function completeActivatedWrite(
  baseUrl: string,
  repo: string,
  prompt: string,
): Promise<string> {
  const body = runBody(prompt, { repo, codexMode: "write" });
  const staged = await fetch(`${baseUrl}/v1/runs`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
  });
  const stagedEvents = await events(staged);
  const activation = stagedEvents.find(
    (event) => event.method === "item/fileChange/requestApproval",
  );
  assert.equal(typeof activation?.id, "string");

  const resumed = await fetch(`${baseUrl}/v1/approvals/resume`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      type: "run.approval",
      runId: body.runId,
      approvalId: activation?.id,
      decision: "allow_once",
    }),
  });
  const resumedEvents = await events(resumed);
  assert.equal(resumed.status, 200);
  assert.equal(resumedEvents.at(-1)?.method, "turn/completed");
  return body.runId;
}

test("status requires Bearer auth and allows only the exact configured loopback Origin", async () => {
  const { baseUrl } = await harness();

  assert.equal((await fetch(`${baseUrl}/v1/status`)).status, 401);
  const rejected = await fetch(`${baseUrl}/v1/status`, {
    headers: headers({ origin: "http://localhost:3000" }),
  });
  assert.equal(rejected.status, 403);
  assert.equal(rejected.headers.has("access-control-allow-origin"), false);

  const accepted = await fetch(`${baseUrl}/v1/status`, {
    headers: headers({ origin: ORIGIN }),
  });
  const status = (await accepted.json()) as {
    ready: boolean;
    account: { signedIn: boolean };
    policy: Record<string, unknown>;
  };
  assert.equal(accepted.status, 200);
  assert.equal(accepted.headers.get("access-control-allow-origin"), ORIGIN);
  assert.equal(accepted.headers.has("access-control-allow-credentials"), false);
  assert.equal(status.ready, true);
  assert.equal(status.account.signedIn, true);
  assert.deepEqual(status.policy, {
    model: "gpt-5.6-sol",
    effort: "max",
    defaultSandbox: "read-only",
    sandboxBackend: "managed-bubblewrap",
    networkAccess: false,
    remoteActions: false,
  });

  const preflight = await fetch(`${baseUrl}/v1/runs`, {
    method: "OPTIONS",
    headers: {
      origin: ORIGIN,
      "access-control-request-method": "POST",
      "access-control-request-headers": "authorization,content-type",
    },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), ORIGIN);
});

test("POST /v1/runs streams bounded adapter envelopes for a read-only plan", async () => {
  const { baseUrl, observabilityLog } = await harness();
  const response = await fetch(`${baseUrl}/v1/runs`, {
    method: "POST",
    headers: headers({
      accept: "application/x-ndjson",
      "x-correlation-id": "corr-observability-1",
    }),
    body: JSON.stringify(runBody("Inspect the repository.")),
  });

  assert.equal(response.status, 200);
  assert.match(
    response.headers.get("content-type") ?? "",
    /application\/x-ndjson/,
  );
  const streamed = await events(response);
  assert.equal(streamed[0]?.method, "thread/started");
  assert.equal(
    streamed.some((event) => event.method === "turn/started"),
    true,
  );
  assert.equal(
    streamed.some((event) => event.method === "item/agentMessage/delta"),
    true,
  );
  assert.equal(streamed.at(-1)?.method, "turn/completed");
  assert.equal(
    streamed.some((event) => "type" in event || "data" in event),
    false,
  );
  assert.equal(
    response.headers.get("x-correlation-id"),
    "corr-observability-1",
  );
  const status = (await (
    await fetch(`${baseUrl}/v1/status`, { headers: headers() })
  ).json()) as {
    observability: {
      activeRuns: number;
      runCount: number;
      commandCount: number;
      fileChangeCount: number;
      runDurationMs: { count: number };
      retention: { maxBytesPerFile: number; fileCount: number };
    };
  };
  assert.equal(status.observability.activeRuns, 0);
  assert.equal(status.observability.runCount, 1);
  assert.equal(status.observability.commandCount, 1);
  assert.equal(status.observability.fileChangeCount, 1);
  assert.equal(status.observability.runDurationMs.count, 1);
  assert.deepEqual(status.observability.retention, {
    maxBytesPerFile: 5 * 1024 * 1024,
    fileCount: 2,
  });
  const retainedLog = await readFile(observabilityLog, "utf8");
  assert.equal(retainedLog.includes("corr-observability-1"), true);
  assert.equal(retainedLog.includes(TOKEN), false);

  const threadId = String(
    (streamed[0]?.params as { thread?: { id?: string } } | undefined)?.thread
      ?.id,
  );
  const foreign = await fetch(`${baseUrl}/v1/runs`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(
      runBody("Foreign resume.", { codexThreadId: "foreign-thread" }),
    ),
  });
  assert.equal(foreign.status, 403);

  const resumed = await fetch(`${baseUrl}/v1/runs`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(runBody("Owned resume.", { codexThreadId: threadId })),
  });
  const resumedEvents = await events(resumed);
  assert.equal(
    (resumedEvents[0]?.params as { thread?: { id?: string } } | undefined)
      ?.thread?.id,
    threadId,
  );
});

test("persists run lifecycle, replays events, resumes after restart, and archives the thread", async () => {
  const metadataDirectory = await mkdtemp(
    join(tmpdir(), "voiss-codex-metadata-"),
  );
  tempDirs.push(metadataDirectory);
  const databasePath = join(metadataDirectory, "control-plane.sqlite");
  const firstStore = new TrustStore(databasePath);
  const first = await harness({ metadataStore: firstStore });
  const firstBody = runBody("Persisted lifecycle.", {
    repo: first.repo,
    correlationId: "corr-persisted-lifecycle",
    selectedSessionId: "meeting-001",
    selectedActionId: "action-persisted",
    sourceEvidenceRefs: [
      "aura-segment:meeting-001/seg-001",
      "aura-claim:meeting-001/action-persisted",
    ],
  });
  const firstResponse = await fetch(`${first.baseUrl}/v1/runs`, {
    method: "POST",
    headers: headers({ "x-correlation-id": "corr-persisted-lifecycle" }),
    body: JSON.stringify(firstBody),
  });
  const firstEvents = await events(firstResponse);
  const threadId = String(
    (firstEvents[0]?.params as { thread?: { id?: string } } | undefined)?.thread
      ?.id,
  );
  assert.match(threadId, /^thread-/);

  const replayed = await fetch(
    `${first.baseUrl}/v1/runs/${firstBody.runId}/events?after=0&limit=200`,
    { headers: headers() },
  );
  const replay = (await replayed.json()) as {
    status: string;
    events: Array<{ sequence: number; correlationId: string }>;
    nextCursor: number;
  };
  assert.equal(replayed.status, 200);
  assert.equal(replay.status, "completed");
  assert.equal(replay.events.length > 0, true);
  assert.deepEqual(
    replay.events.map((event) => event.sequence),
    [...replay.events.map((event) => event.sequence)].sort(
      (left, right) => left - right,
    ),
  );
  assert.equal(replay.events[0]?.correlationId, "corr-persisted-lifecycle");
  assert.equal(replay.nextCursor, replay.events.at(-1)?.sequence);

  const persistedRun = firstStore.listMetadata<{
    id: string;
    voissRunIds: string[];
    codexThreadId: string;
    repository: string;
    worktree: string;
    model: string;
    profile: string;
    startedAt: string;
    endedAt: string;
    status: string;
    correlationId: string;
    sourceSessionId: string;
    sourceActionId: string;
    sourceEvidenceIds: string[];
  }>("agent_runs")[0];
  assert.deepEqual(persistedRun?.voissRunIds, [firstBody.runId]);
  assert.equal(persistedRun?.codexThreadId, threadId);
  assert.equal(persistedRun?.repository, first.repo);
  assert.equal(persistedRun?.worktree, first.repo);
  assert.equal(persistedRun?.model, "gpt-5.6-sol");
  assert.equal(persistedRun?.profile, "max");
  assert.match(persistedRun?.startedAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
  assert.match(persistedRun?.endedAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(persistedRun?.status, "completed");
  assert.equal(persistedRun?.correlationId, "corr-persisted-lifecycle");
  assert.equal(persistedRun?.sourceSessionId, "meeting-001");
  assert.equal(persistedRun?.sourceActionId, "action-persisted");
  assert.deepEqual(persistedRun?.sourceEvidenceIds, [
    "aura-segment:meeting-001/seg-001",
    "aura-claim:meeting-001/action-persisted",
  ]);
  const persistedAction = firstStore.getMetadata<{
    id: string;
    sessionId: string;
    evidenceRefs: string[];
    lastRunId: string;
    updatedAt: string;
  }>("actions", "action-persisted");
  assert.equal(persistedAction?.id, "action-persisted");
  assert.equal(persistedAction?.sessionId, "meeting-001");
  assert.deepEqual(persistedAction?.evidenceRefs, [
    "aura-segment:meeting-001/seg-001",
    "aura-claim:meeting-001/action-persisted",
  ]);
  assert.equal(persistedAction?.lastRunId, persistedRun?.id);
  assert.equal(persistedAction?.updatedAt, persistedRun?.endedAt);

  await first.server.close();
  await first.bridge.close();
  firstStore.close();

  const reopenedStore = new TrustStore(databasePath);
  const second = await harness({
    metadataStore: reopenedStore,
    repo: first.repo,
  });
  const resumedResponse = await fetch(`${second.baseUrl}/v1/runs`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(
      runBody("Restart-safe resume.", {
        repo: first.repo,
        codexThreadId: threadId,
      }),
    ),
  });
  const resumedEvents = await events(resumedResponse);
  assert.equal(resumedResponse.status, 200);
  assert.equal(
    (resumedEvents[0]?.params as { thread?: { id?: string } } | undefined)
      ?.thread?.id,
    threadId,
  );

  const archived = await fetch(
    `${second.baseUrl}/v1/threads/${encodeURIComponent(threadId)}/archive`,
    { method: "POST", headers: headers() },
  );
  assert.equal(archived.status, 200);
  assert.equal(
    ((await archived.json()) as { archived: boolean }).archived,
    true,
  );
  assert.equal(
    reopenedStore.getMetadata<{ status: string }>("codex_threads", threadId)
      ?.status,
    "archived",
  );

  const rejectedResume = await fetch(`${second.baseUrl}/v1/runs`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(
      runBody("Archived resume.", {
        repo: first.repo,
        codexThreadId: threadId,
      }),
    ),
  });
  assert.equal(rejectedResume.status, 403);
  await second.server.close();
  await second.bridge.close();
  reopenedStore.close();
});

test("write activation timeout pauses while preserving resume and stop capabilities", async () => {
  const metadataDirectory = await mkdtemp(
    join(tmpdir(), "voiss-codex-timeout-"),
  );
  tempDirs.push(metadataDirectory);
  const store = new TrustStore(join(metadataDirectory, "control-plane.sqlite"));
  const { baseUrl, repo } = await harness({
    approvalTimeoutMs: 10,
    metadataStore: store,
  });

  const resumable = runBody("PAUSED_RESUME", {
    repo,
    codexMode: "write",
  });
  const staged = await fetch(`${baseUrl}/v1/runs`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(resumable),
  });
  const activationId = String((await events(staged))[0]?.id);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(
    store.getMetadata<{ decision: string; status: string }>(
      "approvals",
      activationId,
    )?.decision,
    "timed_out",
  );
  assert.equal(
    store.getMetadata<{ decision: string; status: string }>(
      "approvals",
      activationId,
    )?.status,
    "paused",
  );

  const resumed = await fetch(`${baseUrl}/v1/approvals/resume`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      type: "run.approval",
      runId: resumable.runId,
      approvalId: activationId,
      decision: "allow_once",
    }),
  });
  assert.equal(resumed.status, 200);
  assert.equal((await events(resumed)).at(-1)?.method, "turn/completed");

  const stoppable = runBody("PAUSED_STOP", {
    repo,
    codexMode: "write",
  });
  const secondStage = await fetch(`${baseUrl}/v1/runs`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(stoppable),
  });
  const secondActivationId = String((await events(secondStage))[0]?.id);
  await new Promise((resolve) => setTimeout(resolve, 30));
  const stopped = await fetch(
    `${baseUrl}/v1/runs/${encodeURIComponent(stoppable.runId)}/stop`,
    { method: "POST", headers: headers() },
  );
  assert.equal(stopped.status, 202);
  assert.equal(
    store.getMetadata<{ decision: string }>("approvals", secondActivationId)
      ?.decision,
    "stopped",
  );
  store.close();
});

test("command approval timeout is persisted and replayable before resume", async () => {
  const metadataDirectory = await mkdtemp(
    join(tmpdir(), "voiss-codex-command-timeout-"),
  );
  tempDirs.push(metadataDirectory);
  const store = new TrustStore(join(metadataDirectory, "control-plane.sqlite"));
  const { baseUrl, repo } = await harness({
    approvalTimeoutMs: 10,
    metadataStore: store,
  });
  const body = runBody("NULLABLE_ACTION_PATHS", {
    repo,
    codexMode: "write",
  });
  const staged = await fetch(`${baseUrl}/v1/runs`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
  });
  const activationId = String((await events(staged))[0]?.id);
  const activated = await fetch(`${baseUrl}/v1/approvals/resume`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      type: "run.approval",
      runId: body.runId,
      approvalId: activationId,
      decision: "allow_once",
    }),
  });
  const commandApprovalId = String(
    (await events(activated)).find(
      (event) => event.method === "item/commandExecution/requestApproval",
    )?.id,
  );
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(
    store.getMetadata<{ decision: string; status: string }>(
      "approvals",
      commandApprovalId,
    )?.decision,
    "timed_out",
  );
  const replay = (await (
    await fetch(
      `${baseUrl}/v1/runs/${encodeURIComponent(body.runId)}/events?after=0&limit=200`,
      { headers: headers() },
    )
  ).json()) as { events: Array<{ type: string }> };
  assert.equal(
    replay.events.some((event) => event.type === "approval.timed_out"),
    true,
  );

  const resumed = await fetch(`${baseUrl}/v1/approvals/resume`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      type: "run.approval",
      runId: body.runId,
      approvalId: commandApprovalId,
      decision: "allow_once",
    }),
  });
  assert.equal(resumed.status, 200);
  assert.equal((await events(resumed)).at(-1)?.method, "turn/completed");
  store.close();
});

test("startup blocks stale active lifecycle records before restoring capabilities", async () => {
  const metadataDirectory = await mkdtemp(
    join(tmpdir(), "voiss-codex-reconcile-"),
  );
  tempDirs.push(metadataDirectory);
  const store = new TrustStore(join(metadataDirectory, "control-plane.sqlite"));
  const initial = await harness({ metadataStore: store });
  await initial.server.close();
  await initial.bridge.close();
  const startedAt = new Date(Date.now() - 60_000).toISOString();
  store.upsertMetadata("agent_runs", "run-stale", {
    id: "run-stale",
    voissRunIds: ["voiss-run-stale"],
    codexThreadId: "thread-stale",
    aguiThreadId: "agui-thread-stale",
    repository: initial.repo,
    worktree: initial.repo,
    mode: "read-only",
    model: "gpt-5.6-sol",
    profile: "max",
    sourceSessionId: "meeting-001",
    sourceActionId: "action-stale",
    sourceEvidenceIds: ["aura-segment:meeting-001/seg-001"],
    startedAt,
    endedAt: null,
    status: "running",
    correlationId: "corr-stale",
  });
  store.upsertMetadata("codex_threads", "thread-stale", {
    id: "thread-stale",
    repository: initial.repo,
    cwd: initial.repo,
    model: "gpt-5.6-sol",
    profile: "max",
    lastRunId: "run-stale",
    status: "active",
    createdAt: startedAt,
    updatedAt: startedAt,
    archivedAt: null,
  });
  store.upsertMetadata("approvals", "approval-stale", {
    id: "approval-stale",
    runId: "run-stale",
    decision: "pending",
    requestedAt: startedAt,
    decidedAt: null,
  });

  const restarted = await harness({
    metadataStore: store,
    repo: initial.repo,
  });
  assert.equal(
    store.getMetadata<{ status: string }>("agent_runs", "run-stale")?.status,
    "blocked",
  );
  assert.equal(
    store.getMetadata<{ status: string }>("codex_threads", "thread-stale")
      ?.status,
    "blocked",
  );
  assert.equal(
    store.getMetadata<{ decision: string }>("approvals", "approval-stale")
      ?.decision,
    "blocked",
  );
  const resume = await fetch(`${restarted.baseUrl}/v1/runs`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(
      runBody("Unsafe stale resume.", {
        repo: initial.repo,
        codexThreadId: "thread-stale",
      }),
    ),
  });
  assert.equal(resume.status, 403);
  store.close();
});

test("normal shutdown closes active lifecycle metadata without granting resume", async () => {
  const metadataDirectory = await mkdtemp(
    join(tmpdir(), "voiss-codex-shutdown-"),
  );
  tempDirs.push(metadataDirectory);
  const store = new TrustStore(join(metadataDirectory, "control-plane.sqlite"));
  const current = await harness({ metadataStore: store });
  const body = runBody("CANCEL", { repo: current.repo });
  const response = await fetch(`${current.baseUrl}/v1/runs`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 200);

  await current.server.close();
  const run = store.listMetadata<{ status: string; endedAt: string | null }>(
    "agent_runs",
  )[0];
  const thread = store.listMetadata<{ status: string }>("codex_threads")[0];
  assert.equal(run?.status, "interrupted");
  assert.match(run?.endedAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(thread?.status, "blocked");
  await response.body?.cancel();
  store.close();
});

test("app-server crash blocks the active run and thread while preserving metadata", async () => {
  const metadataDirectory = await mkdtemp(join(tmpdir(), "voiss-codex-crash-"));
  tempDirs.push(metadataDirectory);
  const store = new TrustStore(join(metadataDirectory, "control-plane.sqlite"));
  const current = await harness({ metadataStore: store });
  const body = runBody("APP_SERVER_CRASH", { repo: current.repo });
  const response = await fetch(`${current.baseUrl}/v1/runs`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
  });
  const streamed = await events(response);
  assert.equal(streamed.at(-1)?.method, "error");
  assert.equal(
    store.listMetadata<{ status: string }>("agent_runs")[0]?.status,
    "blocked",
  );
  assert.equal(
    store.listMetadata<{ status: string }>("codex_threads")[0]?.status,
    "blocked",
  );
  store.close();
});

test("approval resume accepts adapter and trusted-control forms while keeping request ids server-side", async () => {
  const { baseUrl, exportRoot, repo } = await harness();
  const first = await fetch(`${baseUrl}/v1/runs`, {
    method: "POST",
    headers: headers({ accept: "text/event-stream" }),
    body: JSON.stringify(
      runBody("APPROVAL_FLOW", {
        repo,
        codexMode: "write",
        correlationId: "corr-http-export-1",
        selectedSessionId: "meeting-001",
        selectedActionId: "action-queue",
        sourceEvidenceRefs: ["aura-segment:meeting-001/seg-001"],
      }),
    ),
  });
  assert.match(first.headers.get("content-type") ?? "", /text\/event-stream/);
  const firstEvents = await events(first);
  const writeActivation = firstEvents.find(
    (event) => event.method === "item/fileChange/requestApproval",
  );
  assert.equal(typeof writeActivation?.id, "string");

  const second = await fetch(`${baseUrl}/v1/approvals/resume`, {
    method: "POST",
    headers: headers({ accept: "application/x-ndjson" }),
    body: JSON.stringify({
      threadId: "agui-thread-1",
      runId: "agui-run-resume-1",
      interruptId: `codex-request:string:${encodeURIComponent(String(writeActivation?.id))}`,
      pendingRequestId: writeActivation?.id,
      decision: "accept",
      authorizationScope: "once",
    }),
  });
  const secondEvents = await events(second);
  const commandApproval = secondEvents.find(
    (event) => event.method === "item/commandExecution/requestApproval",
  );
  assert.equal(typeof commandApproval?.id, "string");

  const third = await fetch(`${baseUrl}/v1/approvals/resume`, {
    method: "POST",
    headers: headers({ accept: "application/x-ndjson" }),
    body: JSON.stringify({
      threadId: "agui-thread-1",
      runId: "agui-run-resume-2",
      interruptId: `codex-request:string:${encodeURIComponent(String(commandApproval?.id))}`,
      pendingRequestId: commandApproval?.id,
      decision: "accept",
      authorizationScope: "once",
    }),
  });
  const thirdEvents = await events(third);
  const fileApproval = thirdEvents.find(
    (event) => event.method === "item/fileChange/requestApproval",
  );
  assert.equal(typeof fileApproval?.id, "string");

  const fourth = await fetch(`${baseUrl}/v1/approvals/resume`, {
    method: "POST",
    headers: headers({ accept: "application/x-ndjson" }),
    body: JSON.stringify({
      type: "run.approval",
      runId: "agui-run-resume-2",
      approvalId: fileApproval?.id,
      decision: "allow_run_scope",
    }),
  });
  const fourthEvents = await events(fourth);

  assert.equal(fourth.status, 200);
  assert.equal(
    fourthEvents.some((event) => event.method === "serverRequest/resolved"),
    true,
  );
  assert.equal(fourthEvents.at(-1)?.method, "turn/completed");
  const observed = (await (
    await fetch(`${baseUrl}/v1/status`, { headers: headers() })
  ).json()) as {
    observability: {
      approvalWaitMs: { count: number };
      validationPassCount: number;
      validationFailCount: number;
    };
  };
  assert.equal(observed.observability.approvalWaitMs.count, 3);
  assert.equal(observed.observability.validationPassCount, 1);
  assert.equal(observed.observability.validationFailCount, 0);

  const exported = await fetch(`${baseUrl}/v1/evidence/export`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      type: "evidence.export",
      correlationId: "corr-http-export-1",
    }),
  });
  const exportBody = (await exported.json()) as {
    exported?: boolean;
    classification?: string;
    exportId?: string;
    artifacts?: Array<{ filename?: string; sha256?: string }>;
  };
  assert.equal(exported.status, 200);
  assert.equal(exportBody.exported, true);
  assert.equal(exportBody.classification, "live_codex_evidence");
  assert.equal(exportBody.artifacts?.[0]?.filename, "changes.patch");
  assert.match(exportBody.artifacts?.[0]?.sha256 ?? "", /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(exportBody).includes(exportRoot), false);
  const exportId = String(exportBody.exportId);
  const patchDownload = await fetch(
    `${baseUrl}/v1/evidence/exports/${exportId}/changes.patch`,
    { headers: headers() },
  );
  assert.equal(patchDownload.status, 200);
  assert.equal(
    patchDownload.headers.get("content-disposition"),
    'attachment; filename="changes.patch"',
  );
  assert.equal(
    await patchDownload.text(),
    await readFile(join(exportRoot, exportId, "changes.patch"), "utf8"),
  );
  const unauthorizedDownload = await fetch(
    `${baseUrl}/v1/evidence/exports/${exportId}/evidence.json`,
  );
  assert.equal(unauthorizedDownload.status, 401);
  const invalidDownload = await fetch(
    `${baseUrl}/v1/evidence/exports/${exportId}/not-exported.txt`,
    { headers: headers() },
  );
  assert.equal(invalidDownload.status, 404);
  assert.deepEqual(await invalidDownload.json(), {
    error: "artifact_not_found",
  });
  const retained = JSON.parse(
    await readFile(
      join(exportRoot, String(exportBody.exportId), "evidence.json"),
      "utf8",
    ),
  ) as {
    approvals: Array<{
      approvalId: string | null;
      kind: string;
      decision: string;
      reason?: string;
      actor: string;
      decidedAt: string;
    }>;
    context: {
      correlationId: string;
      sourceSessionId: string;
      sourceActionId: string;
      sourceEvidenceRefs: string[];
    };
  };
  assert.deepEqual(
    {
      approvalId: retained.approvals[0]?.approvalId,
      kind: retained.approvals[0]?.kind,
      decision: retained.approvals[0]?.decision,
      reason: retained.approvals[0]?.reason,
      actor: retained.approvals[0]?.actor,
    },
    {
      approvalId: writeActivation?.id,
      kind: "write_activation",
      decision: "allow_once",
      reason: "isolated_workspace_write",
      actor: "operator",
    },
  );
  assert.match(retained.approvals[0]?.decidedAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(retained.context, {
    correlationId: "corr-http-export-1",
    sourceSessionId: "meeting-001",
    sourceActionId: "action-queue",
    sourceEvidenceRefs: ["aura-segment:meeting-001/seg-001"],
  });

  const stale = await fetch(`${baseUrl}/v1/approvals/resume`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      type: "run.approval",
      runId: "agui-run-resume-2",
      approvalId: fileApproval?.id,
      decision: "allow_once",
    }),
  });
  assert.equal(stale.status, 404);
});

test("POST /v1/runs/:id/stop interrupts only the mapped active run", async () => {
  const { baseUrl } = await harness();
  const body = runBody("CANCEL");
  const response = await fetch(`${baseUrl}/v1/runs`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
  });

  const stopped = await fetch(
    `${baseUrl}/v1/runs/${encodeURIComponent(body.runId)}/stop`,
    {
      method: "POST",
      headers: headers(),
      body: "{}",
    },
  );
  assert.equal(stopped.status, 202);
  assert.deepEqual(await stopped.json(), {
    accepted: true,
    runId: body.runId,
    status: "stopping",
  });
  const streamed = await events(response);
  const completed = streamed.at(-1) as {
    method?: string;
    params?: { turn?: { status?: string } };
  };
  assert.equal(completed.method, "turn/completed");
  assert.equal(completed.params?.turn?.status, "interrupted");

  const unknown = await fetch(`${baseUrl}/v1/runs/not-a-run/stop`, {
    method: "POST",
    headers: headers(),
    body: "{}",
  });
  assert.equal(unknown.status, 404);
});

test("stop cancels a staged write activation before any worktree is created", async () => {
  const { baseUrl, repo } = await harness();
  const body = runBody("STOP_STAGED", {
    repo,
    codexMode: "write",
  });
  const staged = await fetch(`${baseUrl}/v1/runs`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
  });
  const stagedEvents = await events(staged);
  const activation = stagedEvents.find(
    (event) => event.method === "item/fileChange/requestApproval",
  );
  assert.equal(typeof activation?.id, "string");

  const stopped = await fetch(
    `${baseUrl}/v1/runs/${encodeURIComponent(body.runId)}/stop`,
    {
      method: "POST",
      headers: headers(),
      body: "{}",
    },
  );
  assert.equal(stopped.status, 202);
  assert.deepEqual(await stopped.json(), {
    accepted: true,
    runId: body.runId,
    status: "cancelled",
  });
  await assert.rejects(access(join(repo, ".voiss")));

  const staleResume = await fetch(`${baseUrl}/v1/approvals/resume`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      type: "run.approval",
      runId: body.runId,
      approvalId: activation?.id,
      decision: "allow_once",
    }),
  });
  assert.equal(staleResume.status, 404);
});

test("dirty repositories cannot activate a write worktree", async () => {
  const { baseUrl, repo } = await harness();
  await writeFile(join(repo, "LOCAL.txt"), "operator work\n");
  const body = runBody("DIRTY_BASE", { repo, codexMode: "write" });
  const staged = await fetch(`${baseUrl}/v1/runs`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
  });
  const activation = (await events(staged)).find(
    (event) => event.method === "item/fileChange/requestApproval",
  );

  const resumed = await fetch(`${baseUrl}/v1/approvals/resume`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      type: "run.approval",
      runId: body.runId,
      approvalId: activation?.id,
      decision: "allow_once",
    }),
  });

  assert.equal(resumed.status, 409);
  assert.deepEqual(await resumed.json(), { error: "dirty_repository" });
  await assert.rejects(access(join(repo, ".voiss")));
  assert.equal(
    (
      await exec("git", ["branch", "--list", "voiss/run-*"], { cwd: repo })
    ).stdout.trim(),
    "",
  );
});

test("evidence export rejects completed write runs with failed or missing validation", async () => {
  const { baseUrl, repo } = await harness();
  for (const prompt of [
    "FAILED_VALIDATION_FLOW",
    "NO_VALIDATION_FLOW",
    "HELP_VALIDATION_FLOW",
    "OUTSIDE_VALIDATION_FLOW",
    "STALE_VALIDATION_FLOW",
  ] as const) {
    const runId = await completeActivatedWrite(baseUrl, repo, prompt);
    const exported = await fetch(`${baseUrl}/v1/evidence/export`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ runId }),
    });
    assert.equal(exported.status, 409, prompt);
    assert.deepEqual(await exported.json(), { error: "export_unavailable" });
  }
});

test("request bodies are stream-bounded even without Content-Length", async () => {
  const { baseUrl } = await harness({ maxBodyBytes: 64 });
  const url = new URL("/v1/runs", baseUrl);
  const status = await new Promise<number>((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
          "transfer-encoding": "chunked",
        },
      },
      (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode ?? 0));
      },
    );
    request.once("error", reject);
    request.write('{"messages":["');
    request.write("x".repeat(128));
    request.end('"]}');
  });

  assert.equal(status, 413);
});

test("write evidence context is complete and bounded before approval staging", async () => {
  const { baseUrl, repo } = await harness();
  const response = await fetch(`${baseUrl}/v1/runs`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(
      runBody("INVALID_CONTEXT", {
        repo,
        codexMode: "write",
        correlationId: "corr-incomplete",
      }),
    ),
  });

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: "invalid_source_evidence_refs",
  });
});

test("premature SSE disconnects are counted and interrupt the active run", async () => {
  const { baseUrl } = await harness();
  const url = new URL("/v1/runs", baseUrl);
  const body = JSON.stringify(runBody("CANCEL"));
  await new Promise<void>((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
          "x-correlation-id": "corr-sse-disconnect",
          accept: "text/event-stream",
        },
      },
      (response) => {
        response.once("data", () => {
          response.destroy();
          resolve();
        });
      },
    );
    request.once("error", reject);
    request.end(body);
  });

  for (let attempt = 0; attempt < 50; attempt += 1) {
    const status = (await (
      await fetch(`${baseUrl}/v1/status`, { headers: headers() })
    ).json()) as {
      observability: { activeRuns: number; sseDisconnectCount: number };
    };
    if (
      status.observability.activeRuns === 0 &&
      status.observability.sseDisconnectCount === 1
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("SSE disconnect metrics did not reach the terminal state.");
});

test("event overflow emits a bounded error and interrupts the underlying run", async () => {
  const { baseUrl } = await harness({ maxEventBytes: 64 });
  const response = await fetch(`${baseUrl}/v1/runs`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(runBody("CANCEL")),
  });
  const streamed = await events(response);

  assert.equal(streamed.at(-1)?.method, "error");
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const status = (await (
      await fetch(`${baseUrl}/v1/status`, { headers: headers() })
    ).json()) as { activeRuns?: number };
    if (status.activeRuns === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("overflowed run remained active");
});
