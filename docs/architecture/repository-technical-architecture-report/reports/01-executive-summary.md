# 01 Executive Summary

## Report control

| Field | Value |
|---|---|
| Status | `Partially Verified` |
| Product milestone | `LOCAL_E2E_VALIDATED` |
| Scoped live run status | `LIVE_MINIMUM_COMPLETED` |
| Source baseline | `6807f516d1083051d75373f110ac871f677f75ce` |
| Baseline role | Source lineage only; it is not live MVP proof |
| Current evidence | Uncommitted source and retained-validation snapshot `dac3f6ca6ad6f170a66448b00adf713a204dede36f90d678ad3352d4918d8ef9` |
| Artifact timestamp | `2026-07-25T00:00:00Z` (normalized; not a wall-clock runtime observation) |

## Architecture finding

目前工作樹已形成並完成一次受控本機 E2E 的 MVP：Next.js 控制室整合證據型 domain、fixture、persistent TrustStore、named agents、AG-UI adapter、AURA Bridge、Codex Bridge，以及 rootless Podman 中的 official Codex target lane；產品里程碑為 `LOCAL_E2E_VALIDATED`，scoped live 狀態為 `LIVE_MINIMUM_COMPLETED`。

MVP 的核心價值是把會議證據、人工確認、代理執行、核准與驗證放在同一個本機控制面。2026-07-25 的 final-source retained record 證明一個 synthetic AURA/Git fixture 經 Web → AURA Bridge → official Codex app-server 完成一個 real plan、Bridge-owned `allow_once`、isolated workspace write、366個exported Codex events、2個 terminal-patch-bound validations及checksum-verified export。CopilotKit runner另保留plan → write interrupt → approval resume的parent-linked invocation history與settled state；它和control-plane各自使用專屬SQLite檔案。另有獨立 managed-sandbox socket canary 證明 active egress denial；它與run中的`networkAccess=false` policy observation分層保存。

目前的 Git `HEAD` 仍是 AURA 基線，因此本報告把該 commit 視為 lineage。VOISS MVP 的實作證據來自本次 source與retained-validation snapshot SHA-256。這個單次、單主機、單fixture證據支持local P0 candidate；production、多repository repeatability、deny、`allow_run_scope`、stop/recovery與app-server command/file callback approvals仍由各自activation gate治理。

## Evidence paths

- `apps/voiss-aura-web/components/control-room.tsx:L564` — 控制室整合介面。
- `services/aura-bridge/src/aura_bridge/app.py:L951` — AURA 證據服務。
- `services/codex-bridge/src/server.ts:L354` — Codex 執行與核准服務。
- `apps/voiss-aura-web/lib/trust-store.ts:L219` — persistent trust wiring。
- `docs/validation/2026-07-24-local-e2e.md:L57` — retained local E2E與final-source quality evidence。
- `docs/validation/screenshots/2026-07-24-control-room-demo.png` — retained deterministic demo screenshot。

## Assumptions

- MVP 以單機、單一操作人與 loopback 服務為主要操作環境。
- 目前原始碼代表本次架構盤點時的實作意圖。

## Limitations

- 本報告不把既有 AURA benchmark 或基線 commit 當作 VOISS 整合實跑證據。
- 本次 generator 未執行產品 build、測試、模型推論或瀏覽器驗收；它引用並校驗正式retained validation record。

## Decisions

- 採本機優先、server-side credential、證據先行與顯式核准架構。
- 以 source/validation snapshot hash 和 artifact checksum 固定本報告證據面。

## Risks

- 單次fixture證據尚不代表production或跨repository repeatability。
- 未提交工作樹需要reviewer選定target commit後才能形成release identity。

## Next validation

- 由reviewer決定target commit與release disposition。
- 為deny、run-scope、stop/recovery與callback approvals保留專屬live trace。
