import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  EvidenceRef,
  Finding,
  TrustAsset,
  TrustControl,
} from "@voiss/domain";
import {
  METADATA_TABLES,
  R002_CLOSURE_CHECKS,
  TrustStore,
  type R002ClosureInput,
} from "../src/index";

const directories: string[] = [];
afterEach(() =>
  directories.splice(0).forEach((path) => rmSync(path, { recursive: true })),
);

describe("TrustStore", () => {
  const proof = (
    check: string,
    correlationId = "corr-approved",
    runId = "run-approved",
  ) => ({
    correlationId,
    runId,
    outcome: "passed" as const,
    evidence: {
      id: `evidence-${check}`,
      kind: "artifact" as const,
      locator: `artifact:${runId}:${check}`,
      sha256: "a".repeat(64),
    },
  });

  const closureInput = (
    correlationId = "corr-approved",
    runId = "run-approved",
  ): R002ClosureInput => ({
    correlationId,
    runId,
    occurredAt: "2026-07-24T06:05:00.000Z",
    approval: {
      correlationId,
      runId,
      decision: "allow_run_scope",
      evidence: {
        id: "evidence-approval",
        kind: "artifact",
        locator: `artifact:${runId}:approval`,
        sha256: "b".repeat(64),
      },
    },
    checks: {
      boundedQueue: proof("bounded-queue", correlationId, runId),
      overloadSemantics: proof("overload-semantics", correlationId, runId),
      durableAudioPreservation: proof("durable-audio", correlationId, runId),
      provisionalDataBehavior: proof("provisional-data", correlationId, runId),
      telemetry: proof("telemetry", correlationId, runId),
      relevantValidation: proof("relevant-validation", correlationId, runId),
    },
  });

  const seedR002 = (store: TrustStore) =>
    store.upsertFinding({
      id: "R-002",
      title: "Bound the ASR queue",
      severity: "high",
      state: "open",
      controlId: "CTRL-EVID-001",
      evidence: [],
    });

  it("creates the complete MVP metadata schema", () => {
    const store = new TrustStore();
    const tables = store.database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => String((row as { name: string }).name));

    expect(tables).toEqual(expect.arrayContaining([...METADATA_TABLES]));
    store.close();
  });

  it("waits for a concurrent writer instead of failing immediately", () => {
    const store = new TrustStore();

    expect(store.database.prepare("PRAGMA busy_timeout").get()).toEqual({
      timeout: 5_000,
    });
    store.close();
  });

  it("persists and updates agent run metadata across store reopen", () => {
    const directory = mkdtempSync(join(tmpdir(), "voiss-trust-"));
    directories.push(directory);
    const databasePath = join(directory, "control-plane.sqlite");
    const started = {
      runId: "run-1",
      threadId: "thread-1",
      status: "running",
      startedAt: "2026-07-24T07:00:00.000Z",
    };
    const first = new TrustStore(databasePath);

    first.upsertMetadata("agent_runs", started.runId, started);
    first.close();

    const reopened = new TrustStore(databasePath);
    expect(
      reopened.getMetadata<typeof started>("agent_runs", started.runId),
    ).toEqual(started);
    const completed = {
      ...started,
      status: "completed",
      endedAt: "2026-07-24T07:05:00.000Z",
    };
    reopened.upsertMetadata("agent_runs", completed.runId, completed);
    expect(reopened.listMetadata<typeof completed>("agent_runs")).toEqual([
      completed,
    ]);
    reopened.close();

    const afterUpdate = new TrustStore(databasePath);
    expect(
      afterUpdate.getMetadata<typeof completed>("agent_runs", completed.runId),
    ).toEqual(completed);
    afterUpdate.close();
  });

  it("persists codex thread deletion across store reopen", () => {
    const directory = mkdtempSync(join(tmpdir(), "voiss-trust-"));
    directories.push(directory);
    const databasePath = join(directory, "control-plane.sqlite");
    const thread = {
      threadId: "thread-delete",
      repository: "/srv/project-aura",
      status: "active",
    };
    const first = new TrustStore(databasePath);
    first.upsertMetadata("codex_threads", thread.threadId, thread);
    first.close();

    const reopened = new TrustStore(databasePath);
    expect(
      reopened.getMetadata<typeof thread>("codex_threads", thread.threadId),
    ).toEqual(thread);
    expect(reopened.deleteMetadata("codex_threads", thread.threadId)).toBe(
      true,
    );
    expect(reopened.deleteMetadata("codex_threads", thread.threadId)).toBe(
      false,
    );
    reopened.close();

    const afterDelete = new TrustStore(databasePath);
    expect(
      afterDelete.getMetadata("codex_threads", thread.threadId),
    ).toBeUndefined();
    expect(afterDelete.listMetadata("codex_threads")).toEqual([]);
    afterDelete.close();
  });

  it("keeps asset, control, and finding convenience APIs compatible", () => {
    const store = new TrustStore();
    const asset: TrustAsset = {
      id: "asset-repo",
      kind: "repository",
      name: "Project AURA",
      state: "ready",
      evidence: [],
    };
    const control: TrustControl = {
      id: "CTRL-LOCAL-001",
      title: "Local evidence boundary",
      state: "pass",
      evidence: [],
    };
    const finding: Finding = {
      id: "F-LOCAL-001",
      title: "Local evidence is ready",
      severity: "low",
      state: "remediated",
      controlId: control.id,
      evidence: [],
    };

    store.upsertAsset(asset);
    store.upsertControl(control);
    store.upsertFinding(finding);

    expect(store.list<typeof asset>("assets")).toEqual([asset]);
    expect(store.list<typeof control>("controls")).toEqual([control]);
    expect(store.list<typeof finding>("findings")).toEqual([finding]);
    store.close();
  });

  it("persists a redacted, verifiable append-only audit chain", () => {
    const directory = mkdtempSync(join(tmpdir(), "voiss-trust-"));
    directories.push(directory);
    const store = new TrustStore(join(directory, "control-plane.sqlite"));
    const first = store.appendAudit({
      correlationId: "corr-1",
      occurredAt: "2026-07-24T06:00:00.000Z",
      actor: "operator",
      action: "claim.confirm",
      subject: "claim-queue",
      detail: { authorization: "Bearer secret", note: "owner@example.com" },
    });
    const second = store.appendAudit({
      correlationId: "corr-1",
      occurredAt: "2026-07-24T06:01:00.000Z",
      actor: "codex-bridge",
      action: "run.plan",
      subject: "run-1",
      detail: { status: "completed" },
    });

    expect(second.previousHash).toBe(first.hash);
    expect(store.auditTimeline()[0].detail).toEqual({
      authorization: "[REDACTED]",
      note: "[REDACTED_EMAIL]",
    });
    expect(store.verifyAuditChain()).toBe(true);
    store.close();
  });

  it("records source, support, and freshness controls from a validated claim confirmation", () => {
    const store = new TrustStore();
    store.recordClaimReviewGate({
      correlationId: "corr-claim",
      sessionId: "meeting-1",
      claimId: "claim-1",
      outcome: "confirmed",
      sourceComplete: true,
      supported: true,
      fresh: true,
      occurredAt: "2026-07-24T05:00:00.000Z",
    });

    expect(store.list<{ id: string; state: string }>("controls")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "CTRL-EVID-001", state: "pass" }),
        expect.objectContaining({ id: "CTRL-EVID-002", state: "pass" }),
        expect.objectContaining({ id: "CTRL-EVID-003", state: "pass" }),
      ]),
    );
    expect(store.auditTimeline("corr-claim").at(-1)?.action).toBe(
      "claim.confirmation_gate.passed",
    );
    store.close();
  });

  it("records a rejected confirmation as evidence that the claim gate held", () => {
    const store = new TrustStore();
    store.recordClaimReviewGate({
      correlationId: "corr-blocked",
      sessionId: "meeting-1",
      claimId: "claim-unsupported",
      outcome: "blocked",
      occurredAt: "2026-07-24T05:01:00.000Z",
    });

    expect(
      store
        .list<{ id: string; state: string }>("controls")
        .find((control) => control.id === "CTRL-EVID-002")?.state,
    ).toBe("pass");
    expect(store.auditTimeline("corr-blocked").at(-1)?.action).toBe(
      "claim.confirmation_gate.blocked",
    );
    store.close();
  });

  it("keeps R-002 open after a generic validated export", () => {
    const store = new TrustStore();
    seedR002(store);

    store.appendAudit({
      correlationId: "corr-approved",
      occurredAt: "2026-07-24T06:01:00.000Z",
      actor: "operator",
      action: "approval.allow_once",
      subject: "run-approved",
      detail: { scope: "isolated_workspace_write" },
    });
    store.recordValidatedExport(
      "corr-approved",
      "run-approved",
      "2026-07-24T06:02:00.000Z",
    );

    expect(
      store.list<{ id: string; state: string }>("findings")[0]?.state,
    ).toBe("open");
    expect(store.auditTimeline("corr-approved").at(-1)?.detail).toMatchObject({
      classification: "generic_validated_export",
      r002ClosureEligible: false,
    });
    store.close();
  });

  it("rejects R-002 closure when approval belongs to another run", () => {
    const store = new TrustStore();
    seedR002(store);

    store.appendAudit({
      correlationId: "corr-approved",
      occurredAt: "2026-07-24T06:01:00.000Z",
      actor: "operator",
      action: "approval.allow_run_scope",
      subject: "run-unrelated",
      detail: { scope: "isolated_workspace_write" },
    });
    store.recordValidatedExport(
      "corr-approved",
      "run-approved",
      "2026-07-24T06:02:00.000Z",
    );

    expect(store.recordR002Closure(closureInput())).toBe(false);
    expect(
      store.list<{ id: string; state: string }>("findings")[0]?.state,
    ).toBe("open");
    expect(store.auditTimeline("corr-approved").at(-1)?.detail).toMatchObject({
      closureControls: {
        approvalBoundToRun: false,
        validatedExportBoundToRun: true,
      },
    });
    store.close();
  });

  it("rejects R-002 closure when any required proof is missing", () => {
    const store = new TrustStore();
    seedR002(store);
    store.appendAudit({
      correlationId: "corr-approved",
      occurredAt: "2026-07-24T06:01:00.000Z",
      actor: "operator",
      action: "approval.allow_run_scope",
      subject: "run-approved",
      detail: { scope: "isolated_workspace_write" },
    });
    store.recordValidatedExport(
      "corr-approved",
      "run-approved",
      "2026-07-24T06:02:00.000Z",
    );
    const complete = closureInput();
    const { telemetry: _telemetry, ...incompleteChecks } = complete.checks;
    const incomplete = {
      ...complete,
      checks: incompleteChecks,
    } as unknown as R002ClosureInput;

    expect(store.recordR002Closure(incomplete as R002ClosureInput)).toBe(false);
    expect(
      store.list<{ id: string; state: string }>("findings")[0]?.state,
    ).toBe("open");
    expect(store.auditTimeline("corr-approved").at(-1)?.detail).toMatchObject({
      closureControls: { telemetry: false },
    });
    store.close();
  });

  it("remediates R-002 only with fully bound, SHA-backed evidence", () => {
    const store = new TrustStore();
    seedR002(store);
    store.appendAudit({
      correlationId: "corr-approved",
      occurredAt: "2026-07-24T06:01:00.000Z",
      actor: "operator",
      action: "approval.allow_run_scope",
      subject: "run-approved",
      detail: { scope: "isolated_workspace_write" },
    });
    store.recordValidatedExport(
      "corr-approved",
      "run-approved",
      "2026-07-24T06:02:00.000Z",
    );

    expect(store.recordR002Closure(closureInput())).toBe(true);
    const finding = store.list<{
      id: string;
      state: string;
      evidence: EvidenceRef[];
    }>("findings")[0];
    expect(finding?.state).toBe("remediated");
    expect(finding?.evidence).toHaveLength(9);
    expect(finding?.evidence.map((item) => item.id)).toEqual(
      expect.arrayContaining([
        closureInput().approval.evidence.id,
        ...R002_CLOSURE_CHECKS.map(
          (check) => closureInput().checks[check].evidence.id,
        ),
      ]),
    );
    expect(store.verifyAuditChain()).toBe(true);
    store.close();
  });

  it("keeps generic export control evidence bound to the exact run approval", () => {
    const store = new TrustStore();
    seedR002(store);

    store.recordValidatedExport(
      "corr-no-approval",
      "run-no-approval",
      "2026-07-24T06:02:00.000Z",
    );
    expect(
      store
        .list<{ id: string; state: string }>("controls")
        .find((control) => control.id === "CTRL-CODEX-004")?.state,
    ).toBe("fail");

    store.appendAudit({
      correlationId: "corr-approved",
      occurredAt: "2026-07-24T06:03:00.000Z",
      actor: "operator",
      action: "approval.allow_once",
      subject: "run-unrelated",
      detail: { scope: "isolated_workspace_write" },
    });
    store.recordValidatedExport(
      "corr-approved",
      "run-approved",
      "2026-07-24T06:04:00.000Z",
    );
    expect(
      store
        .list<{ id: string; state: string }>("controls")
        .find((control) => control.id === "CTRL-CODEX-004")?.state,
    ).toBe("fail");
    expect(
      store.list<{ id: string; state: string }>("findings")[0]?.state,
    ).toBe("open");
    expect(store.verifyAuditChain()).toBe(true);
    store.close();
  });
});
