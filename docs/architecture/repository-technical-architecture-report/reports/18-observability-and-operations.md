# 18 Observability and Operations

## Report control

| Field | Value |
|---|---|
| Status | `Partially Verified` |
| Product milestone | `LOCAL_E2E_VALIDATED` |
| Scoped live run status | `LIVE_MINIMUM_COMPLETED` |
| Source baseline | `6807f516d1083051d75373f110ac871f677f75ce` |
| Baseline role | Source lineage only; it is not live MVP proof |
| Current evidence | Uncommitted source and retained-validation snapshot `c7e4266db46912b0b38f87d6700b1e1a9f670efb2c49ec4a196cd6d0ab2602f0` |
| Artifact timestamp | `2026-07-25T00:00:00Z` (normalized; not a wall-clock runtime observation) |

## Architecture finding

Observability由service status、structured run events、SQLite hash-chain audit、AURA JSONL audit、runtime diagnostics與export evidence共同提供。

Web status route聚合AURA/Codex readiness並同步trust controls。每個session workflow以 correlation ID串接operator action、runtime observation與export evidence。AG-UI activity顯示plan、command、file、diff、approval與error。TrustStore把actor/action/subject/detail寫入ordered hash chain；AURA保留audit event與runtime diagnostic；Bridge只在patch SHA-256與mutation generation一致的authoritative validation gate通過後輸出sanitized completed-write evidence，Web再記錄validated export並更新對應control/finding。

Codex Bridge status另公開bounded restart count；app-server protocol failure遵循有限restart budget，run timeout保持authoritative terminal result並清理pending approval。Approval timeout保留`timed_out/paused` replay/resume/stop capability；stale-running reconcile、normal close與app-server crash保存bounded `blocked`／`interrupted` lifecycle metadata。terminal patch snapshot與validation summary進入export evidence。

2026-07-25 final clean validation database保留1個bootstrap與10個live-correlation events；TrustStore跨workflow保留1,139個run events，exported write-run packet保留366個Codex events，2個validation checks對齊mutation generation 6及terminal patch SHA-256。這些counts屬一個controlled run，不推廣為長期SLO或throughput。現在沒有集中log backend、metrics collector、distributed trace或alerting。

## Evidence paths

- `apps/voiss-aura-web/app/api/status/route.ts` — readiness aggregation。
- `packages/trust-engine/src/index.ts:L277` — hash-chain audit。
- `apps/voiss-aura-web/lib/trust-store.ts:L309` — validated export trust transition。
- `services/codex-bridge/src/index.ts:L743` — validation summary gate。
- `services/codex-bridge/src/index.ts:L887` — restart budget。
- `services/codex-bridge/src/index.ts:L1182` — authoritative timeout。
- `src/aura/audit.py` — AURA audit。
- `services/codex-bridge/src/export.ts` — sanitized export。
- `docs/validation/2026-07-24-local-e2e.md:L136` — retained correlation/audit/event counts。

## Assumptions

- operator可以存取本機state與export root。

## Limitations

- 沒有SLO、alert routing、central retention或cross-host tracing。

## Decisions

- MVP以correlation和evidence export提供可追溯性。

## Risks

- 程序crash前未持久化的stream event可能只存在UI memory。

## Next validation

- 保留target-host crash/reconnect與browser auto-reattach live trace，啟動automatic active/write recovery前由reviewer確認語意。
