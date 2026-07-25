import { realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { TrustStore } from "@voiss/trust-engine";
import { CodexBridge } from "./index.ts";
import { CodexHttpServer } from "./server.ts";

export async function main(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const token = required(env, "CODEX_BRIDGE_TOKEN");
  const configuredRepos =
    env.VOISS_ALLOWED_REPOSITORIES ?? env.VOISS_ALLOWED_REPO_ROOTS;
  if (!configuredRepos) {
    throw new Error(
      "VOISS_ALLOWED_REPOSITORIES is required (VOISS_ALLOWED_REPO_ROOTS is accepted as an alias).",
    );
  }
  const allowedRepoRoots = await Promise.all(
    commaList(configuredRepos).map(async (candidate) => {
      if (!isAbsolute(candidate)) {
        throw new Error("Every allowed repository must be an absolute path.");
      }
      return realpath(candidate);
    }),
  );
  if (allowedRepoRoots.length === 0) {
    throw new Error("At least one allowed repository is required.");
  }
  const allowedOrigins = configuredAllowedOrigins(env);
  const port = integer(
    env.CODEX_BRIDGE_PORT ?? "8770",
    "CODEX_BRIDGE_PORT",
    1,
    65_535,
  );
  const runTimeoutMs = seconds(
    env.CODEX_PROCESS_TIMEOUT_SECONDS ?? "120",
    "CODEX_PROCESS_TIMEOUT_SECONDS",
  );
  const requestTimeoutMs = seconds(
    env.CODEX_REQUEST_TIMEOUT_SECONDS ?? "30",
    "CODEX_REQUEST_TIMEOUT_SECONDS",
  );
  const approvalTimeoutMs = seconds(
    env.CODEX_APPROVAL_TIMEOUT_SECONDS ?? "300",
    "CODEX_APPROVAL_TIMEOUT_SECONDS",
  );
  const observabilityLogPath = env.VOISS_OBSERVABILITY_LOG;
  if (observabilityLogPath && !isAbsolute(observabilityLogPath)) {
    throw new Error("VOISS_OBSERVABILITY_LOG must be an absolute path.");
  }
  const metadataPath =
    env.VOISS_DB_PATH ??
    resolve(allowedRepoRoots[0] as string, ".voiss", "control-plane.sqlite");
  if (!isAbsolute(metadataPath)) {
    throw new Error("VOISS_DB_PATH must be an absolute path.");
  }
  const metadataStore = new TrustStore(metadataPath);
  const bridge = new CodexBridge({
    command: env.CODEX_BIN ?? "codex",
    env: {
      VOISS_ALLOWED_REPOSITORIES: allowedRepoRoots.join(","),
      ...copyEnvironment(env, [
        "VOISS_WORKTREE_ROOT",
        "CODEX_EXPORT_ROOT",
        "CODEX_VENDOR_DIR",
        "CODEX_AUTH_FILE",
        "CODEX_PODMAN_IMAGE",
      ]),
    },
    allowedRepoRoots,
    runTimeoutMs,
    approvalTimeoutMs,
    requestTimeoutMs,
    ...(env.VOISS_WORKTREE_ROOT
      ? { worktreeRoot: env.VOISS_WORKTREE_ROOT }
      : {}),
    ...(env.CODEX_EXPORT_ROOT ? { exportRoot: env.CODEX_EXPORT_ROOT } : {}),
  });
  const server = new CodexHttpServer({
    bridge,
    token,
    allowedOrigins,
    defaultRepo: allowedRepoRoots[0] as string,
    metadataStore,
    approvalTimeoutMs,
    ...(observabilityLogPath ? { observabilityLogPath } : {}),
  });

  try {
    const status = await bridge.start();
    if (!status.account.signedIn) {
      throw new Error("Codex account is not signed in.");
    }
    const address = await server.listen(port);
    process.stdout.write(
      `${JSON.stringify({
        status: "ready",
        url: address.url,
        serverVersion: status.serverVersion,
        allowedRepositories: allowedRepoRoots.length,
        model: "gpt-5.6-sol",
        effort: "max",
        networkAccess: false,
      })}\n`,
    );
  } catch (error) {
    await server.close().catch(() => undefined);
    await bridge.close().catch(() => undefined);
    metadataStore.close();
    throw error;
  }

  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    await server.close().catch(() => undefined);
    await bridge.close().catch(() => undefined);
    metadataStore.close();
  };
  process.once("SIGINT", () => {
    void stop().then(() => process.exit(0));
  });
  process.once("SIGTERM", () => {
    void stop().then(() => process.exit(0));
  });
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value) throw new Error(`${key} is required.`);
  return value;
}

function commaList(value: string): string[] {
  return [
    ...new Set(
      value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

export function configuredAllowedOrigins(env: NodeJS.ProcessEnv): string[] {
  return commaList(
    env.CODEX_ALLOWED_ORIGINS ||
      env.VOISS_ALLOWED_ORIGINS ||
      "http://127.0.0.1:3000",
  );
}

function copyEnvironment(
  env: NodeJS.ProcessEnv,
  names: string[],
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    names.flatMap((name) => {
      const value = env[name];
      return value === undefined ? [] : [[name, value]];
    }),
  );
}

function seconds(value: string, key: string): number {
  return integer(value, key, 1, 86_400) * 1000;
}

function integer(
  value: string,
  key: string,
  minimum: number,
  maximum: number,
): number {
  if (!/^\d+$/.test(value)) throw new Error(`${key} must be an integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${key} must be between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error: unknown) => {
    const message =
      error instanceof Error ? error.message : "Unknown startup error.";
    process.stderr.write(`Codex Bridge startup failed: ${message}\n`);
    process.exitCode = 1;
  });
}
