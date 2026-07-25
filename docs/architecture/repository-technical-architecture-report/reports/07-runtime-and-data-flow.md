# 07 Runtime and Data Flow

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

Runtime flow 以 evidence-first gate 推進：會議證據進入 review，confirmed/supported action 才可 delegation；Codex 先 read-only plan，再於 Bridge-owned approval 後建立隔離 worktree。

Demo mode 完全由 fixtures 驅動；local mode 由 Web server 透過 bearer token 連接兩個 loopback Bridge。AURA 資料經 search/detail/review/export 路徑進出；Codex 事件經 JSON-RPC、Bridge NDJSON/SSE、AG-UI normalizer 抵達 UI。

寫入核准有兩層：使用者先允許建立 write-capable isolated worktree；Codex app-server如針對具名 command 或 file change發出on-request approval，再由typed callback path處理。未經第一層核准前不建立隔離 worktree，stop可直接取消這個staged activation。具名approval綁定active run、turn、item與request time。完成後的 authoritative evidence export 另要求至少一個in-scope recognized validation通過、沒有recognized failure或overflow，且pass所見patch hash與mutation generation必須同時等於terminal frozen patch；missing、failed、help-only、outside-scope或stale validation會以 `export_unavailable` 保持關閉。

Retained live flow已完成一個read-only plan、Bridge-owned `allow_once`、isolated write、2個validation與export，並保留plan → write interrupt → resume child lineage。Approval timeout的`timed_out/paused` replay/resume/stop與stale/crash lifecycle的`blocked`收斂由contract tests支持。該Codex evidence保留`write_activation / allow_once`，並且沒有app-server command/file callback approval；這些callback與deny、run-scope、stop/recovery仍保持獨立live gate。

## Evidence paths

- `packages/domain/src/index.ts:L196` — delegation gate。
- `services/codex-bridge/src/server.ts:L480` — write activation。
- `services/codex-bridge/src/worktree.ts` — isolated worktree。
- `services/codex-bridge/src/index.ts:L749` — authoritative validation export gate。
- `services/codex-bridge/src/index.ts:L155` — validation-to-terminal-patch binding。
- `services/codex-bridge/src/index.ts:L192` — terminal mutation-generation binding。
- `services/codex-bridge/src/server.ts:L203` — staged write cancellation。
- `apps/voiss-aura-web/app/api/control-room/route.ts:L19` — mutation routing。
- `docs/validation/2026-07-24-local-e2e.md:L51` — one controlled plan/write/validation/export flow。

## Assumptions

- Bridge token 與 browser session secret 由本機 operator 安全配置。

## Limitations

- live evidence限單一synthetic AURA/Git fixture；不代表production或多repository repeatability。
- deny、allow_run_scope、stop/recovery與app-server command/file callback approvals尚未各自保留live trace。

## Decisions

- 把 plan、write activation 與具名 mutation approval 分成可辨識階段。

## Risks

- stream interruption仍需browser reattach；approval timeout已保留paused audit與operator resume/stop capability。

## Next validation

- 依序保留deny、allow_run_scope、stop/recovery與command/file callback approval專屬live traces。
