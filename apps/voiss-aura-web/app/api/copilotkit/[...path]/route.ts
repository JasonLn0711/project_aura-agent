import {
  CopilotRuntime,
  createCopilotRuntimeHandler,
} from "@copilotkit/runtime/v2";
import { SqliteAgentRunner } from "@copilotkit/sqlite-runner";
import { createNamedAgents } from "@voiss/agent-runtime";
import { HttpCodexBridgeTransport } from "@voiss/ag-ui-codex-adapter";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  authorizeMutation,
  authorizeRead,
  guardMutationBody,
} from "@/lib/security";
import { createLocalOrchestratorResolver } from "@/lib/orchestrator-resolver";
import { recordTrustEvent, trustSnapshot } from "@/lib/trust-store";

function codexTransport() {
  const base = process.env.CODEX_BRIDGE_URL?.replace(/\/$/, "");
  const token = process.env.CODEX_BRIDGE_TOKEN;
  if (process.env.VOISS_MODE !== "local" || !base || !token) return undefined;
  return new HttpCodexBridgeTransport({
    runEndpoint: `${base}/v1/runs`,
    resumeEndpoint: `${base}/v1/approvals/resume`,
    headers: { authorization: `Bearer ${token}` },
  });
}

const configuredAgentDatabasePath = process.env.VOISS_AGENT_DB_PATH;
const agentDatabasePath = configuredAgentDatabasePath
  ? resolve(/* turbopackIgnore: true */ configuredAgentDatabasePath)
  : resolve(process.cwd(), ".voiss", "agent-runs.sqlite");
mkdirSync(dirname(agentDatabasePath), { recursive: true });

const runtime = new CopilotRuntime({
  agents: createNamedAgents({
    codexTransport: codexTransport(),
    orchestratorResolver:
      process.env.VOISS_MODE === "local"
        ? createLocalOrchestratorResolver({
            baseUrl: process.env.AURA_BRIDGE_URL,
            token: process.env.AURA_BRIDGE_TOKEN,
            readTrust: trustSnapshot,
          })
        : undefined,
  }),
  runner: new SqliteAgentRunner({ dbPath: agentDatabasePath }),
  forwardHeaders: {
    allow: ["x-correlation-id"],
    deny: ["authorization", "cookie", "x-voiss-csrf"],
  },
});
const handle = createCopilotRuntimeHandler({
  runtime,
  basePath: "/api/copilotkit",
  activateChannels: false,
});

export function GET(request: Request) {
  const authorization = authorizeRead(request);
  return authorization instanceof Response ? authorization : handle(request);
}

export async function POST(request: Request) {
  const authorization = authorizeMutation(request);
  if (authorization instanceof Response) return authorization;
  const bodyRejection = await guardMutationBody(request);
  if (bodyRejection) return bodyRejection;
  if (process.env.VOISS_MODE === "local") {
    const correlationId = request.headers.get("x-correlation-id");
    if (
      !correlationId ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(correlationId)
    ) {
      return Response.json(
        { error: "invalid_correlation_id" },
        { status: 400 },
      );
    }
    recordTrustEvent({
      correlationId,
      actor: "operator",
      action: "agent.run.requested",
      subject: "codex_engineer",
      detail: { classification: "trusted_ui_request" },
    });
  }
  return handle(request);
}
