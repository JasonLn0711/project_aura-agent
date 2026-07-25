# VOISS AURA Control Room Security Model

## 1. 安全目標

VOISS AURA 以本機單一 operator 為 P0 operating scope：會議證據保留在 AURA canonical artifacts，工程寫入保留在每個 run 的 isolated worktree，瀏覽器只取得 typed、bounded、去識別的控制平面資料。每一個 consequential action 都經 trusted static UI、server-side validation 與 correlation-aware audit。

## 2. 信任邊界

```text
Browser
  ↕ HttpOnly local session + CSRF + exact Origin
Next.js / CopilotKit runtime
  ↕ loopback Bearer token
AURA Bridge
  ↕ canonical root + symlink/traversal checks
AURA canonical artifacts

Next.js / CopilotKit runtime
  ↕ loopback Bearer HTTP contract
Codex Bridge HTTP service
  ↕ restricted child env + rootless Podman same-path mounts
Official Codex app-server
  ↕ versioned JSON-RPC over child-process stdio
Codex managed-bubblewrap
  ↕ read-only or approved workspace-write sandbox, network off
isolated Git worktree
```

Demo mode uses a separate trust lane:

```text
sanitized fixture + synthetic audio + scripted events
  → browser state
  → downloaded deterministic_demo_evidence packet
```

Demo audit rows、diff 與 test results 是模擬資料；它們不進入 real local trust chain。

## 3. 資料分類

| 資料 | 分類 | P0 stewardship |
|---|---|---|
| Raw audio | 高敏感 | 保留在 AURA artifact root；只開啟 validated span |
| Transcript | 高敏感 | AURA canonical source of truth；typed query |
| Claims/actions/review events | 敏感 | current evidence gate 與人員覆核 |
| Repository source/diff | 預設機密 | allowlisted repo、isolated worktree、bounded output |
| Command/test output | 敏感 | server-side redaction 與 output limits |
| Codex auth/token | Credential | 官方 Codex store；不進 browser/audit/export |
| Runtime/model metadata | Internal | 只保存必要的 version/profile/status |
| Correlation IDs、hashes、control state | Internal | control plane 與 evidence packet |
| Demo fixture/audio | Public／sanitized | 可重播，不含 private meeting data |

## 4. 已實作的控制面

### Web session boundary

- Dev/demo scripts 綁定 `127.0.0.1:3000`。
- `voiss_session` cookie 為 `HttpOnly`、`SameSite=Strict`、8 小時；production 使用 `Secure`。
- Server 以 `VOISS_SESSION_SECRET` 對 session ID 產生 HMAC CSRF token。
- AURA read/audio proxies要求有效的local session cookie。
- Mutation 要求 exact allowed Origin、session cookie 與 `x-voiss-csrf`。
- `VOISS_WEB_ORIGINS` 預設只含本機 `127.0.0.1`／`localhost` port `3000`。
- Mutation body contract 上限 64 KiB，response proxy 截到 64 KiB。
- 每個 session 的 mutation rate limit 為每分鐘 60 次，state 保留在 Web process memory。
- Security headers 包含 `nosniff`、same-origin referrer policy、frame deny 與 self-oriented CSP。

### AURA Bridge boundary

- CLI 固定 bind `127.0.0.1`。
- 每個 request 都需要至少 16 字元的 per-launch Bearer token。
- CORS 只接受精確 loopback HTTP origins，且不允許 credentialed CORS。
- Artifact root、derived index、audit 與 export paths 都經 canonical validation。
- Traversal、symlink escape 與 arbitrary file access fail closed。
- Audio 必須同時符合 session manifest 與 evidence index；response 是 bounded WAV span。
- JSON、items、segments、audio span、audio bytes 與 exports 都有上限。
- Error response 保留 path 與 raw exception 在 server boundary 內。
- Mutation/media event 以 correlation ID 寫入 SHA-256 previous-hash chain。
- Audit/export directories 優先 `0700`，audit/export files 優先 `0600`。

### Codex process boundary

`services/codex-bridge` library 已定義：

- executable/arguments 與 request timeout；
- `initialize`／`account/read`；
- read-only planning、network off、`on-request` approval；
- allowlisted canonical repository roots；
- 每次 write run 的 branch/worktree 與 base commit；
- command/file typed approval；
- timeout、interrupt、bounded restart；
- token patterns redaction、object depth/item limits 與 UTF-8 output truncation；
- remote Git、PR、deploy、external message 等 command guardrails。

Loopback HTTP service進一步提供：

- 固定`127.0.0.1` bind與至少16 bytes的per-launch Bearer token；
- exact loopback Origin allowlist；`CODEX_ALLOWED_ORIGINS`優先，
  `VOISS_ALLOWED_ORIGINS`提供generic alias；
- status、run、approval resume、stop、cursor event replay、thread archive
  與evidence export routes；
- Bridge-owned two-step write activation；核准前不建立worktree；
- bounded request body、NDJSON／SSE event與patch output；
- export response只提供opaque ID、相對檔名、byte count與hash；
- restart時只從owner-controlled SQLite恢復未archived的唯讀thread
  capability，並重新驗證canonical repository。

這些controls已有library、CLI/service、export module、contract tests與一次
完整live official app-server E2E。Verified lane以rootless Podman承載
official Codex binary與credential read-only mount；agent command仍由nested
`managed-bubblewrap`限制在read-only或approved worktree，並保持network
off。Web的CopilotKit/AG-UI transport以actual plan、command、file、diff、
approval、validation與completion events建立authoritative local state。

### Trust data boundary

`packages/trust-engine` 提供SQLite assets、controls、findings與append-only
SHA-256 audit chain；Codex Bridge同時主動寫入`agent_runs`、
`codex_threads`、`run_events`、`approvals`、`validation_results`與
`exports`。Lifecycle rows保存必要的run/thread、repository/worktree、
model/profile、source IDs、timestamps、status與correlation；event payload
在寫入前完成bounded sanitization。Local Web與Codex Bridge可透過
`VOISS_DB_PATH`共用server-side persistent instance，parent與SQLite檔優先採
owner-only permissions。CopilotKit `SqliteAgentRunner`的thread/run history由
獨立的`VOISS_AGENT_DB_PATH`管理；兩個schema各自使用專屬檔案。Lifecycle
persistence/reopen、cursor replay、唯讀restart resume與archive已有contract
test；2026-07-24 live E2E另保留plan → write interrupt → approval resume的
parent-linked invocation history與settled runner state。Successful-export
control updates與完整audit chain另有測試及live evidence。Demo audit維持
獨立client fixture分類。

## 5. Approval matrix

| 操作 | 預設狀態 | 啟動方式 |
|---|---|---|
| 讀取 allowlisted repository | Read-only | Delegation 後開始 plan |
| 搜尋 AURA evidence | Allowed | Authenticated local query |
| 播放 validated WAV span | Allowed | Authenticated local action |
| Confirm/edit/reject claim | Awaiting user | Trusted static UI |
| 啟動 Codex read-only plan | Allowed after delegable action | Evidence gate |
| 寫入 isolated worktree | Blocked | `allow_once` 或 `allow_run_scope` |
| Network access | Off | P0 UI 不啟用 |
| Worktree 外 destructive write | Denied | P0 不提供 |
| Git push／merge／PR | Denied | 另案 release workflow |
| Deploy／publication／external message | Denied | 另案 explicit authority |
| Credential change | External manual flow | Official client |

`allow_run_scope` 只涵蓋該 run/worktree 的受控寫入；不擴張 network、remote Git、deployment 或 credential authority。

## 6. Correlation 與 audit

每個 evidence-to-execution workflow 使用同一個 correlation ID 連結：

- claim review；
- action delegation；
- Codex thread/run；
- approval；
- command/file/diff/test events；
- control/finding state；
- evidence export。

AURA Bridge 接受有效的 `X-Correlation-ID`，不合規值會換成 server-generated UUID。Audit details 不保存 token、secret 或 path keys。完整鏈以 `previous_hash` 與 `hash` 驗證。

Demo 的 `corr-demo-voiss-001` 是固定 fixture correlation。Browser export 會產生 SHA-256 欄位與 `classification=deterministic_demo_evidence`；這個 digest 支持下載 payload 的 demo provenance，不支持 live runtime claim。

## 7. Failure policy

- Auth、path、origin、sandbox 或 evidence freshness 未知時，操作維持 closed/attention。
- AURA unavailable 時保留 evidence workflow 的明確 disconnected state。
- Codex unavailable/sign-out 時保留 AURA review，關閉 real delegation。
- Approval timeout把approval標記為`timed_out/paused`並保留thread；operator
  可用原approval明確resume或stop。已建立的worktree維持可稽核，初始write
  activation則不建立worktree。
- Validation failure 保留 finding open，並展示 exact failed check。
- App-server crash 使用 bounded restart，affected active run與thread以
  `blocked` metadata與事件保留；已完成run所屬的idle read-only thread可在service
  restart後重新驗證repository並續跑。跨程序write-thread與active-run
  recovery由下一個activation layer承接。
- GPU/Ollama 不可用只影響需要該 runtime 的 AURA processing；既存 evidence browsing 與 demo 分別保持可用。

## 8. Release evidence 與 next activation layers

P0 local baseline已建立以下evidence：

1. `/api/copilotkit`、三個named agents、forward-header deny rules與
   clone-safe Codex transport tests。
2. Loopback AURA/Codex Bearer boundaries、typed routes、bounded body/event
   streams、path/traversal controls與server-side credential isolation。
3. Actual AURA session/claim/action/audio evidence進入Web；既有live Codex
   plan/write/validation/export保留worktree與evidence。Codex lifecycle
   metadata、cursor replay、restart後唯讀resume與archive由contract test
   支持目前implemented claim；stale-running reconcile、normal close與
   app-server crash亦有bounded blocked/interrupted metadata回歸面。
4. Live managed-bubblewrap run證明approved isolated write、network-off policy
   observation、real pytest、terminal-patch validation、checksummed export與
   valid audit chain；獨立socket canary以`PermissionError`證明active egress
   denial。
5. Disconnect、timeout、malformed protocol、stale approval、denied remote
   command、stop與no-secret-in-browser paths具有自動化回歸面。

後續activation layers保持清楚分工：

1. 每個新host/repository重新保留version、login、sandbox preflight與至少一個
   real run；不沿用另一台host的runtime attestation。
2. 若選擇direct-host Ubuntu write lane，先啟用官方targeted AppArmor
   prerequisite並通過`:workspace` preflight；rootless Podman是目前已驗證
   的portable managed-sandbox lane。
3. Public或multi-user deployment先建立hosted identity、tenancy、encrypted
   retention、backup/deletion與production CSP驗證。
4. P0以外的network、remote Git、deploy、publication與external message由
   各自的明示授權工作包啟動。
5. 瀏覽器自動reattach、跨程序write-thread resume、target-host
   crash/reconnect，以及deny、`allow_run_scope`、command/file callback
   approval、stop與recovery的live trace，由各自release activation gate啟動。
