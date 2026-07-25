import { describe, expect, it } from "vitest";
import { MeetingSessionSchema, canDelegate } from "@voiss/domain";
import {
  demoAssets,
  demoClaimActionLinks,
  demoControls,
  demoFindings,
  demoFixtureAssetMetadata,
  demoScenarioBFixture,
  demoSession,
} from "../src/index";

describe("demo-voiss-aura-architecture-review", () => {
  it("is deterministic, sanitized, and keeps the GPU claim unsupported", () => {
    const parsed = MeetingSessionSchema.parse(demoSession);
    expect(parsed.id).toBe("demo-voiss-aura-architecture-review");
    expect(
      parsed.claims.find((claim) => claim.id === "claim-gpu")?.status,
    ).toBe("unsupported");
    expect(
      parsed.claims.find((claim) => claim.id === "claim-queue")?.status,
    ).toBe("pending");
    expect(demoClaimActionLinks["claim-queue"]).toBe("action-bound-asr-queue");
    expect(canDelegate(parsed.actions[0])).toBe(false);
    expect(canDelegate(parsed.actions[1])).toBe(true);
    expect(canDelegate(parsed.actions[2])).toBe(false);
    expect(parsed.actions.map((action) => action.workType)).toEqual([
      "engineering",
      "engineering",
      "engineering",
    ]);
    expect(demoAssets.map((asset) => asset.name)).toEqual(
      expect.arrayContaining([
        "AURA application",
        "AURA evidence index",
        "AURA ASR model identity",
        "AURA summary model identity",
        "Codex CLI / app-server",
        "Project AURA",
        "Active Git worktree",
        "CopilotKit runtime",
        "Local AURA and Codex bridges",
      ]),
    );
    expect(demoControls.map((control) => control.id)).toEqual(
      expect.arrayContaining([
        "CTRL-AURA-001",
        "CTRL-EVID-001",
        "CTRL-EVID-002",
        "CTRL-EVID-003",
        "CTRL-CODEX-001",
        "CTRL-CODEX-002",
        "CTRL-CODEX-003",
        "CTRL-CODEX-004",
        "CTRL-AUDIT-001",
        "CTRL-SUPPLY-001",
        "CTRL-REPRO-001",
      ]),
    );
    expect(demoFindings.map((finding) => finding.id)).toEqual(
      expect.arrayContaining([
        "R-001",
        "R-002",
        "R-003",
        "R-004",
        "R-006",
        "R-010",
      ]),
    );
  });

  it("materializes Goal Prompt scenario B with source-backed local-first, queue, and runtime boundaries", () => {
    const parsed = MeetingSessionSchema.parse(demoSession);
    const segments = new Map(
      parsed.segments.map((segment) => [segment.id, segment]),
    );
    const claims = new Map(parsed.claims.map((claim) => [claim.id, claim]));

    expect(demoScenarioBFixture).toMatchObject({
      id: "goal-prompt-scenario-b",
      classification: "deterministic_demo_evidence",
      sourceBoundary: "sanitized_synthetic",
      deterministic: true,
      sessionId: parsed.id,
      occurredAt: parsed.occurredAt,
    });

    const localFirst = claims.get(
      demoScenarioBFixture.localFirstDecision.claimId,
    );
    expect(localFirst).toMatchObject({
      field: "architecture_decision",
      status: "confirmed",
    });
    expect(localFirst?.evidence.map((item) => item.id)).toEqual(
      demoScenarioBFixture.localFirstDecision.sourceSegmentIds,
    );
    expect(segments.get("seg-001")?.text).toContain("local-first");

    const queueSegmentIds = demoScenarioBFixture.queueIssue.sourceSegmentIds;
    const queueClaimIds = demoScenarioBFixture.queueIssue.claimIds;
    expect(new Set(queueSegmentIds).size).toBeGreaterThanOrEqual(2);
    expect(
      queueClaimIds.flatMap(
        (claimId) => claims.get(claimId)?.evidence.map((item) => item.id) ?? [],
      ),
    ).toEqual(expect.arrayContaining([...queueSegmentIds]));
    expect(
      demoControls
        .find((control) => control.id === "CTRL-EVID-001")
        ?.evidence.map((item) => item.id),
    ).toEqual(queueSegmentIds);
    expect(
      demoFindings
        .find((finding) => finding.id === "R-002")
        ?.evidence.map((item) => item.id),
    ).toEqual(queueSegmentIds);
    for (const segmentId of queueSegmentIds) {
      expect(segments.get(segmentId)?.text).toMatch(/佇列|queue/i);
    }

    const gpuVram = claims.get(
      demoScenarioBFixture.gpuVramOpenQuestion.claimId,
    );
    expect(gpuVram).toMatchObject({
      field: "runtime_readiness",
      status: "unsupported",
    });
    expect(gpuVram?.rationale).toMatch(/GPU.*peak VRAM.*尚未提供設備探測證據/);
    expect(gpuVram?.evidence).toEqual([]);
    expect(demoScenarioBFixture.gpuVramOpenQuestion.sourceSegmentIds).toEqual([
      "seg-004",
    ]);
    expect(segments.get("seg-004")?.text).toMatch(/GPU.*peak VRAM/);
  });

  it("keeps the deterministic audio asset explicitly synthetic and privacy-safe", () => {
    expect(demoFixtureAssetMetadata).toMatchObject({
      classification: "synthetic_audio",
      sourceBoundary: "sanitized_synthetic",
      url: demoSession.audioUrl,
      mediaType: "audio/wav",
      durationMs: Math.max(
        ...demoSession.segments.map((segment) => segment.endMs),
      ),
      sampleRateHz: 16_000,
      channels: 1,
      sampleWidthBits: 16,
      generation: "deterministic_tone",
      containsSpeech: false,
      containsPrivateMeetingData: false,
    });
    expect(demoFixtureAssetMetadata.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(
      JSON.stringify({
        scenario: demoScenarioBFixture,
        session: demoSession,
        asset: demoFixtureAssetMetadata,
      }),
    ).not.toMatch(
      /Bearer\s|AURA_BRIDGE_TOKEN|CODEX_BRIDGE_TOKEN|\/home\/|[A-Z]:\\Users\\|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/,
    );
  });
});
