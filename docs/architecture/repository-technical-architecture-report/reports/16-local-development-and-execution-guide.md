# 16 Local Development and Execution Guide

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

本機執行路徑由locked dependency、AURA Bridge、Codex sign-in、Podman target lane、Codex Bridge、Web local mode與status/trust check組成；demo mode提供獨立fixture路徑。

先確認Node、pnpm、Python、uv與rootless Podman版本，再依lockfile安裝。AURA canonical artifact root、Bridge token與origin先配置；Codex完成官方登入後，設定`CODEX_VENDOR_DIR`、`CODEX_AUTH_FILE`、`CODEX_PODMAN_IMAGE`及allowlisted roots，以`run-in-podman.sh`作為`CODEX_BIN` target lane，再啟動`127.0.0.1:8770`。Web local mode配置server-side session secret與Bridge URL/token後啟動`127.0.0.1:3000`。

direct-host `:workspace`只有在targeted AppArmor preflight成功後才是可用替代路徑；目前驗證主機的supported lane是rootless Podman+nested managed-bubblewrap。完整操作步驟由`docs/runbooks/local-setup.md`、`codex-sign-in.md`、`aura-bridge.md`與`troubleshooting.md`承接。

## Evidence paths

- `docs/runbooks/local-setup.md` — local setup runbook。
- `docs/runbooks/codex-sign-in.md` — Codex auth runbook。
- `docs/runbooks/aura-bridge.md` — AURA Bridge runbook。
- `docs/demo/five-minute-demo.md` — demo acceptance flow。
- `services/codex-bridge/run-in-podman.sh:L30` — verified Podman launch path。
- `docs/validation/2026-07-24-local-e2e.md:L19` — retained single-host setup and run evidence。

## Assumptions

- operator擁有repository與本機runtime存取權。

## Limitations

- 沒有在本次generator執行安裝、啟動或登入；正式record只支持已驗證host與single fixture。

## Decisions

- 以readiness endpoint和UI source label確認路徑，不以程序存在推定服務ready。

## Risks

- port、token、artifact root或repository allowlist配置不一致會fail closed。

## Next validation

- 在reviewer選定target commit後由clean shell重跑runbook並封存command/version/readiness evidence。
