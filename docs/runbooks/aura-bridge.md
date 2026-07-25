# AURA Bridge 操作手冊

AURA Bridge 是綁定 `127.0.0.1` 的 FastAPI service。它讓本機 Web 以 typed API 存取 AURA canonical session artifacts，同時沿用 `aura.claim_review` 與 `aura.evidence_search`，並維持 PyQt GUI 在 bridge process 之外。

## 1. 資料前提

`AURA_ARTIFACT_ROOT` 必須是既存、可讀的絕對目錄。Bridge 會遞迴尋找：

```text
session.json
segments.json
summary.json
review_events.jsonl
<audio tracks referenced by session.json>
```

每個 `session.json` 的 `meeting_id` 必須在 root 內唯一。Canonical transcript、summary、review events 與 audio 保留在 AURA artifact directory；Bridge 只建立 derived index、bridge audit 與 export。

## 2. Frozen 安裝與啟動

從 repository root：

```bash
uv sync --all-extras --all-packages --frozen
export AURA_ARTIFACT_ROOT=/absolute/path/to/aura-sessions
export AURA_BRIDGE_TOKEN="$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')"
export AURA_ALLOWED_ORIGINS=http://127.0.0.1:3000
uv run --frozen --package voiss-aura-bridge aura-bridge
```

Service-local 等價入口：

```bash
cd services/aura-bridge
PYTHONPATH=src:../../src uv run --project . --frozen aura-bridge
```

Bridge 固定使用 host `127.0.0.1`。Port 可調整：

```bash
export AURA_BRIDGE_PORT=8765
```

## 3. 環境變數

| 變數 | 必要性 | 預設／作用 |
|---|---|---|
| `AURA_ARTIFACT_ROOT` | 必填 | canonical AURA artifact root |
| `AURA_BRIDGE_TOKEN` | 必填 | 每次啟動的 Bearer token，至少 16 字元 |
| `AURA_ALLOWED_ORIGINS` | 選填 | `http://127.0.0.1:3000`；可用逗號列出精確 loopback origins |
| `AURA_BRIDGE_PORT` | 選填 | `8765` |
| `AURA_EVIDENCE_INDEX` | 選填 | `<artifact-root>/.voiss-aura/evidence.sqlite3` |
| `AURA_AUDIT_ROOT` | 選填 | `<artifact-root>/.voiss-aura/audit` |
| `VOISS_EXPORT_ROOT` | 選填 | `<artifact-root>/.voiss-aura/exports` |

Allowed origin 必須是 `http`、loopback host 與明確 port；Bridge 不接受 wildcard origin。

## 4. 驗證 readiness

所有 API request 都需要 Bearer token：

```bash
curl --fail --silent --show-error \
  --header "Authorization: Bearer $AURA_BRIDGE_TOKEN" \
  http://127.0.0.1:8765/v1/health
```

Response 欄位：

- `status`：artifact root 可讀時為 `ready`，否則為 `degraded`。
- `artifact_root_ready`：canonical root 可讀。
- `evidence_index_ready`：derived index 已存在；首次 action/search 前可為 `false`。
- `audit_ready`：audit directory 可寫。
- `bind`：固定為 `127.0.0.1`。

Health ready 代表 bridge 基礎資料邊界可用；完整 session freshness、audio 與 mutation acceptance 仍由各 endpoint 的實際回應證明。

## 5. API 操作

### 讀取 sessions

```bash
curl --fail --silent --show-error \
  --header "Authorization: Bearer $AURA_BRIDGE_TOKEN" \
  http://127.0.0.1:8765/v1/sessions
```

```bash
curl --fail --silent --show-error \
  --header "Authorization: Bearer $AURA_BRIDGE_TOKEN" \
  http://127.0.0.1:8765/v1/sessions/MEETING_ID
```

```bash
curl --fail --silent --show-error \
  --header "Authorization: Bearer $AURA_BRIDGE_TOKEN" \
  http://127.0.0.1:8765/v1/sessions/MEETING_ID/segments
```

```bash
curl --fail --silent --show-error \
  --header "Authorization: Bearer $AURA_BRIDGE_TOKEN" \
  http://127.0.0.1:8765/v1/sessions/MEETING_ID/claims
```

### 搜尋 evidence

```bash
curl --fail --silent --show-error --get \
  --header "Authorization: Bearer $AURA_BRIDGE_TOKEN" \
  --data-urlencode "q=佇列" \
  --data "scope=all" \
  --data "limit=20" \
  http://127.0.0.1:8765/v1/evidence/search
```

Search 會從 canonical artifacts 重建 derived SQLite index；不會改寫 transcript、summary 或 audio。

### 讀取 confirmed actions

```bash
curl --fail --silent --show-error --get \
  --header "Authorization: Bearer $AURA_BRIDGE_TOKEN" \
  --data-urlencode "meeting_id=MEETING_ID" \
  http://127.0.0.1:8765/v1/actions
```

只有 `review_status=confirmed`、`support_status=supported` 且具來源 segment 的 action 才會得到 `delegable=true`。

### 人員覆核 claim

```bash
curl --fail --silent --show-error \
  --request POST \
  --header "Authorization: Bearer $AURA_BRIDGE_TOKEN" \
  --header "Content-Type: application/json" \
  --header "X-Correlation-ID: REVIEW_CORRELATION_ID" \
  --data '{"decision":"confirmed"}' \
  http://127.0.0.1:8765/v1/sessions/MEETING_ID/claims/CLAIM_ID/review
```

可用 decision：

- `confirmed`
- `rejected`
- `edited`，並提供非空的 `edited_text`

來源不足、stale 或轉換不合法時，Bridge 回傳 `409`，讓 claim 保留在可覆核狀態。

### 開啟 WAV audio span

```bash
curl --fail --silent --show-error \
  --request POST \
  --header "Authorization: Bearer $AURA_BRIDGE_TOKEN" \
  --header "Content-Type: application/json" \
  --header "X-Correlation-ID: AUDIO_CORRELATION_ID" \
  --data '{"meeting_id":"MEETING_ID","start_ms":0,"end_ms":10000,"track":"mixed"}' \
  --output aura-span.wav \
  http://127.0.0.1:8765/v1/evidence/audio-span
```

目前 audio contract 支援經 canonical manifest 與 evidence index 雙重確認的 WAV，單次最長 60 秒、response 上限 20 MB。非 WAV 媒體的 transcoding 是獨立 activation gate。

### 匯出 evidence

```bash
curl --fail --silent --show-error \
  --request POST \
  --header "Authorization: Bearer $AURA_BRIDGE_TOKEN" \
  --header "Content-Type: application/json" \
  --header "X-Correlation-ID: EXPORT_CORRELATION_ID" \
  --data '{"meeting_id":"MEETING_ID","format":"json"}' \
  http://127.0.0.1:8765/v1/evidence/export
```

`format` 可為 `json` 或 `markdown`。Response 提供 opaque `export_id`、檔名、byte count、content type、SHA-256 與相對 download URL。下載時仍需 Bearer token：

```bash
curl --fail --silent --show-error \
  --header "Authorization: Bearer $AURA_BRIDGE_TOKEN" \
  --output evidence-packet.json \
  http://127.0.0.1:8765/v1/evidence/exports/EXPORT_ID
```

### 讀取 bridge audit

```bash
curl --fail --silent --show-error \
  --header "Authorization: Bearer $AURA_BRIDGE_TOKEN" \
  http://127.0.0.1:8765/v1/audit/events
```

Mutating 與 media operations 會把 correlation ID、evidence refs、outcome 與已去識別 details append 到：

```text
<AURA_AUDIT_ROOT>/voiss-aura-bridge.jsonl
```

事件使用 SHA-256 previous-hash chain；讀取 timeline 時會重新驗證完整檔案鏈。

## 6. 安全界線

- Canonical root、index parent、audit root 與 export root 都會 canonicalize。
- Artifact traversal 與 symlink escape 會被拒絕。
- Browser 不取得 arbitrary filesystem path 或任意 local file。
- JSON artifact read 上限為 5 MB。
- Session list/action/search/audit response 有 bounded item limits。
- Error response 提供 correlation ID，保留內部 path 與例外細節在 server boundary 內。
- Audit/export directories 優先設定為 owner-only；export file 優先設定為 `0600`。

## 7. Focused contract checks

以下指令定義 AURA Bridge 的 focused validation 面；release checklist 只有在本次實際執行並保留結果後才能勾選：

```bash
cd services/aura-bridge
PYTHONPATH=src:../../src uv run --no-project \
  --with fastapi==0.116.1 \
  --with httpx==0.28.1 \
  --with pytest==8.4.1 \
  pytest -q tests
```

```bash
uv run ruff check services/aura-bridge
uv run ruff format --check services/aura-bridge
git diff --check -- services/aura-bridge
```

## 8. Web integration contract

AURA Bridge的canonical HTTP API使用`/v1/*`。Web目前提供：

- `/api/status` → `/v1/health`
- `/api/aura/[...path]` → allowlisted read endpoints
- `/api/aura-audio` → `/v1/evidence/audio-span`
- `/api/control-room` claim review → typed claim-review endpoint

這些code paths除integration tests外，已在2026-07-24使用controlled
canonical fixture artifact root完成local-mode E2E，並保留actual response、
claim review、audio evidence、correlation event與bridge audit。新的target
artifact root仍以相同freshness、path與audit checks建立自己的live evidence。
