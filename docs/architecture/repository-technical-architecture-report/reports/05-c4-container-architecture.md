# 05 C4 Container Architecture

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

C4 runtime units以單機多程序為主；official Codex target lane另由一個digest-pinned OCI image透過rootless Podman啟動，Next、AURA Bridge、Codex Bridge與AURA desktop仍是host processes。

Next server 統一對 browser 提供 session、status、trust、AURA proxy、control mutation 與 CopilotKit runtime。兩個 Bridge 分別封裝 Python canonical evidence 與 Node Codex lifecycle。Codex Bridge以`run-in-podman.sh`啟動official vendor binary；vendor directory與auth file採read-only mount，只有allowlisted repositories及明列worktree/export roots採read-write mount。container中的official Codex再以managed-bubblewrap執行read-only或workspace-write tools。

Repository具有一個`Containerfile`與一個Podman wrapper；沒有Compose或Kubernetes manifest。Ubuntu base以digest固定，apt package versions仍由後續image provenance層封存。

## Evidence paths

- `package.json:L6` — Node process commands。
- `services/aura-bridge/src/aura_bridge/cli.py:L43` — AURA loopback process。
- `services/codex-bridge/src/cli.ts:L153` — Codex loopback process。
- `services/codex-bridge/Containerfile:L1` — Codex OCI image source。
- `services/codex-bridge/run-in-podman.sh:L9` — read-only與allowlisted read-write mounts。
- `docs/validation/2026-07-24-local-e2e.md:L84` — single-host image/live evidence。

## Assumptions

- 所有 runtime unit 在同一主機執行。

## Limitations

- 沒有process supervisor、Compose、Kubernetes或remote deployment evidence；Podman證據限單一host與單一fixture。

## Decisions

- Web/AURA/Bridge維持本機程序；Codex workspace-write採已驗證的rootless Podman+nested managed-bubblewrap target lane。

## Risks

- 多程序啟動順序、port、token、mount root與image provenance依賴操作runbook。

## Next validation

- 在reviewer選定的target commit重建image並封存base、apt package及image digest。
