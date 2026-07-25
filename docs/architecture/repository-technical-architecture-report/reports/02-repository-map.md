# 02 Repository Map

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

Repository 同時保留成熟的 Python AURA 桌面與新增的 VOISS TypeScript/Python 控制面；pnpm 與 uv workspace 是兩條清楚的建置邊界。

主要repository map：

```text
apps/voiss-aura-web/        Next.js control room、same-origin API、browser tests
packages/domain/            Zod evidence與workflow contracts
packages/demo-fixtures/     deterministic demo evidence
packages/trust-engine/      SQLite metadata、redaction、hash-chain audit
packages/agent-runtime/     named orchestrator、Codex engineer、demo agents
packages/ag-ui-codex-adapter/ Codex stream到AG-UI normalization
services/aura-bridge/       FastAPI canonical AURA evidence boundary
services/codex-bridge/      Codex app-server、approval、worktree、export、Podman target lane
src/aura/                   PyQt desktop、audio、ASR、review、audit、runtime
src/summary/                structured Gemma/Ollama summary pipeline
tests/ and component tests/ Python、Node、Vitest、Playwright quality surfaces
docs/                       ADR、security、lifecycle、runbook、release與retained validation evidence
```

`src/aura` 與 `src/summary` 擁有音訊、ASR、diarization、summary、review、audit 與 evidence 來源。`apps/voiss-aura-web` 擁有操作介面與 same-origin API；`packages/*` 擁有可重用 contract、fixture、trust、agent 與 adapter；`services/*` 擁有 loopback integration boundary。

`docs/` 提供決策、runbook、安全、生命週期與本套架構快照。generated、cache、virtual environment 與 vendor tree 都排除在 source snapshot 之外。

## Evidence paths

- `pnpm-workspace.yaml:L1` — Node workspace。
- `pyproject.toml:L90` — uv workspace。
- `packages/domain/src/index.ts:L3` — 跨元件 domain contract。
- `services/codex-bridge/Containerfile:L1` — Codex target runtime image boundary。
- `docs/validation/2026-07-24-local-e2e.md:L3` — retained implementation validation record。

## Assumptions

- 每個 workspace manifest 是該元件的主要 package boundary。

## Limitations

- 檔案地圖不展開 node_modules、.venv、.next 或測試產物。

## Decisions

- 保留 AURA canonical runtime，透過 Bridge 暴露受控介面。
- 共用型別與信任邏輯放在 packages，不複製到 Web route。

## Risks

- 雙語言 workspace 增加版本與環境同步成本。

## Next validation

- 在正式 commit 後確認 workspace lockfiles 與 package 邊界一致。
