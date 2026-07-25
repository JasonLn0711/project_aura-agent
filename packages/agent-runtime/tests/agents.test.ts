import {
  AbstractAgent,
  EventType,
  type BaseEvent,
  type RunAgentInput,
} from "@ag-ui/client";
import { toArray } from "rxjs";
import { describe, expect, it } from "vitest";
import {
  VOISS_AGENT_IDS,
  createNamedAgents,
  demo_agent,
  voiss_orchestrator,
} from "../src/index";

const runInput: RunAgentInput = {
  threadId: "thread-demo",
  runId: "run-demo",
  state: { mode: "demo" },
  messages: [
    {
      id: "user-demo",
      role: "user",
      content: "Prepare the safe next step.",
    },
  ],
  tools: [],
  context: [],
  forwardedProps: {},
};

const collect = async (agent: AbstractAgent): Promise<BaseEvent[]> =>
  await new Promise((resolve, reject) => {
    agent.run(runInput).pipe(toArray()).subscribe({
      next: resolve,
      error: reject,
    });
  });

const expectedEnvelope = [
  EventType.RUN_STARTED,
  EventType.ACTIVITY_SNAPSHOT,
  EventType.STEP_STARTED,
  EventType.TEXT_MESSAGE_START,
  EventType.TEXT_MESSAGE_CONTENT,
  EventType.TEXT_MESSAGE_END,
  EventType.STEP_FINISHED,
  EventType.RUN_FINISHED,
];

describe("credential-free named agents", () => {
  it.each([
    ["demo_agent", demo_agent],
    ["voiss_orchestrator", voiss_orchestrator],
  ] as const)("%s emits a complete AG-UI run envelope", async (_, agent) => {
    const events = await collect(agent);

    expect(events.map((event) => event.type)).toEqual(expectedEnvelope);
    expect(events[0]).toMatchObject({
      type: EventType.RUN_STARTED,
      threadId: runInput.threadId,
      runId: runInput.runId,
    });
    expect(events.at(-1)).toMatchObject({
      type: EventType.RUN_FINISHED,
      threadId: runInput.threadId,
      runId: runInput.runId,
      outcome: { type: "success" },
    });
  });

  it.each([
    ["demo_agent", demo_agent],
    ["voiss_orchestrator", voiss_orchestrator],
  ] as const)(
    "%s replays deterministically for the same input",
    async (_, agent) => {
      expect(await collect(agent)).toEqual(await collect(agent));
    },
  );

  it("exports all three named AbstractAgent registrations", () => {
    const agents = createNamedAgents();

    expect(Object.keys(agents)).toEqual([
      VOISS_AGENT_IDS.orchestrator,
      VOISS_AGENT_IDS.codexEngineer,
      VOISS_AGENT_IDS.demo,
    ]);
    expect(
      Object.values(agents).every((agent) => agent instanceof AbstractAgent),
    ).toBe(true);
    expect(agents.voiss_orchestrator.agentId).toBe("voiss_orchestrator");
    expect(agents.codex_engineer.agentId).toBe("codex_engineer");
    expect(agents.demo_agent.agentId).toBe("demo_agent");
  });

  it("advertises bounded tool contracts without write authority on the orchestrator", async () => {
    const capabilities = await voiss_orchestrator.getCapabilities();
    const names = capabilities.tools?.items?.map((tool) => tool.name) ?? [];

    expect(names).toContain("searchEvidence");
    expect(names).toContain("draftCodexGoal");
    expect(names).not.toContain("reviewClaim");
    expect(names).not.toContain("startCodexPlan");
    expect(names).not.toContain("requestRunWriteApproval");
    expect(names).not.toContain("respondToApproval");
    expect(names).not.toContain("closeFinding");
    expect(capabilities.tools?.clientProvided).toBe(false);
    expect(capabilities.tools?.parallelCalls).toBe(false);
  });
});
