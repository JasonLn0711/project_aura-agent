# 10 SBOM

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

套件同時產生 CycloneDX 1.6 JSON 與 SPDX 2.3 JSON，涵蓋完整 Node/Python lock identities、workspace component及分層標示的 native/model runtime。

CycloneDX使用 stable snapshot-derived UUID；SPDX使用 snapshot namespace。Repository license可由 `pyproject.toml`與 `LICENSE`確認為 MIT。workspace package manifest與lockfile沒有足夠的package-level license metadata，因此相關workspace package、dependency、native tool與external model均保守使用 `NOASSERTION`。

SBOM是source snapshot inventory，不是執行主機 attestation，也不是法律意見。它明確保留 coverage層次，讓 release owner能把 license resolution、model terms與binary provenance作為下一層驗證。

## Evidence paths

- `docs/architecture/repository-technical-architecture-report/sbom/cyclonedx.json` — CycloneDX artifact。
- `docs/architecture/repository-technical-architecture-report/sbom/spdx.json` — SPDX artifact。
- `pyproject.toml:L11` — MIT declaration。
- `LICENSE` — license text。
- `services/codex-bridge/Containerfile:L1` — digest-pinned Ubuntu base identity。

## Assumptions

- PURL與lock key足以在下一步解析上游 metadata。

## Limitations

- NOASSERTION元件尚未完成 license conclusion。
- 已列入Podman image與base digest，但apt package版本、official Codex vendor binary hash及model weight digest尚未形成完整attestation。

## Decisions

- 以完整 identity與誠實 license unknown優先於不完整的推測性授權清單。

## Risks

- 未完成 license/model terms review前不應視為 release-cleared supply chain。

## Next validation

- 用上游 registry與model card解析license，再進行人工合規覆核。
