# 20 Open Questions, Unknowns, and Release Gates

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

MVP source architecture、final-source quality與一個controlled live integration已有retained evidence；release決策現在取決於target commit/reviewer identity、單次證據的repeatability邊界、專屬negative live traces、runtime/model provenance、license與retention。

Open questions以activation gate管理：reviewer何時選定target commit；其他repository、host與concurrent workload如何保留repeatability evidence；模型revision/digest與授權如何封存；TrustStore migration/retention如何運作；remote deployment是否另案。`item/plan/delta` source mapping及一次live observation已關閉原缺口；direct-host `:workspace`在此host仍由targeted AppArmor preflight控制，已驗證target lane為rootless Podman+nested managed-bubblewrap。

已完成的release evidence包括frozen install/lint/typecheck/test/build、real AURA query/review、one real Codex plan/allow_once/write/two validations/export、18 deterministic與1 guarded live browser scenario、active egress canary及retained demo screenshot/packet。尚需專屬live traces的是deny、`allow_run_scope`、stop/recovery與app-server command/file callback approvals；release identity仍需target commit與reviewer sign-off。Push、merge、PR、deploy、publication與external messaging維持另案授權。

## Evidence paths

- `docs/release-checklist.md` — release gates。
- `KNOWN_LIMITATIONS.md` — known unknowns。
- `PROGRESS.md` — implementation status。
- `docs/validation/2026-07-24-local-e2e.md:L223` — retained completed/open evidence matrix。
- `docs/architecture/repository-technical-architecture-report/inventories/16-findings.json` — open findings。

## Assumptions

- release owner會把每個gate連到可重現artifact。

## Limitations

- 本報告無法替代host validation、security review、license counsel或field acceptance。

## Decisions

- 所有未知保持visible，不以baseline、fixture或harness代理live result。

## Risks

- 若在gate未關閉前標示complete，會弱化evidence trust model。

## Next validation

- 由reviewer選定target commit並簽署release identity與checksums。
- 為deny、run-scope、stop/recovery與callback approval各自保留live artifact。
