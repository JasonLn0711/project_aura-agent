# 08 API and Interface Inventory

## Report control

| Field | Value |
|---|---|
| Status | `Partially Verified` |
| Product milestone | `LOCAL_E2E_VALIDATED` |
| Scoped live run status | `LIVE_MINIMUM_COMPLETED` |
| Source baseline | `6807f516d1083051d75373f110ac871f677f75ce` |
| Baseline role | Source lineage only; it is not live MVP proof |
| Current evidence | Uncommitted source and retained-validation snapshot `6d6f7c1921878853d9c197145ad03cc2d42af872de665d247aee60b97893a6a7` |
| Artifact timestamp | `2026-07-25T00:00:00Z` (normalized; not a wall-clock runtime observation) |

## Architecture finding

HTTP surface 由 Web same-origin API、AURA `/v1` evidence API 與 Codex `/v1` run API 組成；每一條 mutation 都位於 server-side authorization boundary。

Web API提供 session/status/trust、AURA allowlisted read/audio proxy、control-room mutation與 CopilotKit route。AURA API提供 health、session、segment、claim review、action、search、audio span、audit與 export。Codex API提供 status、run stream、approval resume、stop與 evidence export；stop可取消staged write或中斷active run。Codex export只接受completed write run，且retained command evidence必須含至少一個in-scope passed recognized validation、零個recognized failure，並與terminal frozen patch SHA-256及mutation generation一致。

完整 machine-readable list位於 `inventories/03-apis-interfaces.json`。Interface inventory是 current source route的人工校讀快照，internal functions則透過 component report治理。

## Evidence paths

- `apps/voiss-aura-web/app/api/control-room/route.ts:L3` — same-origin mutation API。
- `services/aura-bridge/src/aura_bridge/app.py:L1016` — AURA endpoints。
- `services/codex-bridge/src/server.ts:L5` — Codex endpoints。

## Assumptions

- 所有 Bridge URL 只指向受信任 loopback address。

## Limitations

- 沒有公開 remote API、version negotiation 或 compatibility SLA。

## Decisions

- 以 `/v1` 固定 Bridge contract；browser 只呼叫同源 Web API。

## Risks

- route 與 machine inventory 可能隨 source drift，需要 generator 重跑與 review。

## Next validation

- 加入 contract test 或 OpenAPI/JSON Schema export，降低人工 inventory drift。
