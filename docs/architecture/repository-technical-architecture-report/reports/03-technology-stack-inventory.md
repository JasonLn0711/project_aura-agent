# 03 Technology Stack Inventory

## Report control

| Field | Value |
|---|---|
| Status | `Partially Verified` |
| Product milestone | `LOCAL_E2E_VALIDATED` |
| Scoped live run status | `LIVE_MINIMUM_COMPLETED` |
| Source baseline | `6807f516d1083051d75373f110ac871f677f75ce` |
| Baseline role | Source lineage only; it is not live MVP proof |
| Current evidence | Uncommitted source and retained-validation snapshot `c5ccf5b8e02e3c73b5c3db7d44f66d80ec430cf3f50ddcfc4bf9327b794fc772` |
| Artifact timestamp | `2026-07-25T00:00:00Z` (normalized; not a wall-clock runtime observation) |

## Architecture finding

主要技術堆疊是 Next.js 16、React 19、TypeScript 5.9、AG-UI/CopilotKit、Node 22、Python 3.10+、FastAPI、PyQt6 與 SQLite；模型、GPU 與 native audio 工具屬主機 activation layer。

主要declared stack如下：

| Layer | Declared technology |
|---|---|
| Web | Next.js 16.2.11、React 19.2.8、TypeScript 5.9.3 |
| Agent UI | AG-UI client 0.0.57、CopilotKit 1.63.2、RxJS 7.8.1 |
| Contract | Zod 4.4.3、Pydantic/FastAPI |
| Node runtime | Node 22.18+ for Codex Bridge、pnpm 11.17.0 |
| Codex protocol | exact app-server 0.145.0、gpt-5.6-sol、max effort |
| Verified Codex target lane | rootless Podman 4.9.3、digest-pinned Ubuntu 24.04 base、nested managed-bubblewrap |
| Python runtime | Python 3.10+、FastAPI 0.116.1、Uvicorn 0.35.0 |
| Desktop | PyQt6、faster-whisper、local audio/native tools |
| Storage | SQLite via `node:sqlite`、Python SQLite、filesystem JSON/JSONL/WAV |
| Quality | Vitest 4.0.18、Playwright 1.58.2、pytest 8.4.1 |
| Verified host observation | Node 22.23.1、pnpm 11.17.0、Python 3.11.15、uv 0.11.6、Git 2.43.0、Codex 0.145.0、Podman 4.9.3 |

Node 與 Python 的 resolved component identities 分別由 `pnpm-lock.yaml` 與 `uv.lock` 完整擷取。native tools 與 external model/runtime 以 source-detected curated inventory 表示，因 repository 無法證明每一台主機的安裝、版本或授權狀態。

技術選擇支援本機資料治理：Next route 隔離 browser credential，FastAPI 只服務 loopback，Node `sqlite` 儲存 trust metadata，AURA 桌面維持離線音訊與模型流程。

## Evidence paths

- `apps/voiss-aura-web/package.json:L27` — Web versions。
- `services/aura-bridge/pyproject.toml:L12` — FastAPI service。
- `pyproject.toml:L26` — AURA Python stack。
- `pnpm-lock.yaml:L204` — Node resolved identities。
- `uv.lock:L31` — Python resolved identities。
- `services/codex-bridge/Containerfile:L1` — digest-pinned Codex runtime base。
- `docs/validation/2026-07-24-local-e2e.md:L33` — observed host/runtime versions。

## Assumptions

- lockfile 是本次 dependency identity 的權威來源。

## Limitations

- native binary、GPU driver 與模型 cache 沒有完整 lockfile；Containerfile的base digest固定，但apt package versions未逐項pin。
- dependency edge coverage 受 pnpm peer variant 與 Python marker/extra 影響。

## Decisions

- 完整列出 lock identities；主機與模型 runtime 明確標為 partial curated coverage。

## Risks

- 主機 runtime drift 可能讓 source-ready capability 無法在特定環境啟用。

## Next validation

- 產生主機 runtime attestation，記錄 binary/model version 與 digest。
