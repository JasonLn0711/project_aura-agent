# VOISS AURA Control Room 本機設定

本文件提供兩條明確分離的啟動路徑：

- `demo`：使用公開／去識別 fixture、synthetic audio 與 scripted events，適合產品走查。
- `local`：連接 AURA canonical artifacts、官方 Codex client 與受允許的 Git repository，適合真實本機驗證。

畫面上的 `DEMO MODE` 或 `LOCAL MODE` 徽章是證據分類的一部分。Demo 的 diff、tests、readiness 與 audit 皆為可重播 fixture；只有保留真實服務回應、工作樹、命令、diff 與驗證紀錄後，才能形成 real local runtime 證據。

## 1. 目前證據層級

| 層級 | 目前可用範圍 | 可支持的敘述 |
|---|---|---|
| Demo fixture | `packages/demo-fixtures`、synthetic WAV、Control Room scripted transitions | 使用者流程與受控 UI 可重播 |
| Contract test | Web、domain、agent adapter、trust engine 與 bridge 測試檔 | 契約與預期行為已有可執行測試面；結果須由本次實際指令證明 |
| Real local runtime | AURA Bridge、Codex Bridge、Web proxies 與 official Codex app-server path | 2026-07-24 已完成一次受控 Web → AURA → Codex live E2E；每次 target run 仍以自己的 worktree、命令、diff、validation、audit 與 export 證據為準 |

目前已驗證的 local baseline：

1. `services/codex-bridge` 提供 loopback Bearer boundary、NDJSON／SSE event
   stream，以及 status/run/resume/stop、cursor replay、thread archive與
   export routes；official app-server `0.145.0` 已完成真實 read-only plan
   與 approved write run。
2. Local Agent Runs 由 actual Codex plan、command、file、diff、approval、
   validation 與 completion events 驅動；demo replay 保留獨立分類。
3. Local trust 由 owner-only SQLite `TrustStore` 保存 assets、controls、
   findings、hash-chained audit，以及 Codex `agent_runs`、`codex_threads`、
   `run_events`、`approvals`、`validation_results`與`exports` lifecycle
   metadata。CopilotKit runner另以獨立owner-only SQLite保存thread/run
   history；live approval resume保留plan → write interrupt → resume child的
   parent-linked lineage。成功的 bridge export 更新對應 run 的 controls 與
   audit evidence。R-002 的 `remediated` transition另由同一 run 綁定的 approval、
   export、bounded queue、overload semantics、durable audio、provisional
   behavior、telemetry 與 relevant validation 完整證據啟動。
4. AURA readiness、session/segment/claim/action query、audio span、typed
   claim review 與 evidence export 已接到 canonical fixture artifacts，並在
   live browser flow 中完成驗證。
5. Linux write runtime 的已驗證路徑是 rootless Podman 內的 official Codex
   app-server，再由 Codex `managed-bubblewrap` 對每個 agent command 提供
   worktree scope 與 network denial。這個容器不是 agent sandbox 的替代品；
   它提供本機相容執行環境，真正的工具權限仍由 Codex sandbox policy執行。
   獨立socket canary對`1.1.1.1:443`的連線在socket建立階段得到
   `PermissionError: [Errno 1] Operation not permitted`。

這份 baseline 支持 `LOCAL_E2E_VALIDATED`。它涵蓋一個 synthetic AURA
artifact set與一個受控 Git fixture；新的 repository／host 仍沿用相同
allowlist、preflight與retained-evidence gate。

## 2. 工具需求

- Node.js `>=22.18`，與 Codex Bridge package engine 對齊。
- pnpm `11.17.0`，版本由根目錄 `package.json` 固定。
- Python `>=3.10`。
- `uv` 與 Git。
- 官方 Codex CLI；只有 real local Codex 路徑需要登入。
- Rootless Podman；Ubuntu 24.04 的已驗證 workspace-write 路徑使用它承載
  official Codex runtime。

先從 repository root 確認工具：

```bash
node --version
pnpm --version
python3 --version
uv --version
git --version
podman --version
```

## 3. Frozen 安裝

從 repository root 執行：

```bash
pnpm install --frozen-lockfile
uv sync --all-extras --all-packages --frozen
```

`pnpm-lock.yaml` 與 `uv.lock` 是 release dependency evidence。Frozen 安裝若偵測到 lock drift，請先檢視 manifest 與 lockfile 差異，再用獨立變更更新 lockfile。

## 4. 啟動 deterministic demo

```bash
pnpm demo
```

開啟：

```text
http://127.0.0.1:3000
```

Demo 的資料來源為：

- `packages/demo-fixtures/src/index.ts`
- `apps/voiss-aura-web/public/demo/voiss-aura-architecture-review.wav`
- `apps/voiss-aura-web/components/control-room.tsx`

重新整理頁面可將目前的 client-side fixture state 回到起始狀態。瀏覽器匯出的 evidence packet 是「根據模擬事件產生的真實 JSON 檔」，其分類為 `deterministic_demo_evidence`，不等同於 live Codex 或 live AURA 執行結果。

完整講稿見 `docs/demo/five-minute-demo.md`。

## 5. 啟動 AURA Bridge

先選定包含 AURA `session.json` artifacts 的絕對路徑：

```bash
export AURA_ARTIFACT_ROOT=/absolute/path/to/aura-sessions
export AURA_BRIDGE_TOKEN="$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')"
export AURA_ALLOWED_ORIGINS=http://127.0.0.1:3000
uv run --frozen --package voiss-aura-bridge aura-bridge
```

AURA Bridge 固定綁定 `127.0.0.1`，預設 port 是 `8765`。另開 terminal 驗證實際 endpoint：

```bash
export AURA_BRIDGE_TOKEN='<same launch token used by AURA Bridge>'
curl --fail --silent --show-error \
  --header "Authorization: Bearer $AURA_BRIDGE_TOKEN" \
  http://127.0.0.1:8765/v1/health
```

詳細設定與 API 操作見 `docs/runbooks/aura-bridge.md`。

## 6. 準備 Codex 官方登入

```bash
codex --version
codex login status
```

需要登入時，使用官方流程：

```bash
codex login
```

應用程式只透過 `codex app-server --stdio` 的 `account/read` 取得正規化狀態；瀏覽器不接收 Codex token。詳細步驟見 `docs/runbooks/codex-sign-in.md`。

## 7. 啟動 Codex Bridge

從 repository root 選定受允許的 canonical repository 與 owner-controlled export root：

```bash
export CODEX_BRIDGE_TOKEN="$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')"
export VOISS_ALLOWED_REPOSITORIES=/absolute/path/to/project_aura-voiss-mvp
export CODEX_EXPORT_ROOT=/absolute/path/to/local-evidence
export VOISS_ALLOWED_ORIGINS=http://127.0.0.1:3000
export VOISS_DB_PATH=/absolute/path/to/local-state/control-plane.sqlite
export VOISS_WORKTREE_ROOT=/absolute/path/to/local-worktrees
export VOISS_OBSERVABILITY_LOG=/absolute/path/to/local-state/codex-bridge.jsonl
```

### 7.1 已驗證的 rootless Podman lane

先建立 digest-pinned runtime image：

```bash
pnpm codex:runtime:build
```

再提供官方 Codex Linux vendor directory與官方 credential store檔案。兩者
都以 read-only mount進入container；browser、Web state、audit與export不會
取得credential內容：

```bash
export CODEX_BIN=/absolute/path/to/project_aura-voiss-mvp/services/codex-bridge/run-in-podman.sh
export CODEX_VENDOR_DIR=/absolute/path/to/codex-linux-vendor/x86_64-unknown-linux-musl
export CODEX_AUTH_FILE=/absolute/path/to/codex-home/auth.json
export CODEX_PODMAN_IMAGE=localhost/voiss-codex-runtime:0.145.0
pnpm --filter @voiss/codex-bridge start
```

`CODEX_VENDOR_DIR` 指向官方平台套件中同時包含 `bin/codex`、
`codex-resources/bwrap` 與 `codex-path/rg` 的 directory。Wrapper只 mount
allowlisted repository、worktree root、export root、vendor directory與單一
auth檔；repository/worktree/export roots保持與host相同的absolute path，
因此Bridge的canonical path檢查在兩層runtime中一致。

### 7.2 Direct-host lane

已完成官方 Linux sandbox prerequisites 的host可先執行：

```bash
codex sandbox \
  -C /absolute/path/to/allowed-repository \
  -P :workspace \
  -- true
```

此preflight通過後，可省略`CODEX_BIN`與Podman-specific變數，讓Bridge使用
`codex`。在啟用unprivileged-user-namespace限制的Ubuntu host上，採用上方
rootless Podman lane即可保留managed workspace-write與network-off語意，
無須調整全域kernel policy。

Bridge 固定綁定 `127.0.0.1`，預設 port 是 `8770`。啟動時會先連接 official `codex app-server --stdio`，確認 account signed-in，再輸出不含 credential 的 readiness JSON。另開 terminal 驗證實際 endpoint：

```bash
export CODEX_BRIDGE_TOKEN='<same launch token used by Codex Bridge>'
curl --fail --silent --show-error \
  --header "Authorization: Bearer $CODEX_BRIDGE_TOKEN" \
  http://127.0.0.1:8770/v1/status
```

`ready=true` 支持該次 process 的 account 與 transport readiness；actual plan、
worktree、diff、tests、stop 與 export 仍由各 run 的實際事件證明。Bridge
會把 lifecycle metadata寫入`VOISS_DB_PATH`，並在 service restart後恢復
未 archived 的唯讀 thread capability。詳細設定見
`docs/runbooks/codex-sign-in.md` 與 `services/codex-bridge/README.md`。

## 8. 啟動 local Web shell

Local Web 已具備 AURA readiness、session/segments/claims/actions query、audio與claim-review proxy，也具備 Codex status、run、approval、stop與export transport。先在 Web process設定與兩個 running bridges一致的server-side環境：

```bash
export VOISS_SESSION_SECRET="$(python3 -c 'import secrets; print(secrets.token_urlsafe(48))')"
export VOISS_WEB_ORIGINS=http://127.0.0.1:3000
export AURA_BRIDGE_URL=http://127.0.0.1:8765
export AURA_BRIDGE_TOKEN='<same launch token used by AURA Bridge>'
export CODEX_BRIDGE_URL=http://127.0.0.1:8770
export CODEX_BRIDGE_TOKEN='<same launch token used by Codex Bridge>'
export VOISS_DB_PATH=/absolute/path/to/local-state/control-plane.sqlite
export VOISS_AGENT_DB_PATH=/absolute/path/to/local-state/copilotkit-agent-runs.sqlite
pnpm dev
```

`pnpm dev` 由 package script明確設定 `VOISS_MODE=local`，並綁定
`127.0.0.1:3000`。Bridge回應時，Control Room會保留完整AURA session清單，
並依使用者選擇載入session detail、freshness、segments、claims與actions；
所選segment直接決定經Bridge驗證的audio span。載入失敗時，本機畫面以空的
AURA context與明確disconnected notice維持fail-closed，Codex委派保持關閉；
Demo僅透過`pnpm demo`獨立啟動。成功路徑使用actual AURA response、Codex
stream、worktree、persistent TrustStore與bridge-generated download作為
authoritative state。瀏覽器只保留screen、session、segment與filter等非敏感
導覽選擇；mode、CSRF與bridge credentials持續由server-side session與環境設定
管理。

## 9. 已接線的環境變數

| 變數 | 使用位置 | 目前作用 |
|---|---|---|
| `VOISS_MODE` | Web session、status、mutation route | `local` 才啟用 bridge proxy；其他值採 demo |
| `VOISS_SESSION_SECRET` | Web server | HMAC 簽署 local session；未設定時每個 process 產生暫時 secret |
| `VOISS_WEB_ORIGINS` | Web mutation security | 允許的精確 Origin，預設含 `127.0.0.1:3000` 與 `localhost:3000` |
| `AURA_BRIDGE_URL` | Web server | AURA readiness 與 mutation proxy 的目標 base URL |
| `AURA_BRIDGE_TOKEN` | Web server、AURA Bridge | server-to-server Bearer token；Bridge 要求至少 16 字元 |
| `CODEX_BRIDGE_URL` | Web server | Codex status、run、approval、stop與export的 loopback base URL |
| `CODEX_BRIDGE_TOKEN` | Web server、Codex Bridge | per-launch server-to-server Bearer token；至少 16 bytes |
| `VOISS_ALLOWED_REPOSITORIES` | Codex Bridge | 逗號分隔的 canonical absolute repository roots；必填 |
| `VOISS_ALLOWED_REPO_ROOTS` | Codex Bridge | `VOISS_ALLOWED_REPOSITORIES` 的相容 alias |
| `CODEX_ALLOWED_ORIGINS` | Codex Bridge | 服務專用的精確 loopback HTTP origins；設定時優先於 generic alias |
| `VOISS_ALLOWED_ORIGINS` | Codex Bridge | 精確 loopback HTTP origins 的 generic alias |
| `CODEX_BRIDGE_PORT` | Codex Bridge | port，預設 `8770` |
| `CODEX_BIN` | Codex Bridge | Codex executable，預設 `codex` |
| `CODEX_VENDOR_DIR` | Podman wrapper | 官方 Codex Linux platform package 的 vendor directory |
| `CODEX_AUTH_FILE` | Podman wrapper | 官方 Codex credential store檔案；read-only mount |
| `CODEX_PODMAN_IMAGE` | Podman wrapper | runtime image；預設 `localhost/voiss-codex-runtime:0.145.0` |
| `CODEX_PROCESS_TIMEOUT_SECONDS` | Codex Bridge | 每個 run 的上限，預設 `120` |
| `CODEX_REQUEST_TIMEOUT_SECONDS` | Codex Bridge | JSON-RPC request 上限，預設 `30` |
| `CODEX_APPROVAL_TIMEOUT_SECONDS` | Codex Bridge | approval等待標記為paused前的秒數，預設`300`；timeout後仍可resume或stop |
| `VOISS_WORKTREE_ROOT` | Codex Bridge | 選填的 isolated worktree root |
| `CODEX_EXPORT_ROOT` | Codex Bridge | 啟用 patch/evidence/checksum export 的 owner-controlled root |
| `VOISS_OBSERVABILITY_LOG` | Codex Bridge | 結構化、去識別且 bounded 的本機 JSONL 絕對路徑 |
| `VOISS_DB_PATH` | Web、Codex Bridge | lifecycle/control-plane SQLite 絕對路徑 |
| `AURA_ARTIFACT_ROOT` | AURA Bridge | canonical session artifact root，必填 |
| `AURA_ALLOWED_ORIGINS` | AURA Bridge | 逗號分隔的精確 loopback HTTP origins |
| `AURA_BRIDGE_PORT` | AURA Bridge | port，預設 `8765` |
| `AURA_EVIDENCE_INDEX` | AURA Bridge | derived SQLite index |
| `AURA_AUDIT_ROOT` | AURA Bridge | hash-chained bridge audit directory |
| `VOISS_EXPORT_ROOT` | AURA Bridge | evidence export directory |
| `VOISS_AGENT_DB_PATH` | CopilotKit runtime | named-agent thread/run state 的 owner-controlled SQLite path |

`VOISS_DB_PATH` 是已接線的 persistent TrustStore path；Web與Codex Bridge
使用同一路徑時，共用 lifecycle/control-plane metadata。兩者都會建立
owner-only parent與SQLite檔；建議明確設定絕對路徑。未設定時使用
repository-local `.voiss/control-plane.sqlite`。Codex Bridge主動寫入
`agent_runs`、`codex_threads`、`run_events`、`approvals`、
`validation_results`與`exports`，並以cursor replay支援已保存事件。
`VOISS_AGENT_DB_PATH`則由CopilotKit `SqliteAgentRunner`專用，保存named-agent
thread/run history。這兩個變數必須指向不同SQLite檔案，因為兩者擁有獨立
schema。
`CODEX_MODEL`、`CODEX_SANDBOX` 與
`CODEX_NETWORK_ACCESS` 不是 runtime override：Codex Bridge固定要求
`gpt-5.6-sol`、`max`、read-only／approved workspace-write與network off，
讓release evidence對齊單一政策。

Lifecycle persistence、`GET /v1/runs/{run_id}/events`、service restart後
續跑已完成run所屬的idle唯讀thread、
`POST /v1/threads/{thread_id}/archive`，以及stale-running／normal close／
app-server crash的bounded lifecycle metadata已有contract test。瀏覽器自動
reattach、跨程序write-thread resume、target-host crash/reconnect，以及除
既有`allow_once`外的各approval與stop target-host live trace，保留為release
activation gates。

AURA Bridge 的 operational log 預設位於 `AURA_AUDIT_ROOT` 同層的
`observability/aura-bridge.jsonl`；兩個 bridge 都採兩檔、每檔 5 MiB 的
bounded retention，並在寫入前去識別 credential-like 欄位。

`OPENAI_API_KEY` 與 `COPILOTKIT_PUBLIC_API_KEY` 不是 deterministic demo 的必要條件；官方 Codex subscription path 也不需要將 API key 放入瀏覽器。

## 10. 品質指令

以下是 release evidence 的執行入口；每次 release 都應保留該次 stdout、stderr、exit code、commit 與工具版本：

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm build
uv run pytest -q
uv run ruff check services/aura-bridge
uv run ruff format --check services/aura-bridge
git diff --check
```

指令出現在 runbook 代表驗證契約已定義；只有實際成功執行並保留紀錄，才可勾選 `docs/release-checklist.md`。
