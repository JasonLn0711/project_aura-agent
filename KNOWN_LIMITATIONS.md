# VOISS AURA Control Room — 已知範圍與啟動路徑

狀態：P0 的 active implementation boundaries。

- Local mode服務一位loopback operator；hosted multi-user identity與tenancy
  由獨立activation path啟動。
- P0 authority涵蓋local patch與evidence export。Push、merge、pull request、
  deployment、package publication與external messages由另行治理的工作包啟動。
- Demo mode使用sanitized transcript、synthetic audio、scripted agent events、
  expected diffs與expected test output；持續顯示的mode badge讓這些證據與
  local runtime results保持清楚分層。
- Control plane透過`VOISS_DB_PATH`保存metadata、correlation、hash、
  approval與bounded redacted excerpts。Codex Bridge主動寫入`agent_runs`、
  `codex_threads`、`run_events`、`approvals`、`validation_results`與
  `exports`；CopilotKit runner另以`VOISS_AGENT_DB_PATH`保存thread/run
  history。兩個SQLite schema使用不同檔案；AURA持續作為transcript與audio
  artifacts的canonical home。
- `GET /v1/runs/{run_id}/events`已提供sequence cursor replay。瀏覽器自動
  reattach與reconnect UI由下一個release activation gate承接。
- Service restart後可從SQLite恢復已完成run所屬、未archived的idle唯讀
  thread capability，並在相同canonical repository續跑。Contract tests已
  驗證stale-running reconcile、normal close與app-server crash會保留
  bounded `blocked`／`interrupted` metadata；跨程序write-thread resume與
  target-host crash/reconnect live trace保留為獨立安全驗證工作包。
- `POST /v1/threads/{thread_id}/archive`會archive idle Codex thread並關閉
  resume capability；run events、evidence export與worktree持續保留，
  worktree/branch cleanup由明示operator維運流程啟動。
- Approval與stop已有contract regression面。既有live path涵蓋
  `allow_once`；approval timeout以`timed_out/paused`保留replay、resume與stop
  capability。deny、`allow_run_scope`、command/file callback approval、stop與
  recovery各自保留target-host live trace gate。
- Source baseline的GPU、Ollama與model claims是每個target runtime重新驗證的
  observations；Demo mode不需要這些服務。
- Codex model固定為`gpt-5.6-sol`，reasoning effort固定為`max`。
  2026-07-24 target host已完成一次未reroute的official live run；每個新增
  target host都在startup重新驗證account、version與model readiness。
- Verified Ubuntu 24.04 host的direct-host `managed-bubblewrap`
  workspace-write需要official targeted AppArmor prerequisite。P0 verified
  lane使用rootless Podman、digest-pinned Ubuntu image、read-only Codex
  binary/auth mounts與nested `managed-bubblewrap`；live export保留
  network-off policy、real write、test與export evidence。Active egress
  denial以獨立sandbox canary保存，不從policy field推定。
- Live completion目前涵蓋一個controlled synthetic AURA fixture repository。
  新增repositories、host distributions與long-running concurrent workloads
  沿用相同allowlist與retained-evidence validation path。
- Architecture與SBOM coverage分別呈現complete repository dependencies、
  partial native-runtime discovery與externally managed model/runtime evidence；
  final-source snapshot、manifest與checksums構成implemented P0 review baseline。
