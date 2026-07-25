# Repository Technical Architecture Report

這個 package 是 Project AURA + VOISS implemented MVP 的 source-backed architecture snapshot。

## Evidence contract

- Status: `IMPLEMENTED_MVP_SOURCE_SNAPSHOT`
- Product milestone: `LOCAL_E2E_VALIDATED`
- Scoped live run status: `LIVE_MINIMUM_COMPLETED`
- Source baseline: `6807f516d1083051d75373f110ac871f677f75ce`，只表示 AURA source lineage
- Current MVP evidence: uncommitted source and retained-validation snapshot `c5ccf5b8e02e3c73b5c3db7d44f66d80ec430cf3f50ddcfc4bf9327b794fc772`
- Artifact timestamp: `2026-07-25T00:00:00Z`（normalized；不代表產品runtime觀測時間）
- Retained evidence: `docs/validation/2026-07-24-local-e2e.md`記錄一個controlled fixture live flow、final-source quality matrix與single-host Podman runtime；本generator不宣稱自己執行了這些產品命令

本 package 包含：

- 20 份 report Markdown
- 12 份 Mermaid source
- 19 份 machine-readable inventory JSON
- CycloneDX 1.6 JSON 與 SPDX 2.3 JSON
- metadata、validation manifest 與 SHA-256 checksum list

## Coverage statement

`pnpm-lock.yaml` 的 Node resolved component identities與 `uv.lock` 的 Python package identities採完整盤點。transitive relationship edges維持 partial；native tools與external model/runtime採partial curated source-detected coverage。Podman container inventory包含digest-pinned Ubuntu base與observed local image identity，但apt package versions、vendor binary與model weights尚未形成完整attestation。Repository license為MIT；workspace package、dependency、native tool與model license在manifest或lockfile沒有可驗證package-level metadata時使用`NOASSERTION`。`docs/validation/logs/`是獨立checksummed runtime evidence，不進入source snapshot hash，避免驗證輸出與source identity形成循環。

## Generate and validate

```bash
python3 docs/architecture/repository-technical-architecture-report/generate.py
python3 docs/architecture/repository-technical-architecture-report/generate.py --check
```

`--check`驗證exact counts、JSON parse、report required sections、Mermaid source headers、retained validation markers/screenshot digest、source snapshot與checksums。它不執行產品build、test、服務啟動、模型推論或live E2E。

## Reading order

先讀`reports/01-executive-summary.md`、`reports/13-security-boundaries.md`與`reports/20-open-questions-unknowns-and-release-gates.md`；需要精確盤點時再讀`inventories/`與`sbom/`。
