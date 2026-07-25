import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { sanitizeForEvent } from "./sanitize.ts";

export const OBSERVABILITY_LOG_MAX_BYTES = 5 * 1024 * 1024;
const OBSERVABILITY_LOG_FILES = 2;
const LOG_EVENT_MAX_BYTES = 4 * 1024;

type DurationMetric = {
  count: number;
  totalMs: number;
  maxMs: number;
  lastMs: number;
};

export type CodexObservabilitySnapshot = {
  activeRuns: number;
  runCount: number;
  runCompletedCount: number;
  runFailedCount: number;
  runInterruptedCount: number;
  runDurationMs: DurationMetric;
  approvalWaitMs: DurationMetric;
  bridgeReconnectCount: number;
  commandCount: number;
  fileChangeCount: number;
  validationPassCount: number;
  validationFailCount: number;
  sseDisconnectCount: number;
  logWriteFailureCount: number;
  retention: {
    maxBytesPerFile: number;
    fileCount: typeof OBSERVABILITY_LOG_FILES;
  };
};

export class CodexObservability {
  readonly #path: string;
  readonly #previousPath: string;
  readonly #maxBytes: number;
  readonly #runStartedAt = new Map<string, number>();
  readonly #approvalStartedAt = new Map<string, number>();
  readonly #runDurationMs = durationMetric();
  readonly #approvalWaitMs = durationMetric();
  #runCount = 0;
  #runCompletedCount = 0;
  #runFailedCount = 0;
  #runInterruptedCount = 0;
  #commandCount = 0;
  #fileChangeCount = 0;
  #validationPassCount = 0;
  #validationFailCount = 0;
  #sseDisconnectCount = 0;
  #logWriteFailureCount = 0;

  constructor(
    path = join(
      homedir(),
      ".voiss-aura",
      "observability",
      "codex-bridge.jsonl",
    ),
    maxBytes = OBSERVABILITY_LOG_MAX_BYTES,
  ) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < LOG_EVENT_MAX_BYTES) {
      throw new Error("Observability retention must be at least 4096 bytes.");
    }
    this.#path = path;
    this.#previousPath = `${path}.1`;
    this.#maxBytes = maxBytes;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try {
      chmodSync(dirname(path), 0o700);
    } catch {
      // Best effort on platforms without POSIX modes.
    }
  }

  runStarted(runId: string, correlationId: string): void {
    this.#runStartedAt.set(runId, Date.now());
    this.#record("run.started", correlationId, { runId });
  }

  runFinished(
    runId: string,
    correlationId: string,
    status: "completed" | "interrupted" | "failed" | "blocked",
  ): void {
    const startedAt = this.#runStartedAt.get(runId);
    this.#runStartedAt.delete(runId);
    this.#runCount += 1;
    if (status === "completed") this.#runCompletedCount += 1;
    else if (status === "interrupted") this.#runInterruptedCount += 1;
    else this.#runFailedCount += 1;
    const durationMs = startedAt === undefined ? 0 : Date.now() - startedAt;
    observeDuration(this.#runDurationMs, durationMs);
    this.#record("run.finished", correlationId, {
      runId,
      status,
      durationMs,
    });
  }

  approvalRequested(approvalId: string, correlationId: string): void {
    this.#approvalStartedAt.set(approvalId, Date.now());
    this.#record("approval.requested", correlationId, { approvalId });
  }

  approvalResolved(
    approvalId: string,
    correlationId: string,
    outcome: string,
  ): void {
    const startedAt = this.#approvalStartedAt.get(approvalId);
    if (startedAt === undefined) return;
    this.#approvalStartedAt.delete(approvalId);
    const waitMs = Date.now() - startedAt;
    observeDuration(this.#approvalWaitMs, waitMs);
    this.#record("approval.resolved", correlationId, {
      approvalId,
      outcome,
      waitMs,
    });
  }

  command(correlationId: string): void {
    this.#commandCount += 1;
    this.#record("command.completed", correlationId);
  }

  fileChange(correlationId: string): void {
    this.#fileChangeCount += 1;
    this.#record("file_change.completed", correlationId);
  }

  validation(correlationId: string, passed: number, failed: number): void {
    this.#validationPassCount += passed;
    this.#validationFailCount += failed;
    if (passed || failed) {
      this.#record("validation.observed", correlationId, { passed, failed });
    }
  }

  sseDisconnected(correlationId: string, runId: string): void {
    this.#sseDisconnectCount += 1;
    this.#record("sse.disconnected", correlationId, { runId });
  }

  record(
    event: string,
    correlationId: string,
    detail: Record<string, unknown> = {},
  ): void {
    this.#record(event, correlationId, detail);
  }

  snapshot(
    activeRuns: number,
    bridgeReconnectCount: number,
  ): CodexObservabilitySnapshot {
    return {
      activeRuns,
      runCount: this.#runCount,
      runCompletedCount: this.#runCompletedCount,
      runFailedCount: this.#runFailedCount,
      runInterruptedCount: this.#runInterruptedCount,
      runDurationMs: { ...this.#runDurationMs },
      approvalWaitMs: { ...this.#approvalWaitMs },
      bridgeReconnectCount,
      commandCount: this.#commandCount,
      fileChangeCount: this.#fileChangeCount,
      validationPassCount: this.#validationPassCount,
      validationFailCount: this.#validationFailCount,
      sseDisconnectCount: this.#sseDisconnectCount,
      logWriteFailureCount: this.#logWriteFailureCount,
      retention: {
        maxBytesPerFile: this.#maxBytes,
        fileCount: OBSERVABILITY_LOG_FILES,
      },
    };
  }

  #record(
    event: string,
    correlationId: string,
    detail: Record<string, unknown> = {},
  ): void {
    const sanitized = sanitizeForEvent(
      {
        timestamp: new Date().toISOString(),
        component: "codex-bridge",
        event,
        correlationId,
        detail,
      },
      LOG_EVENT_MAX_BYTES,
    );
    const line = `${JSON.stringify(sanitized)}\n`;
    try {
      if (
        existsSync(this.#path) &&
        statSync(this.#path).size + Buffer.byteLength(line) > this.#maxBytes
      ) {
        rmSync(this.#previousPath, { force: true });
        renameSync(this.#path, this.#previousPath);
      }
      appendFileSync(this.#path, line, { encoding: "utf8", mode: 0o600 });
      try {
        chmodSync(this.#path, 0o600);
      } catch {
        // Best effort on platforms without POSIX modes.
      }
    } catch {
      this.#logWriteFailureCount += 1;
    }
  }
}

function durationMetric(): DurationMetric {
  return { count: 0, totalMs: 0, maxMs: 0, lastMs: 0 };
}

function observeDuration(metric: DurationMetric, durationMs: number): void {
  const bounded = Math.max(0, Math.round(durationMs));
  metric.count += 1;
  metric.totalMs += bounded;
  metric.maxMs = Math.max(metric.maxMs, bounded);
  metric.lastMs = bounded;
}
