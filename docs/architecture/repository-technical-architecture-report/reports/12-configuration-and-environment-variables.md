# 12 Configuration and Environment Variables

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

設定以明確env contract分隔 Web、AURA Bridge、Codex Bridge、AURA desktop與Codex child allowlist；所有token保持server-side。

Web local mode需要session secret、兩組Bridge URL/token、control-plane `VOISS_DB_PATH`與獨立的CopilotKit `VOISS_AGENT_DB_PATH`。AURA Bridge配置canonical artifact、evidence index、audit與export root。Codex Bridge配置repository allowlist、origin、process/request/approval timeout、binary、worktree與export root。已驗證的Podman wrapper另要求`CODEX_VENDOR_DIR`、`CODEX_AUTH_FILE`，並可由`CODEX_PODMAN_IMAGE`選擇local image tag；vendor/auth採read-only mount，allowlisted repo及明列worktree/export roots採read-write mount。AURA desktop另有model token、audit、runtime與CUDA path。

machine inventory不收錄實際secret值；test-only canary env也不視為runtime contract。Codex child只繼承明列的非秘密主機context，避免把Bridge token、provider key或其他ambient secret傳給app-server。

## Evidence paths

- `apps/voiss-aura-web/lib/security.ts:L12` — session configuration。
- `services/aura-bridge/src/aura_bridge/cli.py:L18` — AURA env。
- `services/codex-bridge/src/cli.ts:L14` — Codex env。
- `services/codex-bridge/src/index.ts` — child env allowlist。
- `services/codex-bridge/run-in-podman.sh:L4` — Codex Podman env and mount contract。

## Assumptions

- secret由本機受控管道注入，不寫入repo。

## Limitations

- 沒有集中secret manager或configuration schema deployment artifact；`CODEX_AUTH_FILE`是敏感locator，不進browser或machine inventory value。

## Decisions

- browser不接收Bridge token；inventory只描述名稱、用途與activation gate。

## Risks

- missing/misaligned env會使local mode降為not-ready或拒絕服務。

## Next validation

- 用runbook做clean-shell啟動，驗證缺少每一個required env時fail closed。
