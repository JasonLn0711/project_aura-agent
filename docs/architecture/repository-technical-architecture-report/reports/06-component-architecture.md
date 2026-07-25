# 06 Component Architecture

## Report control

| Field | Value |
|---|---|
| Status | `Partially Verified` |
| Product milestone | `LOCAL_E2E_VALIDATED` |
| Scoped live run status | `LIVE_MINIMUM_COMPLETED` |
| Source baseline | `6807f516d1083051d75373f110ac871f677f75ce` |
| Baseline role | Source lineage only; it is not live MVP proof |
| Current evidence | Uncommitted source and retained-validation snapshot `9f64c159040bee39834284683d62bfc107720f633644bca53e11b35d9a157e16` |
| Artifact timestamp | `2026-07-25T00:00:00Z` (normalized; not a wall-clock runtime observation) |

## Architecture finding

Web 內部採 route/security/status/trust/control-room 分層；packages 提供 contract 與 orchestration；Bridge 把外部 runtime protocol 轉成受控、可稽核介面。

Domain Zod schemas固定 evidence、claim、action、approval、run 與 trust vocabulary。Demo fixtures只提供 deterministic demo evidence。Trust engine以 SQLite 與 hash chain提供 metadata integrity。Agent runtime組裝 `voiss_orchestrator`、`codex_engineer` 與 `demo_agent`。

AG-UI adapter將 Codex app-server family轉成 browser-safe event，包含bounded、redacted的`item/plan/delta` mapping，並以`CodexBridgeAgent.clone()`明確保留CopilotKit每次request clone所需的Bridge transport。CopilotKit `SqliteAgentRunner`以獨立SQLite保存parent-linked invocation history；2026-07-25 retained live export保留366個Codex events，證明這條single-fixture路徑可運作。AURA Bridge則以 Pydantic response model、path validation、token與 origin policy暴露 canonical artifact。

## Evidence paths

- `packages/domain/src/index.ts:L196` — domain schemas。
- `packages/agent-runtime/src/index.ts:L430` — named agents。
- `packages/trust-engine/src/index.ts:L119` — trust store。
- `packages/ag-ui-codex-adapter/src/index.ts:L290` — event adapter。
- `packages/ag-ui-codex-adapter/src/index.ts:L913` — CopilotKit clone transport preservation。
- `docs/validation/2026-07-24-local-e2e.md:L57` — retained live adapter/runtime flow。

## Assumptions

- package exports 是內部穩定 API boundary。

## Limitations

- 目前沒有獨立 schema registry 或 generated OpenAPI contract 在本套件內。

## Decisions

- 跨層資料使用明確 schema；credential 與 native runtime 留在 server boundary。

## Risks

- event family drift 可能造成 adapter unknown fallback。

## Next validation

- 以專屬live traces驗證unknown-event drift、disconnect/resume及未執行的callback approval paths。
