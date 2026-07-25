# 17 Testing and Quality Strategy

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

Repository具備Python unit/integration、TypeScript unit、Node bridge、Web component/security與Playwright E2E測試面；retained final-source matrix記錄116個JS/TS tests（含55個Codex Bridge tests）、398個AURA tests、14個AURA Bridge tests、18個deterministic browser scenarios及1個guarded live browser scenario全數PASS。

Static inventory掃描tests、apps、packages、services與architecture boundary checker，記錄framework與test declaration近似數。測試策略涵蓋domain validation、fixture一致性、SQLite audit chain、agent orchestration、Codex event normalization、Bridge authentication/path policy、Web security、static architecture policy與browser flow。Playwright的guarded live config在single synthetic AURA/Git fixture完成一個2.0分鐘real local scenario；另一個coherent deterministic demo walkthrough在3.42秒內完成Control Room到browser export並保留packet與screenshot。

品質閘門分層保留：format/diff check、typecheck/lint、unit、service integration、real app-server、real AURA artifact、browser E2E、host/model runtime。Codex HTTP write tests使用disposable Git repositories以避免污染工作repo。fake app-server與fixture是有效baseline/contract evidence；live claim只限正式record的一個controlled fixture flow。

## Evidence paths

- `package.json:L15` — Node test orchestration。
- `pyproject.toml:L100` — pytest configuration。
- `services/codex-bridge/tests/fake-app-server.ts:L36` — contract fixture。
- `apps/voiss-aura-web/tests/e2e/control-room.spec.ts` — browser E2E。
- `apps/voiss-aura-web/tests/live/control-room-live.spec.ts:L4` — activation-gated live browser E2E。
- `scripts/check_architecture_boundaries.mjs:L48` — static architecture boundary assertions。
- `docs/validation/2026-07-24-local-e2e.md:L187` — retained final-source execution results。

## Assumptions

- test declarations可作為coverage surface近似值。

## Limitations

- inventory中的per-file declaration count是regex近似，不等於test collection；本次generator未執行產品tests或build。
- retained live browser證據限一個synthetic fixture，未覆蓋production、multi-repo或未執行的negative paths。

## Decisions

- 測試存在與測試通過分開記錄；fake runtime不作live proof。

## Risks

- 只跑unit會漏掉token/origin/stream/model/host整合問題。

## Next validation

- 在target commit重跑分層gate，並為deny、run-scope、stop/recovery與callback approvals新增專屬live evidence。
