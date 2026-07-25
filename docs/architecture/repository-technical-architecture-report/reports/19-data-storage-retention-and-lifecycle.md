# 19 Data Storage, Retention, and Lifecycle

## Report control

| Field | Value |
|---|---|
| Status | `Partially Verified` |
| Product milestone | `LOCAL_E2E_VALIDATED` |
| Scoped live run status | `LIVE_MINIMUM_COMPLETED` |
| Source baseline | `6807f516d1083051d75373f110ac871f677f75ce` |
| Baseline role | Source lineage only; it is not live MVP proof |
| Current evidence | Uncommitted source and retained-validation snapshot `c5ccf5b8e02e3c73b5c3db7d44f66d80ec430cf3f50ddcfc4bf9327b794fc772` |
| Artifact timestamp | `2026-07-25T00:00:00Z` (normalized; not a wall-clock runtime observation) |

## Architecture finding

Canonical meeting evidence、control metadata、CopilotKit runner history、Codex lifecycle、audit、worktree與export各有獨立owner和locator；資料生命週期採local stewardship，retention與cleanup仍需release policy。

AURA artifact tree保存音訊、transcript、summary與reviewed evidence；evidence SQLite支援search。VOISS control-plane SQLite已active wiring保存assets、controls、findings與hash-chain audit events，以及workspaces、repositories、actions、agent runs、Codex threads、bounded run events、approvals、validation results與exports。CopilotKit runner另以`VOISS_AGENT_DB_PATH`的專屬SQLite保存`agent_runs`、`run_state`與parent-linked invocation history，避免與control-plane schema共用檔案。Codex lifecycle record涵蓋VOISS run IDs、thread、repository/worktree、model/profile、source evidence、起訖時間、status與correlation；service可從SQLite恢復未封存的read-only thread capability，並提供cursor replay與official thread archive。aura session cache、control results與remediations維持declared schema activation paths。Codex worktree是隔離mutation workspace；reviewed exports位於具名root。

資料流程由raw evidence進入review，再形成confirmed claim/action、approved delegation、validation與export。2026-07-25 clean validation DB中的1個bootstrap與10個correlation-scoped events證明active control-plane tables支援該single flow；獨立runner DB另證明plan → write interrupt → approval resume的parent lineage與settled state。只有`aura_sessions_cache`、`control_results`與`remediations`維持reserved schema paths。原始音訊與model artifact不複製到browser或architecture inventory；本套件只保存path、schema、hash與coverage metadata。

## Evidence paths

- `docs/data-lifecycle.md` — data lifecycle policy。
- `src/aura/evidence_search.py:L225` — evidence index。
- `packages/trust-engine/src/index.ts:L60` — control metadata。
- `services/codex-bridge/src/worktree.ts` — ephemeral worktree。
- `docs/validation/2026-07-24-local-e2e.md:L138` — retained clean audit-chain evidence。

## Assumptions

- 本機filesystem permission與backup策略由operator管理。

## Limitations

- TrustStore三個reserved tables仍待owner與write/read path activation；兩個SQLite store的migration、retention、backup與secure deletion尚未形成完整policy。

## Decisions

- canonical source留在AURA；control-plane只保存必要metadata與evidence refs。

## Risks

- 未設定retention可能造成敏感meeting artifact或run evidence長期累積。

## Next validation

- 決定每個store的owner、retention、backup、export與deletion acceptance test。
