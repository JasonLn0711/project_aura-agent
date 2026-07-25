import {
  ORCHESTRATOR_ACTIVITY_SCHEMA,
  classifyOrchestratorIntent,
  type OrchestratorResolution,
  type OrchestratorResolver,
} from "@voiss/agent-runtime";

type ResolverOptions = {
  baseUrl?: string;
  token?: string;
  readTrust: () => unknown;
  fetchImpl?: typeof fetch;
  now?: () => Date;
};

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const correlationPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const sha256Pattern = /^[a-f0-9]{64}$/;

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const rows = (value: unknown, key: string): Record<string, unknown>[] => {
  const items = record(value)[key];
  return Array.isArray(items) ? items.map(record).slice(0, 100) : [];
};

const text = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value.slice(0, 500) : fallback;

const stringList = (value: unknown): string[] =>
  Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === "string")
        .slice(0, 64)
    : [];

const evidenceLocators = (value: unknown): string[] =>
  Array.isArray(value)
    ? value
        .map(record)
        .map((item) => text(item.locator))
        .filter(Boolean)
        .slice(0, 64)
    : [];

const currentWeek = (value: unknown, now: Date): boolean => {
  const date = new Date(text(value));
  if (Number.isNaN(date.valueOf())) return false;
  const start = new Date(now);
  const day = (start.getDay() + 6) % 7;
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - day);
  const end = new Date(start);
  end.setDate(end.getDate() + 7);
  return date >= start && date < end;
};

export function createLocalOrchestratorResolver(
  options: ResolverOptions,
): OrchestratorResolver {
  const request = options.fetchImpl ?? fetch;
  const base = options.baseUrl?.replace(/\/$/, "");

  return async (input): Promise<OrchestratorResolution> => {
    const intent = classifyOrchestratorIntent(input);
    const state = record(input.state);
    const correlationId = correlationPattern.test(text(state.correlationId))
      ? text(state.correlationId)
      : `orchestrator-${input.runId}`.slice(0, 160);
    const selectedRefs = stringList(state.sourceEvidenceRefs);
    const selectedSession = idPattern.test(text(state.selectedSessionId))
      ? text(state.selectedSessionId)
      : undefined;
    const trust = record(options.readTrust());
    const findings = rows(trust, "findings");
    const controls = rows(trust, "controls");

    const result = (
      summary: string,
      facts: OrchestratorResolution["facts"],
      evidenceRefs: string[],
      nextAction = "先覆核來源證據，再由可信任 Control Room 控制項啟動狀態變更。",
    ): OrchestratorResolution => ({
      schema: ORCHESTRATOR_ACTIVITY_SCHEMA,
      intent,
      mode: "local",
      summary,
      facts: facts.slice(0, 50),
      evidenceRefs: Array.from(new Set(evidenceRefs)).slice(0, 64),
      scopeControls: {
        readOnly: true,
        mutationExecuted: false,
        nextAction,
      },
    });

    const aura = async (path: string): Promise<Record<string, unknown>> => {
      if (!base || !options.token) throw new Error("aura_not_configured");
      const response = await request(`${base}${path}`, {
        headers: {
          authorization: `Bearer ${options.token}`,
          "x-correlation-id": correlationId,
        },
        cache: "no-store",
        signal: AbortSignal.timeout(3_000),
      });
      if (!response.ok) throw new Error(`aura_${response.status}`);
      return record(await response.json());
    };

    const sessionId = async (): Promise<string | undefined> => {
      if (selectedSession) return selectedSession;
      const first = rows(await aura("/v1/sessions?limit=1"), "sessions")[0];
      const value = text(first?.session_id);
      return idPattern.test(value) ? value : undefined;
    };

    if (intent === "codex_diff_review") {
      const review = record(state.codexDiffReview);
      const runId = idPattern.test(text(review.runId))
        ? text(review.runId)
        : "";
      const digest = sha256Pattern.test(text(review.sha256))
        ? text(review.sha256)
        : "";
      if (!runId || review.available !== true) {
        return result(
          "目前沒有可供 orchestrator 檢視的 Codex diff snapshot；唯讀狀態保持不變。",
          [
            { label: "diff_available", value: false },
            { label: "mutation_executed", value: false },
          ],
          selectedRefs,
          "先在 Agent Runs 選取含 Trusted diff 的 run，再重送此唯讀查詢。",
        );
      }
      return result(
        `已檢視 run ${runId} 的目前 Trusted diff 摘要，未套用任何額外變更。`,
        [
          { label: "run_id", value: runId },
          {
            label: "changed_files",
            value: stringList(review.changedFiles).join(", ") || "none",
          },
          {
            label: "additions",
            value: typeof review.additions === "number" ? review.additions : 0,
          },
          {
            label: "deletions",
            value: typeof review.deletions === "number" ? review.deletions : 0,
          },
          { label: "run_status", value: text(review.status, "unknown") },
          { label: "mutation_executed", value: false },
        ],
        [
          digest ? `codex-diff:${runId}/${digest}` : `codex-run:${runId}`,
          ...selectedRefs,
        ],
        "在 Agent Runs 的 Trusted diff 與 Validation 分頁覆核完整內容與 terminal patch hash。",
      );
    }

    if (intent === "consequential_action" || intent === "evidence_export") {
      return result(
        "這項請求已辨識為需要可信任控制項承接的操作；orchestrator 保持唯讀，尚未執行寫入、匯出、核准或部署。",
        [
          { label: "requested_intent", value: intent },
          { label: "mutation_executed", value: false },
          { label: "audit_chain_valid", value: trust.auditChainValid === true },
        ],
        selectedRefs.length > 0 ? selectedRefs : ["trust-snapshot:current"],
        "請在 Agent Runs 檢視目標 run 與差異，再使用具名核准或匯出控制項。",
      );
    }

    try {
      if (intent === "readiness") {
        const health = await aura("/v1/health");
        const failingControls = controls.filter(
          (item) => item.state === "fail",
        );
        return result(
          health.status === "ready"
            ? "AURA 本機服務與目前信任快照已完成即時準備度讀取。"
            : "AURA 本機服務目前需要操作員確認；信任快照仍可供診斷。",
          [
            { label: "aura_status", value: text(health.status, "unknown") },
            {
              label: "artifact_root_ready",
              value: health.artifact_root_ready === true,
            },
            {
              label: "evidence_index_ready",
              value: health.evidence_index_ready === true,
            },
            { label: "audit_ready", value: health.audit_ready === true },
            { label: "failing_control_count", value: failingControls.length },
          ],
          ["aura-health:current", "trust-snapshot:current"],
        );
      }

      if (intent === "unconfirmed_claims") {
        const id = await sessionId();
        if (!id) {
          return result(
            "目前沒有可供主張覆核的 AURA 會議。",
            [{ label: "unconfirmed_claim_count", value: 0 }],
            ["aura-sessions:current"],
          );
        }
        const claims = rows(
          await aura(`/v1/sessions/${encodeURIComponent(id)}/claims`),
          "claims",
        ).filter((item) => item.review_status !== "confirmed");
        return result(
          `會議 ${id} 目前有 ${claims.length} 個尚未確認的主張。`,
          claims.map((claim) => ({
            label: text(claim.claim_id, "unknown-claim"),
            value: `${text(claim.review_status, "unknown")}/${text(claim.support_status, "unknown")}`,
          })),
          claims.map(
            (claim) => `aura-claim:${id}/${text(claim.claim_id, "unknown")}`,
          ),
        );
      }

      if (intent === "unsupported_actions") {
        const actions = rows(await aura("/v1/actions"), "actions").filter(
          (item) =>
            stringList(item.source_segment_ids).length === 0 ||
            item.support_status === "unsupported",
        );
        return result(
          `目前有 ${actions.length} 個 action 缺少可委派的來源支持。`,
          actions.map((action) => ({
            label: text(action.action_id, "unknown-action"),
            value: text(action.task, text(action.support_status, "unknown")),
          })),
          actions.map(
            (action) => `aura-action:${text(action.action_id, "unknown")}`,
          ),
        );
      }

      if (intent === "max_commitments") {
        const [actions, sessions] = await Promise.all([
          aura("/v1/actions").then((value) => rows(value, "actions")),
          aura("/v1/sessions?limit=50").then((value) =>
            rows(value, "sessions"),
          ),
        ]);
        const thisWeek = new Set(
          sessions
            .filter((session) =>
              currentWeek(session.started_at, options.now?.() ?? new Date()),
            )
            .map((session) => text(session.session_id))
            .filter(Boolean),
        );
        const ownerCandidates = actions.filter(
          (action) =>
            text(action.owner).toLocaleLowerCase("zh-TW") === "max" &&
            thisWeek.has(text(action.meeting_id)),
        );
        const matches = ownerCandidates.filter(
          (action) =>
            action.work_type === "engineering" &&
            [
              "proposed",
              "confirmed",
              "delegated",
              "running",
              "open",
              "in_progress",
            ].includes(text(action.completion_status)),
        );
        const missingClassification = ownerCandidates.length - matches.length;
        return result(
          matches.length > 0
            ? `找到 ${matches.length} 個由 Max 在本週來源會議承諾、明確標記為工程且尚未完成的 action。`
            : "目前沒有同時通過 Max、本週來源會議、明確 engineering 類型與未完成狀態四項證據 gate 的 action。",
          [
            { label: "verified_match_count", value: matches.length },
            {
              label: "excluded_missing_classification",
              value: missingClassification,
            },
            ...matches.map((match) => ({
              label: text(match.action_id, "unknown-action"),
              value: text(match.task, text(match.completion_status, "unknown")),
            })),
          ],
          matches.flatMap((match) => [
            `aura-action:${text(match.meeting_id, "unknown")}/${text(match.action_id, "unknown")}`,
            ...stringList(match.source_segment_ids).map(
              (segmentId) =>
                `aura-segment:${text(match.meeting_id, "unknown")}/${segmentId}`,
            ),
          ]),
          "為缺少分類的 candidate 補入來源明確的 work_type 與 completion_status 後重跑查詢。",
        );
      }

      if (intent === "r002_plan") {
        const finding = findings.find((item) => item.id === "R-002");
        const control = controls.find((item) => item.id === finding?.controlId);
        return result(
          "R-002 唯讀計畫以有界容量、明確 overload semantics、持久音訊、provisional 行為、遙測與相關通過測試為驗收契約。",
          [
            { label: "finding_state", value: text(finding?.state, "unknown") },
            { label: "severity", value: text(finding?.severity, "unknown") },
            { label: "control_state", value: text(control?.state, "unknown") },
          ],
          [
            "trust-finding:R-002",
            ...evidenceLocators(finding?.evidence),
            ...selectedRefs,
          ],
        );
      }

      if (intent === "demo_data") {
        const sessions = rows(await aura("/v1/sessions?limit=50"), "sessions");
        return result(
          `本機模式目前可讀取 ${sessions.length} 個 AURA session；固定示範資料可由頂端模式切換啟用。`,
          [{ label: "local_session_count", value: sessions.length }],
          sessions.map(
            (session) => `aura-session:${text(session.session_id, "unknown")}`,
          ),
        );
      }

      const id = await sessionId();
      if (!id) {
        return result(
          "目前沒有可建立委派路徑的 AURA 會議。",
          [{ label: "session_available", value: false }],
          ["aura-sessions:current"],
        );
      }
      const session = await aura(`/v1/sessions/${encodeURIComponent(id)}`);
      return result(
        "已從目前 AURA session 與選取的證據整理唯讀委派路徑。",
        [
          { label: "session_id", value: id },
          { label: "title", value: text(session.title, "untitled") },
          {
            label: "transcript_hash_state",
            value: text(session.transcript_hash_state, "unknown"),
          },
          {
            label: "claim_count",
            value:
              typeof session.claim_count === "number" ? session.claim_count : 0,
          },
        ],
        selectedRefs.length > 0 ? selectedRefs : [`aura-session:${id}`],
      );
    } catch (error) {
      return result(
        "AURA 即時證據目前尚未連線；orchestrator 已保留唯讀狀態，既有信任快照仍可檢視。",
        [
          { label: "aura_read", value: "unavailable" },
          {
            label: "failure_class",
            value:
              error instanceof Error ? error.message.slice(0, 80) : "unknown",
          },
        ],
        ["trust-snapshot:current"],
        "確認本機 AURA bridge 設定後重試相同唯讀查詢。",
      );
    }
  };
}
