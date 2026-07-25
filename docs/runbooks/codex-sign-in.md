# Codex 官方登入與 Bridge 啟動

VOISS AURA 使用官方 Codex CLI 的本機認證與 `app-server`。登入由 Codex credential store 管理；Web、CopilotKit state、audit events 與 evidence exports 都只接收正規化狀態，不保存 token 內容。

## 1. 確認 CLI

```bash
command -v codex
codex --version
codex login status
```

判讀方式：

- 顯示已透過 ChatGPT 或其他官方方法登入：可以進入 app-server readiness 檢查。
- 顯示尚未登入：啟動官方登入流程。
- 找不到 `codex`：先依官方 Codex CLI 發行方式安裝，再重新執行上述指令。

每台 target host 都應重新保留 `codex --version` 與 `codex login status` 的去識別輸出；contract test 中的 fake app-server 版本字串不是 live installation evidence。

## 2. 使用官方登入流程

ChatGPT subscription 路徑：

```bash
codex login
```

完成瀏覽器／device flow 後：

```bash
codex login status
```

若受控環境明確採 API key，可由 stdin 交給官方 CLI：

```bash
printenv OPENAI_API_KEY | codex login --with-api-key
```

API key 路徑是一個獨立的 credential activation choice。請勿將 token 貼入 `.env`、browser storage、URL、audit log、issue、commit 或 evidence packet。

## 3. app-server contract

目前 Codex Bridge 的預設 child process 是：

```text
codex app-server --stdio
```

可先檢查本機 CLI 是否提供這個介面：

```bash
codex app-server --help
```

`--stdio` 是 JSON-RPC transport，會持續等待 protocol messages；它不是供人工閱讀的 HTTP health command。`services/codex-bridge/src/index.ts` 的 `CodexBridge.start()` 會：

1. 啟動 child process。
2. 呼叫 `initialize`。
3. 發送 `initialized`。
4. 呼叫 `account/read`，且 `refreshToken: false`。
5. 僅回傳 `signedIn`、account type、plan type、是否需要 OpenAI auth 與 server version。

## 4. 執行權限

Codex Bridge library 的目前 policy：

- model request：`gpt-5.6-sol`
- reasoning effort：`max`
- 初始 planning sandbox：`read-only`
- network：`off`
- approval policy：`on-request`
- approval reviewer：`user`
- write scope：每個 run 的 isolated Git worktree
- remote Git、PR、deploy 與 external message：維持 release authority 之外

Write run 只有在 `allow_once` 或 `allow_run_scope` 後建立：

```text
<repo>/.voiss/worktrees/<run-id>/
```

repository 必須透過 `VOISS_ALLOWED_REPOSITORIES` 明確 allowlist；library embedding也可使用`allowedRepoRoots` constructor option。Bridge 會記錄 base commit，並把 command/file approval 保留為 typed operator decision。

## 5. 啟動 loopback service

從 repository root 設定 per-launch token、canonical repository allowlist 與 evidence export root：

```bash
export CODEX_BRIDGE_TOKEN="$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')"
export VOISS_ALLOWED_REPOSITORIES=/absolute/path/to/project_aura-voiss-mvp
export CODEX_EXPORT_ROOT=/absolute/path/to/local-evidence
export VOISS_ALLOWED_ORIGINS=http://127.0.0.1:3000
export VOISS_DB_PATH=/absolute/path/to/local-state/control-plane.sqlite
export CODEX_APPROVAL_TIMEOUT_SECONDS=300
```

完成共用設定後，先選擇下方Podman或direct-host lane，再啟動Bridge。
Service固定bind `127.0.0.1`，預設使用`CODEX_BRIDGE_PORT=8770`。可調整的
server-side設定包括：

- `CODEX_BIN`：預設 `codex`；
- `CODEX_PROCESS_TIMEOUT_SECONDS`：預設 `120`；
- `CODEX_REQUEST_TIMEOUT_SECONDS`：預設 `30`；
- `VOISS_WORKTREE_ROOT`：選填 isolated worktree root；
- `VOISS_ALLOWED_REPO_ROOTS`：repository allowlist 的相容 alias；
- `CODEX_ALLOWED_ORIGINS`：服務專用 Origin 設定，優先於 generic
  `VOISS_ALLOWED_ORIGINS`；
- `VOISS_DB_PATH`：lifecycle/control-plane SQLite 絕對路徑；未設定時使用
  第一個 allowlisted repository 下的 `.voiss/control-plane.sqlite`。

Ubuntu 24.04 的verified lane由rootless Podman提供Codex runtime環境：

```bash
pnpm codex:runtime:build
export CODEX_BIN=/absolute/path/to/project_aura-voiss-mvp/services/codex-bridge/run-in-podman.sh
export CODEX_VENDOR_DIR=/absolute/path/to/codex-linux-vendor/x86_64-unknown-linux-musl
export CODEX_AUTH_FILE=/absolute/path/to/codex-home/auth.json
export CODEX_PODMAN_IMAGE=localhost/voiss-codex-runtime:0.145.0
pnpm --filter @voiss/codex-bridge start
```

這條lane把official vendor與credential檔案以read-only方式mount；allowlisted
repository、worktree與export roots使用same-path mount。Codex app-server
可連接官方模型，而每個agent command繼續由`managed-bubblewrap`套用
read-only／workspace-write與network-off policy。

Direct-host lane先通過：

```bash
codex sandbox \
  -C /absolute/path/to/project_aura-voiss-mvp \
  -P :workspace \
  -- true
pnpm --filter @voiss/codex-bridge start
```

若`:workspace` preflight未成立，使用上方verified Podman lane；不要把
workspace-write降級成legacy Landlock或no-sandbox。

另開 terminal 讀取正規化 readiness：

```bash
export CODEX_BRIDGE_TOKEN='<same launch token used by Codex Bridge>'
curl --fail --silent --show-error \
  --header "Authorization: Bearer $CODEX_BRIDGE_TOKEN" \
  http://127.0.0.1:8770/v1/status
```

HTTP surface 提供：

- `GET /v1/status`；
- `POST /v1/runs`，以 NDJSON 或 SSE 傳送 AG-UI envelopes；
- `POST /v1/approvals/resume`，接受 adapter 與 trusted Control Room form；
- `POST /v1/runs/{run_id}/stop`；
- `GET /v1/runs/{run_id}/events?after={cursor}&limit={1..200}`，依sequence重播
  已保存事件並回傳`nextCursor`；
- `POST /v1/threads/{thread_id}/archive`，archive idle thread並關閉後續
  resume capability；
- `POST /v1/evidence/export`，回傳 opaque export ID、相對檔名、byte count與hash，不回傳local absolute path。

Workspace-write 使用兩階段啟動：`POST /v1/runs`收到`codexMode=write`時，先串流Bridge-owned opaque approval request，且不建立worktree；operator透過`POST /v1/approvals/resume`選擇`allow_once`或`allow_run_scope`後，Bridge才建立isolated worktree並啟動write run。Deny會以interrupted terminal event結束，canonical repository維持不變。

Bridge在`VOISS_DB_PATH`主動保存`agent_runs`、`codex_threads`、
`run_events`、`approvals`、`validation_results`與`exports`。每個 started
run保留VOISS/internal run IDs、Codex/AG-UI thread IDs、repository/worktree、
model/profile、來源 IDs、起訖時間、status與correlation ID。Service重啟後，
已完成run所屬、未archived的idle唯讀thread可在相同canonical repository
傳入`state.codexThreadId`續跑；archive會保留事件、export與worktree，
並停止該thread後續resume。

Approval超過`CODEX_APPROVAL_TIMEOUT_SECONDS`後保存為
`timed_out/paused`，operator仍可用原approval明確resume或stop。Service
restart時的stale active lifecycle與app-server crash會保存為`blocked`並拒絕
不安全的自動續跑；normal close則保存affected run為`interrupted`並關閉
thread capability。

這些 routes、Bearer boundary、bounded body/event stream與server-side
config已有實作面；lifecycle persistence、cursor replay、service restart後
唯讀resume、archive、approval timeout與fail-closed blocked lifecycle已有
contract test。2026-07-24 的target host已完成actual
`/v1/status`、read-only plan、`allow_once`、isolated write、real pytest、
`git diff --check`與checksummed export。瀏覽器自動reattach、跨程序
write-thread resume、target-host crash/reconnect，以及deny、
`allow_run_scope`、command/file callback approval、stop與recovery，仍各自
需要target-host live trace。每個新target host與repository繼續以自己的live
evidence建立runtime assurance。

## 6. 驗收紀錄

Real local Codex readiness 應保留：

- target commit；
- `codex --version`；
- 去識別的 `codex login status`；
- `initialize` 所見 server version；
- `account/read` 正規化狀態；
- requested 與 observed model/profile；
- sandbox 與 network state；
- allowlisted repository canonical path；
- read-only plan 的 thread/run/correlation IDs；
- SQLite lifecycle row與event replay cursor；
- operator approval；
- isolated worktree 與 base commit；
- actual command、diff、tests 與 completion status；
- redacted event log 與 evidence export；
- 若執行archive，保留archived status/time與resume被拒絕的結果。

任何一項仍未知時，以 `unknown`、`attention` 或 activation gate 呈現，不用 demo fixture 補成 live 結果。

## 7. 登出與 credential 變更

Credential 變更屬於外部人工流程。先停止使用中的 Codex bridge process，再透過官方 CLI 管理登入狀態。VOISS AURA 的一般 UI 不提供密碼、token 編輯或 credential migration。
