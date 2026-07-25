# VOISS AURA Data Lifecycle

## 1. Ownership

AURA canonical artifacts 是會議證據的 source of truth。VOISS Control Room 管理 locator、hash、review decision、approval、correlation、control/finding state 與 export metadata。Codex 的工程輸出保留在每個 run 的 isolated Git worktree。

```text
AURA session artifacts
  → typed bridge query / validated review
  → confirmed evidence-backed action
  → read-only Codex plan
  → operator approval
  → isolated worktree changes + validation
  → trust controls + audit + evidence export
```

## 2. Demo lifecycle

來源：

- `packages/demo-fixtures/src/index.ts`
- `apps/voiss-aura-web/public/demo/voiss-aura-architecture-review.wav`

處理：

1. Browser 載入 sanitized transcript、claims/actions、scripted run、expected diff/tests 與 trust fixtures。
2. Claim、approval、run 與 audit transitions 保留在 React memory。
3. 重新整理頁面會回到 fixture 起始狀態。
4. Export 由 browser 產生 JSON、加入 `classification=deterministic_demo_evidence` 與 SHA-256 欄位，再交給 browser download manager。

Demo packet 是真實建立的下載檔，內容仍是模擬事件。它不寫入 AURA canonical artifacts、Codex worktree 或 server-side TrustStore。

## 3. AURA canonical lifecycle

### Discover

`AURA_ARTIFACT_ROOT` 下的 `session.json` 由 Bridge 遞迴發現。每個 `meeting_id` 在 root 內必須唯一；Bridge 不接受 symlink artifact。

### Read

Bridge 讀取：

- `session.json`：meeting identity、capture/session state、transcript hash、audio tracks；
- `segments.json`：timestamped transcript segments；
- `summary.json`：claims、actions、summary transcript identity；
- `review_events.jsonl`：append-only human review history；
- manifest 內指向的 validated audio。

### Freshness

Bridge 比對 session transcript hash、summary transcript hash 與 invalidation state，產生 `current`、`stale` 或 `missing`。只有 current source evidence、supported status、confirmed review 與非空 source segments 能讓 action 成為 delegable。

### Review mutation

Claim confirmation、editing 與 rejection 透過既有 `aura.claim_review` logic 寫入 canonical review event path。Bridge 同時在自己的 audit chain 寫入 correlation-aware event；Control Room 不直接改寫 `summary.json`。

### Audio access

Audio path 同時經 artifact-root validation、manifest lookup 與 evidence-index identity check。WAV span 在 memory 中裁切並 stream；Bridge 不為 playback 建立長期音訊副本。Operator 明確下載的 `aura-span.wav` 由其選定位置與政策管理。

## 4. Derived AURA state

未覆寫設定時：

```text
<artifact-root>/.voiss-aura/
├── evidence.sqlite3
├── audit/
│   └── voiss-aura-bridge.jsonl
└── exports/
    └── <opaque-export-id>.json|md
```

- `evidence.sqlite3`：可由 canonical artifacts重建的 FTS5 derivative。
- `voiss-aura-bridge.jsonl`：append-only、SHA-256 previous-hash chain。
- `exports/`：operator-requested evidence packets；metadata 含 SHA-256。

Index 可重建；audit 與 exports 是 retained evidence，移除前應先完成 retention decision 與必要備份。

## 5. Control-plane metadata

`packages/trust-engine` 的 `TrustStore`宣告16個control-plane metadata
tables。P0 Web與Codex Bridge目前主動接線：

- assets；
- controls；
- findings；
- audit events；
- workspaces與repositories；
- evidence-backed actions；
- agent runs與Codex threads；
- bounded run events與approvals；
- validation results與exports。

`aura_sessions_cache`、`control_results`與`remediations`保留為
`schema_declared` activation paths。Audit detail與run event data在寫入前
redacts credential-like keys、token patterns與email；run event payload另有
4 KiB上限。Web TrustStore與Codex Bridge共用`VOISS_DB_PATH`或預設
`.voiss/control-plane.sqlite`建立persistent control-plane instance；
CopilotKit `SqliteAgentRunner`另以`VOISS_AGENT_DB_PATH`保存thread/run history。
兩個schema各自使用專屬SQLite檔案，parent與DB優先採owner-only permissions；
共用control-plane連線以SQLite原生5秒busy timeout協調短暫並行writer。
2026-07-25 successful live correlation保留十個hash-chain workflow events；
加上bootstrap後共有十一個events，全部位於從bootstrap到head均驗證通過的
完整chain。跨版本migration與operator backup policy屬於下一個stewardship
layer。

## 6. Operational observability

兩個 loopback bridge 各自保留結構化 JSONL operational log。每筆事件帶有
correlation ID，credential-like 欄位在寫入前完成去識別，內容只保留計數、
狀態與 bounded 摘要。預設 retention 為兩檔、每檔 5 MiB：

- AURA Bridge：`AURA_AUDIT_ROOT` 同層的
  `observability/aura-bridge.jsonl`；
- Codex Bridge：`VOISS_OBSERVABILITY_LOG` 指定的絕對路徑；未指定時使用
  本機使用者狀態目錄。

Operational logs 與 hash-chained audit 各自承擔不同證據角色：metrics 支援
運行觀測，audit chain 支援行動與核准追溯。

## 7. Codex run lifecycle

### Plan

Read-only plan 使用 allowlisted canonical repository root，network off。Run/thread/correlation IDs 與 streamed events形成 execution context。

### Persistent lifecycle、resume與archive

Codex Bridge在run開始、approval、event、terminal validation與export各階段
更新ControlStore。`agent_runs`保留VOISS run IDs、Codex thread ID、
repository/worktree、model/profile、source session/action/evidence IDs、
start/end time、status與correlation ID；`codex_threads`保存thread ownership、
cwd與archive state。

Service重新啟動時會從SQLite恢復未封存thread capability。Read-only run可透過
既有thread安全續接；`GET /v1/runs/:id/events?after=<sequence>&limit=<count>`
提供bounded cursor replay。`POST /v1/threads/:id/archive`在thread idle時呼叫
official Codex `thread/archive`並同步保存archive timestamp。Typed
command/file approval期間會暫停run timeout，operator仍可resolve或stop。
Approval超過`CODEX_APPROVAL_TIMEOUT_SECONDS`後保留為
`timed_out/paused`；同一approval仍可由operator明確resume或stop。Service
restart會把stale `running` run、active thread與pending/timed-out approval
收斂為`blocked`，normal close則把affected run保存為`interrupted`並關閉
thread capability；app-server crash會保存affected run/thread的`blocked`
lifecycle metadata。

目前的next validation layer是browser自動reattach、跨程序active write-thread
resume，以及target-host app-server crash/reconnect的live trace。這些能力在
專屬trace完成前維持明示activation gate；持久化record、read-only restart
resume與bounded crash-state preservation已有contract test證據。

### Approved write

Operator 選擇 `allow_once` 或 `allow_run_scope` 後，Bridge 建立：

```text
<repo>/.voiss/worktrees/<run-id>/
branch: voiss/run-<run-id>
```

每個 worktree 記錄 base commit。Write sandbox 只允許該 worktree，network 維持 off；remote Git、merge、PR、deploy 與 external messages 在 P0 release authority 之外。

### Validation and export

完成的write run可透過`POST /v1/evidence/export`寫入`CODEX_EXPORT_ROOT/<run-id>/`：

```text
changes.patch
evidence.json
checksums.sha256
```

Export module從isolated worktree收集bounded binary-aware patch、actual run
events、approval、sandbox/network state、base commit與authority boundary，
並建立SHA-256 checksums。Export gate要求至少一個recognized successful
validation對應terminal patch與最後mutation generation；failed、missing或
validation後再修改的run保持不可匯出。HTTP response只提供opaque export
ID、相對檔名、byte count與hash。本機absolute paths保留在service
boundary內。Expected demo diff/tests只出現在demo-classified browser
packet；actual tests由run event與exit evidence支持。

### Retention and cleanup

Codex Bridge建立可列舉的run-specific worktree與branch，並將cleanup保留為
明示operator action。每個worktree預設保留，直到operator：

1. 驗證 evidence/patch 已匯出；
2. 確認不需要 resume；
3. 以 `git worktree list` 確認 exact target；
4. 明確核准移除該 run worktree與 branch。

Worktree cleanup、自動expiry、跨run deduplication與remote archival是分開
啟動的stewardship paths；thread archive只管理Codex thread lifecycle，不自動
刪除worktree或evidence。

## 8. Export boundaries

| Export | 來源 | 內容分類 | 寫入位置 |
|---|---|---|---|
| Browser demo JSON | Fixture + scripted browser state | Public/sanitized simulation | Browser-selected download |
| AURA JSON/Markdown | Canonical session/segments/claims/actions | Sensitive | `VOISS_EXPORT_ROOT` |
| Codex patch/evidence | Isolated worktree + actual run events | Confidential/sensitive | `CODEX_EXPORT_ROOT/<run-id>/`；browser只接收opaque download metadata |

Exports 使用 opaque IDs、bounded content 與 checksums。分享前由 operator 重新檢查 transcript excerpts、repository diff、command output、identity metadata 與 recipient scope。

## 9. Backup、restore 與 integrity

- Canonical AURA backup先保留完整 session directory與 audio identity。
- Derived index可從 canonical root重建，不作唯一備份。
- Audit backup要保留完整 JSONL順序；只複製尾端會失去 genesis-to-head verification。
- SQLite backup在 process停止或使用 SQLite-safe backup方式下進行。
- Worktree backup要同時保留 base commit、branch、patch與 evidence packet。
- Restore 後先驗證 canonical paths、hash freshness、audit chain與 export checksums，再開啟 delegation。

## 10. Retention policy activation

P0 不自動刪除會議、audio、review history、worktree或 exports。部署前由資料 owner 明確決定：

- 每一資料類別的保存期限；
- encrypted storage與backup location；
- legal/consent requirements；
- export recipient與分享期限；
- worktree/evidence cleanup approver；
- deletion verification record。

這個 operator-owned retention policy讓 raw evidence、derived metadata與release artifacts各自遵循可追溯的 stewardship path。
