# VOISS Codex Bridge

VOISS Codex Bridge 將本機 `codex app-server` 0.145.0 轉成綁定
`127.0.0.1` 的受控 HTTP service。它提供唯讀規劃、隔離工作樹寫入、
人員核准、停止、持久化 lifecycle、游標事件重播、唯讀 thread 續跑、
thread archive、approval timeout後的paused capability，以及fail-closed
blocked lifecycle與證據匯出；模型固定為 `gpt-5.6-sol`、reasoning effort
固定為 `max`，執行工具的網路維持關閉。

## 啟動

必要設定：

```bash
export CODEX_BRIDGE_TOKEN="$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')"
export VOISS_ALLOWED_REPOSITORIES=/absolute/path/to/project_aura-voiss-mvp
export CODEX_EXPORT_ROOT=/absolute/path/to/local-evidence
export VOISS_OBSERVABILITY_LOG=/absolute/path/to/local-state/codex-bridge.jsonl
export VOISS_DB_PATH=/absolute/path/to/local-state/control-plane.sqlite
export VOISS_ALLOWED_ORIGINS=http://127.0.0.1:3000
```

接著選擇一條sandbox-ready runtime lane。Service固定監聽
`127.0.0.1:8770`。Web server使用同一個token：

```bash
export CODEX_BRIDGE_URL=http://127.0.0.1:8770
```

### Rootless Podman（Ubuntu 24.04 verified lane）

已驗證的workspace-write lane使用rootless Podman承載官方
Codex binary與app-server，並保留Codex自己的`managed-bubblewrap`
sandbox：

```bash
pnpm codex:runtime:build
export CODEX_BIN=/absolute/path/to/project_aura-voiss-mvp/services/codex-bridge/run-in-podman.sh
export CODEX_VENDOR_DIR=/absolute/path/to/codex-linux-vendor/x86_64-unknown-linux-musl
export CODEX_AUTH_FILE=/absolute/path/to/codex-home/auth.json
export CODEX_PODMAN_IMAGE=localhost/voiss-codex-runtime:0.145.0
pnpm --filter @voiss/codex-bridge start
```

Vendor與auth mounts為read-only；只有allowlisted repository、
`VOISS_WORKTREE_ROOT`與`CODEX_EXPORT_ROOT`為可寫入的same-path mounts。
App-server保有官方模型連線，每個agent command則由nested
`managed-bubblewrap`維持network off。

### Direct host

Direct-host lane先驗證official sandbox prerequisites：

```bash
codex sandbox \
  -C /absolute/path/to/project_aura-voiss-mvp \
  -P :workspace \
  -- true
pnpm --filter @voiss/codex-bridge start
```

`:workspace` preflight成功後才使用預設`CODEX_BIN=codex`。Preflight失敗的
Ubuntu host採用上方Podman lane，保留managed sandbox語意。

設定契約：

| 變數 | 作用 |
|---|---|
| `CODEX_BRIDGE_TOKEN` | 必填；每次啟動的 Bearer token，至少 16 bytes |
| `VOISS_ALLOWED_REPOSITORIES` | 必填；逗號分隔的絕對 repository roots |
| `VOISS_ALLOWED_REPO_ROOTS` | 上一欄的相容 alias |
| `CODEX_ALLOWED_ORIGINS` | 服務專用的精確 loopback HTTP origins；設定時優先於 generic alias |
| `VOISS_ALLOWED_ORIGINS` | 精確 loopback HTTP origins 的 generic alias；預設 `http://127.0.0.1:3000` |
| `CODEX_BRIDGE_PORT` | loopback port；預設 `8770` |
| `CODEX_BIN` | Codex executable；預設 `codex` |
| `CODEX_VENDOR_DIR` | Podman wrapper必要；包含`bin/codex`與Codex sandbox resources的Linux vendor directory |
| `CODEX_AUTH_FILE` | Podman wrapper必要；官方credential store檔案的read-only mount |
| `CODEX_PODMAN_IMAGE` | Podman wrapper image；預設`localhost/voiss-codex-runtime:0.145.0` |
| `CODEX_PROCESS_TIMEOUT_SECONDS` | 每個 run 的上限；預設 `120` |
| `CODEX_REQUEST_TIMEOUT_SECONDS` | JSON-RPC request 上限；預設 `30` |
| `CODEX_APPROVAL_TIMEOUT_SECONDS` | approval等待標記為paused前的時間；預設`300`，timeout後仍可resume或stop |
| `VOISS_WORKTREE_ROOT` | 選填的隔離 worktree root |
| `CODEX_EXPORT_ROOT` | 啟用 evidence export 的 owner-controlled root |
| `VOISS_OBSERVABILITY_LOG` | 選填的絕對 JSONL 路徑；預設寫入本機使用者狀態目錄，採兩檔、每檔 5 MiB 的 bounded retention |
| `VOISS_DB_PATH` | lifecycle/control-plane SQLite 絕對路徑；預設為第一個 allowlisted repository 下的 `.voiss/control-plane.sqlite` |

## HTTP 契約

除精確 Origin 的 CORS preflight 外，所有 request 都需要：

```text
Authorization: Bearer <CODEX_BRIDGE_TOKEN>
```

`POST` 使用 `Content-Type: application/json`。Run 與 resume 回傳
`application/x-ndjson`；當 `Accept` 只指定 `text/event-stream` 時回傳 SSE。
每筆資料都是 AG-UI adapter 可讀的 `{method, params, id?}` envelope。

### `GET /v1/status`

回傳 app-server 版本、去識別的 account readiness、active run count，以及固定
policy。Response 不包含 email、token 或本機 credential。

### `POST /v1/runs`

接受 AG-UI `RunAgentInput` 子集：

```json
{
  "threadId": "agui-thread-1",
  "runId": "agui-run-1",
  "messages": [
    {"id": "user-1", "role": "user", "content": "Inspect and plan."}
  ],
  "state": {
    "repo": "/absolute/allowlisted/repo",
    "codexMode": "read-only",
    "codexThreadId": "optional-codex-thread-id"
  },
  "forwardedProps": {}
}
```

`codexMode` 預設為 `read-only`。寫入 request 先建立一個 Bridge-owned
activation approval；此時尚未建立 worktree，也尚未啟動 Codex turn：

```json
{
  "state": {
    "repo": "/absolute/allowlisted/repo",
    "codexMode": "write",
    "baseRef": "HEAD"
  }
}
```

Client 以回傳的 opaque approval ID 呼叫 `/v1/approvals/resume`，選擇
`allow_once` 或 `allow_run_scope` 後，Bridge 才建立隔離 worktree 並啟動
workspace-write turn。每次 app-server command/file callback 仍由 Bridge
重新檢查 worktree、network 與禁止動作；run scope 只保存在 Bridge policy
store，每個核准回覆維持窄範圍 `accept`。

唯讀 run 可在 `state.codexThreadId` 傳入既有 thread。Bridge 會要求該
thread 的持久化 repository capability 與本次 canonical repository 相符；
service 重啟後會由 `codex_threads` 恢復未 archived 的唯讀 capability。
Archived thread、其他 repository 與 write-thread resume 都維持關閉。

### `POST /v1/approvals/resume`

AG-UI adapter form：

```json
{
  "threadId": "agui-thread-1",
  "runId": "agui-run-resume-1",
  "interruptId": "codex-request:string:...",
  "pendingRequestId": "opaque-approval-id",
  "decision": "accept",
  "authorizationScope": "once"
}
```

Trusted Control Room form：

```json
{
  "type": "run.approval",
  "runId": "agui-run-1",
  "approvalId": "opaque-approval-id",
  "decision": "allow_once"
}
```

Decision 支援 once、run scope 與 deny/cancel。Bridge 以 server-side pending
map 找回原 JSON-RPC callback；`timed_out/paused` approval仍可用原ID明確
resume或stop，unknown、resolved、stopped或run不相符的approval維持關閉。

### `POST /v1/runs/:id/stop`

停止映射到該 external run ID 的 active Codex turn，回傳 HTTP `202`。Stream
接著提供 `turn/completed` 的 `interrupted` 狀態。
若 write activation 仍在等待核准，stop 會撤銷 activation、回傳
`status: "cancelled"`，且不建立 worktree。

### `GET /v1/runs/:id/events?after=<cursor>&limit=<1..200>`

以 internal run ID 或 VOISS external run ID 讀取已持久化事件。Response
依 `sequence` 遞增回傳最多 200 筆事件，並提供 `nextCursor`；client 將它
作為下一次 `after` 值即可續讀。這個 route 支援明確的 server-side replay，
目前不代表瀏覽器已自動 reattach 到執行中的 stream。

### `POST /v1/threads/:id/archive`

Archive 僅接受 Bridge 擁有且目前沒有 active run 的 thread。成功時呼叫
official app-server `thread/archive`、把 `codex_threads` 狀態更新為
`archived`，並移除後續 resume capability。Archive 保留 run events、
evidence export 與 worktree；worktree/branch cleanup 仍是獨立的人員維運動作。

### `POST /v1/evidence/export`

支援明確 run：

```json
{"runId": "agui-run-1", "correlationId": "corr-1"}
```

也接受 Control Room form：

```json
{"type": "evidence.export", "correlationId": "corr-1"}
```

後者選擇最近完成的 write run。Response 只提供 opaque export ID、相對檔名、
byte count 與 SHA-256；本機 absolute paths 保留在 service boundary 內。
匯出 gate 要求 write turn 為 `completed`，且 retained command evidence 至少
包含一個成功的 `pytest`、Vitest、Playwright、`pnpm` lint/typecheck/test/build
或 `git diff --check`。任何可辨識 validation failure 或完全缺少 validation
都回傳 HTTP `409`。成功 validation 必須對應 terminal patch 的 SHA-256 與
最後 mutation generation；`evidence.json` 會保留 gate、counts、checks、
terminal hash 與 generation。

## Lifecycle metadata

Codex Bridge 透過 `VOISS_DB_PATH` 共用 owner-controlled `TrustStore`。
目前主動寫入：

- `agent_runs`：VOISS/internal run IDs、Codex/AG-UI thread IDs、
  repository/worktree、model/profile、來源 IDs、起訖時間、status 與
  correlation ID；
- `codex_threads`：repository/cwd capability、last run、
  active/idle/blocked/archived狀態與 archive 時間；
- `run_events`：bounded sanitized event、sequence 與 replay cursor；
- `approvals`：write activation 與 command/file callback 的
  requested/timed_out/paused/resolved/stopped/blocked狀態；
- `validation_results`：terminal validation counts 與 passed/failed/missing
  狀態；
- `exports`：opaque export ID、run mapping、artifact metadata 與 export 時間。

這組 metadata 支援 service 重啟後續跑已完成 run 所屬的 idle read-only
thread、事件重播與明確 archive。原始 AURA transcript/audio、repository
source、patch artifacts 與 Codex credentials仍留在各自 canonical
boundary。

## 安全範圍

- Repository 與 symlink 先 canonicalize，再比對精確 allowlist。
- Write run 使用獨立 branch/worktree；其 writable root 只有該 worktree。
- 已驗證的Linux container lane使用digest-pinned Ubuntu base、rootless
  Podman與same-path allowlisted mounts；agent write/network authority仍由
  Codex `managed-bubblewrap`執行。
- Web search、Apps、remote plugins、hooks、goals、memories、multi-agent 與
  每個 effective-config MCP server都在 run config 關閉。
- Read-only run 的所有 escalation callback自動拒絕。
- Network approvals、worktree 外路徑、`git push`／merge／PR、deploy、
  external messages 與其他遠端 mutation自動拒絕。
- App-server process 只繼承 Codex 設定與基本 shell 所需的 allowlisted
  environment；Bearer token、Slack token、API keys 與其他 credential
  variables不會傳入。每個 Codex shell 另以 `inherit = none` 啟動。
- Request body、JSON-RPC line、stream queue、event payload 與 patch都有上限；
  overflow 會中斷底層 run。credential-bearing keys與常見 token patterns在
  事件與證據前去識別。
- Runtime 僅接受生成契約對應的 Codex app-server `0.145.0`；restart budget
  橫跨 readiness 前後的整個 Bridge lifetime。
- Write patch 在 terminal notification 當下凍結；匯出反映該次 Codex run，
  後續人員編輯不會被歸入該份 evidence。
- Evidence export 以 completed write status 加 successful validation summary
  作為 authoritative gate；failed 與 missing validation 維持待驗證狀態。
- Validation parser接受官方app-server回報的單一`bash|zsh|sh -lc`
  test command，同時拒絕含shell control operator的複合test聲明；只讀
  `git diff/status`收尾不會誤使已驗證patch變成stale，後續file mutation仍
  會關閉export gate。
- 完成後的 worktree 與 branch 由 operator 保留到 evidence review 結束，再依
  repository 維運流程明確清理；Bridge 不會自動刪除尚待覆核的工作成果。

## Release activation gates

- `GET /v1/runs/:id/events` 已提供 cursor replay；瀏覽器自動 reattach 與
  reconnect UI 是下一個 activation layer。
- Service 重啟後續跑已完成 run 所屬的 idle read-only thread，已通過
  contract test；stale-running reconcile、normal close與app-server crash
  亦以contract test證明會保存bounded `blocked`／`interrupted` metadata。
  跨程序write-thread resume與target-host crash/reconnect live trace由下一個
  activation layer承接。
- Approval 與 stop 已有 contract test。既有 target-host live evidence涵蓋
  `allow_once`；deny、`allow_run_scope`、command/file callback approval、
  stop 與 recovery 各自保留專屬 live trace gate。

## 驗證

```bash
pnpm --filter @voiss/codex-bridge check
git diff --check -- services/codex-bridge
```

2026-07-24 current working-state `check`通過55個Codex Bridge tests。

真實唯讀煙霧測試：

```bash
curl --fail --silent --show-error \
  --header "Authorization: Bearer $CODEX_BRIDGE_TOKEN" \
  http://127.0.0.1:8770/v1/status

curl --fail --silent --show-error \
  --request POST \
  --header "Authorization: Bearer $CODEX_BRIDGE_TOKEN" \
  --header "Content-Type: application/json" \
  --header "Accept: application/x-ndjson" \
  --data '{"threadId":"smoke-thread","runId":"smoke-run","messages":[{"id":"u1","role":"user","content":"Reply with exactly VOISS_CODEX_BRIDGE_READY. Do not use tools and do not modify files."}],"state":{"codexMode":"read-only"},"forwardedProps":{}}' \
  http://127.0.0.1:8770/v1/runs
```
