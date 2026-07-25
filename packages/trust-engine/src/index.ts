import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  AuditEvent,
  EvidenceRef,
  Finding,
  TrustAsset,
  TrustControl,
} from "@voiss/domain";

const ZERO_HASH = "0".repeat(64);
const SHA256 = /^[a-f0-9]{64}$/;

export const R002_CLOSURE_CHECKS = [
  "boundedQueue",
  "overloadSemantics",
  "durableAudioPreservation",
  "provisionalDataBehavior",
  "telemetry",
  "relevantValidation",
] as const;

export type R002ClosureCheck = (typeof R002_CLOSURE_CHECKS)[number];

export type R002ClosureProof = {
  correlationId: string;
  runId: string;
  outcome: "passed";
  evidence: EvidenceRef & { sha256: string };
};

export type R002ApprovalProof = {
  correlationId: string;
  runId: string;
  decision: "allow_once" | "allow_run_scope";
  evidence: EvidenceRef & { sha256: string };
};

export type R002ClosureInput = {
  correlationId: string;
  runId: string;
  occurredAt?: string;
  approval: R002ApprovalProof;
  checks: Record<R002ClosureCheck, R002ClosureProof>;
};

export type ClaimReviewGateInput = {
  correlationId: string;
  sessionId: string;
  claimId: string;
  outcome: "confirmed" | "blocked";
  sourceComplete?: boolean;
  supported?: boolean;
  fresh?: boolean;
  occurredAt?: string;
};

export const METADATA_TABLES = [
  "workspaces",
  "repositories",
  "aura_sessions_cache",
  "actions",
  "agent_runs",
  "codex_threads",
  "run_events",
  "approvals",
  "validation_results",
  "assets",
  "controls",
  "control_results",
  "findings",
  "remediations",
  "audit_events",
  "exports",
] as const;

export type MetadataTable = Exclude<
  (typeof METADATA_TABLES)[number],
  "audit_events"
>;

type MetadataStatements = {
  upsert: string;
  get: string;
  list: string;
  delete: string;
};

const METADATA_STATEMENTS = Object.fromEntries(
  METADATA_TABLES.filter(
    (table): table is MetadataTable => table !== "audit_events",
  ).map((table) => [
    table,
    {
      upsert: `
        INSERT INTO ${table} (id, payload) VALUES (?, ?)
        ON CONFLICT(id) DO UPDATE SET payload = excluded.payload
      `,
      get: `SELECT payload FROM ${table} WHERE id = ?`,
      list: `SELECT payload FROM ${table} ORDER BY id`,
      delete: `DELETE FROM ${table} WHERE id = ?`,
    },
  ]),
) as Record<MetadataTable, MetadataStatements>;

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

export class TrustStore {
  readonly database: DatabaseSync;

  constructor(path = ":memory:") {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      try {
        chmodSync(dirname(path), 0o700);
      } catch {
        // Owner-only permissions are best-effort on platforms without POSIX modes.
      }
    }
    this.database = new DatabaseSync(path, { timeout: 5_000 });
    if (path !== ":memory:") {
      try {
        chmodSync(path, 0o600);
      } catch {
        // Owner-only permissions are best-effort on platforms without POSIX modes.
      }
    }
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS repositories (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS aura_sessions_cache (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS actions (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS agent_runs (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS codex_threads (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS run_events (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS approvals (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS validation_results (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS assets (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS controls (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS control_results (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS findings (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS remediations (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS exports (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS audit_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT UNIQUE NOT NULL,
        correlation_id TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        payload TEXT NOT NULL,
        previous_hash TEXT NOT NULL,
        hash TEXT UNIQUE NOT NULL
      );
    `);
  }

  upsertMetadata(table: MetadataTable, id: string, payload: unknown): void {
    const serialized = JSON.stringify(payload);
    if (serialized === undefined) {
      throw new TypeError("Metadata payload must be JSON serializable.");
    }
    this.database.prepare(metadataStatements(table).upsert).run(id, serialized);
  }

  getMetadata<T = unknown>(table: MetadataTable, id: string): T | undefined {
    const row = this.database.prepare(metadataStatements(table).get).get(id) as
      { payload: string } | undefined;
    return row === undefined
      ? undefined
      : (JSON.parse(String(row.payload)) as T);
  }

  listMetadata<T = unknown>(table: MetadataTable): T[] {
    return this.database
      .prepare(metadataStatements(table).list)
      .all()
      .map(
        (row) => JSON.parse(String((row as { payload: string }).payload)) as T,
      );
  }

  deleteMetadata(table: MetadataTable, id: string): boolean {
    const result = this.database
      .prepare(metadataStatements(table).delete)
      .run(id);
    return Number(result.changes) > 0;
  }

  upsertAsset(asset: TrustAsset): void {
    this.upsertMetadata("assets", asset.id, asset);
  }

  upsertControl(control: TrustControl): void {
    this.upsertMetadata("controls", control.id, control);
  }

  upsertFinding(finding: Finding): void {
    this.upsertMetadata("findings", finding.id, finding);
  }

  list<T>(table: "assets" | "controls" | "findings"): T[] {
    return this.listMetadata<T>(table);
  }

  appendAudit(
    input: Omit<AuditEvent, "id" | "sequence" | "previousHash" | "hash">,
  ): AuditEvent {
    const previous = this.database
      .prepare(
        "SELECT sequence, hash FROM audit_events ORDER BY sequence DESC LIMIT 1",
      )
      .get() as { sequence: number; hash: string } | undefined;
    const sequence = (previous?.sequence ?? 0) + 1;
    const previousHash = previous?.hash ?? ZERO_HASH;
    const base = {
      id: randomUUID(),
      correlationId: input.correlationId,
      sequence,
      occurredAt: input.occurredAt,
      actor: input.actor,
      action: input.action,
      subject: input.subject,
      detail: redact(input.detail) as Record<string, unknown>,
      previousHash,
    };
    const event: AuditEvent = {
      ...base,
      hash: createHash("sha256").update(canonicalJson(base)).digest("hex"),
    };
    this.database
      .prepare(
        `
      INSERT INTO audit_events
        (sequence, id, correlation_id, occurred_at, payload, previous_hash, hash)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        sequence,
        event.id,
        event.correlationId,
        event.occurredAt,
        JSON.stringify(event),
        previousHash,
        event.hash,
      );
    return event;
  }

  auditTimeline(correlationId?: string): AuditEvent[] {
    const rows = correlationId
      ? this.database
          .prepare(
            "SELECT payload FROM audit_events WHERE correlation_id = ? ORDER BY sequence",
          )
          .all(correlationId)
      : this.database
          .prepare("SELECT payload FROM audit_events ORDER BY sequence")
          .all();
    return rows.map(
      (row) =>
        JSON.parse(String((row as { payload: string }).payload)) as AuditEvent,
    );
  }

  verifyAuditChain(): boolean {
    let previousHash = ZERO_HASH;
    for (const event of this.auditTimeline()) {
      const { hash, ...base } = event;
      if (event.previousHash !== previousHash) return false;
      if (
        createHash("sha256").update(canonicalJson(base)).digest("hex") !== hash
      )
        return false;
      previousHash = hash;
    }
    return true;
  }

  recordValidatedExport(
    correlationId: string,
    runId: string,
    occurredAt = new Date().toISOString(),
  ): void {
    const runEvidence = [
      {
        id: runId,
        kind: "run" as const,
        locator: `codex-run:${runId}`,
      },
    ];
    this.upsertControl({
      id: "CTRL-CODEX-002",
      title: "Worktree isolation",
      state: "pass",
      checkedAt: occurredAt,
      evidence: runEvidence,
    });
    this.upsertControl({
      id: "CTRL-CODEX-003",
      title: "Default network denial",
      state: "pass",
      checkedAt: occurredAt,
      evidence: runEvidence,
    });
    const timeline = this.auditTimeline(correlationId);
    const approval = timeline.find(
      (event) =>
        ["approval.allow_once", "approval.allow_run_scope"].includes(
          event.action,
        ) && event.subject === runId,
    );
    const approvalEvidence = approval
      ? [
          {
            id: approval.id,
            kind: "control" as const,
            locator: `audit:${approval.id}`,
            sha256: approval.hash,
          },
        ]
      : [];
    const auditValid = this.verifyAuditChain();
    this.upsertControl({
      id: "CTRL-CODEX-004",
      title: "Consequential action approval",
      state: approval ? "pass" : "fail",
      checkedAt: occurredAt,
      evidence: approvalEvidence,
    });
    this.upsertControl({
      id: "CTRL-AUDIT-001",
      title: "Audit chain continuity",
      state: auditValid ? "pass" : "fail",
      checkedAt: occurredAt,
      evidence: timeline.slice(-1).map((event) => ({
        id: event.id,
        kind: "control" as const,
        locator: `audit:${event.id}`,
        sha256: event.hash,
      })),
    });
    const finding = this.list<Finding>("findings").find(
      (item) => item.id === "R-002",
    );
    this.appendAudit({
      correlationId,
      occurredAt,
      actor: "codex-bridge",
      action: "evidence.exported",
      subject: runId,
      detail: {
        classification: "generic_validated_export",
        findingId: "R-002",
        state: finding?.state ?? "open",
        r002ClosureEligible: false,
        closureControls: {
          approvalBoundToRun: Boolean(approval),
          auditChain: auditValid,
          specificEvidenceComplete: false,
        },
      },
    });
  }

  recordClaimReviewGate(input: ClaimReviewGateInput): void {
    const occurredAt = input.occurredAt ?? new Date().toISOString();
    const evidence = [
      {
        id: input.claimId,
        kind: "claim" as const,
        locator: `aura-claim:${input.sessionId}/${input.claimId}`,
      },
    ];
    this.upsertControl({
      id: "CTRL-EVID-002",
      title: "Unsupported claim gate",
      state:
        input.outcome === "blocked" || input.supported === true
          ? "pass"
          : "fail",
      checkedAt: occurredAt,
      evidence,
    });
    if (input.outcome === "confirmed") {
      this.upsertControl({
        id: "CTRL-EVID-001",
        title: "Claim source completeness",
        state: input.sourceComplete === true ? "pass" : "fail",
        checkedAt: occurredAt,
        evidence,
      });
      this.upsertControl({
        id: "CTRL-EVID-003",
        title: "Transcript-summary freshness",
        state: input.fresh === true ? "pass" : "fail",
        checkedAt: occurredAt,
        evidence,
      });
    }
    this.appendAudit({
      correlationId: input.correlationId,
      occurredAt,
      actor: "trust-engine",
      action:
        input.outcome === "blocked"
          ? "claim.confirmation_gate.blocked"
          : "claim.confirmation_gate.passed",
      subject: input.claimId,
      detail: {
        sessionId: input.sessionId,
        sourceComplete: input.sourceComplete ?? "not_evaluated",
        supported: input.supported ?? "not_evaluated",
        fresh: input.fresh ?? "not_evaluated",
      },
    });
  }

  /**
   * Fail-closed R-002 transition.
   *
   * Callers construct the typed proof bundle from authoritative bridge/export
   * evidence. Operator intent and a generic validated export remain evidence,
   * but neither can mitigate R-002 without this complete, run-bound bundle.
   */
  recordR002Closure(input: R002ClosureInput): boolean {
    const occurredAt = input.occurredAt ?? new Date().toISOString();
    const timeline = this.auditTimeline(input.correlationId);
    const approvalProofValid = validBoundEvidence(
      input.approval,
      input.correlationId,
      input.runId,
    );
    const approval = timeline.find(
      (event) =>
        event.action === `approval.${input.approval?.decision}` &&
        event.subject === input.runId,
    );
    const validatedExport = timeline.find(
      (event) =>
        event.action === "evidence.exported" &&
        event.subject === input.runId &&
        event.detail.classification === "generic_validated_export",
    );
    const approvalPrecedesExport = Boolean(
      approval &&
      validatedExport &&
      approval.sequence < validatedExport.sequence,
    );
    const checkResults = Object.fromEntries(
      R002_CLOSURE_CHECKS.map((check) => [
        check,
        validR002Proof(input.checks?.[check], input.correlationId, input.runId),
      ]),
    ) as Record<R002ClosureCheck, boolean>;
    const specificEvidenceComplete = R002_CLOSURE_CHECKS.every(
      (check) => checkResults[check],
    );
    const auditValid = this.verifyAuditChain();
    const finding = this.list<Finding>("findings").find(
      (item) => item.id === "R-002",
    );
    const closureReady = Boolean(
      finding &&
      approval &&
      validatedExport &&
      approvalPrecedesExport &&
      approvalProofValid &&
      auditValid &&
      specificEvidenceComplete,
    );

    if (finding && closureReady) {
      const closureEvidence = [
        {
          id: approval!.id,
          kind: "control" as const,
          locator: `audit:${approval!.id}`,
          sha256: approval!.hash,
        },
        {
          id: validatedExport!.id,
          kind: "control" as const,
          locator: `audit:${validatedExport!.id}`,
          sha256: validatedExport!.hash,
        },
        input.approval.evidence,
        ...R002_CLOSURE_CHECKS.map((check) => input.checks[check].evidence),
      ];
      this.upsertFinding({
        ...finding,
        state: "remediated",
        evidence: uniqueEvidence([...finding.evidence, ...closureEvidence]),
      });
    }

    this.appendAudit({
      correlationId: input.correlationId,
      occurredAt,
      actor: "trust-engine",
      action: "finding.r002.closure_evaluated",
      subject: input.runId,
      detail: {
        findingId: "R-002",
        state: closureReady ? "remediated" : (finding?.state ?? "open"),
        closureControls: {
          approvalBoundToRun: Boolean(approval),
          approvalProofValid,
          approvalPrecedesExport,
          validatedExportBoundToRun: Boolean(validatedExport),
          auditChain: auditValid,
          ...checkResults,
        },
      },
    });
    return closureReady;
  }

  close(): void {
    this.database.close();
  }
}

function metadataStatements(table: MetadataTable): MetadataStatements {
  const statements = METADATA_STATEMENTS[table];
  if (!statements) throw new TypeError("Unsupported metadata table.");
  return statements;
}

function validR002Proof(
  proof: R002ClosureProof | undefined,
  correlationId: string,
  runId: string,
): boolean {
  if (!proof || proof.outcome !== "passed") return false;
  return validBoundEvidence(proof, correlationId, runId);
}

function validBoundEvidence(
  proof:
    | {
        correlationId: string;
        runId: string;
        evidence: EvidenceRef & { sha256: string };
      }
    | undefined,
  correlationId: string,
  runId: string,
): boolean {
  if (
    !proof ||
    !proof.evidence ||
    proof.correlationId !== correlationId ||
    proof.runId !== runId
  ) {
    return false;
  }
  return Boolean(
    proof.evidence.id.trim() &&
    proof.evidence.locator.trim() &&
    SHA256.test(proof.evidence.sha256),
  );
}

function uniqueEvidence(evidence: EvidenceRef[]): EvidenceRef[] {
  const seen = new Set<string>();
  return evidence.filter((item) => {
    const key = [
      item.kind,
      item.id,
      item.locator,
      item.sha256 ?? "",
      item.startMs ?? "",
      item.endMs ?? "",
    ].join(":");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== "object") {
    if (typeof value !== "string") return value;
    return value
      .replace(/\b(sk-[A-Za-z0-9_-]{12,})\b/g, "[REDACTED_TOKEN]")
      .replace(
        /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
        "[REDACTED_EMAIL]",
      );
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      /(token|secret|password|authorization|cookie)/i.test(key)
        ? "[REDACTED]"
        : redact(item),
    ]),
  );
}
