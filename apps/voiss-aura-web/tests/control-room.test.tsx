import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { EventType, type BaseEvent } from "@ag-ui/client";
import { demoSession } from "@voiss/demo-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agentEventToRunEvent,
  aggregateValidationEvidence,
  ControlRoom,
} from "../components/control-room";

const testContext = vi.hoisted(() => ({
  mode: "demo" as "demo" | "local",
  runAgent: vi.fn(async (...args: unknown[]) => {
    void args;
    return { newMessages: [] };
  }),
  setState: vi.fn(),
}));

vi.mock("@copilotkit/react-core/v2", () => ({
  useAgent: () => ({
    isReady: true,
    agent: {
      addMessage: vi.fn(),
      abortRun: vi.fn(),
      pendingInterrupts: [],
      runAgent: testContext.runAgent,
      setState: testContext.setState,
    },
  }),
}));

vi.mock("../components/providers", () => ({
  useVoissSession: () => ({
    csrfToken: "csrf-demo",
    correlationId: "corr-demo-voiss-001",
    mode: testContext.mode,
  }),
}));

beforeEach(() => {
  testContext.mode = "demo";
  testContext.runAgent.mockClear();
  testContext.setState.mockClear();
  window.localStorage.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/session")) {
        return Response.json({
          csrfToken: "csrf-demo",
          correlationId: "corr-demo-voiss-001",
          mode: "demo",
        });
      }
      if (url.endsWith("/api/status")) {
        return Response.json({
          aura: { ready: true, label: "Fixture ready" },
          codex: { ready: true, label: "Scripted agent" },
        });
      }
      return Response.json({ accepted: true, mode: "demo" });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("trusted Control Room components", () => {
  const confirmQueueClaim = async () => {
    fireEvent.click(screen.getByRole("button", { name: /會議紀錄/ }));
    const claim = screen
      .getByText("目前 ASR 工作佇列未設定容量上限。")
      .closest("article");
    expect(claim).not.toBeNull();
    fireEvent.click(
      within(claim as HTMLElement).getByRole("button", { name: /確認/ }),
    );
    await waitFor(() =>
      expect(within(claim as HTMLElement).getByText("已確認")).toBeVisible(),
    );
  };

  it("classifies normalized validation activity as inspected test evidence", () => {
    const mapped = agentEventToRunEvent(
      {
        type: EventType.ACTIVITY_SNAPSHOT,
        messageId: "validation-1",
        activityType: "voiss.codex.command.v1",
        content: {
          command: "pnpm test",
          status: "completed",
          output: "4 tests passed",
        },
        replace: true,
      } as BaseEvent,
      "run-1",
    );

    expect(mapped).toMatchObject({
      id: "validation-1",
      runId: "run-1",
      type: "test",
      status: "passed",
      title: "pnpm test",
      detail: "4 tests passed",
    });
  });

  it("keeps an earlier failed validation authoritative after a later pass", () => {
    const failed = aggregateValidationEvidence(
      { validation: false, validationFailed: false },
      "failed",
    );
    const laterPass = aggregateValidationEvidence(failed, "passed");

    expect(laterPass).toEqual({ validation: true, validationFailed: true });
  });

  it("exposes assets, controls, findings, remediations, and audit as trusted tabs", () => {
    render(<ControlRoom />);
    fireEvent.click(screen.getByRole("button", { name: /信任與稽核/ }));

    for (const tab of [
      "Assets",
      "Controls",
      "Findings",
      "Remediations",
      "Audit Timeline",
    ]) {
      expect(screen.getByRole("tab", { name: tab })).toBeVisible();
    }
    fireEvent.click(screen.getByRole("tab", { name: "Remediations" }));
    expect(
      screen.getByRole("heading", { name: "Remediation work packages" }),
    ).toBeVisible();
    expect(
      screen.getAllByRole("button", { name: "草擬唯讀修復計畫" }),
    ).toHaveLength(6);
  });

  it("keeps an unsupported claim outside the confirm path", async () => {
    render(<ControlRoom />);
    fireEvent.click(screen.getByRole("button", { name: /會議紀錄/ }));
    const claim = screen.getByText("目標設備具備可用 GPU。").closest("article");
    expect(claim).not.toBeNull();
    expect(
      within(claim as HTMLElement).getByRole("button", { name: /確認/ }),
    ).toBeDisabled();
    expect(
      within(claim as HTMLElement).getByText(/尚未提供設備探測證據/),
    ).toBeVisible();
  });

  it("delegates a confirmed supported action into read-only approval", async () => {
    render(<ControlRoom />);
    await confirmQueueClaim();
    fireEvent.click(screen.getByRole("button", { name: "Control Room" }));
    fireEvent.click(screen.getByRole("button", { name: /Codex delegation/ }));
    fireEvent.click(await screen.findByRole("tab", { name: "Approvals" }));
    expect(
      await screen.findByRole("heading", { name: "啟用隔離工作樹寫入" }),
    ).toBeVisible();
    expect(screen.getByText("read-only")).toBeVisible();
    expect(screen.getByText("gpt-5.6-sol")).toBeVisible();
    expect(screen.getByText(/目前執行：run-demo-001-/)).toBeVisible();
  });

  it("denial leaves the run read-only and records a stopped outcome", async () => {
    render(<ControlRoom />);
    await confirmQueueClaim();
    fireEvent.click(screen.getByRole("button", { name: "Control Room" }));
    fireEvent.click(screen.getByRole("button", { name: /Codex delegation/ }));
    fireEvent.click(await screen.findByRole("tab", { name: "Approvals" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "拒絕" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "拒絕" }));
    await screen.findByText(/工作樹保持未變更/);
    expect(screen.getByText("read-only")).toBeVisible();
    expect(screen.getByText("0 active runs")).toBeVisible();
    expect(
      screen.queryByRole("heading", { name: "Trusted diff" }),
    ).not.toBeInTheDocument();
  });

  it("fails closed without exposing demo evidence when local AURA loading fails", async () => {
    testContext.mode = "local";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/status")) {
          return Response.json({
            aura: { ready: false, label: "可復原：服務未連線" },
            codex: { ready: true, label: "本機服務就緒" },
          });
        }
        if (url.endsWith("/api/trust")) {
          return Response.json(
            { error: "bridge_not_configured" },
            { status: 503 },
          );
        }
        if (url.endsWith("/api/aura/v1/sessions")) {
          return Response.json(
            { error: "aura_bridge_unavailable" },
            { status: 503 },
          );
        }
        return Response.json({ accepted: true, mode: "local" });
      }),
    );

    render(<ControlRoom />);

    expect(await screen.findByText(/AURA 會議資料尚未載入/)).toBeVisible();
    expect(
      screen.queryByText("VOISS × AURA 架構與可信任執行檢視"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("限制 ASR 佇列並加入背壓"),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Codex delegation/ }));
    expect(
      await screen.findByRole("heading", { name: "行動項目" }),
    ).toBeVisible();
    expect(screen.getByText(/目前沒有可委派的 AURA 行動/)).toBeVisible();
    expect(
      screen.queryByRole("heading", { name: "啟用隔離工作樹寫入" }),
    ).not.toBeInTheDocument();
    expect(testContext.runAgent).not.toHaveBeenCalled();
  });

  it("requires claim confirmation before the matching demo action becomes eligible", async () => {
    render(<ControlRoom />);
    const actionRow = screen
      .getByRole("heading", {
        level: 3,
        name: "限制 ASR 佇列並加入背壓",
      })
      .closest("article");
    expect(actionRow).not.toBeNull();
    expect(
      within(actionRow as HTMLElement).getByRole("button", { name: "委派" }),
    ).toBeDisabled();

    await confirmQueueClaim();
    fireEvent.click(screen.getByRole("button", { name: "Control Room" }));

    const confirmedRow = screen
      .getByRole("heading", {
        level: 3,
        name: "限制 ASR 佇列並加入背壓",
      })
      .closest("article");
    expect(confirmedRow).not.toBeNull();
    expect(
      within(confirmedRow as HTMLElement).getByRole("button", { name: "委派" }),
    ).toBeEnabled();
  });

  it("keeps an edited claim action proposed until a later explicit confirmation", async () => {
    render(<ControlRoom />);
    fireEvent.click(screen.getByRole("button", { name: /會議紀錄/ }));
    const originalClaim = screen
      .getByText("目前 ASR 工作佇列未設定容量上限。")
      .closest("article");
    expect(originalClaim).not.toBeNull();
    fireEvent.click(
      within(originalClaim as HTMLElement).getByRole("button", {
        name: /編輯/,
      }),
    );
    fireEvent.change(
      within(originalClaim as HTMLElement).getByRole("textbox"),
      {
        target: { value: "目前 ASR 工作佇列需要加入明確容量上限。" },
      },
    );
    fireEvent.click(
      within(originalClaim as HTMLElement).getByRole("button", {
        name: "儲存編輯",
      }),
    );
    await waitFor(() => expect(screen.getByText("已編輯確認")).toBeVisible());

    fireEvent.click(screen.getByRole("button", { name: /行動項目/ }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Delegate to Codex" }),
      ).toBeDisabled(),
    );

    fireEvent.click(screen.getByRole("button", { name: /會議紀錄/ }));
    const editedClaim = screen
      .getByText("目前 ASR 工作佇列需要加入明確容量上限。")
      .closest("article");
    expect(editedClaim).not.toBeNull();
    fireEvent.click(
      within(editedClaim as HTMLElement).getByRole("button", { name: /確認/ }),
    );
    await waitFor(() =>
      expect(
        within(editedClaim as HTMLElement).getByText("已確認"),
      ).toBeVisible(),
    );

    fireEvent.click(screen.getByRole("button", { name: /行動項目/ }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Delegate to Codex" }),
      ).toBeEnabled(),
    );
  });

  it("retains the full local session list and binds audio to the selected segment span", async () => {
    testContext.mode = "local";
    const summaries = [
      {
        session_id: "local-session-1",
        title: "第一場本機會議",
        started_at: "2026-07-24T01:00:00.000Z",
        ended_at: "2026-07-24T01:20:00.000Z",
        workflow: "meeting",
        status: "ready",
        transcript_hash_state: "current",
        summary_state: "ready",
        reviewed_count: 1,
        unreviewed_count: 0,
        confirmed_action_count: 1,
        local_path_available: true,
      },
      {
        session_id: "local-session-2",
        title: "第二場本機會議",
        started_at: "2026-07-24T02:00:00.000Z",
        ended_at: "2026-07-24T02:30:00.000Z",
        workflow: "meeting",
        status: "ready",
        transcript_hash_state: "stale",
        summary_state: "invalidated",
        reviewed_count: 0,
        unreviewed_count: 1,
        confirmed_action_count: 0,
        local_path_available: true,
      },
    ] as const;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/status") {
          return Response.json({
            aura: { ready: true, label: "本機服務就緒" },
            codex: {
              ready: false,
              label: "可復原：服務未連線",
              installed: true,
              signedIn: false,
            },
          });
        }
        if (url === "/api/trust") {
          return Response.json({
            assets: [],
            controls: [],
            findings: [],
            audit: [],
            auditChainValid: true,
          });
        }
        if (url === "/api/aura/v1/sessions")
          return Response.json({ sessions: summaries });
        const sessionId = url.includes("local-session-2")
          ? "local-session-2"
          : "local-session-1";
        const summary =
          summaries.find((item) => item.session_id === sessionId) ??
          summaries[0];
        if (url === `/api/aura/v1/sessions/${sessionId}`) {
          return Response.json({
            ...summary,
            capture_mode: "meeting",
            audio_tracks: ["mixed"],
            segment_count: 2,
            claim_count: 1,
          });
        }
        if (url === `/api/aura/v1/sessions/${sessionId}/segments`) {
          return Response.json({
            segments: [
              {
                segment_id: `${sessionId}-seg-1`,
                start_ms: 0,
                end_ms: 10_000,
                text: `只屬於${summary.title}的第一段`,
                speaker: "Max",
                state: "confirmed",
                revision: 1,
              },
              {
                segment_id: `${sessionId}-seg-2`,
                start_ms: 12_000,
                end_ms: 18_000,
                text: `只屬於${summary.title}的第二段`,
                speaker: "Jason",
                state: "raw",
                revision: 1,
              },
            ],
          });
        }
        if (url === `/api/aura/v1/sessions/${sessionId}/claims`) {
          return Response.json({
            claims: [
              {
                claim_id: `${sessionId}-claim`,
                field: "action_items",
                text: `${summary.title}待覆核事項`,
                source_segment_ids: [`${sessionId}-seg-2`],
                support_status: "supported",
                review_status:
                  sessionId === "local-session-1" ? "confirmed" : "unreviewed",
              },
            ],
          });
        }
        if (url === `/api/aura/v1/actions?meeting_id=${sessionId}`) {
          return Response.json({
            actions: [
              {
                action_id: `${sessionId}-claim`,
                meeting_id: sessionId,
                task: `${summary.title}已確認行動`,
                owner: "Jason",
                deadline: "",
                source_segment_ids: [`${sessionId}-seg-1`],
                support_status: "supported",
                review_status: "confirmed",
              },
            ],
          });
        }
        return Response.json({ error: "unexpected request" }, { status: 404 });
      }),
    );

    render(<ControlRoom />);
    expect(
      await screen.findByLabelText("資料邊界：Unknown/misconfigured"),
    ).toBeVisible();
    const localAction = await screen.findByRole("heading", {
      level: 3,
      name: "第一場本機會議已確認行動",
    });
    expect(
      within(localAction.closest("article") as HTMLElement).getByRole(
        "button",
        { name: "委派" },
      ),
    ).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /會議紀錄/ }));
    const rail = screen.getByLabelText("會議清單");
    expect(
      await within(rail).findByRole("button", { name: /第一場本機會議/ }),
    ).toBeVisible();
    const secondSession = within(rail).getByRole("button", {
      name: /第二場本機會議/,
    });
    expect(secondSession).toHaveTextContent("摘要已過期");
    fireEvent.click(secondSession);

    const segment = await screen.findByText("只屬於第二場本機會議的第二段", {
      exact: true,
    });
    fireEvent.click(segment.closest("button") as HTMLElement);
    await waitFor(() =>
      expect(screen.getByLabelText("所選來源片段音訊")).toHaveAttribute(
        "src",
        "/api/aura-audio?meeting_id=local-session-2&start_ms=12000&end_ms=18000",
      ),
    );
    expect(
      window.localStorage.getItem("voiss.control-room.local.session"),
    ).toBe("local-session-2");
    expect(window.localStorage.getItem("voiss.control-room.segment")).toBe(
      "local-session-2-seg-2",
    );

    fireEvent.click(screen.getByRole("button", { name: /行動項目/ }));
    const actionDetail = await screen.findByRole("heading", {
      name: "第二場本機會議已確認行動",
    });
    const detailPanel = actionDetail.closest("aside");
    expect(detailPanel).not.toBeNull();
    expect(
      within(detailPanel as HTMLElement).getByText("第二場本機會議待覆核事項"),
    ).toBeVisible();
    expect(
      within(detailPanel as HTMLElement).getByText("unknown"),
    ).toBeVisible();
    expect(
      within(detailPanel as HTMLElement).getByRole("button", {
        name: "Delegate to Codex",
      }),
    ).toBeDisabled();
    expect(
      within(detailPanel as HTMLElement).getByText(
        /runtime 就緒後開啟本機委派/,
      ),
    ).toBeVisible();
  });

  it("restores only non-secret navigation and filter choices from browser storage", async () => {
    window.localStorage.setItem("voiss.control-room.screen", "sessions");
    window.localStorage.setItem("voiss.control-room.segment", "seg-003");
    window.localStorage.setItem(
      "voiss.control-room.speaker-filter",
      "AURA 團隊",
    );
    window.localStorage.setItem("voiss.control-room.state-filter", "confirmed");

    render(<ControlRoom />);

    expect(
      await screen.findByRole("heading", { name: "會議紀錄" }),
    ).toBeVisible();
    await waitFor(() => {
      expect(screen.getByLabelText("依講者篩選")).toHaveValue("AURA 團隊");
      expect(screen.getByLabelText("依片段狀態篩選")).toHaveValue("confirmed");
    });
    expect(
      screen.getByText(
        "aura://demo-voiss-aura-architecture-review/segments/seg-003",
      ),
    ).toBeVisible();
    expect(window.localStorage.getItem("csrfToken")).toBeNull();
    expect(window.localStorage.getItem("mode")).toBeNull();
  });

  it("shares selected evidence locators and renders orchestrator activity as trusted cards", async () => {
    testContext.runAgent.mockImplementationOnce(async (...args: unknown[]) => {
      const subscriber = args[1] as {
        onEvent: (payload: { event: BaseEvent }) => void;
      };
      subscriber.onEvent({
        event: {
          type: EventType.ACTIVITY_SNAPSHOT,
          messageId: "orchestrator-plan-1",
          activityType: "voiss.codex.plan.v1",
          content: { status: "completed", plan: "依來源建立受控檢視路徑" },
          replace: true,
        } as BaseEvent,
      });
      return { newMessages: [] };
    });

    render(<ControlRoom />);
    fireEvent.click(
      screen.getByRole("button", { name: "檢查 AURA 是否已準備好開始工作" }),
    );

    await waitFor(() =>
      expect(testContext.setState).toHaveBeenCalledWith(
        expect.objectContaining({
          selectedSessionId: demoSession.id,
          selectedClaimId: "claim-queue",
          selectedActionId: "action-bound-asr-queue",
          selectedClaimEvidenceRefs: [
            "aura://demo-voiss-aura-architecture-review/segments/seg-002",
          ],
          selectedActionEvidenceRefs: [
            "aura://demo-voiss-aura-architecture-review/segments/seg-002",
          ],
          sourceEvidenceRefs: [
            "aura://demo-voiss-aura-architecture-review/segments/seg-002",
          ],
        }),
      ),
    );
    expect(
      await screen.findByRole("heading", { name: "Trusted agent activity" }),
    ).toBeVisible();
    expect(screen.getByText("Codex 計畫更新")).toBeVisible();
    expect(
      screen.getByText(
        "aura://demo-voiss-aura-architecture-review/segments/seg-002",
      ),
    ).toBeVisible();
  });

  it("renders the complete action register columns, native filters, and source-backed detail", () => {
    render(<ControlRoom />);
    fireEvent.click(screen.getByRole("button", { name: /行動項目/ }));

    for (const column of [
      "Action",
      "Meeting",
      "Owner",
      "Deadline",
      "Action status",
      "Support status",
      "Review status",
      "Sources",
      "Delegation",
      "Last agent run",
    ]) {
      expect(screen.getByRole("columnheader", { name: column })).toBeVisible();
    }
    for (const filter of [
      "依 owner 篩選",
      "依期限篩選",
      "依證據狀態篩選",
      "依覆核狀態篩選",
      "依工作類型篩選",
      "依委派狀態篩選",
    ]) {
      expect(screen.getByLabelText(filter)).toBeVisible();
    }
    expect(
      within(screen.getByLabelText("依工作類型篩選")).getByRole("option", {
        name: "unknown / 待來源分類",
      }),
    ).toBeVisible();
    expect(
      screen.getByRole("heading", { name: "Original claim" }),
    ).toBeVisible();
    expect(
      screen.getByRole("heading", { name: "Supporting segments and audio" }),
    ).toBeVisible();
    expect(
      screen.getByRole("heading", { name: "Delegation gate" }),
    ).toBeVisible();
  });

  it("exposes an inspectable run list and all seven named run detail tabs", async () => {
    render(<ControlRoom />);
    await confirmQueueClaim();
    fireEvent.click(screen.getByRole("button", { name: "Control Room" }));
    fireEvent.click(screen.getByRole("button", { name: /Codex delegation/ }));

    expect(
      await screen.findByRole("heading", { name: "Run list" }),
    ).toBeVisible();
    for (const tab of [
      "Overview",
      "Plan",
      "Activity",
      "Changes",
      "Validation",
      "Approvals",
      "Evidence Packet",
    ]) {
      expect(screen.getByRole("tab", { name: tab })).toBeVisible();
    }
    expect(screen.getByLabelText("Supported run statuses")).toHaveTextContent(
      "waiting for approval",
    );
    expect(screen.queryByText("Reasoning effort")).not.toBeInTheDocument();
  });

  it("guides local operators through official Codex installation and sign-in", async () => {
    testContext.mode = "local";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/status")) {
          return Response.json({
            aura: { ready: false, label: "可復原：服務未連線" },
            codex: {
              ready: false,
              label: "可復原：服務未連線",
              installed: false,
              signedIn: "unknown",
            },
          });
        }
        if (url.endsWith("/api/trust")) {
          return Response.json(
            { error: "bridge_not_configured" },
            { status: 503 },
          );
        }
        if (url.endsWith("/api/aura/v1/sessions")) {
          return Response.json(
            { error: "aura_bridge_unavailable" },
            { status: 503 },
          );
        }
        return Response.json({ accepted: true, mode: "local" });
      }),
    );

    render(<ControlRoom />);
    fireEvent.click(screen.getByRole("button", { name: /設定/ }));

    expect(
      await screen.findByRole("heading", { name: "啟用 Codex 本機委派" }),
    ).toBeVisible();
    expect(screen.getByText(/codex --version/)).toBeVisible();
    expect(screen.getByText(/使用官方 client 完成 ChatGPT 登入/)).toBeVisible();
    expect(
      screen.getByLabelText("資料邊界：Unknown/misconfigured"),
    ).toBeVisible();
  });

  it("shows the complete settings surfaces and resets the deterministic fixture", async () => {
    render(<ControlRoom />);
    expect(screen.getByLabelText("資料邊界：Local only")).toBeVisible();
    await confirmQueueClaim();
    window.localStorage.setItem(
      "voiss.control-room.speaker-filter",
      "AURA 團隊",
    );

    fireEvent.click(screen.getByRole("button", { name: /設定/ }));
    for (const section of ["Agent", "Privacy", "Developer"]) {
      expect(screen.getByRole("heading", { name: section })).toBeVisible();
    }
    expect(screen.getByText("Orchestrator backend")).toBeVisible();
    expect(screen.getByText("Optional API credential")).toBeVisible();
    expect(screen.getByText("Tool allowlist")).toBeVisible();
    expect(screen.getByText("Audit retention")).toBeVisible();
    expect(screen.getByText("Event stream")).toBeVisible();
    expect(screen.getByText("Raw diagnostics")).toBeVisible();

    fireEvent.click(
      screen.getByRole("button", { name: "重設 deterministic fixture" }),
    );
    expect(
      await screen.findByText(/Deterministic fixture 已重設/),
    ).toBeVisible();
    expect(
      window.localStorage.getItem("voiss.control-room.speaker-filter"),
    ).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /會議紀錄/ }));
    const claim = screen
      .getByText("目前 ASR 工作佇列未設定容量上限。")
      .closest("article");
    expect(claim).not.toBeNull();
    expect(
      within(claim as HTMLElement).getByRole("button", { name: /確認/ }),
    ).toBeEnabled();
  });

  it("uses a unique execution run id for each deterministic demo replay", async () => {
    const first = render(<ControlRoom />);
    await confirmQueueClaim();
    fireEvent.click(screen.getByRole("button", { name: "Control Room" }));
    fireEvent.click(screen.getByRole("button", { name: /Codex delegation/ }));
    await waitFor(() => expect(testContext.runAgent).toHaveBeenCalledTimes(1));
    first.unmount();
    window.localStorage.clear();

    render(<ControlRoom />);
    await confirmQueueClaim();
    fireEvent.click(screen.getByRole("button", { name: "Control Room" }));
    fireEvent.click(screen.getByRole("button", { name: /Codex delegation/ }));
    await waitFor(() => expect(testContext.runAgent).toHaveBeenCalledTimes(2));

    const runIds = testContext.runAgent.mock.calls.map(
      (call) => (call[0] as { runId: string }).runId,
    );
    expect(runIds[0]).toMatch(/^run-demo-001-/);
    expect(runIds[1]).toMatch(/^run-demo-001-/);
    expect(runIds[0]).not.toBe(runIds[1]);
  });
});
