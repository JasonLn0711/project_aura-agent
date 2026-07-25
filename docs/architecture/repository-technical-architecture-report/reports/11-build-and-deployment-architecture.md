# 11 Build and Deployment Architecture

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

建置由pnpm workspace與uv workspace分開管理；部署目標是單機多程序、Windows desktop packaging，以及一個已驗證的rootless Podman Codex target image。

Root scripts提供frozen install、lint、typecheck、test、static architecture boundary、fixture/local E2E、activation-gated live E2E、Podman image與build orchestration。Python以uv lock與setuptools/hatchling管理AURA及Bridge。CI有一般與Windows兩個workflow source。Windows scripts另提供portable build與runtime smoke。

Retained final-source matrix記錄frozen pnpm/uv install、format check、lint、typecheck、116個JS/TS tests（含55個Codex Bridge tests）、398個AURA baseline tests、14個AURA Bridge tests、18個deterministic browser scenarios、1個guarded live scenario、demo walkthrough及Next production build全數PASS。架構generator未重跑這些產品命令；它把該正式validation record納入snapshot並保留來源邊界。

## Evidence paths

- `package.json:L18` — Node build commands。
- `package.json:L14` — architecture and live E2E commands。
- `pyproject.toml:L1` — Python build backend。
- `.github/workflows/ci.yml` — CI source。
- `.github/workflows/windows.yml` — Windows CI source。
- `scripts/build_windows_portable.ps1` — Windows packaging。
- `services/codex-bridge/Containerfile:L1` — Codex target image。
- `services/codex-bridge/run-in-podman.sh:L30` — Codex Podman runtime wrapper。
- `docs/validation/2026-07-24-local-e2e.md:L178` — retained final-source quality matrix。

## Assumptions

- Node版本符合 Codex Bridge engine，Python版本符合 project requires-python。

## Limitations

- 本次generator沒有執行產品build、CI或deployment；retained results來自正式validation record。
- 沒有Compose、Kubernetes、remote deployment或cross-host repeatability evidence。

## Decisions

- local MVP維持host process deployment；Codex workspace-write使用rootless Podman target lane。

## Risks

- host toolchain、apt package與native dependency drift可能造成跨主機建置不一致。

## Next validation

- 由reviewer選定target commit後，在該identity重跑frozen gate與image build並簽署evidence。
