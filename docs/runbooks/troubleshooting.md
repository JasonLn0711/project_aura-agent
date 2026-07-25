# VOISS AURA Control Room 疑難排解

先確認畫面徽章與證據層級。`DEMO MODE` 使用 fixture；`LOCAL MODE` 的 live 狀態需由實際 bridge response、Codex app-server、worktree、diff 與 validation records 支持。系統不以 demo 結果補足 local runtime。

## 快速診斷順序

```bash
git status --short
node --version
pnpm --version
python3 --version
uv --version
codex --version
codex login status
```

接著分層確認：

1. Web 是否綁定 `127.0.0.1:3000`。
2. AURA Bridge 的 `/v1/health` 是否以正確 Bearer token 回應。
3. Codex CLI 是否安裝、已登入且提供 `app-server --stdio`。
4. 目標 repository 是否為 canonical allowlisted root。
5. 畫面事件是否有同一個 correlation ID。

## `pnpm demo` 無法啟動

先確認 frozen dependencies：

```bash
pnpm install --frozen-lockfile
```

確認 port：

```bash
ss --listening --tcp --numeric --processes | rg ':3000'
```

若已有受信任的本機服務使用該 port，先停止或重新配置該服務。Current demo script 固定使用 `127.0.0.1:3000`；變更 port 時也要同步 exact-origin security 與 Playwright base URL。

Demo 首次安裝可能需要 package registry；依賴已安裝後，fixture 執行不需要 Codex login、GPU、Ollama 或 private data。

## Frozen lock 安裝拒絕

Frozen mode 會把 manifest/lock drift 轉成可見 release gate。先檢視：

```bash
git diff -- package.json pnpm-lock.yaml pyproject.toml uv.lock
```

若 dependency 變更是本輪 scope，使用獨立 commit 更新 manifest 與 lockfile，再重新執行 frozen install。若不是本輪 scope，保留原始差異並由變更 owner 處理。

## Web 顯示 AURA disconnected，但 Bridge health 正常

先直接確認實際 endpoint：

```bash
curl --fail --silent --show-error \
  --header "Authorization: Bearer $AURA_BRIDGE_TOKEN" \
  http://127.0.0.1:8765/v1/health
```

Web status route會probe `<AURA_BRIDGE_URL>/v1/health`。若direct curl成功而Web仍disconnected，確認：

- Web process已在設定環境變數後重新啟動；
- `AURA_BRIDGE_URL`沒有重複的`/v1`；
- Web與Bridge使用相同token；
- request timeout內Bridge可回應；
- `VOISS_WEB_ORIGINS`第一個origin也存在於`AURA_ALLOWED_ORIGINS`。

## Local claim回傳 `400`、`404`或`409`

Web已把claim review映射到：

```text
/v1/sessions/{session_id}/claims/{claim_id}/review
```

`400`表示browser payload contract未成立；`404`表示session/claim identity不在目前artifact root；`409`表示evidence freshness、support或review transition gate保留關閉。用相同ID直接讀取session與claims，再對照correlation audit。

## Local approval、stop或export回傳 `404`／`409`／`503`

Web的Codex contract使用：

- `/v1/approvals/resume`
- `/v1/runs/{run_id}/stop`
- `/v1/evidence/export`

依 route 判讀：

- approval `404`：approval ID不是該run目前的pending request、已被使用或已過期；
- stop `404`：external run ID沒有映射到active run；
- export `409`：目前沒有已完成的write run、`CODEX_EXPORT_ROOT`未提供可用
  boundary、沒有recognized successful validation、validation失敗，或
  validation後的mutation使terminal patch不再相符；
- status `503`：official Codex app-server未能啟動或取得account readiness；
- Web `503 bridge_not_configured`：Web process沒有取得Bridge URL/token。

保留HTTP status、去識別error code、run/correlation ID與Bridge log，讓問題回到正確的activation gate。Demo UI transition維持fixture分類。

Approval超過`CODEX_APPROVAL_TIMEOUT_SECONDS`後會保留為
`timed_out/paused`，同一approval仍可明確resume或stop。Service restart會把
stale active lifecycle收斂為`blocked`；normal close保留affected run為
`interrupted`，app-server crash則保留affected run/thread為`blocked`。
這些metadata讓operator先稽核exact run，再啟動新的受控操作。

## 回傳 `503 bridge_not_configured`

Local AURA paths需要：

```text
AURA_BRIDGE_URL
AURA_BRIDGE_TOKEN
```

Local Codex paths需要：

```text
CODEX_BRIDGE_URL
CODEX_BRIDGE_TOKEN
```

重新啟動 Web process 讓環境變數生效。Token 保留在 server process；不要使用 `NEXT_PUBLIC_` 前綴。

## AURA Bridge 回傳 `401`

確認：

- Request 使用 `Authorization: Bearer ...`。
- Request token 與啟動 Bridge 時的 token 完全相同。
- `AURA_BRIDGE_TOKEN` 至少 16 字元。
- Token 沒有被 shell 引號、換行或不同 terminal 的新值改變。

產生新的 launch token 後，Bridge 與 Web server 必須一起更新並重啟。

## AURA Bridge 回傳 `403`

常見的安全控制：

- Origin 不在 `AURA_ALLOWED_ORIGINS`。
- Artifact path 離開 `AURA_ARTIFACT_ROOT`。
- Artifact 或 parent path 使用 symlink。
- Request 嘗試 traversal。

確認精確 origin：

```text
http://127.0.0.1:3000
```

`http://localhost:3000` 與 `http://127.0.0.1:3000` 是不同 origin；需要哪一個就明確列入 allowlist。

## AURA Bridge 回傳 `409`

Claim review 只有在 source evidence、freshness 與 transition 規則成立時才會接受。讀取：

```text
GET /v1/sessions/{session_id}
GET /v1/sessions/{session_id}/claims
```

確認 `transcript_hash_state`、`support_status`、`source_segment_ids` 與目前 `review_status`。補齊 canonical evidence 或重新產生 current summary 後，再由人員覆核。

## Audio span 回傳 `404`、`415`、`416` 或 `413`

- `404`：manifest 沒有該 track 或 meeting。
- `415`：目前 bridge contract 只產生 validated WAV spans。
- `416`：時間範圍落在音檔之外。
- `413`：超過 60 秒或 20 MB response boundary。

非 WAV import 的本機播放需要另行啟動受控 transcoding path；先保留原始 canonical media，不以任意檔案讀取繞過 bridge。

## Evidence search 或 actions 回傳可復原錯誤

Search/actions 會 on-demand 重建 `AURA_EVIDENCE_INDEX`。確認：

- artifact root 可讀；
- index parent 可建立且不是 symlink；
- `meeting_id` 在 root 內唯一；
- `session.json`、`segments.json`、`summary.json` 是有效 JSON；
- 磁碟仍有空間。

Bridge 對外只回傳去識別錯誤與 correlation ID。以該 ID 對照 server-side logs 與 `voiss-aura-bridge.jsonl`，避免把 absolute path 或 private content 貼到外部 issue。

## Codex CLI 找不到

```bash
command -v codex
codex --version
```

使用官方 Codex CLI 安裝流程完成target host activation。Evidence review與
deterministic demo可獨立使用；local status會把delegation gate呈現為
attention，安裝並通過readiness後即可啟動。

## Codex 尚未登入

```bash
codex login
codex login status
```

VOISS 不提供自訂帳密表單。完成官方流程後重新啟動 Codex bridge，讓 `account/read` 取得新狀態。

## Codex Bridge URL 無法連線

先在Bridge terminal確認啟動設定與listener：

```bash
export CODEX_BRIDGE_TOKEN="$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')"
export VOISS_ALLOWED_REPOSITORIES=/absolute/path/to/allowed-repository
export CODEX_EXPORT_ROOT=/absolute/path/to/local-evidence
export VOISS_WORKTREE_ROOT=/absolute/path/to/local-worktrees
export CODEX_ALLOWED_ORIGINS=http://127.0.0.1:3000
pnpm codex:runtime:build
export CODEX_BIN=/absolute/path/to/project_aura-voiss-mvp/services/codex-bridge/run-in-podman.sh
export CODEX_VENDOR_DIR=/absolute/path/to/codex-linux-vendor/x86_64-unknown-linux-musl
export CODEX_AUTH_FILE=/absolute/path/to/codex-home/auth.json
pnpm --filter @voiss/codex-bridge start
```

```bash
ss --listening --tcp --numeric --processes | rg ':8770'
curl --fail --silent --show-error \
  --header "Authorization: Bearer $CODEX_BRIDGE_TOKEN" \
  http://127.0.0.1:8770/v1/status
```

Startup fail時依error message確認：Codex CLI可執行且已登入、allowlist每一項都是既存absolute repository path、port未被占用、token長度成立、origin是含明確port的loopback HTTP origin。Bridge與Web process使用同一個launch token，且Web的`CODEX_BRIDGE_URL`為`http://127.0.0.1:8770`。

## `managed-bubblewrap` 回報 user namespace／loopback 權限錯誤

先用direct-host preflight確認：

```bash
codex sandbox \
  -C /absolute/path/to/allowed-repository \
  -P :workspace \
  -- true
```

Ubuntu 24.04啟用unprivileged-user-namespace限制但尚未載入targeted AppArmor
profile時，可能看到`bwrap`建立loopback失敗。可採兩條受支持路徑：

1. 依[官方 Codex Linux sandbox prerequisites](https://developers.openai.com/codex/concepts/sandboxing#prerequisites)
   啟用targeted AppArmor profile，再重新執行`:workspace` preflight。
2. 使用本repo的rootless Podman lane；它在container內保留official
   `managed-bubblewrap`，不把workspace-write降級成legacy Landlock或
   no-sandbox。

Podman lane readiness：

```bash
podman image exists localhost/voiss-codex-runtime:0.145.0 \
  || pnpm codex:runtime:build
curl --fail --silent --show-error \
  --header "Authorization: Bearer $CODEX_BRIDGE_TOKEN" \
  http://127.0.0.1:8770/v1/status
```

Status應顯示`policy.sandboxBackend=managed-bubblewrap`與
`policy.networkAccess=false`。
不要以`use_legacy_landlock`繞過`:workspace`permission profile；該組合不
提供此P0 write policy要求的direct enforcement。

## Codex Bridge 回傳 `401` 或 `403`

- `401`：Bearer header缺少或token與Bridge process不同。
- `403 origin_required`：CORS preflight缺少`Origin`。
- `403 origin_forbidden`：request的Origin未精確列在`CODEX_ALLOWED_ORIGINS`。

Next.js server-to-server requests可不帶browser Origin，仍必須提供Bearer token。Browser不可直接取得或呼叫Bridge token。

## CopilotKit runtime route 回傳 `404`

Repository目前以`app/api/copilotkit/[...path]/route.ts`建立CopilotKit runtime，並註冊`voiss_orchestrator`、`codex_engineer`與`demo_agent`。若仍回傳`404`，確認Next dev server已從最新worktree重啟、request使用CopilotKit handler的實際subpath，並檢視build route manifest。Demo agent可credential-free執行；local `codex_engineer`需要running Codex Bridge與official app-server readiness。

Local runtime另需確認`VOISS_AGENT_DB_PATH`的parent與SQLite檔可由Web process
寫入，且它與`VOISS_DB_PATH`指向不同檔案。Approval resume會在同一thread下
建立新的run ID，runner history應以`parent_run_id`形成
plan → write interrupt → resume child lineage；settled state應為
`is_running=0`、`current_run_id=null`。

## App-server crash、malformed JSON 或 timeout

Codex Bridge library 提供 bounded restart、protocol error、run timeout 與 interrupt handling。處理原則：

1. 保留 run/thread/correlation IDs。
2. 記錄 child process exit 與去識別錯誤分類。
3. 只在 thread semantics 明確時 reconnect。
4. 保留 isolated worktree。
5. Approval `timed_out/paused`可由operator resume或stop；stale/crashed active
   run與thread收斂為`blocked`並拒絕直接resume。
6. Normal shutdown把affected run保存為`interrupted`，thread保存為
   `blocked`。

Contract test證明bounded lifecycle preservation；target CLI的實際
crash/reconnect trace才支持automatic active/write recovery的release claim。

## Approval 後沒有真實 diff 或 tests

先看 mode badge。Demo 會 replay `demoExpectedPatch` 與 `demoExpectedTests`，並在 UI 顯示 scripted PASS。Local mode 必須保留：

- actual worktree path 與 base commit；
- actual command output；
- actual `git diff`；
- actual test exit codes；
- observed completion status。

任何一項缺少時，finding 保留 open，evidence packet 標示 skipped/unknown/failed。

## Playwright 找不到 browser

依賴安裝完成後，在允許下載 browser binary 的環境執行：

```bash
pnpm exec playwright install chromium
```

Deterministic browser suite共有18個cases，入口為`pnpm test:e2e`。Guarded
live suite是`apps/voiss-aura-web/tests/live/control-room-live.spec.ts`的一個
獨立case，需以`VOISS_LIVE_E2E=1 pnpm test:e2e:live`及完整bridge/repository
環境啟動。兩者的本次actual result與report各自支持自己的claim；檔案存在
本身只是test surface。

## Session 在 dev restart 後失效

未設定 `VOISS_SESSION_SECRET` 時，Web process 每次啟動都產生暫時 secret。Real local rehearsal 請在 server-side 設定新的高 entropy secret，並在該次 process 生命週期內保持一致。

## GPU 或 Ollama 不可用

Control Room 的 artifact browsing 與 AURA Bridge 不需要啟動 PyQt、GPU model worker 或 Ollama。需要新 transcription／summary 的 AURA desktop runtime 才進入各自的 hardware/model activation path。畫面可保留 existing evidence browsing，並將新 live processing 標為 unavailable；deterministic demo 繼續使用 synthetic data。
