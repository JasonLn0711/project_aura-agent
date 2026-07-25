# 15 Risks and Technical Debt

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

一個受控live E2E、plan-delta mapping與CopilotKit clone transport缺口已取得evidence；目前最高優先風險集中在單次證據的repeatability ceiling、ASR容量、external runtime/model provenance、license resolution、retention與未提交snapshot。

風險採positive scope control表達：每一項都連到目前可用的保護層與下一個activation gate。既有trust findings保留R-002與R-004；本架構inventory把F-LIVE-E2E標為`mitigated_single_run`，並保留license、worktree、retention、single-host container portability與CSP等release concern。F-ADAPTER-PLAN-DELTA與F-CODEX-TRANSPORT-CLONE已有closed evidence。

technical debt不等同未完成產品：TrustStore的assets/controls/findings/audit core wiring、two-stage approval、Podman target lane與一個plan/write/validation/export flow已有實作/evidence。reserved tables、cross-host/repository repeatability，以及deny、run-scope、stop/recovery、callback approvals的專屬live traces仍屬activation debt。

## Evidence paths

- `apps/voiss-aura-web/lib/trust-store.ts:L163` — active findings。
- `packages/ag-ui-codex-adapter/src/index.ts:L311` — closed plan-delta mapping。
- `services/codex-bridge/src/server.ts:L1731` — plan delta emission。
- `KNOWN_LIMITATIONS.md` — known limits。
- `docs/validation/2026-07-24-local-e2e.md:L7` — single-run evidence and explicit claim ceiling。

## Assumptions

- severity反映local MVP release風險，不是production clinical system評級。

## Limitations

- 沒有量化likelihood或owner/due date資料。

## Decisions

- 風險保持open直到對應evidence產生，不以source presence自動關閉。

## Risks

- 若把單一synthetic fixture flow擴寫為production或multi-repository證據，會產生錯誤完成宣告。

## Next validation

- 依13-risks.json逐項指定owner、acceptance evidence與release disposition。
