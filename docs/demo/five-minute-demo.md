# VOISS AURA 五分鐘示範講稿

## 證據聲明

本講稿使用 `demo-voiss-aura-architecture-review` sanitized fixture。AURA readiness、Codex agent events、worktree、diff、tests、controls 與 audit rows 都是 deterministic replay；畫面匯出的是根據這些模擬事件實際產生的 JSON packet，分類為 `deterministic_demo_evidence`。

這場示範證明 operator workflow、trusted UI 與 evidence packaging。2026-07-24
另完成一次受控 real local AURA/Codex flow；demo classification與live
execution evidence維持兩條可辨識的證據路徑。

## 會前準備

從 repository root：

```bash
pnpm install --frozen-lockfile
pnpm demo
```

開啟 `http://127.0.0.1:3000`，並在開始計時前確認：

- [x] 左下角持續顯示 `DEMO MODE`。
- [x] AURA 顯示 `Fixture ready`。
- [x] Codex 顯示 `Scripted agent`。
- [x] Browser download 可用。
- [x] 畫面中沒有 private meeting data。

以上preflight已由2026-07-24 passing Playwright flow與retained sanitized
screenshot確認。重新整理頁面會重設 claim/action workflow state，同時保留
screen、session、segment與filter等非敏感導覽選擇。

## 0:00–0:40 — Readiness

操作：

1. 停在 `Control Room`。
2. 指向左下角 `DEMO MODE`。
3. 指向右上角 AURA 與 Codex simulated readiness。
4. 點選 `Runtime readiness` tile，開啟 `信任與稽核`。

講稿：

> 這是 VOISS AURA 的 evidence-to-execution control plane。今天使用公開、去識別的 deterministic demo，因此 AURA 是 fixture，Codex 是 scripted agent。若我提出「檢查 AURA 是否已準備好開始工作」，這些 readiness cards 會以 pass、attention 或 unknown 呈現；現在看到的是模擬控制結果，不是 live service attestation。

證據標籤：

- `demo_fixture`
- `simulated_readiness`

## 0:40–1:40 — Evidence 與 confirmed action

操作：

1. 點左側 `會議紀錄`。
2. 顯示會議 `VOISS × AURA 架構與可信任執行檢視`。
3. 點選 `00:08–00:18` 的 Jason 片段（fixture ID `seg-002`）。
4. 播放 synthetic audio。
5. 顯示 `目前 ASR 工作佇列未設定容量上限` 的 `待覆核` claim。
6. 點左側 `行動項目`，確認 `限制 ASR 佇列並加入背壓` 的委派 gate 尚未開啟。
7. 回到 `會議紀錄`，在 queue claim 點 `確認`。
8. 顯示 GPU claim 為 `證據不足`，其確認按鈕維持 disabled。
9. 回到 `行動項目`，選取 `限制 ASR 佇列並加入背壓`。
10. 指出 owner、source ref、`confirmed`、`supported` 與已開啟的委派 gate。

講稿：

> 執行從來源開始。Transcript segment、synthetic audio span 與 claim 使用同一個 evidence locator。Queue claim 起始為待覆核，對應 action 起始為 proposed；人員確認具備來源的 claim 後，matching action 轉為 confirmed、supported，委派 gate 隨即開啟。GPU claim 的來源層仍待設備探測證據，因此確認路徑由 evidence gate 持續守護。

證據標籤：

- `sanitized_transcript`
- `synthetic_audio`
- `fixture_claim_to_action_transition`
- `unsupported_claim_blocked_by_ui`

## 1:40–2:30 — Read-only plan

操作：

1. 在 action detail 點 `產生唯讀計畫`。
2. 畫面進入 `Agent Runs`。
3. 指向 correlation ID `corr-demo-voiss-001`。
4. 顯示 model request `gpt-5.6-sol`、effort `max`、sandbox `read-only`、network `off`。
5. 逐項說明三步唯讀計畫。

講稿：

> 委派先建立 bounded goal：追蹤 producer、queue、consumer、stop 與 error path；加入可設定容量與背壓；用針對性測試驗證，同時保留 durable audio 與既有行為。現在只有 read-only plan，尚未取得 workspace write authority。Demo 使用固定 plan events；real local 會由 official Codex app-server stream actual repository findings。

證據標籤：

- `scripted_read_only_plan`
- `network_off_fixture`

## 2:30–3:15 — Trusted approval

操作：

1. 顯示 `TRUSTED APPROVAL REQUIRED`。
2. 指出 write scope：
   - `src/aura/asr/threads.py`
   - 對應 tests
   - isolated worktree
   - network off
   - remote Git 未啟用
3. 點 `允許這一次`。

講稿：

> 寫入權限由 trusted static UI 啟動。這次只示範 allow once；權限範圍是該 run 的 isolated worktree，network、push、merge、PR 與 deploy 都不在這個 approval 內。Demo 按鈕會重播批准後事件；real local 必須保留 actual approval request、worktree path 與 base commit。

證據標籤：

- `simulated_allow_once`
- `trusted_static_ui`

## 3:15–4:00 — Diff 與 tests

操作：

1. 等待 event timeline 到 `COMPLETED`。
2. 指向 `Trusted diff`。
3. 指向 `Validation` 的兩個 checks。

講稿：

> Demo 顯示 expected patch：將 unbounded queue 改成設定容量的 queue；Validation 顯示預先定義的 expected test result 與 `git diff --check`。這些 PASS 是 fixture，不是本機 AURA tests 的執行紀錄。Real finding 只有在 actual diff、actual commands 與 actual exit codes 都保留後才能進入 closure。

證據標籤：

- `expected_demo_diff`
- `expected_demo_tests`

## 4:00–4:35 — Trust 與 audit

操作：

1. 點左側 `信任與稽核`。
2. 顯示 assets、controls 與 findings。
3. 指出 R-002 維持 open，並顯示完整 closure evidence 的啟動條件。
4. 沿 audit table 顯示同一 correlation context：
   - session loaded
   - action confirmed/delegated
   - approval
   - run validated

講稿：

> Trust closure 把來源、decision、approval、sandbox、run events 與 finding 放在同一個 correlation context。這裡的 control state 與短 hash 是 fixture display；R-002 維持 open，清楚呈現下一層需要的同一 run approval、export 與六類專屬驗證證據。Real local closure 使用 server-side hash chain 與完整 proof bundle 啟動 `remediated` transition。

證據標籤：

- `simulated_controls`
- `simulated_audit_timeline`

## 4:35–5:00 — Export 與收尾

操作：

1. 點右上角下載圖示。
2. 顯示 status notice 的 SHA-256 prefix。
3. 顯示 audit table 新增 `evidence.exported`。
4. 在 browser downloads確認：

```text
corr-demo-voiss-001-evidence.json
```

講稿：

> 最後匯出一份真實 JSON 檔，內容標記為 `deterministic_demo_evidence`，包含 meeting source、confirmed action、approval、scripted run、expected diff/tests、controls、findings、audit 與 digest。這份 packet 支持 demo provenance；產品沒有執行 push、merge 或 deploy。相同流程已在 2026-07-24 以 live AURA Bridge 與 official Codex app-server 完成；deterministic demo也已保留3.42秒的scripted browser walkthrough、下載packet與screenshot。下一個presentation gate是人員實際口述rehearsal與reviewer sign-off。

證據標籤：

- `real_file_from_simulated_events`
- `no_remote_action`

## Demo 後檢查

- [x] 全程可見 `DEMO MODE`。
- [ ] 每次提到 readiness、Codex、diff、tests、controls 時都有說明 fixture 分類。
- [x] Unsupported GPU claim 沒有被確認。
- [x] Write approval 明確限於一次／run scope。
- [x] Export 檔含 `classification: "deterministic_demo_evidence"`。
- [ ] 講稿在五分鐘內完成。

Machine walkthrough已依本講稿順序完成Control Room → Sessions → Actions →
read-only plan → `allow_once` → completed diff/tests → Trust → browser
export，總時間3.42秒。下載檔：

```text
/tmp/voiss-aura-demo-walkthrough-20260724.json
```

- suggested filename：`corr-demo-voiss-001-evidence.json`
- classification：`deterministic_demo_evidence`
- correlation：`corr-demo-voiss-001`
- run status：`completed`
- embedded digest：64字元
- outer file SHA-256：
  `bde472bdcb409009d45f26dcb06c8f6f7dbbf925727c9d3d55e2bc88f8148e82`

Retained screenshot位於
`docs/validation/screenshots/2026-07-24-control-room-demo.png`，尺寸
1440 × 1436，SHA-256
`d2207ad08b24191fc3dc590fe6e20b1cafa0f3c76f4fce7998cbd90aa5d1c2ac`。
這些machine checks支持scripted demo；人員口述是否完整呈現fixture
boundary與五分鐘節奏，仍由實際rehearsal及reviewer確認。

## Demo acceptance 與 evidence boundaries

- Playwright 18個required E2E cases與accessibility scan已實際PASS，結果保存在
  `docs/validation/2026-07-24-local-e2e.md`。
- CopilotKit `/api/copilotkit` runtime、named agents、loopback bridges與
  authoritative local UI state已有實作；2026-07-24另以獨立local-mode
  Playwright case完成official app-server live stream與retained export。
- Fixture claim review會動態重算 matching action eligibility；明確確認後才
  開啟委派路徑。
- Demo audit table是scripted display；local mode使用persistent server-side
  TrustStore chain，兩者保持不同classification。
- Screenshot與scripted walkthrough已由目前final-source worktree保留；目前
  尚未建立target feature commit，人員rehearsal與reviewer sign-off維持release
  activation gate。
