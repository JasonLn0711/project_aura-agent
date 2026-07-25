# 04 C4 System Context

## Report control

| Field | Value |
|---|---|
| Status | `Partially Verified` |
| Product milestone | `LOCAL_E2E_VALIDATED` |
| Scoped live run status | `LIVE_MINIMUM_COMPLETED` |
| Source baseline | `6807f516d1083051d75373f110ac871f677f75ce` |
| Baseline role | Source lineage only; it is not live MVP proof |
| Current evidence | Uncommitted source and retained-validation snapshot `9f64c159040bee39834284683d62bfc107720f633644bca53e11b35d9a157e16` |
| Artifact timestamp | `2026-07-25T00:00:00Z` (normalized; not a wall-clock runtime observation) |

## Architecture finding

系統邊界以單一現場操作人為中心：控制室協調 AURA canonical evidence、Codex engineering runtime、Git repository 與本機模型；外部 provider 僅由明確 runtime 路徑接觸。

操作人從瀏覽器檢視會議、claim、action、trust control 與 agent run，並在兩種核准點作出決定。AURA Bridge 是會議證據的 authoritative interface；Codex Bridge 是 app-server 與 repository mutation 的 authoritative policy boundary。目標Linux host以rootless Podman承載official Codex與nested managed-bubblewrap；direct-host `:workspace`由targeted AppArmor preflight另行啟用。

Diagram 01 使用 context-level flowchart，將 browser、loopback services、repository、local models 與 optional hosted Codex model 分開。

## Evidence paths

- `apps/voiss-aura-web/app/page.tsx` — 使用者入口。
- `services/aura-bridge/README.md` — AURA boundary。
- `services/codex-bridge/README.md` — Codex boundary。
- `services/codex-bridge/run-in-podman.sh:L30` — verified Codex runtime boundary。

## Assumptions

- 主要 operator 與本機登入使用者是同一個信任主體。

## Limitations

- 尚未建模多使用者、遠端瀏覽器、SSO 或組織 tenancy。

## Decisions

- MVP context 只開放 loopback integration。

## Risks

- 未來遠端化會改變 origin、identity、transport 與 data residency boundary。

## Next validation

- 若要遠端營運，先建立獨立 threat model 與 tenancy contract。
