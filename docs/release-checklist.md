# VOISS AURA Control Room Release Checklist

本清單是 release evidence gate。所有 checkbox 預設維持未勾選；只有在目標 commit 上實際執行、保留輸出並由 reviewer 對齊 claim depth 後才勾選。

目前 claim ceiling：

- deterministic demo fixture與完整automated contract surface；
- AURA Bridge、Codex loopback service、Web proxies、CopilotKit named agents與
  persistent TrustStore均已接線；
- 2026-07-25完成final-source Web → AURA → official Codex live E2E，包含actual
  plan、approval、managed workspace write、validation、export與audit-chain
  evidence；
- 目前最高狀態為`LOCAL_E2E_VALIDATED`。Final-source frozen quality gate與
  architecture regeneration已完成；target commit identity與reviewer
  sign-off是進入`RELEASE_CANDIDATE`的下一層啟動條件。

## 1. Release identity

- [ ] Target repository root與 remote 已確認。
- [ ] Source baseline記錄為 `6807f516d1083051d75373f110ac871f677f75ce`。
- [ ] Target feature commit SHA已記錄。
- [ ] Branch與 worktree identity已記錄。
- [ ] `git status --short` 已保存，且 release scope與既有 dirty work清楚分離。
- [ ] `git diff --check` 已在 target commit執行並保存結果。
- [ ] Demo、contract-test、real local與 production-candidate claims已分開。

## 2. Frozen dependencies

- [ ] Node.js、pnpm、Python、uv、Git與 Codex CLI版本已保存。
- [ ] `pnpm install --frozen-lockfile` 已成功並保存 log。
- [ ] `uv sync --all-extras --all-packages --frozen` 已成功並保存 log。
- [ ] `package.json`／`pnpm-lock.yaml` identity一致。
- [ ] `pyproject.toml`／`uv.lock` identity一致。
- [ ] Dependency reports、CycloneDX SBOM與 SPDX SBOM由 target commit產生。
- [ ] SBOM涵蓋範圍與 externally managed model/runtime evidence明確標示。

## 3. Deterministic demo

- [ ] `pnpm demo` 從 clean target checkout啟動。
- [ ] Browser只連線 `http://127.0.0.1:3000`。
- [ ] `DEMO MODE` 徽章全程可見。
- [ ] Demo不需要 Codex login、GPU、Ollama或 private data。
- [ ] `demo-voiss-aura-architecture-review`載入。
- [ ] Synthetic audio可播放。
- [ ] Unsupported claim的 confirm path維持關閉。
- [ ] Confirmed/supported/source-backed action可進入 delegation UI。
- [ ] Read-only plan、approval、expected diff與 expected tests明確標記為 simulated。
- [ ] Browser evidence packet實際下載。
- [ ] Packet含 `classification=deterministic_demo_evidence`與 digest。
- [ ] 五分鐘講稿完成 rehearsal並保留時間。
- [ ] Screenshot或錄影由相同 target commit產生。

## 4. Web quality

逐項執行並保存 command、exit code與 log：

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm build
```

Current uncommitted working-state evidence records 116 passing JS/TS tests,
18 deterministic browser scenarios, 1 disconnected-local browser scenario,
and a passing production build. Target-commit release execution remains
represented by the unchecked controls below.

- [ ] Formatting policy通過。
- [ ] ESLint通過。
- [ ] TypeScript typecheck通過。
- [ ] Unit tests通過。
- [ ] Component tests涵蓋 claim evidence gate與 approval decisions。
- [ ] Playwright E2E cases存在並通過。
- [ ] Axe accessibility scan通過，或每個 finding有 owner與activation path。
- [ ] Production build通過。
- [ ] Browser bundle未包含 bridge/Codex tokens。
- [ ] Local與demo mode不會無聲切換。

## 5. AURA Bridge

- [ ] CLI固定 bind `127.0.0.1`。
- [ ] `/v1/health`以正確 token回應。
- [ ] 無 token／錯誤 token回傳 `401`。
- [ ] Exact Origin allowlist與 CORS contract通過。
- [ ] Session、segments、claims、actions與search使用 canonical fixture通過。
- [ ] Stale／unsupported claim confirmation被拒絕。
- [ ] Claim review沿用 AURA validated review logic。
- [ ] Traversal與 symlink escape tests通過。
- [ ] WAV audio span identity、duration與size boundaries通過。
- [ ] Derived index可由 canonical artifacts重建。
- [ ] Audit chain從 genesis到head驗證。
- [ ] JSON與Markdown evidence export checksum通過。
- [ ] Bridge process未import `TranscriptionTab`或啟動 PyQt。

Focused commands：

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
```

Current uncommitted working-state evidence records 14 focused AURA Bridge
tests and 398 passing full Python tests. Target-runtime GPU、model與media
evidence continue through their dedicated controls.

## 6. Codex Bridge

- [ ] Official `codex --version`已保存。
- [ ] Official `codex login status`已去識別保存。
- [ ] `initialize`與`account/read`對 target CLI通過。
- [ ] Account status未包含 email或 token。
- [ ] Loopback HTTP service entrypoint已實作。
- [ ] Per-launch Bearer token已實作。
- [ ] `/v1/status`與 run/resume/stop/approval/export/event-stream routes已實作。
- [ ] Web `CODEX_BRIDGE_URL` contract已對齊。
- [ ] `VOISS_ALLOWED_REPOSITORIES`、worktree/export roots與timeouts由validated server config載入。
- [ ] Read-only plan使用 allowlisted canonical repo。
- [ ] Requested model/profile與 observed model/profile均有記錄。
- [ ] Network-off state有 live evidence。
- [ ] Rootless Podman image由digest-pinned base建立，official vendor/auth mounts為read-only。
- [ ] Status確認agent sandbox為`managed-bubblewrap`，未以legacy/no-sandbox替代workspace-write。
- [ ] Write request先串流Bridge-owned trusted approval，核准前未建立worktree。
- [ ] Deny保留 read-only／unchanged state。
- [ ] Allow once建立 isolated worktree與 branch。
- [ ] Base commit與 changed files有記錄。
- [ ] Command/file approvals維持 typed scope。
- [ ] Stop會中止 active turn並保存結果。
- [ ] Timeout、malformed JSON、crash與 bounded restart有 retained traces。
- [ ] Output redaction與 truncation不洩漏 secrets。
- [ ] Remote Git、PR、deploy與 external writes維持 denied。
- [ ] Patch與 Codex evidence packet從 actual worktree匯出。

Contract command：

```bash
pnpm --filter @voiss/codex-bridge run check
```

Current uncommitted working-state evidence records 55 passing Codex Bridge
tests. The suite covers approval `timed_out/paused` replay/resume/stop,
stale-running reconciliation, normal close, and app-server crash preservation
as bounded `blocked`／`interrupted` lifecycle metadata.

Contract test支持bridge contract。2026-07-25 retained live run已覆蓋
version/account/model、`allow_once` isolated write、兩個validation checks與
patch/export；stale-running、normal close與app-server crash另由contract
test保存bounded lifecycle metadata。deny、`allow_run_scope`、stop/recovery、
live command/file callback approval仍各自需要專屬live trace，不能由contract
test或單一成功run代替。Active egress denial已有獨立managed-bubblewrap
socket canary，並與run的`networkAccess=false` policy observation分開記錄。

## 7. Web／CopilotKit／bridge integration

- [ ] `/api/copilotkit` route已建立。
- [ ] `voiss_orchestrator`、`codex_engineer`、`demo_agent`已註冊。
- [ ] AG-UI plan、command、file、diff、approval、message與completion mapping通過 E2E。
- [ ] Web AURA health probe對齊 `/v1/health`。
- [ ] Web claim review對齊 typed AURA endpoint。
- [ ] Web evidence export對齊 typed AURA/Codex endpoint。
- [ ] Local UI state由 live AURA queries初始化。
- [ ] Local UI不把 `packages/demo-fixtures`資料呈現為 live。
- [ ] Bridge disconnect顯示可復原 state。
- [ ] SSE/NDJSON disconnect與 resume semantics通過。
- [ ] `VOISS_DB_PATH`與`VOISS_AGENT_DB_PATH`使用獨立owner-controlled
  SQLite檔案。
- [ ] Approval resume使用新的run ID並以`parent_run_id`保留CopilotKit
  invocation lineage。
- [ ] 同一 correlation ID串連 source、review、action、run、approval、diff、tests、controls、audit與export。

## 8. Trust closure

- [ ] Persistent TrustStore DB path與 owner-only permissions已設定。
- [ ] Assets、controls與findings由 runtime evidence更新。
- [ ] Demo controls與local controls具有不同 classification。
- [ ] Audit chain完整驗證。
- [ ] Validation skipped/failed時 finding維持 open。
- [ ] Actual validation passed後才允許 finding進入`remediated`或`accepted`。
- [ ] Evidence packet含 source refs、approval、sandbox、network、commands、files、tests、diff hash與final status。
- [ ] Export checksum重新計算並比對。
- [ ] Export內容完成去識別與recipient review。

## 9. Security and privacy

- [ ] `VOISS_SESSION_SECRET`在 server-side設定。
- [ ] Session cookie、CSRF、Origin與rate-limit tests通過。
- [ ] Request body以實際 streaming byte limit驗證。
- [ ] AURA/Codex bridge都只綁 loopback。
- [ ] Bridge tokens為per-launch、server-side且未進browser。
- [ ] Repository allowlist由validated config載入。
- [ ] Worktree canonical path與write root驗證。
- [ ] Network unknown時fail closed。
- [ ] CSP production profile已移除不必要的`unsafe-eval`。
- [ ] Agent output未進入raw arbitrary HTML。
- [ ] Logs、audit、tests與exports通過 secret scan。
- [ ] Raw audio、transcript、repo source與command output retention owner已確認。
- [ ] No-sandbox mode未由一般 UI提供。

## 10. AURA baseline regression

```bash
uv run pytest -q
```

- [ ] Host-independent AURA tests通過。
- [ ] GPU tests有 target hardware runtime evidence，或明確列為activation gate。
- [ ] Model/Ollama tests有 target runtime evidence，或明確列為activation gate。
- [ ] Media tests有必要 codec/runtime evidence。
- [ ] R-002只有在 bounded queue、overload semantics、durable audio、provisional behavior、telemetry與relevant tests都有actual evidence後才標記closed。

## 11. Documentation and architecture evidence

- [ ] `docs/runbooks/local-setup.md`由clean machine walkthrough驗證。
- [ ] `docs/runbooks/codex-sign-in.md`由official client flow驗證。
- [ ] `docs/runbooks/aura-bridge.md`的curl examples對target service驗證。
- [ ] `docs/runbooks/troubleshooting.md`與actual failure modes對齊。
- [ ] `docs/security-model.md`由security reviewer檢視。
- [ ] `docs/data-lifecycle.md`的owner、retention與cleanup decision完成。
- [ ] Codex lifecycle的八組必要欄位、cursor replay、restart-safe read-only
  resume、thread archive與fail-closed blocked lifecycle由contract tests驗證；
  browser自動reattach、跨程序write-thread resume與target-host
  crash/reconnect保留activation evidence。
- [ ] `docs/demo/five-minute-demo.md`完成rehearsal。
- [ ] ADR register與實作一致。
- [ ] Known limitations與progress status更新。
- [ ] 二十節implemented-system architecture package從target commit重建。
- [ ] 十二份 Mermaid source可解析。
- [ ] Machine-readable inventories、validation logs、checksums與report provenance齊備。
- [ ] Baseline architecture analysis與implemented-system evidence保持分離。

## 12. Final decision

- [ ] 所有必須項目已有 retained evidence。
- [ ] 每個 remaining gate都有 owner、scope與next validation layer。
- [ ] Release notes以 capability → evidence → ownership → scope control → next validation layer撰寫。
- [ ] P0 authority終止於 local patch與evidence export。
- [ ] Push、merge、PR、deploy、publication與external message由獨立授權流程處理。
- [ ] Reviewer簽署 target commit與evidence package checksum。

最終狀態使用：

```text
Status: <RUNTIME_IMPL_IN_PROGRESS | DEMO_VALIDATED | LOCAL_E2E_VALIDATED | RELEASE_CANDIDATE>

Evidence:
- Demo runs: <count + artifact paths>
- Contract tests: <count + logs>
- Real local runs: <count + correlation IDs>
- Build: <command + log + exit code>

Activation gates:
- <owner / evidence needed / next action>

Release authority:
- Local patch/export: <enabled or gated>
- Remote Git/deploy/external actions: separate explicit workflow
```
