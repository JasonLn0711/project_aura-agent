# 09 Dependency Graph and Analysis

## Report control

| Field | Value |
|---|---|
| Status | `Partially Verified` |
| Product milestone | `LOCAL_E2E_VALIDATED` |
| Scoped live run status | `LIVE_MINIMUM_COMPLETED` |
| Source baseline | `6807f516d1083051d75373f110ac871f677f75ce` |
| Baseline role | Source lineage only; it is not live MVP proof |
| Current evidence | Uncommitted source and retained-validation snapshot `dac3f6ca6ad6f170a66448b00adf713a204dede36f90d678ad3352d4918d8ef9` |
| Artifact timestamp | `2026-07-25T00:00:00Z` (normalized; not a wall-clock runtime observation) |

## Architecture finding

pnpm 與 uv lockfile 的 resolved component identities 完整盤點；workspace edges 清楚，transitive relationship graph 因 peer variant、marker 與 extra 維持 partial。

Web依賴 domain、fixtures、trust-engine、agent-runtime與 adapter；agent-runtime依賴 adapter與fixtures；fixtures與trust-engine依賴 domain。Codex Bridge為獨立 Node service；AURA Bridge是 uv workspace member並讀取 AURA canonical artifacts。

SBOM為每個 pnpm lock record與 uv package record建立 component identity。這能回答「有哪些已解析元件」，但不把簡化 parser包裝成完整 package-manager dependency solver。

## Evidence paths

- `apps/voiss-aura-web/package.json:L24` — Web workspace dependencies。
- `packages/agent-runtime/package.json:L14` — agent dependency edge。
- `pnpm-lock.yaml:L204` — Node identities。
- `uv.lock:L31` — Python identities。

## Assumptions

- lock records代表本次 workspace resolution。

## Limitations

- transitive edge graph不是 pnpm/uv resolver的完整重建。
- native與模型依賴只做 source-detected curated coverage。

## Decisions

- coverage欄位分別標明 identity complete與relationship partial。

## Risks

- 只看 direct manifests會漏掉 supply-chain footprint；本套件以 full lock inventory降低此風險。

## Next validation

- 使用 package-manager原生 export或專用 SBOM工具補齊 dependency edges與 license metadata。
