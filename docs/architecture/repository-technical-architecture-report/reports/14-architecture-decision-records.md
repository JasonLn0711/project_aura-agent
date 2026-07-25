# 14 Architecture Decision Records

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

架構決策以local-first evidence control為主軸，並由repo ADR與decision log支持：canonical AURA evidence、Bridge boundary、AG-UI normalization、two-stage approval、persistent trust metadata。

Decision inventory將source、interpretation與implementation分層。既有`docs/adr`與`DECISIONS.md`是決策來源；本報告不把未落地的proposal提升為implemented capability。

目前十二份ADR形成連續決策鏈：

| ADR | Active decision |
|---|---|
| 0001 | Companion Web control plane |
| 0002 | AURA artifacts保持source of truth |
| 0003 | Loopback AURA Bridge |
| 0004 | Official Codex app-server boundary |
| 0005 | Trusted static GenUI |
| 0006 | P0不開放任意generated UI |
| 0007 | Approved write run使用isolated worktree |
| 0008 | Read-only與network-off defaults |
| 0009 | Deterministic demo mode |
| 0010 | SQLite control-plane metadata |
| 0011 | Agent runtime不含remote Git或deploy authority |
| 0012 | Report與release evidence contract |

目前可由source驗證的關鍵決策包括：AURA資料不搬成Web權威副本；browser不直連native runtime；Codex mutation在isolated worktree；trust metadata以SQLite與hash chain保存；demo fixture與live evidence保持可辨識。

## Evidence paths

- `DECISIONS.md` — decision log。
- `docs/adr` — ADR directory。
- `packages/trust-engine/src/index.ts:L140` — implemented trust decision。
- `services/codex-bridge/src/worktree.ts` — implemented isolation decision。

## Assumptions

- ADR與source若衝突，以current implementation及明確release gate為準。

## Limitations

- 部分決策仍可能以planning prose存在，尚未有supersession metadata。

## Decisions

- 本報告只將source-visible行為列為implemented。

## Risks

- decision log drift會讓未來agent誤讀active architecture。

## Next validation

- 為persistent trust、event mapping與local process deployment補正式ADR或更新既有ADR狀態。
