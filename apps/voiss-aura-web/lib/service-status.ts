export type ServiceState = {
  ready: boolean;
  label: string;
  installed?: boolean;
  signedIn?: boolean | "unknown";
  version?: string;
  model?: string;
  effort?: string;
  sandbox?: string;
  network?: boolean;
  activeRuns?: number;
  restarts?: number;
  artifactRootReady?: boolean;
  evidenceIndexReady?: boolean;
  auditReady?: boolean;
};

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

async function probe(
  kind: "aura" | "codex",
  url: string | undefined,
  token: string | undefined,
): Promise<ServiceState> {
  if (!url || !token) return { ready: false, label: "尚未設定" };
  try {
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${token}` },
      cache: "no-store",
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) {
      return { ready: false, label: `可復原錯誤 ${response.status}` };
    }
    const body = record(await response.json());
    if (kind === "aura") {
      return {
        ready: body.status === "ready",
        label: body.status === "ready" ? "本機服務就緒" : "本機服務需確認",
        artifactRootReady: body.artifact_root_ready === true,
        evidenceIndexReady: body.evidence_index_ready === true,
        auditReady: body.audit_ready === true,
      };
    }
    const account = record(body.account);
    const policy = record(body.policy);
    return {
      ready: body.ready === true,
      label: body.ready === true ? "本機服務就緒" : "本機服務需確認",
      installed: typeof body.serverVersion === "string",
      signedIn:
        typeof account.signedIn === "boolean" ? account.signedIn : "unknown",
      version:
        typeof body.serverVersion === "string"
          ? body.serverVersion.slice(0, 160)
          : undefined,
      model:
        typeof policy.model === "string"
          ? policy.model.slice(0, 80)
          : undefined,
      effort:
        typeof policy.effort === "string"
          ? policy.effort.slice(0, 40)
          : undefined,
      sandbox:
        typeof policy.defaultSandbox === "string"
          ? policy.defaultSandbox.slice(0, 80)
          : undefined,
      network:
        typeof policy.networkAccess === "boolean"
          ? policy.networkAccess
          : undefined,
      activeRuns:
        typeof body.activeRuns === "number" ? body.activeRuns : undefined,
      restarts:
        typeof body.restartCount === "number" ? body.restartCount : undefined,
    };
  } catch {
    return { ready: false, label: "可復原：服務未連線" };
  }
}

export async function readServiceStatus() {
  if (process.env.VOISS_MODE !== "local") {
    return {
      mode: "demo" as const,
      aura: {
        ready: true,
        label: "Fixture ready",
        artifactRootReady: true,
        evidenceIndexReady: true,
        auditReady: true,
      },
      codex: {
        ready: true,
        label: "Scripted agent",
        installed: false,
        signedIn: "unknown" as const,
        version: "deterministic fixture",
        model: "scripted",
        effort: "deterministic",
        sandbox: "no execution",
        network: false,
        activeRuns: 0,
        restarts: 0,
      },
    };
  }
  const [aura, codex] = await Promise.all([
    probe(
      "aura",
      process.env.AURA_BRIDGE_URL
        ? `${process.env.AURA_BRIDGE_URL.replace(/\/$/, "")}/v1/health`
        : undefined,
      process.env.AURA_BRIDGE_TOKEN,
    ),
    probe(
      "codex",
      process.env.CODEX_BRIDGE_URL
        ? `${process.env.CODEX_BRIDGE_URL.replace(/\/$/, "")}/v1/status`
        : undefined,
      process.env.CODEX_BRIDGE_TOKEN,
    ),
  ]);
  return { mode: "local" as const, aura, codex };
}
