import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  access,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

import { BridgeTimeoutError, CodexBridge } from "../src/index.ts";

const fakeServer = fileURLToPath(
  new URL("./fake-app-server.ts", import.meta.url),
);
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const bridges: CodexBridge[] = [];
const tempDirs: string[] = [];
const exec = promisify(execFile);

afterEach(async () => {
  await Promise.all(bridges.splice(0).map((bridge) => bridge.close()));
  await Promise.all(
    tempDirs
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function createRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "voiss-codex-bridge-"));
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
  return repo;
}

test("initializes Codex 0.145.0 and exposes account status without email or tokens", async () => {
  const bridge = new CodexBridge({
    command: process.execPath,
    args: ["--experimental-strip-types", fakeServer],
  });
  bridges.push(bridge);

  const status = await bridge.start();

  assert.deepEqual(status.account, {
    signedIn: true,
    type: "chatgpt",
    planType: "pro",
    requiresOpenaiAuth: true,
  });
  assert.equal(status.serverVersion, "fake-codex/0.145.0");
  assert.equal(JSON.stringify(status).includes("operator@example.test"), false);
});

test("rejects an app-server version outside the generated 0.145.0 contract", async () => {
  const bridge = new CodexBridge({
    command: process.execPath,
    args: ["--experimental-strip-types", fakeServer],
    env: { FAKE_VERSION: "0.146.0" },
    restartLimit: 0,
  });
  bridges.push(bridge);

  await assert.rejects(bridge.start(), /Unsupported Codex app-server version/);
});

test("updates cached account readiness after account/updated logout", async () => {
  const bridge = new CodexBridge({
    command: process.execPath,
    args: ["--experimental-strip-types", fakeServer],
    env: { FAKE_START_MODE: "account-logout-after-ready" },
  });
  bridges.push(bridge);

  assert.equal((await bridge.start()).account.signedIn, true);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal((await bridge.start()).account.signedIn, false);
});

test("starts and resumes a read-only network-off plan and maps Codex events", async () => {
  const bridge = new CodexBridge({
    command: process.execPath,
    args: ["--experimental-strip-types", fakeServer],
    allowedRepoRoots: [repoRoot],
  });
  bridges.push(bridge);
  const eventTypes: string[] = [];
  bridge.subscribe((event) => eventTypes.push(event.type));
  await bridge.start();

  const first = await bridge.startReadOnlyPlan({
    repo: repoRoot,
    prompt: "Inspect the repository.",
  });
  const firstResult = await first.completion;
  const resumed = await bridge.startReadOnlyPlan({
    repo: repoRoot,
    prompt: "Continue the plan.",
    threadId: first.threadId,
  });
  const resumedResult = await resumed.completion;

  assert.equal(firstResult.status, "completed");
  assert.equal(resumed.threadId, first.threadId);
  assert.equal(resumedResult.status, "completed");
  assert.deepEqual(
    [...new Set(eventTypes)],
    [
      "run.started",
      "turn.started",
      "item.started",
      "plan.delta",
      "plan.updated",
      "command.output",
      "file.patch",
      "diff.updated",
      "message.delta",
      "item.completed",
      "turn.completed",
    ],
  );
});

test("permits only one active run per Codex thread", async () => {
  const bridge = new CodexBridge({
    command: process.execPath,
    args: ["--experimental-strip-types", fakeServer],
    allowedRepoRoots: [repoRoot],
  });
  bridges.push(bridge);
  await bridge.start();
  const active = await bridge.startReadOnlyPlan({
    repo: repoRoot,
    prompt: "CANCEL",
  });

  await assert.rejects(
    bridge.startReadOnlyPlan({
      repo: repoRoot,
      prompt: "Second turn.",
      threadId: active.threadId,
    }),
    /already has an active run/,
  );
  await bridge.interrupt(active.runId);
  assert.equal((await active.completion).status, "interrupted");
});

test(
  "creates an allowlisted isolated worktree and pauses for typed command and file approvals",
  { timeout: 3_000 },
  async () => {
    const repo = await createRepo();
    const bridge = new CodexBridge({
      command: process.execPath,
      args: ["--experimental-strip-types", fakeServer],
      allowedRepoRoots: [repo],
    });
    bridges.push(bridge);
    const decisions: string[] = [];
    let codexDecisions = "";
    bridge.subscribe((event) => {
      if (event.type === "approval.requested") {
        const approval = event.data as {
          approvalId: string;
          kind: "command" | "file";
        };
        const decision =
          approval.kind === "command" ? "allow_once" : "allow_run_scope";
        decisions.push(decision);
        void bridge.resolveApproval(approval.approvalId, decision);
      }
      if (event.type === "message.delta") {
        codexDecisions = String((event.data as { delta?: string }).delta);
      }
    });
    await bridge.start();

    const handle = await bridge.startWriteRun({
      repo,
      prompt: "APPROVAL_FLOW",
      approval: "allow_once",
    });
    const result = await handle.completion;

    assert.equal(result.status, "completed");
    assert.deepEqual(decisions, ["allow_once", "allow_run_scope"]);
    assert.equal(codexDecisions, "accept,accept");
    assert.equal(
      handle.cwd.startsWith(join(repo, ".voiss", "worktrees")),
      true,
    );
    assert.equal(
      (
        await exec("git", ["rev-parse", "--show-toplevel"], { cwd: handle.cwd })
      ).stdout.trim(),
      handle.cwd,
    );
  },
);

test(
  "records an approval timeout while preserving the paused run for resume",
  { timeout: 3_000 },
  async () => {
    const repo = await createRepo();
    const bridge = new CodexBridge({
      command: process.execPath,
      args: ["--experimental-strip-types", fakeServer],
      allowedRepoRoots: [repo],
      approvalTimeoutMs: 15,
      runTimeoutMs: 100,
    });
    bridges.push(bridge);
    let requestedApproval:
      { approvalId: string; kind: "command" | "file" } | undefined;
    let resolveTimedOut:
      | ((value: {
          approvalId: string;
          kind: "command" | "file";
          timeoutMs: number;
        }) => void)
      | undefined;
    const timedOut = new Promise<{
      approvalId: string;
      kind: "command" | "file";
      timeoutMs: number;
    }>((resolve) => {
      resolveTimedOut = resolve;
    });
    const eventTypes: string[] = [];
    bridge.subscribe((event) => {
      eventTypes.push(event.type);
      if (event.type === "approval.requested") {
        requestedApproval = event.data as {
          approvalId: string;
          kind: "command" | "file";
        };
      }
      if (event.type === "approval.timed_out") {
        resolveTimedOut?.(
          event.data as {
            approvalId: string;
            kind: "command" | "file";
            timeoutMs: number;
          },
        );
      }
    });
    await bridge.start();

    const handle = await bridge.startWriteRun({
      repo,
      prompt: "NULLABLE_ACTION_PATHS",
      approval: "allow_once",
    });
    const timeout = await timedOut;

    assert.deepEqual(timeout, {
      approvalId: requestedApproval?.approvalId,
      kind: "command",
      timeoutMs: 15,
    });
    await new Promise((resolve) => setTimeout(resolve, 125));
    await access(handle.cwd);
    assert.equal(eventTypes.includes("run.error"), false);

    bridge.resolveApproval(timeout.approvalId, "allow_once");

    assert.equal((await handle.completion).status, "completed");
    assert.deepEqual(
      eventTypes.filter((type) => type.startsWith("approval.")),
      ["approval.requested", "approval.timed_out", "approval.resolved"],
    );
  },
);

test(
  "rejects the pending approval and settles when stopped after approval timeout",
  { timeout: 3_000 },
  async () => {
    const repo = await createRepo();
    const bridge = new CodexBridge({
      command: process.execPath,
      args: ["--experimental-strip-types", fakeServer],
      allowedRepoRoots: [repo],
      approvalTimeoutMs: 15,
      runTimeoutMs: 100,
    });
    bridges.push(bridge);
    let resolveTimedOut:
      | ((value: { approvalId: string; kind: "command" | "file" }) => void)
      | undefined;
    const timedOut = new Promise<{
      approvalId: string;
      kind: "command" | "file";
    }>((resolve) => {
      resolveTimedOut = resolve;
    });
    let resolution: unknown;
    bridge.subscribe((event) => {
      if (event.type === "approval.timed_out") {
        resolveTimedOut?.(
          event.data as {
            approvalId: string;
            kind: "command" | "file";
          },
        );
      }
      if (event.type === "approval.resolved") resolution = event.data;
    });
    await bridge.start();

    const handle = await bridge.startWriteRun({
      repo,
      prompt: "NULLABLE_ACTION_PATHS",
      approval: "allow_once",
    });
    const timeout = await timedOut;

    await bridge.interrupt(handle.runId);

    assert.equal((await handle.completion).status, "completed");
    assert.deepEqual(resolution, {
      approvalId: timeout.approvalId,
      kind: "command",
      decision: "deny",
      reason: "run_interrupted",
    });
    assert.throws(
      () => bridge.resolveApproval(timeout.approvalId, "allow_once"),
      /Unknown or resolved approval/,
    );
  },
);

for (const { prompt, expectedKinds } of [
  {
    prompt: "OPTIONAL_APPROVAL_FIELDS",
    expectedKinds: ["command", "file"] as const,
  },
  {
    prompt: "NULLABLE_ACTION_PATHS",
    expectedKinds: ["command"] as const,
  },
]) {
  test(
    `accepts Codex 0.145.0 nullable approval fields for ${prompt.toLowerCase()}`,
    { timeout: 3_000 },
    async () => {
      const repo = await createRepo();
      const bridge = new CodexBridge({
        command: process.execPath,
        args: ["--experimental-strip-types", fakeServer],
        allowedRepoRoots: [repo],
      });
      bridges.push(bridge);
      const requestedKinds: string[] = [];
      let codexDecisions = "";
      bridge.subscribe((event) => {
        if (event.type === "approval.requested") {
          const approval = event.data as {
            approvalId: string;
            kind: "command" | "file";
          };
          requestedKinds.push(approval.kind);
          void bridge.resolveApproval(approval.approvalId, "allow_once");
        }
        if (event.type === "message.delta") {
          codexDecisions = String((event.data as { delta?: string }).delta);
        }
      });
      await bridge.start();

      const handle = await bridge.startWriteRun({
        repo,
        prompt,
        approval: "allow_once",
      });

      assert.equal((await handle.completion).status, "completed");
      assert.deepEqual(requestedKinds, [...expectedKinds]);
      assert.equal(codexDecisions, expectedKinds.map(() => "accept").join(","));
    },
  );
}

test("rejects repositories outside the allowlist, including symlink escapes, before creating a worktree", async () => {
  const allowedRepo = await createRepo();
  const outsideRepo = await createRepo();
  const escape = join(allowedRepo, "escape");
  await symlink(outsideRepo, escape, "dir");
  const bridge = new CodexBridge({
    command: process.execPath,
    args: ["--experimental-strip-types", fakeServer],
    allowedRepoRoots: [allowedRepo],
  });
  bridges.push(bridge);
  await bridge.start();

  await assert.rejects(
    bridge.startWriteRun({
      repo: outsideRepo,
      prompt: "Outside allowlist.",
      approval: "allow_once",
    }),
    /not allowlisted/,
  );
  await assert.rejects(
    bridge.startWriteRun({
      repo: escape,
      prompt: "Symlink escape.",
      approval: "allow_once",
    }),
    /not allowlisted/,
  );
  await assert.rejects(
    bridge.startWriteRun({
      repo: allowedRepo,
      prompt: "Denied before activation.",
      approval: "deny",
    }),
    /denied/,
  );
  await assert.rejects(access(join(allowedRepo, ".voiss")));
});

test("automatically declines forbidden remote commands without opening an approval pause", async () => {
  const repo = await createRepo();
  const bridge = new CodexBridge({
    command: process.execPath,
    args: ["--experimental-strip-types", fakeServer],
    allowedRepoRoots: [repo],
  });
  bridges.push(bridge);
  const requested: string[] = [];
  const resolved: Array<{ decision?: string; reason?: string }> = [];
  bridge.subscribe((event) => {
    if (event.type === "approval.requested") requested.push(event.type);
    if (event.type === "approval.resolved") {
      resolved.push(event.data as { decision?: string; reason?: string });
    }
  });
  await bridge.start();

  const handle = await bridge.startWriteRun({
    repo,
    prompt: "FORBIDDEN_COMMAND",
    approval: "allow_once",
  });
  const result = await handle.completion;

  assert.equal(result.status, "completed");
  assert.deepEqual(requested, []);
  assert.deepEqual(resolved, [
    { kind: "command", decision: "deny", reason: "outside_scope" },
  ]);
});

for (const { prompt, expectedReason } of [
  {
    prompt: "MISSING_ENVIRONMENT_APPROVAL",
    expectedReason: "invalid_turn",
  },
  {
    prompt: "REMOTE_ENVIRONMENT_APPROVAL",
    expectedReason: "outside_scope",
  },
  {
    prompt: "ADDITIONAL_PERMISSIONS_APPROVAL",
    expectedReason: "outside_scope",
  },
  {
    prompt: "NO_ACCEPT_DECISION_APPROVAL",
    expectedReason: "outside_scope",
  },
  {
    prompt: "MALFORMED_ACTIONS_APPROVAL",
    expectedReason: "outside_scope",
  },
  {
    prompt: "OUTSIDE_READ_COMMAND_APPROVAL",
    expectedReason: "outside_scope",
  },
] as const) {
  test(`fails closed for ${prompt.toLowerCase()}`, async () => {
    const repo = await createRepo();
    const bridge = new CodexBridge({
      command: process.execPath,
      args: ["--experimental-strip-types", fakeServer],
      allowedRepoRoots: [repo],
    });
    bridges.push(bridge);
    let requested = false;
    let codexDecision = "";
    let resolution: unknown;
    bridge.subscribe((event) => {
      if (event.type === "approval.requested") requested = true;
      if (event.type === "approval.resolved") resolution = event.data;
      if (event.type === "message.delta") {
        codexDecision = String((event.data as { delta?: string }).delta);
      }
    });
    await bridge.start();

    const handle = await bridge.startWriteRun({
      repo,
      prompt,
      approval: "allow_once",
    });

    assert.equal((await handle.completion).status, "completed");
    assert.equal(requested, false);
    assert.equal(codexDecision, "decline");
    assert.deepEqual(resolution, {
      kind: "command",
      decision: "deny",
      reason: expectedReason,
    });
  });
}

for (const prompt of [
  "INJECTED_COMMAND",
  "STALE_APPROVAL",
  "MISSING_TURN_APPROVAL",
] as const) {
  test(`declines ${prompt.toLowerCase()} callbacks without opening an approval pause`, async () => {
    const repo = await createRepo();
    const bridge = new CodexBridge({
      command: process.execPath,
      args: ["--experimental-strip-types", fakeServer],
      allowedRepoRoots: [repo],
    });
    bridges.push(bridge);
    let requested = false;
    let decision = "";
    bridge.subscribe((event) => {
      if (event.type === "approval.requested") requested = true;
      if (event.type === "message.delta") {
        decision = String((event.data as { delta?: string }).delta);
      }
    });
    await bridge.start();

    const handle = await bridge.startWriteRun({
      repo,
      prompt,
      approval: "allow_once",
    });
    assert.equal((await handle.completion).status, "completed");
    assert.equal(requested, false);
    assert.equal(decision, "decline");
  });
}

test("declines every escalation request during a read-only run", async () => {
  const bridge = new CodexBridge({
    command: process.execPath,
    args: ["--experimental-strip-types", fakeServer],
    allowedRepoRoots: [repoRoot],
  });
  bridges.push(bridge);
  let requested = false;
  let resolution: unknown;
  bridge.subscribe((event) => {
    if (event.type === "approval.requested") requested = true;
    if (event.type === "approval.resolved") resolution = event.data;
  });
  await bridge.start();

  const handle = await bridge.startReadOnlyPlan({
    repo: repoRoot,
    prompt: "READ_ONLY_APPROVAL",
  });
  await handle.completion;

  assert.equal(requested, false);
  assert.deepEqual(resolution, {
    kind: "command",
    decision: "deny",
    reason: "outside_scope",
  });
});

test("reports a missing Codex executable as a rejected readiness check", async () => {
  const bridge = new CodexBridge({
    command: join(tmpdir(), "voiss-codex-does-not-exist"),
    args: [],
    restartLimit: 0,
    requestTimeoutMs: 250,
  });
  bridges.push(bridge);

  await assert.rejects(bridge.start(), /Unable to start Codex app-server/);
});

test("does not inherit parent credential variables into the app-server process", async () => {
  const previous = {
    CODEX_BRIDGE_TOKEN: process.env.CODEX_BRIDGE_TOKEN,
    SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
  };
  Object.assign(process.env, {
    CODEX_BRIDGE_TOKEN: "bridge-capability",
    SLACK_BOT_TOKEN: "xoxb-secret",
    OPENAI_API_KEY: "sk-secret-value",
    AWS_SECRET_ACCESS_KEY: "aws-secret",
  });
  const bridge = new CodexBridge({
    command: process.execPath,
    args: ["--experimental-strip-types", fakeServer],
    env: { FAKE_START_MODE: "assert-clean-env" },
    restartLimit: 0,
  });
  bridges.push(bridge);
  try {
    assert.equal((await bridge.start()).connected, true);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("interrupts an active turn and reports interrupted completion", async () => {
  const bridge = new CodexBridge({
    command: process.execPath,
    args: ["--experimental-strip-types", fakeServer],
    allowedRepoRoots: [repoRoot],
  });
  bridges.push(bridge);
  await bridge.start();
  const handle = await bridge.startReadOnlyPlan({
    repo: repoRoot,
    prompt: "CANCEL",
  });

  await bridge.interrupt(handle.runId);

  assert.equal((await handle.completion).status, "interrupted");
});

test("times out an active turn, sends interrupt, and rejects completion", async () => {
  const bridge = new CodexBridge({
    command: process.execPath,
    args: ["--experimental-strip-types", fakeServer],
    allowedRepoRoots: [repoRoot],
    runTimeoutMs: 25,
  });
  bridges.push(bridge);
  const deltas: string[] = [];
  bridge.subscribe((event) => {
    if (event.type === "message.delta") {
      deltas.push(String((event.data as { delta?: string }).delta));
    }
  });
  await bridge.start();
  const handle = await bridge.startReadOnlyPlan({
    repo: repoRoot,
    prompt: "TIMEOUT_COMPLETES",
  });

  await assert.rejects(handle.completion, BridgeTimeoutError);
  assert.deepEqual(deltas, ["interrupt received"]);
});

for (const mode of [
  "crash-once",
  "malformed-once",
  "semantic-malformed-once",
] as const) {
  test(
    `restarts and reinitializes after ${mode}`,
    { timeout: 3_000 },
    async () => {
      const markerDir = await mkdtemp(join(tmpdir(), "voiss-codex-restart-"));
      tempDirs.push(markerDir);
      const bridge = new CodexBridge({
        command: process.execPath,
        args: ["--experimental-strip-types", fakeServer],
        env: {
          FAKE_START_MODE: mode,
          FAKE_MARKER: join(markerDir, "started"),
        },
        restartLimit: 1,
        restartDelayMs: 1,
      });
      bridges.push(bridge);

      const status = await bridge.start();

      assert.equal(status.connected, true);
      assert.equal(status.restartCount, 1);
    },
  );
}

test("bounds the restart budget across repeated post-readiness exits", async () => {
  const markerDir = await mkdtemp(
    join(tmpdir(), "voiss-codex-restart-budget-"),
  );
  tempDirs.push(markerDir);
  const marker = join(markerDir, "ready-count");
  const bridge = new CodexBridge({
    command: process.execPath,
    args: ["--experimental-strip-types", fakeServer],
    env: {
      FAKE_START_MODE: "crash-after-ready",
      FAKE_MARKER: marker,
    },
    restartLimit: 1,
    restartDelayMs: 1,
  });
  bridges.push(bridge);

  assert.equal((await bridge.start()).connected, true);
  await new Promise((resolve) => setTimeout(resolve, 150));

  await assert.rejects(bridge.start(), /restart budget exhausted/);
  assert.equal((await readFile(marker, "utf8")).trim().split("\n").length, 2);
});

test("redacts credentials and bounds streamed output before publishing events", async () => {
  const bridge = new CodexBridge({
    command: process.execPath,
    args: ["--experimental-strip-types", fakeServer],
    allowedRepoRoots: [repoRoot],
    outputLimitBytes: 96,
  });
  bridges.push(bridge);
  let output = "";
  bridge.subscribe((event) => {
    if (event.type === "command.output") {
      output = String((event.data as { delta?: string }).delta);
    }
  });
  await bridge.start();
  const handle = await bridge.startReadOnlyPlan({
    repo: repoRoot,
    prompt: "REDACTION",
  });
  await handle.completion;

  assert.equal(output.includes("secret-token-123"), false);
  assert.equal(output.includes("[REDACTED]"), true);
  assert.equal(Buffer.byteLength(output) <= 96, true);
  assert.equal(output.includes("[TRUNCATED]"), true);
});

test("exports an exact local patch and redacted evidence packet with checksums", async () => {
  const repo = await createRepo();
  const exportRoot = await mkdtemp(join(tmpdir(), "voiss-codex-export-"));
  tempDirs.push(exportRoot);
  const bridge = new CodexBridge({
    command: process.execPath,
    args: ["--experimental-strip-types", fakeServer],
    allowedRepoRoots: [repo],
    exportRoot,
  });
  bridges.push(bridge);
  bridge.subscribe((event) => {
    if (event.type !== "approval.requested") return;
    const approval = event.data as { approvalId: string };
    bridge.resolveApproval(approval.approvalId, "allow_once");
  });
  await bridge.start();
  const handle = await bridge.startWriteRun({
    repo,
    prompt: "EVIDENCE_FLOW",
    approval: "allow_once",
    evidenceContext: {
      correlationId: "corr-evidence-flow",
      sourceSessionId: "meeting-001",
      sourceActionId: "action-queue",
      sourceEvidenceRefs: ["aura-segment:meeting-001/seg-001"],
    },
  });
  await handle.completion;
  await writeFile(join(handle.cwd, "feature.txt"), "post-run human edit\n");

  const exported = await bridge.exportRun(handle.runId);
  const patch = await readFile(exported.patchPath, "utf8");
  const evidence = JSON.parse(
    await readFile(exported.evidencePath, "utf8"),
  ) as {
    schemaVersion: string;
    authority: Record<string, boolean>;
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
    run: { frozenPatchSha256: string };
    validation: {
      gate: string;
      passed: number;
      failed: number;
      stale: number;
      overflow: boolean;
      frozenPatchSha256: string;
      terminalMutationGeneration: number;
      checks: Array<{
        itemId: string;
        command: string;
        cwd: string;
        status: string;
        exitCode: number;
        outcome: string;
        patchSha256: string;
        mutationGeneration: number;
        matchesFrozenPatch: boolean;
      }>;
    };
  };
  const checksums = await readFile(exported.checksumsPath, "utf8");

  assert.equal(patch.includes("feature.txt"), true);
  assert.equal(patch.includes("generated during Codex run"), true);
  assert.equal(patch.includes("post-run human edit"), false);
  assert.equal(evidence.schemaVersion, "voiss.codex.evidence.v1");
  assert.deepEqual(evidence.authority, {
    push: false,
    merge: false,
    deploy: false,
    externalMessages: false,
  });
  assert.deepEqual(
    {
      approvalId: evidence.approvals[0]?.approvalId,
      kind: evidence.approvals[0]?.kind,
      decision: evidence.approvals[0]?.decision,
      reason: evidence.approvals[0]?.reason,
      actor: evidence.approvals[0]?.actor,
    },
    {
      approvalId: null,
      kind: "write_activation",
      decision: "allow_once",
      reason: "isolated_workspace_write",
      actor: "operator",
    },
  );
  assert.match(evidence.approvals[0]?.decidedAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(evidence.context, {
    correlationId: "corr-evidence-flow",
    sourceSessionId: "meeting-001",
    sourceActionId: "action-queue",
    sourceEvidenceRefs: ["aura-segment:meeting-001/seg-001"],
  });
  assert.deepEqual(
    {
      gate: evidence.validation.gate,
      passed: evidence.validation.passed,
      failed: evidence.validation.failed,
      stale: evidence.validation.stale,
      overflow: evidence.validation.overflow,
    },
    {
      gate: "passed",
      passed: 1,
      failed: 0,
      stale: 0,
      overflow: false,
    },
  );
  assert.deepEqual(evidence.validation.checks[0], {
    itemId: `validation-${handle.turnId}`,
    command: "/bin/bash -lc 'python3 -m pytest -q'",
    cwd: handle.cwd,
    status: "completed",
    exitCode: 0,
    outcome: "passed",
    patchSha256: evidence.run.frozenPatchSha256,
    mutationGeneration: evidence.validation.checks[0]?.mutationGeneration,
    matchesFrozenPatch: true,
  });
  assert.equal(
    evidence.validation.checks[0]?.mutationGeneration,
    evidence.validation.terminalMutationGeneration,
  );
  assert.equal(
    evidence.validation.frozenPatchSha256,
    evidence.run.frozenPatchSha256,
  );
  assert.equal(evidence.run.frozenPatchSha256, exported.patchSha256);
  assert.equal(checksums.includes(exported.patchSha256), true);
  assert.equal(checksums.includes(exported.evidenceSha256), true);
});
