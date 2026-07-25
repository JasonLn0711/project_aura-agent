# 13 Security Boundaries

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

MVP使用loopback bind、Origin檢查、signed session、bearer token、repository allowlist、sandbox、worktree isolation、on-request approval與redaction形成分層保護。

Browser boundary由HttpOnly SameSite cookie、same-origin mutation和server-only modules控制。Bridge boundary使用token與origin allowlist。Codex boundary固定read-only plan、network-off sandbox與user-reviewed approval；寫入在第一階段核准後才建立isolated worktree，具名command/file如被app-server請求仍需第二階段決策，並綁定active run、turn、request ID與worktree scope。Approval timeout保存`timed_out/paused` capability供operator resume或stop；stale/crashed active lifecycle以`blocked` metadata fail closed。

Codex protocol另限制incoming line/event/body大小、驗證exact 0.145.0與thread response policy、限制lifetime restart budget，並讓timeout保持terminal authority。Validation pass與terminal frozen patch hash及mutation generation綁定後才允許export；staged write可在worktree建立前由stop取消。Podman wrapper以read-only vendor/auth mount與allowlisted read-write roots縮小host exposure。單次live flow觀察`networkAccess=false`與nested `managed-bubblewrap`；獨立socket canary主動獲得`PermissionError`，證明該sandbox的egress denial。direct-host `:workspace`在此host由targeted AppArmor prerequisite gate保持關閉。

## Evidence paths

- `apps/voiss-aura-web/lib/security.ts:L102` — browser authorization。
- `services/codex-bridge/src/server.ts:L480` — two-stage approval。
- `services/codex-bridge/src/worktree.ts:L60` — worktree isolation。
- `services/codex-bridge/src/index.ts:L1023` — approval turn binding。
- `services/codex-bridge/src/index.ts:L155` — terminal validation binding。
- `services/codex-bridge/src/index.ts` — exact Codex app-server gate。
- `services/codex-bridge/src/rpc.ts:L34` — protocol line-size ceiling。
- `packages/trust-engine/src/index.ts:L593` — redaction and audit。
- `services/codex-bridge/run-in-podman.sh:L9` — container mount boundary。
- `docs/validation/2026-07-24-local-e2e.md:L104` — single-run sandbox policy and separate egress canary。

## Assumptions

- loopback host與OS user account受到基本保護。

## Limitations

- 未進行penetration test、multi-user authorization或remote threat model。
- deny、run-scope、stop/recovery與command/file callback approvals尚未有專屬live negative traces。

## Decisions

- 採deny-by-default origin/repository path與explicit approval。

## Risks

- local malware或同帳號程序仍可能接觸本機資料；remote deployment需要新identity layer。

## Next validation

- 由reviewer覆核既有automated negative tests，並為未執行的live approval/stop/recovery paths保留專屬trace。
