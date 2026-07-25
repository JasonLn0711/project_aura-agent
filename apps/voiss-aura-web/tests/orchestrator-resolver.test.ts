import type { RunAgentInput } from "@ag-ui/client";
import { describe, expect, it, vi } from "vitest";
import { createLocalOrchestratorResolver } from "../lib/orchestrator-resolver";

const input = (
  content: string,
  state: Record<string, unknown> = {},
): RunAgentInput => ({
  threadId: "thread-orchestrator",
  runId: "run-orchestrator",
  state: {
    mode: "local",
    correlationId: "corr-orchestrator-001",
    sourceEvidenceRefs: ["aura-segment:meeting-001/seg-001"],
    ...state,
  },
  messages: [{ id: "user-1", role: "user", content }],
  tools: [],
  context: [],
  forwardedProps: {},
});

const trust = () => ({
  schema: "voiss.trust.snapshot.v1",
  auditChainValid: true,
  findings: [{ id: "R-002", state: "open", severity: "high", evidence: [] }],
  controls: [{ id: "CTRL-AURA-001", state: "pass" }],
});

describe("local orchestrator resolver", () => {
  it("returns current source-backed readiness without exposing credentials", async () => {
    const request = vi.fn(async () =>
      Response.json({
        status: "ready",
        artifact_root_ready: true,
        evidence_index_ready: true,
        audit_ready: true,
      }),
    );
    const resolver = createLocalOrchestratorResolver({
      baseUrl: "http://127.0.0.1:8765",
      token: "aura-secret-token",
      readTrust: trust,
      fetchImpl: request,
    });

    const result = await resolver(input("請檢查服務準備度"));

    expect(result).toMatchObject({
      schema: "voiss.orchestrator.evidence.v1",
      intent: "readiness",
      mode: "local",
      scopeControls: { readOnly: true, mutationExecuted: false },
    });
    expect(result.evidenceRefs).toEqual([
      "aura-health:current",
      "trust-snapshot:current",
    ]);
    expect(result.facts).toContainEqual({
      label: "aura_status",
      value: "ready",
    });
    expect(JSON.stringify(result)).not.toContain("aura-secret-token");
    expect(request).toHaveBeenCalledWith(
      "http://127.0.0.1:8765/v1/health",
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: "Bearer aura-secret-token",
          "x-correlation-id": "corr-orchestrator-001",
        }),
      }),
    );
  });

  it("keeps unsupported consequential requests distinct and read-only", async () => {
    const request = vi.fn();
    const resolver = createLocalOrchestratorResolver({
      baseUrl: "http://127.0.0.1:8765",
      token: "aura-secret-token",
      readTrust: trust,
      fetchImpl: request,
    });

    const result = await resolver(input("請直接部署到 production"));

    expect(result.intent).toBe("consequential_action");
    expect(result.summary).toContain("尚未執行");
    expect(result.scopeControls).toMatchObject({
      readOnly: true,
      mutationExecuted: false,
    });
    expect(result.evidenceRefs).toEqual(["aura-segment:meeting-001/seg-001"]);
    expect(request).not.toHaveBeenCalled();
  });

  it("reports only actions that actually lack source evidence", async () => {
    const resolver = createLocalOrchestratorResolver({
      baseUrl: "http://127.0.0.1:8765",
      token: "aura-secret-token",
      readTrust: trust,
      fetchImpl: vi.fn(async () =>
        Response.json({
          actions: [
            {
              action_id: "action-no-source",
              task: "補齊來源",
              source_segment_ids: [],
              support_status: "unsupported",
              delegable: false,
            },
            {
              action_id: "action-sourced-unconfirmed",
              task: "等待人員確認",
              source_segment_ids: ["seg-001"],
              support_status: "supported",
              delegable: false,
            },
          ],
        }),
      ),
    });

    const result = await resolver(input("找出沒有來源證據的 action items"));

    expect(result.intent).toBe("unsupported_actions");
    expect(result.summary).toContain("1 個");
    expect(result.facts).toEqual([
      { label: "action-no-source", value: "補齊來源" },
    ]);
    expect(result.evidenceRefs).toEqual(["aura-action:action-no-source"]);
  });

  it("gates Max commitments by current week, explicit engineering type, unfinished status, and sources", async () => {
    const request = vi.fn(async (url: string | URL | Request) => {
      const path = String(url);
      if (path.endsWith("/v1/actions")) {
        return Response.json({
          actions: [
            {
              action_id: "action-qualified",
              meeting_id: "meeting-current",
              task: "完成 queue telemetry",
              owner: "Max",
              work_type: "engineering",
              completion_status: "running",
              source_segment_ids: ["seg-001"],
            },
            {
              action_id: "action-unknown-type",
              meeting_id: "meeting-current",
              task: "分類待確認",
              owner: "Max",
              work_type: "unknown",
              completion_status: "running",
              source_segment_ids: ["seg-002"],
            },
            {
              action_id: "action-other-owner",
              meeting_id: "meeting-current",
              task: "其他 owner",
              owner: "Jason",
              work_type: "engineering",
              completion_status: "running",
              source_segment_ids: ["seg-003"],
            },
          ],
        });
      }
      return Response.json({
        sessions: [
          {
            session_id: "meeting-current",
            started_at: "2026-07-22T09:00:00+08:00",
          },
        ],
      });
    });
    const resolver = createLocalOrchestratorResolver({
      baseUrl: "http://127.0.0.1:8765",
      token: "aura-secret-token",
      readTrust: trust,
      fetchImpl: request,
      now: () => new Date("2026-07-24T12:00:00+08:00"),
    });

    const result = await resolver(
      input("找出 Max 本週承諾但尚未完成的工程行動"),
    );

    expect(result.intent).toBe("max_commitments");
    expect(result.facts).toEqual([
      { label: "verified_match_count", value: 1 },
      { label: "excluded_missing_classification", value: 1 },
      { label: "action-qualified", value: "完成 queue telemetry" },
    ]);
    expect(result.evidenceRefs).toEqual([
      "aura-action:meeting-current/action-qualified",
      "aura-segment:meeting-current/seg-001",
    ]);
  });

  it("reviews current diff metadata without executing another change", async () => {
    const request = vi.fn();
    const resolver = createLocalOrchestratorResolver({
      baseUrl: "http://127.0.0.1:8765",
      token: "aura-secret-token",
      readTrust: trust,
      fetchImpl: request,
    });

    const result = await resolver(
      input("審查這次 Codex diff，先不要套用其他變更", {
        codexDiffReview: {
          runId: "run-001",
          status: "completed",
          available: true,
          sha256: "a".repeat(64),
          changedFiles: ["src/aura/asr/threads.py"],
          additions: 1,
          deletions: 1,
        },
      }),
    );

    expect(result.intent).toBe("codex_diff_review");
    expect(result.summary).toContain("未套用任何額外變更");
    expect(result.facts).toContainEqual({ label: "additions", value: 1 });
    expect(result.evidenceRefs[0]).toBe(`codex-diff:run-001/${"a".repeat(64)}`);
    expect(result.scopeControls.mutationExecuted).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });
});
