#!/usr/bin/env python3
"""Generate and validate the repository technical architecture report package.

This script intentionally uses only the Python standard library.  It inventories
the current filesystem implementation, while treating the pinned Git commit as
source lineage rather than proof that the uncommitted MVP has been published.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
import tomllib
import uuid
from pathlib import Path
from typing import Any, Iterable


PACKAGE_DIR = Path(__file__).resolve().parent
ROOT = PACKAGE_DIR.parents[2]
BASELINE = "6807f516d1083051d75373f110ac871f677f75ce"
GENERATED_AT = "2026-07-25T00:00:00Z"
STATUS = "IMPLEMENTED_MVP_SOURCE_SNAPSHOT"
REPORT_STATUS = "Partially Verified"
PRODUCT_MILESTONE = "LOCAL_E2E_VALIDATED"
LIVE_RUN_STATUS = "LIVE_MINIMUM_COMPLETED"
EXPECTED_NODE_LOCK_RECORDS = 1245
EXPECTED_PYTHON_LOCK_RECORDS = 168
VALIDATION_RECORD = "docs/validation/2026-07-24-local-e2e.md"
DEMO_SCREENSHOT = "docs/validation/screenshots/2026-07-24-control-room-demo.png"
DEMO_SCREENSHOT_SHA256 = "d2207ad08b24191fc3dc590fe6e20b1cafa0f3c76f4fce7998cbd90aa5d1c2ac"
DEMO_WALKTHROUGH_SHA256 = "bde472bdcb409009d45f26dcb06c8f6f7dbbf925727c9d3d55e2bc88f8148e82"
SCHEMA_PREFIX = "voiss.repository-architecture"

REPORT_DIR = PACKAGE_DIR / "reports"
DIAGRAM_DIR = PACKAGE_DIR / "diagrams"
INVENTORY_DIR = PACKAGE_DIR / "inventories"
SBOM_DIR = PACKAGE_DIR / "sbom"
VALIDATION_DIR = PACKAGE_DIR / "validation"

REPORT_FILES = [
    "01-executive-summary.md",
    "02-repository-map.md",
    "03-technology-stack-inventory.md",
    "04-c4-system-context.md",
    "05-c4-container-architecture.md",
    "06-component-architecture.md",
    "07-runtime-and-data-flow.md",
    "08-api-and-interface-inventory.md",
    "09-dependency-graph-and-analysis.md",
    "10-sbom.md",
    "11-build-and-deployment-architecture.md",
    "12-configuration-and-environment-variables.md",
    "13-security-boundaries.md",
    "14-architecture-decision-records.md",
    "15-risks-and-technical-debt.md",
    "16-local-development-and-execution-guide.md",
    "17-testing-and-quality-strategy.md",
    "18-observability-and-operations.md",
    "19-data-storage-retention-and-lifecycle.md",
    "20-open-questions-unknowns-and-release-gates.md",
]

DIAGRAM_FILES = [
    "01-c4-system-context.mmd",
    "02-c4-container.mmd",
    "03-component-architecture.mmd",
    "04-runtime-flow.mmd",
    "05-meeting-to-execution-sequence.mmd",
    "06-codex-approval-sequence.mmd",
    "07-data-flow.mmd",
    "08-deployment.mmd",
    "09-security-boundaries.mmd",
    "10-internal-dependency-graph.mmd",
    "11-evidence-lifecycle.mmd",
    "12-trust-control-lifecycle.mmd",
]

INVENTORY_FILES = [
    "01-components.json",
    "02-entry-points.json",
    "03-apis-interfaces.json",
    "04-ag-ui-event-contracts.json",
    "05-codex-event-mappings.json",
    "06-environment-variables.json",
    "07-external-services.json",
    "08-databases-stores.json",
    "09-queues-events.json",
    "10-dependencies.json",
    "11-licenses.json",
    "12-tests.json",
    "13-risks.json",
    "14-controls.json",
    "15-assets.json",
    "16-findings.json",
    "17-scheduled-jobs.json",
    "18-ci-workflows.json",
    "19-containers-images.json",
]

TEXT_SUFFIXES = {
    ".css",
    ".json",
    ".md",
    ".mjs",
    ".png",
    ".ps1",
    ".py",
    ".sh",
    ".toml",
    ".ts",
    ".tsx",
    ".txt",
    ".yaml",
    ".yml",
}
SOURCE_ROOTS = ("apps", "packages", "services", "src", "tests", "scripts", "docs", ".github")
SOURCE_TOP_LEVEL = (
    ".gitignore",
    "DECISIONS.md",
    "KNOWN_LIMITATIONS.md",
    "LICENSE",
    "PROGRESS.md",
    "README.md",
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "pyproject.toml",
    "uv.lock",
)
EXCLUDED_PARTS = {
    ".git",
    ".next",
    ".next-local",
    ".pytest_cache",
    ".voiss",
    ".venv",
    "__pycache__",
    "node_modules",
    "playwright-report",
    "test-results",
}


def read_text(relative: str) -> str:
    return (ROOT / relative).read_text(encoding="utf-8")


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    return sha256_bytes(path.read_bytes())


def json_dump(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n"


def write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def git(*args: str) -> str:
    result = subprocess.run(
        ["git", *args],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout.strip()


def is_excluded(path: Path) -> bool:
    relative = path.relative_to(ROOT)
    if PACKAGE_DIR in path.parents or path == PACKAGE_DIR:
        return True
    if relative.parts[:3] == ("docs", "validation", "logs"):
        return True
    if any(part in EXCLUDED_PARTS for part in relative.parts):
        return True
    if path.name.endswith(".tsbuildinfo") or path.name == "next-env.d.ts":
        return True
    return False


def implementation_files() -> list[Path]:
    files: list[Path] = []
    for top in SOURCE_TOP_LEVEL:
        path = ROOT / top
        if path.is_file():
            files.append(path)
    for root_name in SOURCE_ROOTS:
        base = ROOT / root_name
        if not base.exists():
            continue
        for path in base.rglob("*"):
            if (
                path.is_file()
                and not is_excluded(path)
                and (
                    path.suffix.lower() in TEXT_SUFFIXES
                    or path.name == "Containerfile"
                )
            ):
                files.append(path)
    return sorted(set(files), key=lambda item: item.relative_to(ROOT).as_posix())


def implementation_snapshot() -> tuple[str, list[dict[str, Any]]]:
    digest = hashlib.sha256()
    records: list[dict[str, Any]] = []
    for path in implementation_files():
        relative = path.relative_to(ROOT).as_posix()
        data = path.read_bytes()
        file_digest = sha256_bytes(data)
        digest.update(relative.encode("utf-8"))
        digest.update(b"\0")
        digest.update(data)
        digest.update(b"\0")
        records.append(
            {
                "path": relative,
                "bytes": len(data),
                "sha256": file_digest,
            }
        )
    return digest.hexdigest(), records


def line_ref(relative: str, needle: str | None = None) -> str:
    path = ROOT / relative
    if not path.exists() or not needle:
        return relative
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if needle in line:
            return f"{relative}:L{number}"
    return relative


def source_metrics(relative: str) -> dict[str, int]:
    base = ROOT / relative
    files = [
        path
        for path in base.rglob("*")
        if path.is_file()
        and not is_excluded(path)
        and (
            path.suffix.lower() in TEXT_SUFFIXES
            or path.name == "Containerfile"
        )
    ]
    lines = 0
    for path in files:
        try:
            lines += len(path.read_text(encoding="utf-8").splitlines())
        except UnicodeDecodeError:
            pass
    return {"source_files": len(files), "source_lines": lines}


def evidence_item(relative: str, purpose: str, needle: str | None = None) -> dict[str, str]:
    return {
        "path": relative,
        "reference": line_ref(relative, needle),
        "purpose": purpose,
    }


def envelope(
    inventory_id: str,
    coverage: dict[str, Any],
    records: Any,
    evidence: Iterable[dict[str, str]],
    snapshot: str,
) -> dict[str, Any]:
    return {
        "$schema": f"{SCHEMA_PREFIX}.{inventory_id}.v1",
        "status": STATUS,
        "source_baseline": BASELINE,
        "source_baseline_role": "lineage_only",
        "product_milestone": PRODUCT_MILESTONE,
        "scoped_live_run_status": LIVE_RUN_STATUS,
        "current_evidence": {
            "kind": "uncommitted_source_and_retained_validation_snapshot",
            "sha256": snapshot,
            "generated_at": GENERATED_AT,
            "timestamp_semantics": "normalized_artifact_timestamp_not_wall_clock_observation",
        },
        "coverage": coverage,
        "evidence": list(evidence),
        "records": records,
    }


def parse_pnpm_lock() -> list[dict[str, Any]]:
    text = read_text("pnpm-lock.yaml")
    packages_section = text.split("\npackages:\n", 1)[1].split("\nsnapshots:\n", 1)[0]
    keys: list[str] = []
    for line in packages_section.splitlines():
        match = re.match(r"^  (\S.*):$", line)
        if match:
            keys.append(match.group(1).strip("'\""))
    records: list[dict[str, Any]] = []
    for index, lock_key in enumerate(keys, 1):
        identity = lock_key.split("(", 1)[0]
        if identity.startswith("@"):
            name, version = identity.rsplit("@", 1)
        else:
            name, version = identity.rsplit("@", 1)
        records.append(
            {
                "id": f"npm-lock-{index:04d}",
                "ecosystem": "npm",
                "name": name,
                "version": version,
                "lock_key": lock_key,
                "purl": f"pkg:npm/{name.replace('@', '%40', 1)}@{version}",
                "resolution_coverage": "complete_lock_record_identity",
                "relationship_coverage": "coarse_importer_and_workspace_only",
            }
        )
    return records


def parse_uv_lock() -> list[dict[str, Any]]:
    data = tomllib.loads(read_text("uv.lock"))
    records: list[dict[str, Any]] = []
    for index, package in enumerate(data.get("package", []), 1):
        name = str(package["name"])
        version = str(package["version"])
        source = package.get("source", {})
        records.append(
            {
                "id": f"pypi-lock-{index:04d}",
                "ecosystem": "PyPI",
                "name": name,
                "version": version,
                "source": source,
                "purl": f"pkg:pypi/{name}@{version}",
                "resolution_coverage": "complete_lock_record_identity",
                "relationship_coverage": "partial_marker_and_extra_aware",
            }
        )
    return records


def workspace_components() -> list[dict[str, Any]]:
    manifests = [
        ("voiss-aura-control-room", "application", "package.json", "Node.js/pnpm"),
        ("@voiss/aura-web", "application", "apps/voiss-aura-web/package.json", "Next.js"),
        ("@voiss/ag-ui-codex-adapter", "library", "packages/ag-ui-codex-adapter/package.json", "TypeScript"),
        ("@voiss/agent-runtime", "library", "packages/agent-runtime/package.json", "TypeScript"),
        ("@voiss/demo-fixtures", "library", "packages/demo-fixtures/package.json", "TypeScript"),
        ("@voiss/domain", "library", "packages/domain/package.json", "TypeScript/Zod"),
        ("@voiss/trust-engine", "library", "packages/trust-engine/package.json", "TypeScript/SQLite"),
        ("@voiss/codex-bridge", "service", "services/codex-bridge/package.json", "Node.js"),
        ("voiss-aura-bridge", "service", "services/aura-bridge/pyproject.toml", "Python/FastAPI"),
        ("project-aura-refactor", "application", "pyproject.toml", "Python/PyQt6"),
    ]
    records = []
    for name, kind, manifest, technology in manifests:
        version = "0.0.0-private"
        text = read_text(manifest)
        if manifest.endswith(".json"):
            version = json.loads(text).get("version", version)
        else:
            match = re.search(r'^version\s*=\s*"([^"]+)"', text, re.MULTILINE)
            if match:
                version = match.group(1)
        records.append(
            {
                "id": name,
                "name": name,
                "version": version,
                "type": kind,
                "manifest": manifest,
                "technology": technology,
            }
        )
    return records


NATIVE_TOOLS = [
    ("git", "repository and isolated-worktree operations", "services/codex-bridge/src/worktree.ts"),
    ("codex", "official Codex app-server child process", "services/codex-bridge/src/cli.ts"),
    ("node", "web, package, and Codex Bridge runtime", "package.json"),
    ("pnpm", "JavaScript workspace package manager", "package.json"),
    ("podman", "rootless Codex runtime container lane", "services/codex-bridge/run-in-podman.sh"),
    ("bash", "validated Podman wrapper shell", "services/codex-bridge/run-in-podman.sh"),
    ("python", "AURA desktop and AURA Bridge runtime", "pyproject.toml"),
    ("uv", "Python lock/workspace manager", "uv.lock"),
    ("ffmpeg", "audio conversion and export", "src/aura/audio/normalization.py"),
    ("ffprobe", "audio inspection", "src/aura/audio/normalization.py"),
    ("pactl", "Linux audio source diagnostics", "src/aura/audio/capture.py"),
    ("parec", "Linux native audio capture", "src/aura/audio/capture.py"),
    ("nvidia-smi", "GPU diagnostics", "src/aura/system/gpu_diagnostics.py"),
    ("nproc", "CPU-aware FFmpeg worker sizing", "src/aura/audio/normalization.py"),
    ("ollama", "local Gemma model lifecycle", "src/aura/llm/ollama_runtime.py"),
    ("PowerShell", "Windows run and packaging scripts", "scripts/run_aura_windows.ps1"),
    ("choco", "Windows CI FFmpeg installation", ".github/workflows/windows.yml"),
]

EXTERNAL_RUNTIME_COMPONENTS = [
    {
        "id": "model:faster-whisper-breeze-asr-25",
        "name": "SoybeanMilk/faster-whisper-Breeze-ASR-25",
        "kind": "model",
        "purpose": "local ASR",
        "evidence": "src/aura/config.py",
        "runtime_status": "external_runtime_activation_required",
    },
    {
        "id": "model:pyannote-speaker-diarization-community-1",
        "name": "pyannote/speaker-diarization-community-1",
        "kind": "model",
        "purpose": "speaker diarization",
        "evidence": "src/aura/config.py",
        "runtime_status": "external_runtime_activation_required",
    },
    {
        "id": "model:zh-wiki-punctuation-restore",
        "name": "p208p2002/zh-wiki-punctuation-restore",
        "kind": "model",
        "purpose": "Traditional Chinese punctuation restoration",
        "evidence": "src/aura/config.py",
        "runtime_status": "external_runtime_activation_required",
    },
    {
        "id": "model:gemma-4-e4b-it",
        "name": "google/gemma-4-E4B-it",
        "runtime_alias": "gemma4:e4b-it-qat",
        "kind": "model",
        "purpose": "local meeting summary through Ollama",
        "evidence": "src/summary/field_schemas.py",
        "runtime_status": "external_runtime_activation_required",
    },
    {
        "id": "model:mossformer2-se-48k",
        "name": "MossFormer2_SE_48K",
        "kind": "model",
        "purpose": "optional ClearVoice speech enhancement",
        "evidence": "src/aura/audio/enhancement_backends.py",
        "runtime_status": "separate_python_runtime_activation_required",
    },
    {
        "id": "model:gpt-5.6-sol",
        "name": "gpt-5.6-sol",
        "kind": "hosted_model",
        "purpose": "Codex engineering delegation",
        "evidence": VALIDATION_RECORD,
        "runtime_status": "verified_one_controlled_fixture_flow",
    },
    {
        "id": "runtime:ollama",
        "name": "Ollama",
        "kind": "local_model_runtime",
        "purpose": "Gemma 4 inference",
        "evidence": "src/aura/llm/ollama_runtime.py",
        "runtime_status": "local_service_activation_required",
    },
    {
        "id": "runtime:codex-app-server",
        "name": "Codex app-server",
        "kind": "local_agent_runtime",
        "purpose": "official Codex JSON-RPC execution",
        "evidence": VALIDATION_RECORD,
        "required_version": "0.145.0",
        "runtime_status": "verified_single_host_rootless_podman_target_lane",
    },
    {
        "id": "runtime:clearvoice-python",
        "name": "ClearVoice external Python environment",
        "kind": "separate_python_runtime",
        "purpose": "optional isolated MossFormer2 speech-enhancement execution",
        "evidence": "src/aura/audio/enhancement_backends.py",
        "runtime_status": "AURA_CLEARVOICE_PYTHON_activation_required",
    },
    {
        "id": "runtime:nvidia-cuda",
        "name": "NVIDIA driver and CUDA/cuBLAS/cuDNN",
        "kind": "native_accelerator_runtime",
        "purpose": "GPU model inference",
        "evidence": "src/aura/system/cuda.py",
        "runtime_status": "host_specific_activation_required",
    },
    {
        "id": "container:ubuntu-24.04-codex-runtime-base",
        "name": "ubuntu:24.04",
        "kind": "container_base_image",
        "purpose": "digest-pinned base for the verified rootless Podman Codex lane",
        "evidence": "services/codex-bridge/Containerfile",
        "required_version": "24.04",
        "digest": "sha256:c4a8d5503dfb2a3eb8ab5f807da5bc69a85730fb49b5cfca2330194ebcc41c7b",
        "runtime_status": "verified_single_host_build_apt_versions_not_pinned",
    },
]


def component_inventory(snapshot: str) -> dict[str, Any]:
    components = [
        {
            "id": "legacy-aura-desktop",
            "kind": "desktop_application",
            "path": "src/aura",
            "responsibility": "audio capture, ASR, review, summary, evidence, audit, and local UI",
            **source_metrics("src/aura"),
        },
        {
            "id": "summary-pipeline",
            "kind": "python_library",
            "path": "src/summary",
            "responsibility": "structured Gemma/Ollama summary and claim-layer generation",
            **source_metrics("src/summary"),
        },
        {
            "id": "voiss-aura-web",
            "kind": "web_application",
            "path": "apps/voiss-aura-web",
            "responsibility": "local control-room UI and same-origin server boundaries",
            **source_metrics("apps/voiss-aura-web"),
        },
        {
            "id": "domain",
            "kind": "typescript_library",
            "path": "packages/domain",
            "responsibility": "Zod-backed evidence, action, run, approval, and trust contracts",
            **source_metrics("packages/domain"),
        },
        {
            "id": "demo-fixtures",
            "kind": "typescript_library",
            "path": "packages/demo-fixtures",
            "responsibility": "deterministic demo-mode meeting and run evidence",
            **source_metrics("packages/demo-fixtures"),
        },
        {
            "id": "trust-engine",
            "kind": "typescript_library",
            "path": "packages/trust-engine",
            "responsibility": "SQLite metadata, hash-chain audit, evidence controls, and redaction",
            **source_metrics("packages/trust-engine"),
        },
        {
            "id": "agent-runtime",
            "kind": "typescript_library",
            "path": "packages/agent-runtime",
            "responsibility": "named orchestrator, Codex engineer, and demo agents",
            **source_metrics("packages/agent-runtime"),
        },
        {
            "id": "ag-ui-codex-adapter",
            "kind": "typescript_library",
            "path": "packages/ag-ui-codex-adapter",
            "responsibility": "Codex Bridge stream transport and AG-UI normalization",
            **source_metrics("packages/ag-ui-codex-adapter"),
        },
        {
            "id": "aura-bridge",
            "kind": "python_service",
            "path": "services/aura-bridge",
            "responsibility": "loopback authenticated read/review/export access to canonical AURA evidence",
            **source_metrics("services/aura-bridge"),
        },
        {
            "id": "codex-bridge",
            "kind": "node_service",
            "path": "services/codex-bridge",
            "responsibility": "loopback Codex app-server mediation, approval, isolation, and export",
            **source_metrics("services/codex-bridge"),
        },
    ]
    return envelope(
        "components",
        {
            "workspace_components": "complete_for_current_implementation_roots",
            "generated_or_vendor_trees": "excluded",
        },
        components,
        [
            evidence_item("pnpm-workspace.yaml", "Node workspace topology", "packages:"),
            evidence_item("pyproject.toml", "Python workspace topology", "[tool.uv.workspace]"),
        ],
        snapshot,
    )


def entry_point_inventory(snapshot: str) -> dict[str, Any]:
    records = [
        {"id": "web-dev", "command": "pnpm dev", "path": "package.json", "scope": "local web"},
        {"id": "web-demo", "command": "pnpm demo", "path": "package.json", "scope": "fixture demo"},
        {"id": "aura-desktop", "command": "uv run aura", "path": "pyproject.toml", "scope": "desktop"},
        {"id": "aura-evidence", "command": "uv run aura-evidence", "path": "pyproject.toml", "scope": "evidence CLI"},
        {"id": "aura-bridge", "command": "uv run aura-bridge", "path": "services/aura-bridge/pyproject.toml", "scope": "loopback service"},
        {"id": "codex-bridge", "command": "pnpm --filter @voiss/codex-bridge start", "path": "services/codex-bridge/package.json", "scope": "loopback service"},
        {"id": "codex-runtime-build", "command": "pnpm codex:runtime:build", "path": "package.json", "scope": "digest-pinned rootless Podman image"},
        {"id": "codex-runtime-wrapper", "command": "services/codex-bridge/run-in-podman.sh app-server --listen stdio://", "path": "services/codex-bridge/run-in-podman.sh", "scope": "verified Codex target lane"},
        {"id": "web-page", "command": "Next.js App Router /", "path": "apps/voiss-aura-web/app/page.tsx", "scope": "browser"},
        {"id": "windows-launch", "command": "scripts/run_aura_windows.ps1", "path": "scripts/run_aura_windows.ps1", "scope": "Windows desktop"},
        {"id": "architecture-boundary-check", "command": "pnpm test:architecture", "path": "scripts/check_architecture_boundaries.mjs", "scope": "static architecture policy"},
        {"id": "live-browser-e2e", "command": "VOISS_LIVE_E2E=1 pnpm test:e2e:live", "path": "apps/voiss-aura-web/playwright.live.config.ts", "scope": "activation-gated real local services"},
        {"id": "architecture-generator", "command": "python3 docs/architecture/repository-technical-architecture-report/generate.py", "path": PACKAGE_DIR.relative_to(ROOT).as_posix() + "/generate.py", "scope": "documentation"},
    ]
    return envelope(
        "entry-points",
        {"declared_manifests": "complete", "ad_hoc_scripts": "curated_high_value"},
        records,
        [
            evidence_item("package.json", "root scripts", '"scripts"'),
            evidence_item("pyproject.toml", "Python console scripts", "[project.scripts]"),
        ],
        snapshot,
    )


def api_inventory(snapshot: str) -> dict[str, Any]:
    records = [
        {"owner": "web", "method": "GET", "path": "/api/session", "purpose": "same-origin session bootstrap"},
        {"owner": "web", "method": "GET", "path": "/api/status", "purpose": "AURA/Codex readiness summary"},
        {"owner": "web", "method": "GET", "path": "/api/trust", "purpose": "persistent trust snapshot"},
        {"owner": "web", "method": "GET", "path": "/api/aura/[...path]", "purpose": "allowlisted AURA read proxy"},
        {"owner": "web", "method": "GET", "path": "/api/aura-audio", "purpose": "allowlisted AURA audio-span proxy"},
        {"owner": "web", "method": "POST", "path": "/api/control-room", "purpose": "claim review, run approval/stop, validation-gated evidence export, and operator/runtime-observation audit boundary"},
        {"owner": "web", "method": "GET|POST", "path": "/api/copilotkit/[...path]", "purpose": "CopilotKit runtime and AG-UI stream"},
        {"owner": "aura-bridge", "method": "GET", "path": "/v1/health", "purpose": "service and source readiness"},
        {"owner": "aura-bridge", "method": "GET", "path": "/v1/sessions", "purpose": "meeting session list"},
        {"owner": "aura-bridge", "method": "GET", "path": "/v1/sessions/{session_id}", "purpose": "meeting detail"},
        {"owner": "aura-bridge", "method": "GET", "path": "/v1/sessions/{session_id}/segments", "purpose": "transcript segments"},
        {"owner": "aura-bridge", "method": "GET", "path": "/v1/sessions/{session_id}/claims", "purpose": "claim list"},
        {"owner": "aura-bridge", "method": "POST", "path": "/v1/sessions/{session_id}/claims/{claim_id}/review", "purpose": "explicit claim review"},
        {"owner": "aura-bridge", "method": "GET", "path": "/v1/actions", "purpose": "evidence-backed actions"},
        {"owner": "aura-bridge", "method": "GET", "path": "/v1/evidence/search", "purpose": "canonical evidence search"},
        {"owner": "aura-bridge", "method": "POST", "path": "/v1/evidence/audio-span", "purpose": "bounded audio evidence"},
        {"owner": "aura-bridge", "method": "GET", "path": "/v1/audit/events", "purpose": "audit timeline"},
        {"owner": "aura-bridge", "method": "POST", "path": "/v1/evidence/export", "purpose": "reviewed evidence export"},
        {"owner": "aura-bridge", "method": "GET", "path": "/v1/evidence/exports/{export_id}", "purpose": "validated export download"},
        {"owner": "codex-bridge", "method": "GET", "path": "/v1/status", "purpose": "Codex account/runtime readiness"},
        {"owner": "codex-bridge", "method": "POST", "path": "/v1/runs", "purpose": "start read or write-gated run stream"},
        {"owner": "codex-bridge", "method": "POST", "path": "/v1/approvals/resume", "purpose": "resume exact pending approval"},
        {"owner": "codex-bridge", "method": "POST", "path": "/v1/runs/{run_id}/stop", "purpose": "cancel staged write activation or interrupt an active run"},
        {"owner": "codex-bridge", "method": "POST", "path": "/v1/evidence/export", "purpose": "export sanitized completed-write evidence only after an in-scope pass matches terminal patch SHA-256 and mutation generation with no failure or overflow"},
    ]
    return envelope(
        "apis-interfaces",
        {
            "implemented_http_routes": "complete_curated_from_current_source",
            "internal_python_and_typescript_functions": "covered_by_component_boundaries_not_exhaustive",
        },
        records,
        [
            evidence_item("apps/voiss-aura-web/app/api/control-room/route.ts", "web mutation boundary", "export async function POST"),
            evidence_item("services/aura-bridge/src/aura_bridge/app.py", "AURA HTTP routes", '@app.get("/v1/health"'),
            evidence_item("services/codex-bridge/src/server.ts", "Codex HTTP routes", '"/v1/runs"'),
        ],
        snapshot,
    )


def ag_ui_inventory(snapshot: str) -> dict[str, Any]:
    records = [
        {"event": "RUN_STARTED", "source_family": "thread/started or agent start", "semantic": "run lifecycle"},
        {"event": "STATE_SNAPSHOT", "source_family": "thread/started", "semantic": "initial normalized state"},
        {"event": "ACTIVITY_SNAPSHOT", "source_family": "plan, command, file, diff, approval", "semantic": "VOISS activity envelope"},
        {"event": "STEP_STARTED", "source_family": "turn/started", "semantic": "Codex turn step"},
        {"event": "STATE_DELTA", "source_family": "turn and run status", "semantic": "JSON Patch-like state change"},
        {"event": "TEXT_MESSAGE_START", "source_family": "agent message", "semantic": "assistant message open"},
        {"event": "TEXT_MESSAGE_CONTENT", "source_family": "agent message delta", "semantic": "redacted text delta"},
        {"event": "TEXT_MESSAGE_END", "source_family": "agent message completed", "semantic": "assistant message close"},
        {"event": "TOOL_CALL_START", "source_family": "command start", "semantic": "command tool lifecycle"},
        {"event": "TOOL_CALL_ARGS", "source_family": "command start", "semantic": "redacted command/cwd"},
        {"event": "TOOL_CALL_END", "source_family": "command completion", "semantic": "command completion"},
        {"event": "TOOL_CALL_RESULT", "source_family": "command completion", "semantic": "redacted output and exit evidence"},
        {"event": "RUN_FINISHED", "source_family": "turn completed or approval interrupt", "semantic": "terminal or resumable interrupt"},
        {"event": "RUN_ERROR", "source_family": "Codex error or transport failure", "semantic": "sanitized failure"},
    ]
    return envelope(
        "ag-ui-event-contracts",
        {"normalized_event_types": "complete_for_current_adapter_switch", "payload_fields": "semantic_summary"},
        records,
        [evidence_item("packages/ag-ui-codex-adapter/src/index.ts", "AG-UI normalizer", "class CodexEventNormalizer")],
        snapshot,
    )


def codex_mapping_inventory(snapshot: str) -> dict[str, Any]:
    records = [
        {"bridge_event": "run.started", "http_method": "thread/started", "adapter": "mapped"},
        {"bridge_event": "turn.started", "http_method": "turn/started", "adapter": "mapped"},
        {"bridge_event": "item.started", "http_method": "item/started", "adapter": "mapped"},
        {"bridge_event": "item.completed", "http_method": "item/completed", "adapter": "mapped"},
        {"bridge_event": "message.delta", "http_method": "item/agentMessage/delta", "adapter": "mapped"},
        {
            "bridge_event": "plan.delta",
            "http_method": "item/plan/delta",
            "adapter": "mapped_to_bounded_redacted_plan_activity",
            "finding": "F-ADAPTER-PLAN-DELTA",
        },
        {"bridge_event": "plan.updated", "http_method": "turn/plan/updated", "adapter": "mapped"},
        {"bridge_event": "command.output", "http_method": "item/commandExecution/outputDelta", "adapter": "mapped"},
        {"bridge_event": "file.patch", "http_method": "item/fileChange/patchUpdated", "adapter": "mapped"},
        {"bridge_event": "diff.updated", "http_method": "turn/diff/updated", "adapter": "mapped"},
        {"bridge_event": "approval.requested", "http_method": "item/commandExecution/requestApproval or item/fileChange/requestApproval", "adapter": "mapped_to_interrupt"},
        {"bridge_event": "approval.resolved", "http_method": "serverRequest/resolved", "adapter": "mapped"},
        {"bridge_event": "turn.completed", "http_method": "turn/completed", "adapter": "mapped_terminal"},
        {"bridge_event": "run.error", "http_method": "error", "adapter": "mapped_terminal"},
    ]
    return envelope(
        "codex-event-mappings",
        {
            "bridge_event_families": "complete_for_current_server_emissions",
            "adapter_mapping": "complete_for_current_bridge_event_families",
        },
        records,
        [
            evidence_item("services/codex-bridge/src/server.ts", "HTTP event envelope mapping", "plan.delta"),
            evidence_item("packages/ag-ui-codex-adapter/src/index.ts", "normalizer switch including bounded plan delta", 'case "item/plan/delta"'),
        ],
        snapshot,
    )


def environment_inventory(snapshot: str) -> dict[str, Any]:
    groups: dict[str, list[tuple[str, str, str, bool]]] = {
        "web": [
            ("VOISS_MODE", "demo/local mode selection", "demo unless local", False),
            ("VOISS_SESSION_SECRET", "signed same-origin session cookie", "required local secret", True),
            ("VOISS_WEB_ORIGINS", "allowed browser origins", "loopback origin", False),
            ("VOISS_DB_PATH", "persistent trust SQLite path", ".voiss/control-plane.sqlite", False),
            ("VOISS_AGENT_DB_PATH", "CopilotKit runner SQLite path", ".voiss/agent-runs.sqlite", False),
            ("AURA_BRIDGE_URL", "AURA loopback service URL", "required local", False),
            ("AURA_BRIDGE_TOKEN", "AURA bearer token", "required local", True),
            ("CODEX_BRIDGE_URL", "Codex loopback service URL", "required local", False),
            ("CODEX_BRIDGE_TOKEN", "Codex bearer token", "required local", True),
            ("NODE_ENV", "Next.js environment and cookie/CSP behavior", "tool-managed", False),
        ],
        "aura_bridge": [
            ("AURA_ARTIFACT_ROOT", "canonical AURA artifact root", "required", False),
            ("AURA_BRIDGE_PORT", "loopback port", "8765", False),
            ("AURA_BRIDGE_TOKEN", "bearer token", "required", True),
            ("AURA_ALLOWED_ORIGINS", "allowed same-origin callers", "http://127.0.0.1:3000", False),
            ("AURA_EVIDENCE_INDEX", "evidence SQLite path", "state/evidence.sqlite3", False),
            ("AURA_AUDIT_ROOT", "audit JSONL root", "state/audit", False),
            ("VOISS_EXPORT_ROOT", "reviewed export root", "state/exports", False),
        ],
        "codex_bridge": [
            ("CODEX_BRIDGE_TOKEN", "bearer token", "required", True),
            ("VOISS_ALLOWED_REPOSITORIES", "explicit repository allowlist", "required", False),
            ("VOISS_ALLOWED_REPO_ROOTS", "legacy alias for allowlist roots", "optional", False),
            ("CODEX_ALLOWED_ORIGINS", "allowed caller origins", "http://127.0.0.1:3000", False),
            ("VOISS_ALLOWED_ORIGINS", "generic allowed-caller origin alias", "optional", False),
            ("CODEX_BRIDGE_PORT", "loopback port", "8770", False),
            ("CODEX_PROCESS_TIMEOUT_SECONDS", "Codex child-process ceiling", "implementation default", False),
            ("CODEX_REQUEST_TIMEOUT_SECONDS", "JSON-RPC request ceiling", "implementation default", False),
            ("CODEX_APPROVAL_TIMEOUT_SECONDS", "approval pause ceiling; resume or stop remains available", "300", False),
            ("CODEX_BIN", "Codex executable", "codex", False),
            ("VOISS_WORKTREE_ROOT", "isolated worktree parent", "OS temporary root", False),
            ("CODEX_EXPORT_ROOT", "sanitized evidence export root", "state path", False),
            ("VOISS_DB_PATH", "persistent lifecycle/control-plane SQLite path", ".voiss/control-plane.sqlite", False),
            ("VOISS_OBSERVABILITY_LOG", "bounded local JSONL log", "platform state path", False),
        ],
        "codex_podman_wrapper": [
            ("CODEX_VENDOR_DIR", "installed official Codex Linux vendor directory mounted read-only", "required for verified Podman lane", False),
            ("CODEX_AUTH_FILE", "Codex auth.json locator mounted read-only", "required sensitive path for verified Podman lane", True),
            ("CODEX_PODMAN_IMAGE", "local Codex runtime image tag", "localhost/voiss-codex-runtime:0.145.0", False),
        ],
        "aura_desktop": [
            ("AURA_CLEARVOICE_PYTHON", "separate ClearVoice interpreter", "optional", False),
            ("HUGGINGFACE_TOKEN", "model access token", "optional by model", True),
            ("HF_TOKEN", "model access token alias", "optional by model", True),
            ("AURA_HF_TOKEN_FILE", "local token-file locator", "optional", True),
            ("AURA_AUDIT_DIR", "audit event directory", "platform state path", False),
            ("AURA_AUDIT_ENABLED", "audit activation", "true", False),
            ("AURA_AUDIT_RETENTION_DAYS", "audit retention window", "implementation default", False),
            ("AURA_RUNTIME_DIR", "runtime state root", "platform data path", False),
            ("XDG_DATA_HOME", "Linux data root", "platform default", False),
            ("XDG_STATE_HOME", "Linux state root", "platform default", False),
            ("LOCALAPPDATA", "Windows local state root", "platform default", False),
            ("CUDA_PATH", "CUDA toolkit locator", "host-specific", False),
            ("PATH", "native executable resolution", "host-specific", False),
            ("container", "container-runtime signal", "optional", False),
        ],
        "codex_child_allowlist": [
            (name, "forwarded non-secret process context", "inherited when present", False)
            for name in (
                "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL",
                "LC_CTYPE", "TERM", "COLORTERM", "NO_COLOR", "XDG_CONFIG_HOME",
                "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "CODEX_HOME",
            )
        ],
    }
    records = []
    for group, values in groups.items():
        for name, purpose, default, secret in values:
            records.append(
                {
                    "group": group,
                    "name": name,
                    "purpose": purpose,
                    "default_or_gate": default,
                    "secret": secret,
                }
            )
    return envelope(
        "environment-variables",
        {
            "runtime_contract_variables": "complete_curated_from_current_source",
            "test_only_variables": "excluded",
            "ambient_os_variables": "bounded_to_explicitly_consumed_or_forwarded_names",
        },
        records,
        [
            evidence_item("apps/voiss-aura-web/lib/security.ts", "web session boundary", "VOISS_SESSION_SECRET"),
            evidence_item("services/aura-bridge/src/aura_bridge/cli.py", "AURA Bridge configuration", "AURA_BRIDGE_TOKEN"),
            evidence_item("services/codex-bridge/src/cli.ts", "Codex Bridge configuration", "CODEX_BRIDGE_TOKEN"),
            evidence_item("services/codex-bridge/run-in-podman.sh", "Podman wrapper configuration and mount policy", "CODEX_VENDOR_DIR"),
        ],
        snapshot,
    )


def external_service_inventory(snapshot: str) -> dict[str, Any]:
    records = [
        {
            **item,
            "network_scope": "local_loopback_or_provider_managed_as_named",
            "coverage": "curated_source_detected",
        }
        for item in EXTERNAL_RUNTIME_COMPONENTS
    ]
    records.extend(
        [
            {
                "id": "service:hugging-face-hub",
                "name": "Hugging Face Hub",
                "kind": "external_artifact_source",
                "purpose": "optional acquisition of declared ASR, diarization, and punctuation model artifacts",
                "evidence": "src/aura/config.py",
                "runtime_status": "network_or_prepopulated_cache_activation_required",
                "network_scope": "external_during_explicit_model_acquisition",
                "coverage": "partial_curated_source_detected",
            },
            {
                "id": "service:codex-provider",
                "name": "Codex model provider",
                "kind": "external_agent_provider",
                "purpose": "authenticated gpt-5.6-sol execution mediated by official Codex app-server",
                "evidence": VALIDATION_RECORD,
                "runtime_status": "verified_one_controlled_fixture_flow",
                "network_scope": "owned_by_codex_app_server_not_browser_or_bridge_policy",
                "coverage": "partial_curated_source_detected",
            },
            {
                "id": "service:aura-bridge",
                "name": "AURA Bridge",
                "kind": "loopback_http",
                "purpose": "canonical meeting evidence",
                "evidence": VALIDATION_RECORD,
                "runtime_status": "verified_one_controlled_fixture_flow",
                "network_scope": "127.0.0.1",
                "coverage": "complete_internal_service",
            },
            {
                "id": "service:codex-bridge",
                "name": "Codex Bridge",
                "kind": "loopback_http",
                "purpose": "Codex mediation and approvals",
                "evidence": VALIDATION_RECORD,
                "runtime_status": "verified_one_controlled_fixture_flow_via_rootless_podman",
                "network_scope": "127.0.0.1",
                "coverage": "complete_internal_service",
            },
        ]
    )
    return envelope(
        "external-services",
        {
            "internal_loopback_services": "complete",
            "models_native_and_provider_runtimes": "partial_curated_source_detected",
            "live_availability": "one_controlled_fixture_flow_retained_for_AURA_Codex_and_browser",
            "claim_ceiling": "single_host_single_fixture_not_production_or_multi_repository_repeatability",
        },
        records,
        [
            evidence_item("src/aura/system/runtime_report.py", "host/runtime diagnostic surface", "collect_ollama_diagnostics"),
            evidence_item(VALIDATION_RECORD, "retained one-run live runtime evidence", "Codex events in the exported write-run packet"),
        ],
        snapshot,
    )


def database_inventory(snapshot: str) -> dict[str, Any]:
    records = [
        {
            "id": "voiss-control-plane",
            "technology": "SQLite via node:sqlite",
            "default_locator": ".voiss/control-plane.sqlite",
            "owner": "trust-engine/web server",
            "declared_tables": [
                "workspaces", "repositories", "aura_sessions_cache", "actions",
                "agent_runs", "codex_threads", "run_events", "approvals",
                "validation_results", "assets", "controls", "control_results",
                "findings", "remediations", "audit_events", "exports",
            ],
            "actively_wired_tables": [
                "workspaces", "repositories", "actions", "agent_runs",
                "codex_threads", "run_events", "approvals",
                "validation_results", "assets", "controls", "findings",
                "audit_events", "exports",
            ],
            "reserved_schema_tables": [
                "aura_sessions_cache", "control_results", "remediations",
            ],
            "status": "persistent_trust_and_codex_lifecycle_wiring_implemented",
        },
        {
            "id": "aura-evidence-index",
            "technology": "SQLite",
            "default_locator": "AURA_EVIDENCE_INDEX or AURA state root/evidence.sqlite3",
            "owner": "AURA Bridge and AURA evidence search",
            "tables": ["meetings", "segments", "actions"],
            "status": "implemented",
        },
        {
            "id": "copilotkit-agent-runner",
            "technology": "SQLite via @copilotkit/sqlite-runner",
            "default_locator": "VOISS_AGENT_DB_PATH or .voiss/agent-runs.sqlite",
            "owner": "Web CopilotKit runtime",
            "tables": ["agent_runs", "run_state", "schema_version"],
            "status": "persistent_parent_linked_runner_history_implemented",
            "scope_control": "uses a dedicated file separate from VOISS_DB_PATH",
        },
        {
            "id": "aura-artifact-tree",
            "technology": "filesystem JSON/WAV/Markdown",
            "default_locator": "AURA_ARTIFACT_ROOT",
            "owner": "AURA",
            "status": "canonical_file_evidence",
        },
        {
            "id": "aura-audit",
            "technology": "append-oriented JSONL",
            "default_locator": "AURA_AUDIT_ROOT or platform state path",
            "owner": "AURA",
            "status": "implemented",
        },
        {
            "id": "reviewed-exports",
            "technology": "filesystem JSON bundles",
            "default_locator": "VOISS_EXPORT_ROOT and CODEX_EXPORT_ROOT",
            "owner": "bridges",
            "status": "implemented_export_paths",
        },
        {
            "id": "codex-worktrees",
            "technology": "Git worktree filesystem",
            "default_locator": "VOISS_WORKTREE_ROOT or OS temporary root",
            "owner": "Codex Bridge",
            "status": "ephemeral_isolation_path",
        },
    ]
    return envelope(
        "databases-stores",
        {"implemented_stores": "complete_curated", "runtime_instances": "not_inspected"},
        records,
        [
            evidence_item("packages/trust-engine/src/index.ts", "control-plane schema", "CREATE TABLE IF NOT EXISTS workspaces"),
            evidence_item("apps/voiss-aura-web/lib/trust-store.ts", "persistent web wiring", "VOISS_DB_PATH"),
            evidence_item("apps/voiss-aura-web/app/api/copilotkit/[...path]/route.ts", "CopilotKit runner persistence", "VOISS_AGENT_DB_PATH"),
            evidence_item("src/aura/evidence_search.py", "AURA evidence schema", "CREATE TABLE meetings"),
        ],
        snapshot,
    )


def queue_event_inventory(snapshot: str) -> dict[str, Any]:
    records = [
        {"id": "ag-ui-observable", "kind": "in_process_stream", "owner": "AG-UI adapter", "durability": "none", "backpressure": "consumer-driven AsyncIterable/Observable"},
        {"id": "codex-jsonrpc", "kind": "stdio_json_rpc", "owner": "Codex Bridge", "durability": "run evidence export only", "backpressure": "process and request timeouts"},
        {"id": "codex-http-stream", "kind": "NDJSON_or_SSE", "owner": "Codex Bridge", "durability": "sanitized export path", "backpressure": "HTTP stream"},
        {"id": "aura-asr-threads", "kind": "PyQt worker threads", "owner": "AURA desktop", "durability": "artifact output", "backpressure": "finding R-002 remains relevant to bounded queue design"},
        {"id": "trust-audit-chain", "kind": "SQLite append sequence", "owner": "TrustStore", "durability": "persistent SQLite", "backpressure": "synchronous local writes"},
        {"id": "external-broker", "kind": "message_broker", "owner": "none", "durability": "not_applicable", "backpressure": "no Kafka, RabbitMQ, Redis queue, or cloud queue implemented"},
    ]
    return envelope(
        "queues-events",
        {"in_process_and_streaming_paths": "complete_curated", "external_brokers": "none_detected"},
        records,
        [
            evidence_item("packages/ag-ui-codex-adapter/src/index.ts", "stream transport", "AsyncIterable<CodexBridgeEvent>"),
            evidence_item("packages/trust-engine/src/index.ts", "ordered audit sequence", "AUTOINCREMENT"),
        ],
        snapshot,
    )


def dependency_inventory(
    snapshot: str,
    node_records: list[dict[str, Any]],
    python_records: list[dict[str, Any]],
) -> dict[str, Any]:
    native = [
        {
            "id": f"native:{name}",
            "name": name,
            "purpose": purpose,
            "evidence": path,
            "coverage": "partial_curated_source_detected",
        }
        for name, purpose, path in NATIVE_TOOLS
    ]
    return envelope(
        "dependencies",
        {
            "node_component_identities": {
                "level": "complete",
                "source": "pnpm-lock.yaml packages section",
                "records": len(node_records),
            },
            "python_component_identities": {
                "level": "complete",
                "source": "uv.lock package records",
                "records": len(python_records),
            },
            "workspace_manifests": {"level": "complete", "records": len(workspace_components())},
            "transitive_relationship_edges": "partial_due_to_peer_variants_markers_and_optional_extras",
            "native_tools": {"level": "partial_curated_source_detected", "records": len(native)},
            "external_models_and_runtimes": {
                "level": "partial_curated_source_detected",
                "records": len(EXTERNAL_RUNTIME_COMPONENTS),
            },
        },
        {
            "workspace_components": workspace_components(),
            "node_lock_records": node_records,
            "python_lock_records": python_records,
            "native_tools": native,
            "external_models_and_runtimes": EXTERNAL_RUNTIME_COMPONENTS,
        },
        [
            evidence_item("pnpm-lock.yaml", "complete Node resolved identities", "packages:"),
            evidence_item("uv.lock", "complete Python resolved identities", "[[package]]"),
            evidence_item("pnpm-workspace.yaml", "workspace importers", "packages:"),
        ],
        snapshot,
    )


def license_inventory(
    snapshot: str,
    node_records: list[dict[str, Any]],
    python_records: list[dict[str, Any]],
) -> dict[str, Any]:
    records = [
        {
            "component": "project-aura-refactor",
            "ecosystem": "repository",
            "version": "1.15.0",
            "license_concluded": "MIT",
            "license_source": "pyproject.toml and LICENSE",
            "assertion": "declared",
        }
    ]
    for item in workspace_components():
        if item["id"] == "project-aura-refactor":
            continue
        records.append(
            {
                "component": item["name"],
                "ecosystem": "workspace",
                "version": item["version"],
                "license_concluded": "NOASSERTION",
                "license_source": "workspace_manifest_has_no_individual_license_field",
                "assertion": "repository_is_MIT_but_package_level_conclusion_is_pending",
            }
        )
    for item in [*node_records, *python_records]:
        records.append(
            {
                "component": item["name"],
                "ecosystem": item["ecosystem"],
                "version": item["version"],
                "lock_key": item.get("lock_key"),
                "license_concluded": "NOASSERTION",
                "license_source": "lockfiles_do_not_carry_verified_license_metadata",
                "assertion": "pending_external_license_resolution",
            }
        )
    for item in EXTERNAL_RUNTIME_COMPONENTS:
        records.append(
            {
                "component": item["name"],
                "ecosystem": item["kind"],
                "version": item.get("required_version", "NOASSERTION"),
                "license_concluded": "NOASSERTION",
                "license_source": "external_runtime_license_not_resolved_in_repository",
                "assertion": "pending_external_license_resolution",
            }
        )
    for name, purpose, path in NATIVE_TOOLS:
        records.append(
            {
                "component": name,
                "ecosystem": "native_tool",
                "version": "NOASSERTION",
                "license_concluded": "NOASSERTION",
                "license_source": f"source_detected_at_{path}",
                "assertion": f"partial_curated_coverage; {purpose}; host_package_license_pending",
            }
        )
    return envelope(
        "licenses",
        {
            "repository_license": "declared_MIT",
            "workspace_dependency_model_and_native_licenses": "partial_NOASSERTION",
            "license_compliance_review": "release_gate",
        },
        records,
        [
            evidence_item("pyproject.toml", "repository license declaration", 'license = "MIT"'),
            evidence_item("LICENSE", "repository license text"),
            evidence_item("pnpm-lock.yaml", "Node identity source without license metadata"),
            evidence_item("uv.lock", "Python identity source without license metadata"),
        ],
        snapshot,
    )


def test_inventory(snapshot: str) -> dict[str, Any]:
    paths: list[Path] = []
    for base_name in ("apps", "packages", "services", "tests"):
        base = ROOT / base_name
        if base.exists():
            paths.extend(
                path
                for path in base.rglob("*")
                if path.is_file()
                and not is_excluded(path)
                and (
                    path.name.startswith("test_")
                    or path.name.endswith((".test.ts", ".test.tsx", ".spec.ts", ".spec.tsx"))
                )
            )
    architecture_check = ROOT / "scripts/check_architecture_boundaries.mjs"
    if architecture_check.exists():
        paths.append(architecture_check)
    records = []
    for path in sorted(set(paths)):
        text = path.read_text(encoding="utf-8")
        if path.suffix == ".py":
            cases = len(re.findall(r"^\s*def test_", text, re.MULTILINE))
            framework = "pytest"
        elif path.name == "check_architecture_boundaries.mjs":
            cases = len(re.findall(r"\bassert\.", text))
            framework = "node:assert"
        else:
            cases = len(re.findall(r"\b(?:it|test)\s*\(", text))
            framework = "playwright" if (
                "/e2e/" in path.as_posix()
                or "/live/" in path.as_posix()
                or path.name.endswith((".spec.ts", ".spec.tsx"))
            ) else (
                "node:test" if "services/codex-bridge" in path.as_posix() else "vitest"
            )
        records.append(
            {
                "path": path.relative_to(ROOT).as_posix(),
                "framework": framework,
                "test_case_declarations": cases,
                "status": "test_surface_present",
                "execution_result": "not_asserted_by_architecture_generator",
            }
        )
    return envelope(
        "tests",
        {
            "test_files": "complete_source_scan",
            "test_case_counts": "static_regex_approximation",
            "runtime_results_by_generator": "not_run",
            "retained_final_source_quality_evidence": {
                "source": VALIDATION_RECORD,
                "status": "PASS",
                "js_ts_tests": 116,
                "codex_bridge_tests": 55,
                "aura_baseline_pytest": 398,
                "aura_bridge_pytest": 14,
                "deterministic_browser_scenarios": 18,
                "guarded_live_browser_scenarios": 1,
                "production_build": "PASS",
                "claim_ceiling": "one_controlled_synthetic_AURA_and_Git_fixture_flow",
            },
        },
        records,
        [
            evidence_item("package.json", "workspace test commands", '"test"'),
            evidence_item("pyproject.toml", "Python test configuration", "[tool.pytest.ini_options]"),
            evidence_item(VALIDATION_RECORD, "retained final-source quality matrix", "Final-source quality matrix"),
        ],
        snapshot,
    )


RISKS = [
    {
        "id": "R-001",
        "title": "單一受控 fixture 的 AURA、Codex 與 Web live 路徑已驗證，擴充到其他 repo、host 與負向路徑需各自留證",
        "severity": "medium",
        "state": "controlled_single_run",
        "scope_control": "保留 LOCAL_E2E_VALIDATED claim ceiling；deny、run-scope、stop/recovery與callback approval以專屬live trace啟用",
        "evidence": [VALIDATION_RECORD, "docs/release-checklist.md"],
    },
    {
        "id": "R-002",
        "title": "ASR 工作容量與背壓需要量測後設定上限",
        "severity": "high",
        "state": "open",
        "scope_control": "桌面工作執行維持本機範圍；下一層以壓力測試確認容量",
        "evidence": ["apps/voiss-aura-web/lib/trust-store.ts", "src/aura/asr/threads.py"],
    },
    {
        "id": "R-003",
        "title": "本機 UI 同時支援 demo fixture 與 local live mode，展示證據需明確標示來源",
        "severity": "medium",
        "state": "controlled",
        "scope_control": "VOISS_MODE、service status 與 fixture 標籤維持兩條證據路徑",
        "evidence": ["packages/demo-fixtures/src/index.ts", "apps/voiss-aura-web/components/control-room.tsx"],
    },
    {
        "id": "R-004",
        "title": "模型 revision、digest、授權與主機 runtime 仍需逐項驗證",
        "severity": "high",
        "state": "open",
        "scope_control": "外部模型與 native runtime 維持獨立 activation gate",
        "evidence": ["src/aura/system/runtime_report.py", "docs/release-checklist.md"],
    },
    {
        "id": "R-005",
        "title": "Codex plan delta 已有 bounded、redacted 的專用 AG-UI adapter mapping",
        "severity": "medium",
        "state": "closed",
        "scope_control": "current event family由專用case累積最多16,000字元並套用sensitive-text redaction；single-fixture live stream已留證，future protocol drift持續由E2E監測",
        "evidence": ["services/codex-bridge/src/server.ts", "packages/ag-ui-codex-adapter/src/index.ts"],
    },
    {
        "id": "R-006",
        "title": "相依套件與外部模型授權資料尚未完成解析",
        "severity": "high",
        "state": "open",
        "scope_control": "SBOM 使用 NOASSERTION，正式釋出以 license resolution 作為閘門",
        "evidence": ["pnpm-lock.yaml", "uv.lock", "LICENSE"],
    },
    {
        "id": "R-007",
        "title": "目前 MVP 實作仍是未提交工作樹快照",
        "severity": "high",
        "state": "open",
        "scope_control": "以 snapshot hash、checksum manifest、分層驗證與 publish evidence 完成版本封存",
        "evidence": [".git", "docs/architecture/repository-technical-architecture-report/validation/manifest.json"],
    },
    {
        "id": "R-008",
        "title": "控制平面 SQLite 的 retention、migration 與 cleanup policy 需要 release 決策",
        "severity": "medium",
        "state": "open",
        "scope_control": "資料維持本機 owner-only path；下一層定義 migration 與 retention contract",
        "evidence": ["packages/trust-engine/src/index.ts", "apps/voiss-aura-web/lib/trust-store.ts"],
    },
    {
        "id": "R-009",
        "title": "digest-pinned rootless Podman Codex lane已在單一主機驗證，跨主機重建與apt package版本仍需封存",
        "severity": "medium",
        "state": "controlled_single_host",
        "scope_control": "Podman wrapper只讀掛載vendor/auth並只讓allowlisted repo、worktree、export roots可寫；direct-host :workspace由AppArmor preflight啟用",
        "evidence": ["services/codex-bridge/Containerfile", "services/codex-bridge/run-in-podman.sh", VALIDATION_RECORD],
    },
    {
        "id": "R-010",
        "title": "CSP 的 development unsafe-eval 與正式 origin policy 需要瀏覽器驗收",
        "severity": "medium",
        "state": "controlled",
        "scope_control": "unsafe-eval 只在 development；正式模式以 Next headers 與 loopback origin 驗證",
        "evidence": ["apps/voiss-aura-web/next.config.ts", "apps/voiss-aura-web/lib/security.ts"],
    },
    {
        "id": "R-011",
        "title": "CopilotKit per-request clone retains the configured Codex Bridge transport",
        "severity": "high",
        "state": "closed",
        "scope_control": "CodexBridgeAgent overrides clone and copies the private transport; adapter regression coverage exercises the clone lifecycle",
        "evidence": ["packages/ag-ui-codex-adapter/src/index.ts", "packages/ag-ui-codex-adapter/tests/adapter.test.ts"],
    },
]

CONTROLS = [
    {"id": "CTRL-AURA-001", "title": "AURA runtime readiness", "implementation": "status proxy plus TrustStore control", "validation": "live bridge health gate"},
    {"id": "CTRL-CODEX-001", "title": "Codex authentication and app-server readiness", "implementation": "bridge status plus sanitized account state", "validation": "authenticated local status gate"},
    {"id": "CTRL-EVIDENCE-001", "title": "Confirmed action has current source evidence", "implementation": "domain canDelegate contract and reviewed export", "validation": "fixture and live evidence tests"},
    {"id": "CTRL-WORKTREE-001", "title": "Approved write run uses an isolated worktree", "implementation": "Codex Bridge worktree manager and second-stage approval", "validation": "live write-run evidence"},
    {"id": "CTRL-NETWORK-001", "title": "Agent write runtime keeps network disabled", "implementation": "Codex thread sandbox policy in nested managed-bubblewrap", "validation": "one live run policy observation plus a separate active socket egress-denial canary"},
    {"id": "CTRL-SESSION-001", "title": "Browser mutations require signed same-origin session", "implementation": "HttpOnly SameSite cookie, origin and session verification", "validation": "security tests and browser acceptance"},
    {"id": "CTRL-SECRET-001", "title": "Bridge and provider credentials stay server-side", "implementation": "server-only modules, child env allowlist, redaction", "validation": "secret canary and exported-evidence inspection"},
    {"id": "CTRL-AUDIT-001", "title": "Control-plane audit events form a verifiable hash chain", "implementation": "canonical JSON SHA-256 chain in SQLite", "validation": "TrustStore tests and persistent restart test"},
    {"id": "CTRL-EXPORT-001", "title": "Exports are bounded, sanitized, validation-gated, and explicitly requested", "implementation": "bridge export endpoints, allowlisted paths, completed-write state, and authoritative validation pass gate", "validation": "passed, missing, failed, help-only, out-of-scope, stale, and overflow export cases"},
    {"id": "CTRL-VALIDATION-001", "title": "Validation evidence binds to the terminal frozen patch and mutation generation", "implementation": "recognized in-scope validation captures patch SHA-256 plus mutation generation; export requires a pass matching frozenPatchSha256 and terminalMutationGeneration, no failure, and no overflow", "validation": "mutate-after-test, stale-pass, overflow, and terminal-patch generation cases"},
    {"id": "CTRL-APPROVAL-001", "title": "Codex approvals bind to the active run and turn", "implementation": "pending request registry, exact request id, turn-id check, scope validation, and automatic decline", "validation": "cross-run, stale-turn, malformed, and out-of-scope approval cases"},
    {"id": "CTRL-PROTOCOL-001", "title": "Codex protocol input and lifecycle remain bounded", "implementation": "exact 0.145.0 gate, strict response shape, line-size ceiling, lifetime restart budget, request limits, and terminal timeout authority", "validation": "version mismatch, oversize, malformed response, restart exhaustion, timeout-race, and policy-retention cases"},
    {"id": "CTRL-STOP-001", "title": "Stop covers both staged and active Codex work", "implementation": "pending write activation cancellation before worktree plus active turn interruption", "validation": "staged-write and active-run stop cases"},
    {"id": "CTRL-ADAPTER-001", "title": "CopilotKit per-request agents retain their Codex transport and bounded event contract", "implementation": "CodexBridgeAgent clone override preserves transport; normalizer redacts and bounds event payloads", "validation": "clone lifecycle, run/resume transport, plan delta, approval, and unknown-event cases"},
    {"id": "CTRL-RUNTIME-001", "title": "Verified Codex target lane isolates official runtime inside rootless Podman", "implementation": "digest-pinned base, read-only vendor/auth mounts, allowlisted read-write roots, and nested managed-bubblewrap", "validation": "one controlled live flow plus separate active egress-denial canary; direct-host workspace remains AppArmor-gated"},
]

ASSETS = [
    {"id": "asset-repo", "kind": "repository", "name": "Project AURA + VOISS MVP", "state": "implemented_snapshot"},
    {"id": "asset-web", "kind": "application", "name": "VOISS AURA Control Room", "state": "implemented_source"},
    {"id": "asset-aura", "kind": "aura_runtime", "name": "AURA Bridge and desktop runtime", "state": "bridge_verified_one_controlled_fixture_flow_desktop_model_runtimes_separate"},
    {"id": "asset-codex", "kind": "codex_runtime", "name": "Codex Bridge and app-server", "state": "verified_one_controlled_fixture_flow_via_rootless_podman"},
    {"id": "asset-codex-container", "kind": "container_image", "name": "Digest-pinned Codex rootless Podman target lane", "state": "verified_single_host_build_and_live_flow"},
    {"id": "asset-trust", "kind": "metadata_store", "name": "VOISS TrustStore SQLite", "state": "assets_controls_findings_and_audit_persisted_other_tables_schema_reserved"},
    {"id": "asset-models", "kind": "external_runtime", "name": "ASR, diarization, punctuation, Gemma, ClearVoice, CUDA and Ollama", "state": "separate_activation_required"},
    {"id": "asset-exports", "kind": "evidence", "name": "reviewed AURA and Codex evidence exports", "state": "implemented_and_one_live_Codex_export_checksum_verified"},
]

FINDINGS = [
    {"id": "R-002", "title": "ASR work queue requires a measured bounded-capacity and backpressure policy", "severity": "high", "state": "open", "control_id": "CTRL-EVIDENCE-001"},
    {"id": "R-004", "title": "Model revision and digest evidence awaits the next validation layer", "severity": "medium", "state": "open", "control_id": "CTRL-AURA-001"},
    {"id": "F-ADAPTER-PLAN-DELTA", "title": "item/plan/delta has a bounded redacted plan activity mapping", "severity": "medium", "state": "closed", "control_id": "CTRL-EVIDENCE-001"},
    {"id": "F-CODEX-TRANSPORT-CLONE", "title": "CopilotKit clone lifecycle retains the configured Codex Bridge transport", "severity": "high", "state": "closed", "control_id": "CTRL-ADAPTER-001"},
    {"id": "F-LIVE-E2E", "title": "One controlled AURA plus Codex plus browser live flow is retained; repeatability and dedicated negative paths remain release gates", "severity": "medium", "state": "mitigated_single_run", "control_id": "CTRL-CODEX-001"},
    {"id": "F-LICENSE", "title": "Dependency and model licenses remain NOASSERTION", "severity": "high", "state": "open", "control_id": "CTRL-EXPORT-001"},
    {"id": "F-WORKTREE", "title": "Implemented MVP remains an uncommitted source and retained-validation snapshot without a reviewer-selected target commit", "severity": "high", "state": "open", "control_id": "CTRL-WORKTREE-001"},
    {"id": "F-RETENTION", "title": "TrustStore retention and migration contract awaits release decision", "severity": "medium", "state": "open", "control_id": "CTRL-AUDIT-001"},
]


def compact_inventory(
    identifier: str,
    snapshot: str,
    records: list[dict[str, Any]],
    coverage: dict[str, Any],
    evidence: list[dict[str, str]],
) -> dict[str, Any]:
    return envelope(identifier, coverage, records, evidence, snapshot)


def scheduled_inventory(snapshot: str) -> dict[str, Any]:
    records = [
        {
            "id": "aura-scheduled-recording",
            "scheduler": "PyQt QTimer and wall-clock scheduling",
            "scope": "in_process_desktop",
            "persistence": "none_declared",
            "status": "implemented",
            "evidence": line_ref("src/aura/scheduling.py", "QTimer"),
        }
    ]
    return envelope(
        "scheduled-jobs",
        {
            "in_process_schedules": "complete_curated",
            "external_cron_or_ci_schedule": "none_detected",
        },
        records,
        [
            evidence_item("src/aura/scheduling.py", "recording schedule primitives"),
            evidence_item("src/aura/ui/transcription_tab.py", "scheduled recording UI", "scheduled"),
        ],
        snapshot,
    )


def workflow_triggers(text: str) -> list[str]:
    lines = text.splitlines()
    try:
        start = next(index for index, line in enumerate(lines) if line.strip() == "on:" and not line.startswith(" "))
    except StopIteration:
        return []
    triggers: list[str] = []
    for line in lines[start + 1 :]:
        if line and not line.startswith((" ", "\t", "#")):
            break
        match = re.match(r"^  ([A-Za-z_][A-Za-z0-9_-]*):", line)
        if match:
            triggers.append(match.group(1))
    return sorted(set(triggers))


def ci_inventory(snapshot: str) -> dict[str, Any]:
    records = []
    for relative in (".github/workflows/ci.yml", ".github/workflows/windows.yml"):
        text = read_text(relative)
        records.append(
            {
                "path": relative,
                "name": re.search(r"^name:\s*(.+)$", text, re.MULTILINE).group(1),
                "triggers": workflow_triggers(text),
                "scheduled": "schedule" in workflow_triggers(text),
                "status": "workflow_source_present_execution_not_asserted",
            }
        )
    return envelope(
        "ci-workflows",
        {"workflow_files": "complete", "run_results": "not_asserted"},
        records,
        [evidence_item(".github/workflows/ci.yml", "primary CI"), evidence_item(".github/workflows/windows.yml", "Windows CI")],
        snapshot,
    )


def container_inventory(snapshot: str) -> dict[str, Any]:
    return envelope(
        "containers-images",
        {
            "containerfiles": 1,
            "runtime_wrappers": 1,
            "compose_manifests": 0,
            "kubernetes_manifests": 0,
            "container_images": 1,
            "assessment": "verified_rootless_podman_codex_target_lane_on_one_host",
            "scope_control": "Next_Web_AURA_Bridge_and_desktop_remain_host_processes",
        },
        [
            {
                "id": "voiss-codex-runtime-image",
                "kind": "oci_image",
                "engine": "rootless Podman",
                "manifest": "services/codex-bridge/Containerfile",
                "local_tag": "localhost/voiss-codex-runtime:0.145.0",
                "base_image": "docker.io/library/ubuntu:24.04",
                "base_digest": "sha256:c4a8d5503dfb2a3eb8ab5f807da5bc69a85730fb49b5cfca2330194ebcc41c7b",
                "observed_image_id": "9c379b112906ca025141698d28e5ac166c7839f5ccee281bd29661f58a32a157",
                "observed_image_digest": "sha256:5f442b726a16550240a8ab38898632fa0d127fb52041caa3d7a656e518d27d38",
                "status": "verified_single_host_build_and_live_flow",
                "rebuild_limit": "base_digest_pinned_but_apt_package_versions_not_pinned",
            },
            {
                "id": "voiss-codex-podman-wrapper",
                "kind": "runtime_wrapper",
                "path": "services/codex-bridge/run-in-podman.sh",
                "read_only_mounts": ["CODEX_VENDOR_DIR", "CODEX_AUTH_FILE"],
                "read_write_mounts": [
                    "VOISS_ALLOWED_REPOSITORIES",
                    "VOISS_WORKTREE_ROOT_when_configured",
                    "CODEX_EXPORT_ROOT_when_configured",
                ],
                "image_selector": "CODEX_PODMAN_IMAGE",
                "security_options": ["label=disable"],
                "target_sandbox": "official Codex managed-bubblewrap nested inside rootless Podman",
                "direct_host_alternative": "blocked_on_verified_host_until_targeted_AppArmor_preflight_passes",
                "status": "verified_single_controlled_fixture_flow",
            },
        ],
        [
            evidence_item("services/codex-bridge/Containerfile", "digest-pinned Codex runtime image source", "sha256:c4a8d550"),
            evidence_item("services/codex-bridge/run-in-podman.sh", "rootless Podman mount and launch wrapper", "podman run"),
            evidence_item(VALIDATION_RECORD, "retained image and live target-runtime evidence", "image ID"),
        ],
        snapshot,
    )


def report_specs() -> list[dict[str, Any]]:
    return [
        {
            "file": REPORT_FILES[0],
            "title": "01 Executive Summary",
            "finding": "目前工作樹已形成並完成一次受控本機 E2E 的 MVP：Next.js 控制室整合證據型 domain、fixture、persistent TrustStore、named agents、AG-UI adapter、AURA Bridge、Codex Bridge，以及 rootless Podman 中的 official Codex target lane；產品里程碑為 `LOCAL_E2E_VALIDATED`，scoped live 狀態為 `LIVE_MINIMUM_COMPLETED`。",
            "detail": """MVP 的核心價值是把會議證據、人工確認、代理執行、核准與驗證放在同一個本機控制面。2026-07-25 的 final-source retained record 證明一個 synthetic AURA/Git fixture 經 Web → AURA Bridge → official Codex app-server 完成一個 real plan、Bridge-owned `allow_once`、isolated workspace write、366個exported Codex events、2個 terminal-patch-bound validations及checksum-verified export。CopilotKit runner另保留plan → write interrupt → approval resume的parent-linked invocation history與settled state；它和control-plane各自使用專屬SQLite檔案。另有獨立 managed-sandbox socket canary 證明 active egress denial；它與run中的`networkAccess=false` policy observation分層保存。

目前的 Git `HEAD` 仍是 AURA 基線，因此本報告把該 commit 視為 lineage。VOISS MVP 的實作證據來自本次 source與retained-validation snapshot SHA-256。這個單次、單主機、單fixture證據支持local P0 candidate；production、多repository repeatability、deny、`allow_run_scope`、stop/recovery與app-server command/file callback approvals仍由各自activation gate治理。""",
            "evidence": [
                ("apps/voiss-aura-web/components/control-room.tsx", "控制室整合介面", "export function ControlRoom"),
                ("services/aura-bridge/src/aura_bridge/app.py", "AURA 證據服務", '"/v1/health"'),
                ("services/codex-bridge/src/server.ts", "Codex 執行與核准服務", '"/v1/runs"'),
                ("apps/voiss-aura-web/lib/trust-store.ts", "persistent trust wiring", "VOISS_DB_PATH"),
                (VALIDATION_RECORD, "retained local E2E與final-source quality evidence", "Codex events in the exported write-run packet"),
                (DEMO_SCREENSHOT, "retained deterministic demo screenshot", None),
            ],
            "assumptions": ["MVP 以單機、單一操作人與 loopback 服務為主要操作環境。", "目前原始碼代表本次架構盤點時的實作意圖。"],
            "limitations": ["本報告不把既有 AURA benchmark 或基線 commit 當作 VOISS 整合實跑證據。", "本次 generator 未執行產品 build、測試、模型推論或瀏覽器驗收；它引用並校驗正式retained validation record。"],
            "decisions": ["採本機優先、server-side credential、證據先行與顯式核准架構。", "以 source/validation snapshot hash 和 artifact checksum 固定本報告證據面。"],
            "risks": ["單次fixture證據尚不代表production或跨repository repeatability。", "未提交工作樹需要reviewer選定target commit後才能形成release identity。"],
            "next": ["由reviewer決定target commit與release disposition。", "為deny、run-scope、stop/recovery與callback approvals保留專屬live trace。"],
        },
        {
            "file": REPORT_FILES[1],
            "title": "02 Repository Map",
            "finding": "Repository 同時保留成熟的 Python AURA 桌面與新增的 VOISS TypeScript/Python 控制面；pnpm 與 uv workspace 是兩條清楚的建置邊界。",
            "detail": """主要repository map：

```text
apps/voiss-aura-web/        Next.js control room、same-origin API、browser tests
packages/domain/            Zod evidence與workflow contracts
packages/demo-fixtures/     deterministic demo evidence
packages/trust-engine/      SQLite metadata、redaction、hash-chain audit
packages/agent-runtime/     named orchestrator、Codex engineer、demo agents
packages/ag-ui-codex-adapter/ Codex stream到AG-UI normalization
services/aura-bridge/       FastAPI canonical AURA evidence boundary
services/codex-bridge/      Codex app-server、approval、worktree、export、Podman target lane
src/aura/                   PyQt desktop、audio、ASR、review、audit、runtime
src/summary/                structured Gemma/Ollama summary pipeline
tests/ and component tests/ Python、Node、Vitest、Playwright quality surfaces
docs/                       ADR、security、lifecycle、runbook、release與retained validation evidence
```

`src/aura` 與 `src/summary` 擁有音訊、ASR、diarization、summary、review、audit 與 evidence 來源。`apps/voiss-aura-web` 擁有操作介面與 same-origin API；`packages/*` 擁有可重用 contract、fixture、trust、agent 與 adapter；`services/*` 擁有 loopback integration boundary。

`docs/` 提供決策、runbook、安全、生命週期與本套架構快照。generated、cache、virtual environment 與 vendor tree 都排除在 source snapshot 之外。""",
            "evidence": [
                ("pnpm-workspace.yaml", "Node workspace", "packages:"),
                ("pyproject.toml", "uv workspace", "[tool.uv.workspace]"),
                ("packages/domain/src/index.ts", "跨元件 domain contract", "EvidenceRefSchema"),
                ("services/codex-bridge/Containerfile", "Codex target runtime image boundary", "FROM docker.io"),
                (VALIDATION_RECORD, "retained implementation validation record", "LOCAL_E2E_VALIDATED"),
            ],
            "assumptions": ["每個 workspace manifest 是該元件的主要 package boundary。"],
            "limitations": ["檔案地圖不展開 node_modules、.venv、.next 或測試產物。"],
            "decisions": ["保留 AURA canonical runtime，透過 Bridge 暴露受控介面。", "共用型別與信任邏輯放在 packages，不複製到 Web route。"],
            "risks": ["雙語言 workspace 增加版本與環境同步成本。"],
            "next": ["在正式 commit 後確認 workspace lockfiles 與 package 邊界一致。"],
        },
        {
            "file": REPORT_FILES[2],
            "title": "03 Technology Stack Inventory",
            "finding": "主要技術堆疊是 Next.js 16、React 19、TypeScript 5.9、AG-UI/CopilotKit、Node 22、Python 3.10+、FastAPI、PyQt6 與 SQLite；模型、GPU 與 native audio 工具屬主機 activation layer。",
            "detail": """主要declared stack如下：

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

技術選擇支援本機資料治理：Next route 隔離 browser credential，FastAPI 只服務 loopback，Node `sqlite` 儲存 trust metadata，AURA 桌面維持離線音訊與模型流程。""",
            "evidence": [
                ("apps/voiss-aura-web/package.json", "Web versions", '"next"'),
                ("services/aura-bridge/pyproject.toml", "FastAPI service", '"fastapi=='),
                ("pyproject.toml", "AURA Python stack", '"pyqt6'),
                ("pnpm-lock.yaml", "Node resolved identities", "packages:"),
                ("uv.lock", "Python resolved identities", "[[package]]"),
                ("services/codex-bridge/Containerfile", "digest-pinned Codex runtime base", "sha256:c4a8d550"),
                (VALIDATION_RECORD, "observed host/runtime versions", "Podman"),
            ],
            "assumptions": ["lockfile 是本次 dependency identity 的權威來源。"],
            "limitations": ["native binary、GPU driver 與模型 cache 沒有完整 lockfile；Containerfile的base digest固定，但apt package versions未逐項pin。", "dependency edge coverage 受 pnpm peer variant 與 Python marker/extra 影響。"],
            "decisions": ["完整列出 lock identities；主機與模型 runtime 明確標為 partial curated coverage。"],
            "risks": ["主機 runtime drift 可能讓 source-ready capability 無法在特定環境啟用。"],
            "next": ["產生主機 runtime attestation，記錄 binary/model version 與 digest。"],
        },
        {
            "file": REPORT_FILES[3],
            "title": "04 C4 System Context",
            "finding": "系統邊界以單一現場操作人為中心：控制室協調 AURA canonical evidence、Codex engineering runtime、Git repository 與本機模型；外部 provider 僅由明確 runtime 路徑接觸。",
            "detail": """操作人從瀏覽器檢視會議、claim、action、trust control 與 agent run，並在兩種核准點作出決定。AURA Bridge 是會議證據的 authoritative interface；Codex Bridge 是 app-server 與 repository mutation 的 authoritative policy boundary。目標Linux host以rootless Podman承載official Codex與nested managed-bubblewrap；direct-host `:workspace`由targeted AppArmor preflight另行啟用。

Diagram 01 使用 context-level flowchart，將 browser、loopback services、repository、local models 與 optional hosted Codex model 分開。""",
            "evidence": [
                ("apps/voiss-aura-web/app/page.tsx", "使用者入口"),
                ("services/aura-bridge/README.md", "AURA boundary"),
                ("services/codex-bridge/README.md", "Codex boundary"),
                ("services/codex-bridge/run-in-podman.sh", "verified Codex runtime boundary", "podman run"),
            ],
            "assumptions": ["主要 operator 與本機登入使用者是同一個信任主體。"],
            "limitations": ["尚未建模多使用者、遠端瀏覽器、SSO 或組織 tenancy。"],
            "decisions": ["MVP context 只開放 loopback integration。"],
            "risks": ["未來遠端化會改變 origin、identity、transport 與 data residency boundary。"],
            "next": ["若要遠端營運，先建立獨立 threat model 與 tenancy contract。"],
        },
        {
            "file": REPORT_FILES[4],
            "title": "05 C4 Container Architecture",
            "finding": "C4 runtime units以單機多程序為主；official Codex target lane另由一個digest-pinned OCI image透過rootless Podman啟動，Next、AURA Bridge、Codex Bridge與AURA desktop仍是host processes。",
            "detail": """Next server 統一對 browser 提供 session、status、trust、AURA proxy、control mutation 與 CopilotKit runtime。兩個 Bridge 分別封裝 Python canonical evidence 與 Node Codex lifecycle。Codex Bridge以`run-in-podman.sh`啟動official vendor binary；vendor directory與auth file採read-only mount，只有allowlisted repositories及明列worktree/export roots採read-write mount。container中的official Codex再以managed-bubblewrap執行read-only或workspace-write tools。

Repository具有一個`Containerfile`與一個Podman wrapper；沒有Compose或Kubernetes manifest。Ubuntu base以digest固定，apt package versions仍由後續image provenance層封存。""",
            "evidence": [
                ("package.json", "Node process commands", '"dev"'),
                ("services/aura-bridge/src/aura_bridge/cli.py", "AURA loopback process", "127.0.0.1"),
                ("services/codex-bridge/src/cli.ts", "Codex loopback process", "127.0.0.1"),
                ("services/codex-bridge/Containerfile", "Codex OCI image source", "FROM docker.io"),
                ("services/codex-bridge/run-in-podman.sh", "read-only與allowlisted read-write mounts", "mounts=("),
                (VALIDATION_RECORD, "single-host image/live evidence", "Runtime validity"),
            ],
            "assumptions": ["所有 runtime unit 在同一主機執行。"],
            "limitations": ["沒有process supervisor、Compose、Kubernetes或remote deployment evidence；Podman證據限單一host與單一fixture。"],
            "decisions": ["Web/AURA/Bridge維持本機程序；Codex workspace-write採已驗證的rootless Podman+nested managed-bubblewrap target lane。"],
            "risks": ["多程序啟動順序、port、token、mount root與image provenance依賴操作runbook。"],
            "next": ["在reviewer選定的target commit重建image並封存base、apt package及image digest。"],
        },
        {
            "file": REPORT_FILES[5],
            "title": "06 Component Architecture",
            "finding": "Web 內部採 route/security/status/trust/control-room 分層；packages 提供 contract 與 orchestration；Bridge 把外部 runtime protocol 轉成受控、可稽核介面。",
            "detail": """Domain Zod schemas固定 evidence、claim、action、approval、run 與 trust vocabulary。Demo fixtures只提供 deterministic demo evidence。Trust engine以 SQLite 與 hash chain提供 metadata integrity。Agent runtime組裝 `voiss_orchestrator`、`codex_engineer` 與 `demo_agent`。

AG-UI adapter將 Codex app-server family轉成 browser-safe event，包含bounded、redacted的`item/plan/delta` mapping，並以`CodexBridgeAgent.clone()`明確保留CopilotKit每次request clone所需的Bridge transport。CopilotKit `SqliteAgentRunner`以獨立SQLite保存parent-linked invocation history；2026-07-25 retained live export保留366個Codex events，證明這條single-fixture路徑可運作。AURA Bridge則以 Pydantic response model、path validation、token與 origin policy暴露 canonical artifact。""",
            "evidence": [
                ("packages/domain/src/index.ts", "domain schemas", "canDelegate"),
                ("packages/agent-runtime/src/index.ts", "named agents", "createNamedAgents"),
                ("packages/trust-engine/src/index.ts", "trust store", "class TrustStore"),
                ("packages/ag-ui-codex-adapter/src/index.ts", "event adapter", "class CodexEventNormalizer"),
                ("packages/ag-ui-codex-adapter/src/index.ts", "CopilotKit clone transport preservation", "override clone()"),
                (VALIDATION_RECORD, "retained live adapter/runtime flow", "366"),
            ],
            "assumptions": ["package exports 是內部穩定 API boundary。"],
            "limitations": ["目前沒有獨立 schema registry 或 generated OpenAPI contract 在本套件內。"],
            "decisions": ["跨層資料使用明確 schema；credential 與 native runtime 留在 server boundary。"],
            "risks": ["event family drift 可能造成 adapter unknown fallback。"],
            "next": ["以專屬live traces驗證unknown-event drift、disconnect/resume及未執行的callback approval paths。"],
        },
        {
            "file": REPORT_FILES[6],
            "title": "07 Runtime and Data Flow",
            "finding": "Runtime flow 以 evidence-first gate 推進：會議證據進入 review，confirmed/supported action 才可 delegation；Codex 先 read-only plan，再於 Bridge-owned approval 後建立隔離 worktree。",
            "detail": """Demo mode 完全由 fixtures 驅動；local mode 由 Web server 透過 bearer token 連接兩個 loopback Bridge。AURA 資料經 search/detail/review/export 路徑進出；Codex 事件經 JSON-RPC、Bridge NDJSON/SSE、AG-UI normalizer 抵達 UI。

寫入核准有兩層：使用者先允許建立 write-capable isolated worktree；Codex app-server如針對具名 command 或 file change發出on-request approval，再由typed callback path處理。未經第一層核准前不建立隔離 worktree，stop可直接取消這個staged activation。具名approval綁定active run、turn、item與request time。完成後的 authoritative evidence export 另要求至少一個in-scope recognized validation通過、沒有recognized failure或overflow，且pass所見patch hash與mutation generation必須同時等於terminal frozen patch；missing、failed、help-only、outside-scope或stale validation會以 `export_unavailable` 保持關閉。

Retained live flow已完成一個read-only plan、Bridge-owned `allow_once`、isolated write、2個validation與export，並保留plan → write interrupt → resume child lineage。Approval timeout的`timed_out/paused` replay/resume/stop與stale/crash lifecycle的`blocked`收斂由contract tests支持。該Codex evidence保留`write_activation / allow_once`，並且沒有app-server command/file callback approval；這些callback與deny、run-scope、stop/recovery仍保持獨立live gate。""",
            "evidence": [
                ("packages/domain/src/index.ts", "delegation gate", "canDelegate"),
                ("services/codex-bridge/src/server.ts", "write activation", "#stageWriteActivation"),
                ("services/codex-bridge/src/worktree.ts", "isolated worktree"),
                ("services/codex-bridge/src/index.ts", "authoritative validation export gate", "validation.gate"),
                ("services/codex-bridge/src/index.ts", "validation-to-terminal-patch binding", "frozenPatchSha256"),
                ("services/codex-bridge/src/index.ts", "terminal mutation-generation binding", "terminalMutationGeneration"),
                ("services/codex-bridge/src/server.ts", "staged write cancellation", "pendingWriteByExternal"),
                ("apps/voiss-aura-web/app/api/control-room/route.ts", "mutation routing", "run.approval"),
                (VALIDATION_RECORD, "one controlled plan/write/validation/export flow", "Approval decision"),
            ],
            "assumptions": ["Bridge token 與 browser session secret 由本機 operator 安全配置。"],
            "limitations": ["live evidence限單一synthetic AURA/Git fixture；不代表production或多repository repeatability。", "deny、allow_run_scope、stop/recovery與app-server command/file callback approvals尚未各自保留live trace。"],
            "decisions": ["把 plan、write activation 與具名 mutation approval 分成可辨識階段。"],
            "risks": ["stream interruption仍需browser reattach；approval timeout已保留paused audit與operator resume/stop capability。"],
            "next": ["依序保留deny、allow_run_scope、stop/recovery與command/file callback approval專屬live traces。"],
        },
        {
            "file": REPORT_FILES[7],
            "title": "08 API and Interface Inventory",
            "finding": "HTTP surface 由 Web same-origin API、AURA `/v1` evidence API 與 Codex `/v1` run API 組成；每一條 mutation 都位於 server-side authorization boundary。",
            "detail": """Web API提供 session/status/trust、AURA allowlisted read/audio proxy、control-room mutation與 CopilotKit route。AURA API提供 health、session、segment、claim review、action、search、audio span、audit與 export。Codex API提供 status、run stream、approval resume、stop與 evidence export；stop可取消staged write或中斷active run。Codex export只接受completed write run，且retained command evidence必須含至少一個in-scope passed recognized validation、零個recognized failure，並與terminal frozen patch SHA-256及mutation generation一致。

完整 machine-readable list位於 `inventories/03-apis-interfaces.json`。Interface inventory是 current source route的人工校讀快照，internal functions則透過 component report治理。""",
            "evidence": [
                ("apps/voiss-aura-web/app/api/control-room/route.ts", "same-origin mutation API", "authorizeMutation"),
                ("services/aura-bridge/src/aura_bridge/app.py", "AURA endpoints", "@app.post"),
                ("services/codex-bridge/src/server.ts", "Codex endpoints", "createServer"),
            ],
            "assumptions": ["所有 Bridge URL 只指向受信任 loopback address。"],
            "limitations": ["沒有公開 remote API、version negotiation 或 compatibility SLA。"],
            "decisions": ["以 `/v1` 固定 Bridge contract；browser 只呼叫同源 Web API。"],
            "risks": ["route 與 machine inventory 可能隨 source drift，需要 generator 重跑與 review。"],
            "next": ["加入 contract test 或 OpenAPI/JSON Schema export，降低人工 inventory drift。"],
        },
        {
            "file": REPORT_FILES[8],
            "title": "09 Dependency Graph and Analysis",
            "finding": "pnpm 與 uv lockfile 的 resolved component identities 完整盤點；workspace edges 清楚，transitive relationship graph 因 peer variant、marker 與 extra 維持 partial。",
            "detail": """Web依賴 domain、fixtures、trust-engine、agent-runtime與 adapter；agent-runtime依賴 adapter與fixtures；fixtures與trust-engine依賴 domain。Codex Bridge為獨立 Node service；AURA Bridge是 uv workspace member並讀取 AURA canonical artifacts。

SBOM為每個 pnpm lock record與 uv package record建立 component identity。這能回答「有哪些已解析元件」，但不把簡化 parser包裝成完整 package-manager dependency solver。""",
            "evidence": [
                ("apps/voiss-aura-web/package.json", "Web workspace dependencies", '"@voiss/domain"'),
                ("packages/agent-runtime/package.json", "agent dependency edge", '"@voiss/ag-ui-codex-adapter"'),
                ("pnpm-lock.yaml", "Node identities", "packages:"),
                ("uv.lock", "Python identities", "[[package]]"),
            ],
            "assumptions": ["lock records代表本次 workspace resolution。"],
            "limitations": ["transitive edge graph不是 pnpm/uv resolver的完整重建。", "native與模型依賴只做 source-detected curated coverage。"],
            "decisions": ["coverage欄位分別標明 identity complete與relationship partial。"],
            "risks": ["只看 direct manifests會漏掉 supply-chain footprint；本套件以 full lock inventory降低此風險。"],
            "next": ["使用 package-manager原生 export或專用 SBOM工具補齊 dependency edges與 license metadata。"],
        },
        {
            "file": REPORT_FILES[9],
            "title": "10 SBOM",
            "finding": "套件同時產生 CycloneDX 1.6 JSON 與 SPDX 2.3 JSON，涵蓋完整 Node/Python lock identities、workspace component及分層標示的 native/model runtime。",
            "detail": """CycloneDX使用 stable snapshot-derived UUID；SPDX使用 snapshot namespace。Repository license可由 `pyproject.toml`與 `LICENSE`確認為 MIT。workspace package manifest與lockfile沒有足夠的package-level license metadata，因此相關workspace package、dependency、native tool與external model均保守使用 `NOASSERTION`。

SBOM是source snapshot inventory，不是執行主機 attestation，也不是法律意見。它明確保留 coverage層次，讓 release owner能把 license resolution、model terms與binary provenance作為下一層驗證。""",
            "evidence": [
                ("docs/architecture/repository-technical-architecture-report/sbom/cyclonedx.json", "CycloneDX artifact", None),
                ("docs/architecture/repository-technical-architecture-report/sbom/spdx.json", "SPDX artifact", None),
                ("pyproject.toml", "MIT declaration", 'license = "MIT"'),
                ("LICENSE", "license text"),
                ("services/codex-bridge/Containerfile", "digest-pinned Ubuntu base identity", "sha256:c4a8d550"),
            ],
            "assumptions": ["PURL與lock key足以在下一步解析上游 metadata。"],
            "limitations": ["NOASSERTION元件尚未完成 license conclusion。", "已列入Podman image與base digest，但apt package版本、official Codex vendor binary hash及model weight digest尚未形成完整attestation。"],
            "decisions": ["以完整 identity與誠實 license unknown優先於不完整的推測性授權清單。"],
            "risks": ["未完成 license/model terms review前不應視為 release-cleared supply chain。"],
            "next": ["用上游 registry與model card解析license，再進行人工合規覆核。"],
        },
        {
            "file": REPORT_FILES[10],
            "title": "11 Build and Deployment Architecture",
            "finding": "建置由pnpm workspace與uv workspace分開管理；部署目標是單機多程序、Windows desktop packaging，以及一個已驗證的rootless Podman Codex target image。",
            "detail": """Root scripts提供frozen install、lint、typecheck、test、static architecture boundary、fixture/local E2E、activation-gated live E2E、Podman image與build orchestration。Python以uv lock與setuptools/hatchling管理AURA及Bridge。CI有一般與Windows兩個workflow source。Windows scripts另提供portable build與runtime smoke。

Retained final-source matrix記錄frozen pnpm/uv install、format check、lint、typecheck、116個JS/TS tests（含55個Codex Bridge tests）、398個AURA baseline tests、14個AURA Bridge tests、18個deterministic browser scenarios、1個guarded live scenario、demo walkthrough及Next production build全數PASS。架構generator未重跑這些產品命令；它把該正式validation record納入snapshot並保留來源邊界。""",
            "evidence": [
                ("package.json", "Node build commands", '"build"'),
                ("package.json", "architecture and live E2E commands", '"test:architecture"'),
                ("pyproject.toml", "Python build backend", "[build-system]"),
                (".github/workflows/ci.yml", "CI source"),
                (".github/workflows/windows.yml", "Windows CI source"),
                ("scripts/build_windows_portable.ps1", "Windows packaging"),
                ("services/codex-bridge/Containerfile", "Codex target image", "FROM docker.io"),
                ("services/codex-bridge/run-in-podman.sh", "Codex Podman runtime wrapper", "podman run"),
                (VALIDATION_RECORD, "retained final-source quality matrix", "Final-source quality matrix"),
            ],
            "assumptions": ["Node版本符合 Codex Bridge engine，Python版本符合 project requires-python。"],
            "limitations": ["本次generator沒有執行產品build、CI或deployment；retained results來自正式validation record。", "沒有Compose、Kubernetes、remote deployment或cross-host repeatability evidence。"],
            "decisions": ["local MVP維持host process deployment；Codex workspace-write使用rootless Podman target lane。"],
            "risks": ["host toolchain、apt package與native dependency drift可能造成跨主機建置不一致。"],
            "next": ["由reviewer選定target commit後，在該identity重跑frozen gate與image build並簽署evidence。"],
        },
        {
            "file": REPORT_FILES[11],
            "title": "12 Configuration and Environment Variables",
            "finding": "設定以明確env contract分隔 Web、AURA Bridge、Codex Bridge、AURA desktop與Codex child allowlist；所有token保持server-side。",
            "detail": """Web local mode需要session secret、兩組Bridge URL/token、control-plane `VOISS_DB_PATH`與獨立的CopilotKit `VOISS_AGENT_DB_PATH`。AURA Bridge配置canonical artifact、evidence index、audit與export root。Codex Bridge配置repository allowlist、origin、process/request/approval timeout、binary、worktree與export root。已驗證的Podman wrapper另要求`CODEX_VENDOR_DIR`、`CODEX_AUTH_FILE`，並可由`CODEX_PODMAN_IMAGE`選擇local image tag；vendor/auth採read-only mount，allowlisted repo及明列worktree/export roots採read-write mount。AURA desktop另有model token、audit、runtime與CUDA path。

machine inventory不收錄實際secret值；test-only canary env也不視為runtime contract。Codex child只繼承明列的非秘密主機context，避免把Bridge token、provider key或其他ambient secret傳給app-server。""",
            "evidence": [
                ("apps/voiss-aura-web/lib/security.ts", "session configuration", "VOISS_SESSION_SECRET"),
                ("services/aura-bridge/src/aura_bridge/cli.py", "AURA env", "AURA_ARTIFACT_ROOT"),
                ("services/codex-bridge/src/cli.ts", "Codex env", "VOISS_ALLOWED_REPOSITORIES"),
                ("services/codex-bridge/src/index.ts", "child env allowlist", "CODEX_HOME"),
                ("services/codex-bridge/run-in-podman.sh", "Codex Podman env and mount contract", "CODEX_VENDOR_DIR"),
            ],
            "assumptions": ["secret由本機受控管道注入，不寫入repo。"],
            "limitations": ["沒有集中secret manager或configuration schema deployment artifact；`CODEX_AUTH_FILE`是敏感locator，不進browser或machine inventory value。"],
            "decisions": ["browser不接收Bridge token；inventory只描述名稱、用途與activation gate。"],
            "risks": ["missing/misaligned env會使local mode降為not-ready或拒絕服務。"],
            "next": ["用runbook做clean-shell啟動，驗證缺少每一個required env時fail closed。"],
        },
        {
            "file": REPORT_FILES[12],
            "title": "13 Security Boundaries",
            "finding": "MVP使用loopback bind、Origin檢查、signed session、bearer token、repository allowlist、sandbox、worktree isolation、on-request approval與redaction形成分層保護。",
            "detail": """Browser boundary由HttpOnly SameSite cookie、same-origin mutation和server-only modules控制。Bridge boundary使用token與origin allowlist。Codex boundary固定read-only plan、network-off sandbox與user-reviewed approval；寫入在第一階段核准後才建立isolated worktree，具名command/file如被app-server請求仍需第二階段決策，並綁定active run、turn、request ID與worktree scope。Approval timeout保存`timed_out/paused` capability供operator resume或stop；stale/crashed active lifecycle以`blocked` metadata fail closed。

Codex protocol另限制incoming line/event/body大小、驗證exact 0.145.0與thread response policy、限制lifetime restart budget，並讓timeout保持terminal authority。Validation pass與terminal frozen patch hash及mutation generation綁定後才允許export；staged write可在worktree建立前由stop取消。Podman wrapper以read-only vendor/auth mount與allowlisted read-write roots縮小host exposure。單次live flow觀察`networkAccess=false`與nested `managed-bubblewrap`；獨立socket canary主動獲得`PermissionError`，證明該sandbox的egress denial。direct-host `:workspace`在此host由targeted AppArmor prerequisite gate保持關閉。""",
            "evidence": [
                ("apps/voiss-aura-web/lib/security.ts", "browser authorization", "authorizeMutation"),
                ("services/codex-bridge/src/server.ts", "two-stage approval", "#stageWriteActivation"),
                ("services/codex-bridge/src/worktree.ts", "worktree isolation", "worktree"),
                ("services/codex-bridge/src/index.ts", "approval turn binding", "notificationTurnId"),
                ("services/codex-bridge/src/index.ts", "terminal validation binding", "frozenPatchSha256"),
                ("services/codex-bridge/src/index.ts", "exact Codex app-server gate", "0.145.0"),
                ("services/codex-bridge/src/rpc.ts", "protocol line-size ceiling", "maxIncomingBytes"),
                ("packages/trust-engine/src/index.ts", "redaction and audit", "export function redact"),
                ("services/codex-bridge/run-in-podman.sh", "container mount boundary", "mounts=("),
                (VALIDATION_RECORD, "single-run sandbox policy and separate egress canary", "PermissionError"),
            ],
            "assumptions": ["loopback host與OS user account受到基本保護。"],
            "limitations": ["未進行penetration test、multi-user authorization或remote threat model。", "deny、run-scope、stop/recovery與command/file callback approvals尚未有專屬live negative traces。"],
            "decisions": ["採deny-by-default origin/repository path與explicit approval。"],
            "risks": ["local malware或同帳號程序仍可能接觸本機資料；remote deployment需要新identity layer。"],
            "next": ["由reviewer覆核既有automated negative tests，並為未執行的live approval/stop/recovery paths保留專屬trace。"],
        },
        {
            "file": REPORT_FILES[13],
            "title": "14 Architecture Decision Records",
            "finding": "架構決策以local-first evidence control為主軸，並由repo ADR與decision log支持：canonical AURA evidence、Bridge boundary、AG-UI normalization、two-stage approval、persistent trust metadata。",
            "detail": """Decision inventory將source、interpretation與implementation分層。既有`docs/adr`與`DECISIONS.md`是決策來源；本報告不把未落地的proposal提升為implemented capability。

目前十二份ADR形成連續決策鏈：

| ADR | Active decision |
|---|---|
| 0001 | Companion Web control plane |
| 0002 | AURA artifacts保持source of truth |
| 0003 | Loopback AURA Bridge |
| 0004 | Official Codex app-server boundary |
| 0005 | Trusted static GenUI |
| 0006 | P0不開放任意generated UI |
| 0007 | Approved write run使用isolated worktree |
| 0008 | Read-only與network-off defaults |
| 0009 | Deterministic demo mode |
| 0010 | SQLite control-plane metadata |
| 0011 | Agent runtime不含remote Git或deploy authority |
| 0012 | Report與release evidence contract |

目前可由source驗證的關鍵決策包括：AURA資料不搬成Web權威副本；browser不直連native runtime；Codex mutation在isolated worktree；trust metadata以SQLite與hash chain保存；demo fixture與live evidence保持可辨識。""",
            "evidence": [
                ("DECISIONS.md", "decision log"),
                ("docs/adr", "ADR directory", None),
                ("packages/trust-engine/src/index.ts", "implemented trust decision", "PRAGMA journal_mode = WAL"),
                ("services/codex-bridge/src/worktree.ts", "implemented isolation decision"),
            ],
            "assumptions": ["ADR與source若衝突，以current implementation及明確release gate為準。"],
            "limitations": ["部分決策仍可能以planning prose存在，尚未有supersession metadata。"],
            "decisions": ["本報告只將source-visible行為列為implemented。"],
            "risks": ["decision log drift會讓未來agent誤讀active architecture。"],
            "next": ["為persistent trust、event mapping與local process deployment補正式ADR或更新既有ADR狀態。"],
        },
        {
            "file": REPORT_FILES[14],
            "title": "15 Risks and Technical Debt",
            "finding": "一個受控live E2E、plan-delta mapping與CopilotKit clone transport缺口已取得evidence；目前最高優先風險集中在單次證據的repeatability ceiling、ASR容量、external runtime/model provenance、license resolution、retention與未提交snapshot。",
            "detail": """風險採positive scope control表達：每一項都連到目前可用的保護層與下一個activation gate。既有trust findings保留R-002與R-004；本架構inventory把F-LIVE-E2E標為`mitigated_single_run`，並保留license、worktree、retention、single-host container portability與CSP等release concern。F-ADAPTER-PLAN-DELTA與F-CODEX-TRANSPORT-CLONE已有closed evidence。

technical debt不等同未完成產品：TrustStore的assets/controls/findings/audit core wiring、two-stage approval、Podman target lane與一個plan/write/validation/export flow已有實作/evidence。reserved tables、cross-host/repository repeatability，以及deny、run-scope、stop/recovery、callback approvals的專屬live traces仍屬activation debt。""",
            "evidence": [
                ("apps/voiss-aura-web/lib/trust-store.ts", "active findings", 'id: "R-002"'),
                ("packages/ag-ui-codex-adapter/src/index.ts", "closed plan-delta mapping", 'case "item/plan/delta"'),
                ("services/codex-bridge/src/server.ts", "plan delta emission", "plan.delta"),
                ("KNOWN_LIMITATIONS.md", "known limits"),
                (VALIDATION_RECORD, "single-run evidence and explicit claim ceiling", "Validation scope"),
            ],
            "assumptions": ["severity反映local MVP release風險，不是production clinical system評級。"],
            "limitations": ["沒有量化likelihood或owner/due date資料。"],
            "decisions": ["風險保持open直到對應evidence產生，不以source presence自動關閉。"],
            "risks": ["若把單一synthetic fixture flow擴寫為production或multi-repository證據，會產生錯誤完成宣告。"],
            "next": ["依13-risks.json逐項指定owner、acceptance evidence與release disposition。"],
        },
        {
            "file": REPORT_FILES[15],
            "title": "16 Local Development and Execution Guide",
            "finding": "本機執行路徑由locked dependency、AURA Bridge、Codex sign-in、Podman target lane、Codex Bridge、Web local mode與status/trust check組成；demo mode提供獨立fixture路徑。",
            "detail": """先確認Node、pnpm、Python、uv與rootless Podman版本，再依lockfile安裝。AURA canonical artifact root、Bridge token與origin先配置；Codex完成官方登入後，設定`CODEX_VENDOR_DIR`、`CODEX_AUTH_FILE`、`CODEX_PODMAN_IMAGE`及allowlisted roots，以`run-in-podman.sh`作為`CODEX_BIN` target lane，再啟動`127.0.0.1:8770`。Web local mode配置server-side session secret與Bridge URL/token後啟動`127.0.0.1:3000`。

direct-host `:workspace`只有在targeted AppArmor preflight成功後才是可用替代路徑；目前驗證主機的supported lane是rootless Podman+nested managed-bubblewrap。完整操作步驟由`docs/runbooks/local-setup.md`、`codex-sign-in.md`、`aura-bridge.md`與`troubleshooting.md`承接。""",
            "evidence": [
                ("docs/runbooks/local-setup.md", "local setup runbook"),
                ("docs/runbooks/codex-sign-in.md", "Codex auth runbook"),
                ("docs/runbooks/aura-bridge.md", "AURA Bridge runbook"),
                ("docs/demo/five-minute-demo.md", "demo acceptance flow"),
                ("services/codex-bridge/run-in-podman.sh", "verified Podman launch path", "podman run"),
                (VALIDATION_RECORD, "retained single-host setup and run evidence", "Release identity"),
            ],
            "assumptions": ["operator擁有repository與本機runtime存取權。"],
            "limitations": ["沒有在本次generator執行安裝、啟動或登入；正式record只支持已驗證host與single fixture。"],
            "decisions": ["以readiness endpoint和UI source label確認路徑，不以程序存在推定服務ready。"],
            "risks": ["port、token、artifact root或repository allowlist配置不一致會fail closed。"],
            "next": ["在reviewer選定target commit後由clean shell重跑runbook並封存command/version/readiness evidence。"],
        },
        {
            "file": REPORT_FILES[16],
            "title": "17 Testing and Quality Strategy",
            "finding": "Repository具備Python unit/integration、TypeScript unit、Node bridge、Web component/security與Playwright E2E測試面；retained final-source matrix記錄116個JS/TS tests（含55個Codex Bridge tests）、398個AURA tests、14個AURA Bridge tests、18個deterministic browser scenarios及1個guarded live browser scenario全數PASS。",
            "detail": """Static inventory掃描tests、apps、packages、services與architecture boundary checker，記錄framework與test declaration近似數。測試策略涵蓋domain validation、fixture一致性、SQLite audit chain、agent orchestration、Codex event normalization、Bridge authentication/path policy、Web security、static architecture policy與browser flow。Playwright的guarded live config在single synthetic AURA/Git fixture完成一個2.0分鐘real local scenario；另一個coherent deterministic demo walkthrough在3.42秒內完成Control Room到browser export並保留packet與screenshot。

品質閘門分層保留：format/diff check、typecheck/lint、unit、service integration、real app-server、real AURA artifact、browser E2E、host/model runtime。Codex HTTP write tests使用disposable Git repositories以避免污染工作repo。fake app-server與fixture是有效baseline/contract evidence；live claim只限正式record的一個controlled fixture flow。""",
            "evidence": [
                ("package.json", "Node test orchestration", '"test:e2e"'),
                ("pyproject.toml", "pytest configuration", "testpaths"),
                ("services/codex-bridge/tests/fake-app-server.ts", "contract fixture", "FAKE_START_MODE"),
                ("apps/voiss-aura-web/tests/e2e/control-room.spec.ts", "browser E2E"),
                ("apps/voiss-aura-web/tests/live/control-room-live.spec.ts", "activation-gated live browser E2E", "test("),
                ("scripts/check_architecture_boundaries.mjs", "static architecture boundary assertions", "assert.doesNotMatch"),
                (VALIDATION_RECORD, "retained final-source execution results", "116 JS/TS"),
            ],
            "assumptions": ["test declarations可作為coverage surface近似值。"],
            "limitations": ["inventory中的per-file declaration count是regex近似，不等於test collection；本次generator未執行產品tests或build。", "retained live browser證據限一個synthetic fixture，未覆蓋production、multi-repo或未執行的negative paths。"],
            "decisions": ["測試存在與測試通過分開記錄；fake runtime不作live proof。"],
            "risks": ["只跑unit會漏掉token/origin/stream/model/host整合問題。"],
            "next": ["在target commit重跑分層gate，並為deny、run-scope、stop/recovery與callback approvals新增專屬live evidence。"],
        },
        {
            "file": REPORT_FILES[17],
            "title": "18 Observability and Operations",
            "finding": "Observability由service status、structured run events、SQLite hash-chain audit、AURA JSONL audit、runtime diagnostics與export evidence共同提供。",
            "detail": """Web status route聚合AURA/Codex readiness並同步trust controls。每個session workflow以 correlation ID串接operator action、runtime observation與export evidence。AG-UI activity顯示plan、command、file、diff、approval與error。TrustStore把actor/action/subject/detail寫入ordered hash chain；AURA保留audit event與runtime diagnostic；Bridge只在patch SHA-256與mutation generation一致的authoritative validation gate通過後輸出sanitized completed-write evidence，Web再記錄validated export並更新對應control/finding。

Codex Bridge status另公開bounded restart count；app-server protocol failure遵循有限restart budget，run timeout保持authoritative terminal result並清理pending approval。Approval timeout保留`timed_out/paused` replay/resume/stop capability；stale-running reconcile、normal close與app-server crash保存bounded `blocked`／`interrupted` lifecycle metadata。terminal patch snapshot與validation summary進入export evidence。

2026-07-25 final clean validation database保留1個bootstrap與10個live-correlation events；TrustStore跨workflow保留1,139個run events，exported write-run packet保留366個Codex events，2個validation checks對齊mutation generation 6及terminal patch SHA-256。這些counts屬一個controlled run，不推廣為長期SLO或throughput。現在沒有集中log backend、metrics collector、distributed trace或alerting。""",
            "evidence": [
                ("apps/voiss-aura-web/app/api/status/route.ts", "readiness aggregation"),
                ("packages/trust-engine/src/index.ts", "hash-chain audit", "verifyAuditChain"),
                ("apps/voiss-aura-web/lib/trust-store.ts", "validated export trust transition", "recordValidatedExport"),
                ("services/codex-bridge/src/index.ts", "validation summary gate", "validationSummary"),
                ("services/codex-bridge/src/index.ts", "restart budget", "restart budget exhausted"),
                ("services/codex-bridge/src/index.ts", "authoritative timeout", "timeout result remains authoritative"),
                ("src/aura/audit.py", "AURA audit"),
                ("services/codex-bridge/src/export.ts", "sanitized export"),
                (VALIDATION_RECORD, "retained correlation/audit/event counts", "Audit sequence"),
            ],
            "assumptions": ["operator可以存取本機state與export root。"],
            "limitations": ["沒有SLO、alert routing、central retention或cross-host tracing。"],
            "decisions": ["MVP以correlation和evidence export提供可追溯性。"],
            "risks": ["程序crash前未持久化的stream event可能只存在UI memory。"],
            "next": ["保留target-host crash/reconnect與browser auto-reattach live trace，啟動automatic active/write recovery前由reviewer確認語意。"],
        },
        {
            "file": REPORT_FILES[18],
            "title": "19 Data Storage, Retention, and Lifecycle",
            "finding": "Canonical meeting evidence、control metadata、CopilotKit runner history、Codex lifecycle、audit、worktree與export各有獨立owner和locator；資料生命週期採local stewardship，retention與cleanup仍需release policy。",
            "detail": """AURA artifact tree保存音訊、transcript、summary與reviewed evidence；evidence SQLite支援search。VOISS control-plane SQLite已active wiring保存assets、controls、findings與hash-chain audit events，以及workspaces、repositories、actions、agent runs、Codex threads、bounded run events、approvals、validation results與exports。CopilotKit runner另以`VOISS_AGENT_DB_PATH`的專屬SQLite保存`agent_runs`、`run_state`與parent-linked invocation history，避免與control-plane schema共用檔案。Codex lifecycle record涵蓋VOISS run IDs、thread、repository/worktree、model/profile、source evidence、起訖時間、status與correlation；service可從SQLite恢復未封存的read-only thread capability，並提供cursor replay與official thread archive。aura session cache、control results與remediations維持declared schema activation paths。Codex worktree是隔離mutation workspace；reviewed exports位於具名root。

資料流程由raw evidence進入review，再形成confirmed claim/action、approved delegation、validation與export。2026-07-25 clean validation DB中的1個bootstrap與10個correlation-scoped events證明active control-plane tables支援該single flow；獨立runner DB另證明plan → write interrupt → approval resume的parent lineage與settled state。只有`aura_sessions_cache`、`control_results`與`remediations`維持reserved schema paths。原始音訊與model artifact不複製到browser或architecture inventory；本套件只保存path、schema、hash與coverage metadata。""",
            "evidence": [
                ("docs/data-lifecycle.md", "data lifecycle policy"),
                ("src/aura/evidence_search.py", "evidence index", "CREATE TABLE meetings"),
                ("packages/trust-engine/src/index.ts", "control metadata", "METADATA_TABLES"),
                ("services/codex-bridge/src/worktree.ts", "ephemeral worktree"),
                (VALIDATION_RECORD, "retained clean audit-chain evidence", "fresh validation database"),
            ],
            "assumptions": ["本機filesystem permission與backup策略由operator管理。"],
            "limitations": ["TrustStore三個reserved tables仍待owner與write/read path activation；兩個SQLite store的migration、retention、backup與secure deletion尚未形成完整policy。"],
            "decisions": ["canonical source留在AURA；control-plane只保存必要metadata與evidence refs。"],
            "risks": ["未設定retention可能造成敏感meeting artifact或run evidence長期累積。"],
            "next": ["決定每個store的owner、retention、backup、export與deletion acceptance test。"],
        },
        {
            "file": REPORT_FILES[19],
            "title": "20 Open Questions, Unknowns, and Release Gates",
            "finding": "MVP source architecture、final-source quality與一個controlled live integration已有retained evidence；release決策現在取決於target commit/reviewer identity、單次證據的repeatability邊界、專屬negative live traces、runtime/model provenance、license與retention。",
            "detail": """Open questions以activation gate管理：reviewer何時選定target commit；其他repository、host與concurrent workload如何保留repeatability evidence；模型revision/digest與授權如何封存；TrustStore migration/retention如何運作；remote deployment是否另案。`item/plan/delta` source mapping及一次live observation已關閉原缺口；direct-host `:workspace`在此host仍由targeted AppArmor preflight控制，已驗證target lane為rootless Podman+nested managed-bubblewrap。

已完成的release evidence包括frozen install/lint/typecheck/test/build、real AURA query/review、one real Codex plan/allow_once/write/two validations/export、18 deterministic與1 guarded live browser scenario、active egress canary及retained demo screenshot/packet。尚需專屬live traces的是deny、`allow_run_scope`、stop/recovery與app-server command/file callback approvals；release identity仍需target commit與reviewer sign-off。Push、merge、PR、deploy、publication與external messaging維持另案授權。""",
            "evidence": [
                ("docs/release-checklist.md", "release gates"),
                ("KNOWN_LIMITATIONS.md", "known unknowns"),
                ("PROGRESS.md", "implementation status"),
                (VALIDATION_RECORD, "retained completed/open evidence matrix", "Decision"),
                ("docs/architecture/repository-technical-architecture-report/inventories/16-findings.json", "open findings", None),
            ],
            "assumptions": ["release owner會把每個gate連到可重現artifact。"],
            "limitations": ["本報告無法替代host validation、security review、license counsel或field acceptance。"],
            "decisions": ["所有未知保持visible，不以baseline、fixture或harness代理live result。"],
            "risks": ["若在gate未關閉前標示complete，會弱化evidence trust model。"],
            "next": ["由reviewer選定target commit並簽署release identity與checksums。", "為deny、run-scope、stop/recovery與callback approval各自保留live artifact。"],
        },
    ]


def render_report(spec: dict[str, Any], snapshot: str) -> str:
    evidence_lines = []
    for item in spec["evidence"]:
        relative, purpose = item[:2]
        needle = item[2] if len(item) > 2 else None
        evidence_lines.append(f"- `{line_ref(relative, needle)}` — {purpose}。")

    def bullets(values: list[str]) -> str:
        return "\n".join(f"- {value}" for value in values)

    return f"""# {spec["title"]}

## Report control

| Field | Value |
|---|---|
| Status | `{REPORT_STATUS}` |
| Product milestone | `{PRODUCT_MILESTONE}` |
| Scoped live run status | `{LIVE_RUN_STATUS}` |
| Source baseline | `{BASELINE}` |
| Baseline role | Source lineage only; it is not live MVP proof |
| Current evidence | Uncommitted source and retained-validation snapshot `{snapshot}` |
| Artifact timestamp | `{GENERATED_AT}` (normalized; not a wall-clock runtime observation) |

## Architecture finding

{spec["finding"]}

{spec["detail"]}

## Evidence paths

{chr(10).join(evidence_lines)}

## Assumptions

{bullets(spec["assumptions"])}

## Limitations

{bullets(spec["limitations"])}

## Decisions

{bullets(spec["decisions"])}

## Risks

{bullets(spec["risks"])}

## Next validation

{bullets(spec["next"])}
"""


def diagrams() -> dict[str, str]:
    return {
        DIAGRAM_FILES[0]: """flowchart LR
  Operator["現場操作人"]
  Browser["Browser client"]
  Web["VOISS AURA Control Room system"]
  Aura["Project AURA canonical evidence"]
  Codex["Codex engineering runtime"]
  Repo["Allowed Git repository"]
  Models["Local ASR, diarization, Gemma and enhancement runtimes"]
  Provider["Codex model provider"]
  Operator --> Browser
  Browser -->|same-origin signed session| Web
  Web -->|token-authenticated loopback evidence API| Aura
  Web -->|explicit plan and approval through loopback Bridge| Codex
  Aura --> Models
  Codex --> Repo
  Codex -. authenticated app-server .-> Provider
""",
        DIAGRAM_FILES[1]: """flowchart TB
  subgraph Host["Single local host"]
    Browser["Browser"]
    Web["Next.js Web server :3000"]
    Trust["SQLite TrustStore"]
    AuraBridge["AURA Bridge :8765"]
    CodexBridge["Codex Bridge :8770"]
    AuraDesktop["AURA desktop"]
    AuraData["Canonical AURA artifacts and evidence index"]
    Podman["Rootless Podman"]
    Image["Digest-pinned Codex runtime image"]
    AppServer["Official Codex app-server"]
    Sandbox["Nested managed-bubblewrap"]
    Worktree["Isolated Git worktree"]
    VendorAuth["Codex vendor and auth read-only mounts"]
    Ollama["Ollama and local models"]
  end
  Browser --> Web
  Web --> Trust
  Web --> AuraBridge
  Web --> CodexBridge
  AuraBridge --> AuraData
  AuraDesktop --> AuraData
  AuraDesktop --> Ollama
  CodexBridge --> Podman --> Image --> AppServer --> Sandbox --> Worktree
  VendorAuth -->|read-only| Image
""",
        DIAGRAM_FILES[2]: """flowchart LR
  UI["ControlRoom component"]
  Routes["Next API routes"]
  Security["Session and origin security"]
  Status["Service status"]
  TrustWiring["Persistent trust wiring"]
  Domain["Domain schemas"]
  Fixture["Demo fixtures"]
  Agent["Named agent runtime"]
  Adapter["AG-UI Codex adapter"]
  Trust["Trust engine"]
  Aura["AURA Bridge"]
  Codex["Codex Bridge"]
  UI --> Routes
  Routes --> Security
  Routes --> Status
  Routes --> TrustWiring
  UI --> Domain
  UI --> Fixture
  UI --> Agent
  Agent --> Adapter
  TrustWiring --> Trust
  Routes --> Aura
  Adapter --> Codex
""",
        DIAGRAM_FILES[3]: """flowchart TD
  Mode{"VOISS_MODE"}
  Demo["Deterministic demo fixtures"]
  Local["Local server-side integration"]
  Session["Signed browser session"]
  Aura["AURA Bridge evidence"]
  Gate["Confirmed and supported action"]
  Plan["Codex read-only plan"]
  Activate["Bridge-owned write activation approval"]
  Worktree["Create isolated worktree"]
  Named["Named command or file approval"]
  Execute["Network-off Codex execution"]
  Validate["Validation and evidence export"]
  Mode -->|demo| Demo
  Mode -->|local| Local
  Local --> Session --> Aura --> Gate --> Plan --> Activate
  Activate -->|allow| Worktree --> Named --> Execute --> Validate
  Activate -->|deny| Plan
""",
        DIAGRAM_FILES[4]: """sequenceDiagram
  actor User as 現場操作人
  participant Web as VOISS Web
  participant Aura as AURA Bridge
  participant Agent as VOISS Orchestrator
  participant Codex as Codex Bridge
  participant Repo as Isolated Worktree
  User->>Web: Open meeting evidence
  Web->>Aura: Read session, segments, claims, actions
  Aura-->>Web: Canonical evidence with freshness
  User->>Web: Confirm claim and action
  Web->>Aura: Review and export request
  Aura-->>Web: Reviewed evidence
  Web->>Agent: Delegate supported action
  Agent->>Codex: Start read-only plan
  Codex-->>Web: Normalized plan and activity stream
  User->>Codex: Approve write activation
  Codex->>Repo: Create isolated worktree
  Codex-->>User: Request named command or file approval
  User->>Codex: Allow once, allow run scope, or deny
  Codex-->>Web: Result, diff, and validation events
  Codex->>Codex: Freeze terminal patch and bind validation hash plus mutation generation
  Codex-->>Web: Validation-gated evidence export
""",
        DIAGRAM_FILES[5]: """sequenceDiagram
  actor User
  participant Web
  participant Bridge as Codex Bridge
  participant Git
  participant Codex as Codex app-server
  Web->>Bridge: POST run in plan scope
  Bridge->>Codex: read-only, network-off, on-request
  Codex-->>Web: plan events
  User->>Web: request isolated write scope
  Web->>Bridge: POST run with codexMode write
  Bridge-->>Web: staged write-activation approval, no worktree yet
  User->>Web: approve or deny staged activation
  Web->>Bridge: resume exact activation request id
  Bridge->>Git: create isolated worktree
  Bridge->>Codex: start write-capable turn, network-off
  Codex-->>Bridge: named command or file request
  Bridge-->>Web: approval interrupt
  User->>Web: accept once, accept run scope, or decline
  Web->>Bridge: resume exact pending request id
  Bridge->>Codex: narrow response
  Codex-->>Web: events and terminal result
  Bridge->>Bridge: compare validation hash and generation with frozen terminal patch
  Bridge-->>Web: export only when authoritative gate passes
""",
        DIAGRAM_FILES[6]: """flowchart LR
  Audio["Raw or imported audio"]
  Transcript["Segments and speakers"]
  Claims["Claims and structured summary"]
  Review["Human review"]
  Actions["Supported actions"]
  Runs["Agent runs and approvals"]
  Validation["Validation results"]
  Exports["Reviewed evidence exports"]
  Audit["Hash-chain and AURA audit"]
  Audio --> Transcript --> Claims --> Review --> Actions --> Runs --> Validation --> Exports
  Review --> Audit
  Runs --> Audit
  Validation --> Audit
""",
        DIAGRAM_FILES[7]: """flowchart TB
  subgraph LocalHost["Local host deployment"]
    Browser["Browser"]
    Next["Next.js process :3000"]
    AuraSvc["Python FastAPI AURA Bridge :8765"]
    CodexSvc["Node Codex Bridge :8770"]
    Desktop["PyQt6 AURA desktop"]
    Podman["Rootless Podman"]
    CodexImage["Digest-pinned Ubuntu Codex image"]
    CodexProc["Official Codex app-server"]
    Sandbox["Nested managed-bubblewrap"]
    VendorAuth["Vendor and auth read-only mounts"]
    TrustData["VOISS TrustStore SQLite"]
    AuraData["AURA artifacts, evidence SQLite, and audit JSONL"]
    CodexData["Isolated worktrees and Codex evidence exports"]
  end
  Browser --> Next
  Next --> AuraSvc
  Next --> CodexSvc
  Next --> TrustData
  AuraSvc --> AuraData
  Desktop --> AuraData
  CodexSvc --> Podman --> CodexImage --> CodexProc --> Sandbox
  VendorAuth -->|read-only| CodexImage
  Sandbox -->|allowlisted rw roots| CodexData
  Note["One Podman image is implemented; Compose and Kubernetes are absent"]
  Note -. scope note .-> LocalHost
""",
        DIAGRAM_FILES[8]: """flowchart LR
  BrowserZone["Browser zone: no Bridge credentials"]
  WebZone["Web server zone: signed session and server-only secrets"]
  BridgeZone["Loopback Bridge zone: bearer token and Origin allowlist"]
  RuntimeZone["Runtime zone: AURA plus rootless Podman Codex"]
  SandboxZone["Nested managed-bubblewrap: network-off tools"]
  RepoZone["Repository zone: allowlist and isolated worktree"]
  EvidenceZone["Evidence zone: owner-oriented paths, redaction, hash chain"]
  BrowserZone -->|same-origin| WebZone
  WebZone -->|token, loopback| BridgeZone
  BridgeZone -->|explicit protocol| RuntimeZone
  RuntimeZone --> SandboxZone
  SandboxZone -->|approved mutation and allowlisted rw root only| RepoZone
  WebZone --> EvidenceZone
  BridgeZone --> EvidenceZone
""",
        DIAGRAM_FILES[9]: """flowchart TD
  Web["@voiss/aura-web"]
  Domain["@voiss/domain"]
  Fixture["@voiss/demo-fixtures"]
  Trust["@voiss/trust-engine"]
  Agent["@voiss/agent-runtime"]
  Adapter["@voiss/ag-ui-codex-adapter"]
  AuraBridge["voiss-aura-bridge"]
  CodexBridge["@voiss/codex-bridge"]
  AuraCore["project-aura-refactor"]
  AGUI["@ag-ui/client"]
  Web --> Domain
  Web --> Fixture
  Web --> Trust
  Web --> Agent
  Web --> Adapter
  Fixture --> Domain
  Trust --> Domain
  Agent --> Fixture
  Agent --> Adapter
  Adapter --> AGUI
  Web --> AuraBridge
  Web --> CodexBridge
  AuraBridge --> AuraCore
""",
        DIAGRAM_FILES[10]: """stateDiagram-v2
  [*] --> RawEvidence
  RawEvidence --> Indexed
  Indexed --> Reviewed
  Reviewed --> Confirmed
  Reviewed --> Rejected
  Confirmed --> SupportedAction
  SupportedAction --> Delegated
  Delegated --> ApprovalRequired
  ApprovalRequired --> Running: allow
  ApprovalRequired --> Stopped: deny
  Running --> Validated
  Running --> Failed
  Validated --> Exported
  Exported --> [*]
""",
        DIAGRAM_FILES[11]: """stateDiagram-v2
  [*] --> NotRun
  NotRun --> Pass: readiness or validation evidence
  NotRun --> Fail: negative result
  Fail --> FindingOpen
  FindingOpen --> Mitigated: remediation evidence
  Mitigated --> Pass: revalidation
  FindingOpen --> Accepted: explicit risk decision
  Pass --> Attention: evidence stale or runtime unavailable
  Attention --> Pass: refreshed evidence
""",
    }


def cyclonedx(
    snapshot: str,
    node_records: list[dict[str, Any]],
    python_records: list[dict[str, Any]],
) -> dict[str, Any]:
    root_ref = "pkg:generic/voiss-aura-control-room@0.0.0-private"
    components: list[dict[str, Any]] = []
    for item in workspace_components():
        components.append(
            {
                "type": item["type"] if item["type"] in {"application", "library"} else "application",
                "bom-ref": f"workspace:{item['id']}",
                "name": item["name"],
                "version": item["version"],
                "licenses": [{"license": {"id": "MIT"}}] if item["id"] == "project-aura-refactor" else [{"license": {"name": "NOASSERTION"}}],
                "properties": [
                    {"name": "voiss:coverage", "value": "complete_workspace_manifest"},
                    {"name": "voiss:manifest", "value": item["manifest"]},
                ],
            }
        )
    for item in node_records:
        components.append(
            {
                "type": "library",
                "bom-ref": f"{item['purl']}?lock={sha256_bytes(item['lock_key'].encode())[:12]}",
                "name": item["name"],
                "version": item["version"],
                "purl": item["purl"],
                "licenses": [{"license": {"name": "NOASSERTION"}}],
                "properties": [
                    {"name": "voiss:pnpmLockKey", "value": item["lock_key"]},
                    {"name": "voiss:coverage", "value": "complete_lock_record_identity"},
                ],
            }
        )
    for item in python_records:
        components.append(
            {
                "type": "library",
                "bom-ref": f"{item['purl']}?record={item['id']}",
                "name": item["name"],
                "version": item["version"],
                "purl": item["purl"],
                "licenses": [{"license": {"name": "NOASSERTION"}}],
                "properties": [{"name": "voiss:coverage", "value": "complete_lock_record_identity"}],
            }
        )
    for name, purpose, path in NATIVE_TOOLS:
        components.append(
            {
                "type": "framework",
                "bom-ref": f"native:{name}",
                "name": name,
                "version": "NOASSERTION",
                "licenses": [{"license": {"name": "NOASSERTION"}}],
                "properties": [
                    {"name": "voiss:purpose", "value": purpose},
                    {"name": "voiss:evidence", "value": path},
                    {"name": "voiss:coverage", "value": "partial_curated_source_detected"},
                ],
            }
        )
    for item in EXTERNAL_RUNTIME_COMPONENTS:
        component_type = (
            "machine-learning-model"
            if "model" in item["kind"]
            else "container"
            if item["kind"] == "container_base_image"
            else "framework"
        )
        components.append(
            {
                "type": component_type,
                "bom-ref": item["id"],
                "name": item["name"],
                "version": item.get("required_version", "NOASSERTION"),
                "licenses": [{"license": {"name": "NOASSERTION"}}],
                "properties": [
                    {"name": "voiss:purpose", "value": item["purpose"]},
                    {"name": "voiss:evidence", "value": item["evidence"]},
                    {"name": "voiss:coverage", "value": "partial_curated_source_detected"},
                    {"name": "voiss:runtimeStatus", "value": item["runtime_status"]},
                    *(
                        [{"name": "voiss:requiredVersion", "value": item["required_version"]}]
                        if item.get("required_version")
                        else []
                    ),
                    *(
                        [{"name": "voiss:digest", "value": item["digest"]}]
                        if item.get("digest")
                        else []
                    ),
                ],
            }
        )
    workspace_refs = [item["bom-ref"] for item in components if item["bom-ref"].startswith("workspace:")]
    return {
        "$schema": "http://cyclonedx.org/schema/bom-1.6.schema.json",
        "bomFormat": "CycloneDX",
        "specVersion": "1.6",
        "serialNumber": f"urn:uuid:{uuid.uuid5(uuid.NAMESPACE_URL, 'voiss:' + snapshot)}",
        "version": 1,
        "metadata": {
            "timestamp": GENERATED_AT,
            "component": {
                "type": "application",
                "bom-ref": root_ref,
                "name": "voiss-aura-control-room",
                "version": "0.0.0-private",
                "licenses": [{"license": {"id": "MIT"}}],
                "properties": [
                    {"name": "voiss:status", "value": STATUS},
                    {"name": "voiss:productMilestone", "value": PRODUCT_MILESTONE},
                    {"name": "voiss:scopedLiveRunStatus", "value": LIVE_RUN_STATUS},
                    {"name": "voiss:sourceBaseline", "value": BASELINE},
                    {"name": "voiss:baselineRole", "value": "lineage_only"},
                    {"name": "voiss:sourceSnapshotSha256", "value": snapshot},
                ],
            },
            "tools": {"components": [{"type": "application", "name": "stdlib architecture generator", "version": "1"}]},
        },
        "components": components,
        "dependencies": [
            {"ref": root_ref, "dependsOn": workspace_refs},
            *[{"ref": ref, "dependsOn": []} for ref in workspace_refs],
        ],
        "properties": [
            {"name": "voiss:nodeIdentityCoverage", "value": "complete"},
            {"name": "voiss:pythonIdentityCoverage", "value": "complete"},
            {"name": "voiss:dependencyEdgeCoverage", "value": "partial"},
            {"name": "voiss:nativeToolCoverage", "value": "partial_curated_source_detected"},
            {"name": "voiss:externalRuntimeCoverage", "value": "partial_curated_source_detected"},
            {"name": "voiss:licenseCoverage", "value": "partial_NOASSERTION"},
        ],
    }


def spdx(
    snapshot: str,
    node_records: list[dict[str, Any]],
    python_records: list[dict[str, Any]],
) -> dict[str, Any]:
    packages: list[dict[str, Any]] = []

    def add_package(
        spdx_id: str,
        name: str,
        version: str,
        purl: str | None,
        license_value: str,
        comment: str,
    ) -> None:
        package: dict[str, Any] = {
            "SPDXID": spdx_id,
            "name": name,
            "versionInfo": version,
            "downloadLocation": "NOASSERTION",
            "filesAnalyzed": False,
            "licenseConcluded": license_value,
            "licenseDeclared": license_value,
            "copyrightText": "NOASSERTION",
            "comment": comment,
        }
        if purl:
            package["externalRefs"] = [
                {
                    "referenceCategory": "PACKAGE-MANAGER",
                    "referenceType": "purl",
                    "referenceLocator": purl,
                }
            ]
        packages.append(package)

    add_package(
        "SPDXRef-Root",
        "voiss-aura-control-room",
        "0.0.0-private",
        "pkg:generic/voiss-aura-control-room@0.0.0-private",
        "MIT",
        (
            f"{STATUS}; product milestone {PRODUCT_MILESTONE}; scoped live run "
            f"{LIVE_RUN_STATUS}; baseline {BASELINE} is lineage only; snapshot {snapshot}"
        ),
    )
    relationships = []
    for index, item in enumerate(workspace_components(), 1):
        spdx_id = f"SPDXRef-Workspace-{index:03d}"
        add_package(
            spdx_id,
            item["name"],
            item["version"],
            None,
            "MIT" if item["id"] == "project-aura-refactor" else "NOASSERTION",
            f"complete workspace manifest identity: {item['manifest']}",
        )
        relationships.append({"spdxElementId": "SPDXRef-Root", "relationshipType": "DEPENDS_ON", "relatedSpdxElement": spdx_id})
    for item in node_records:
        suffix = sha256_bytes(item["lock_key"].encode())[:16]
        add_package(
            f"SPDXRef-Npm-{suffix}",
            item["name"],
            item["version"],
            item["purl"],
            "NOASSERTION",
            f"complete pnpm lock identity; lock key {item['lock_key']}; license pending resolution",
        )
    for item in python_records:
        add_package(
            f"SPDXRef-PyPI-{item['id'].split('-')[-1]}",
            item["name"],
            item["version"],
            item["purl"],
            "NOASSERTION",
            "complete uv lock identity; license pending resolution",
        )
    for index, (name, purpose, path) in enumerate(NATIVE_TOOLS, 1):
        add_package(
            f"SPDXRef-Native-{index:03d}",
            name,
            "NOASSERTION",
            None,
            "NOASSERTION",
            f"partial curated source-detected native tool; {purpose}; evidence {path}",
        )
    for index, item in enumerate(EXTERNAL_RUNTIME_COMPONENTS, 1):
        add_package(
            f"SPDXRef-External-{index:03d}",
            item["name"],
            item.get("required_version", "NOASSERTION"),
            None,
            "NOASSERTION",
            (
                f"partial curated external runtime; {item['runtime_status']}; "
                f"required version {item.get('required_version', 'NOASSERTION')}; "
                f"digest {item.get('digest', 'NOASSERTION')}; evidence {item['evidence']}"
            ),
        )
    return {
        "spdxVersion": "SPDX-2.3",
        "dataLicense": "CC0-1.0",
        "SPDXID": "SPDXRef-DOCUMENT",
        "name": "VOISS AURA repository technical architecture SBOM",
        "documentNamespace": f"https://voiss.local/spdx/{snapshot}",
        "creationInfo": {
            "created": GENERATED_AT,
            "creators": ["Tool: VOISS stdlib architecture generator-1"],
            "licenseListVersion": "NOASSERTION",
            "comment": "Source snapshot SBOM; native, model, runtime, and license coverage is explicitly bounded.",
        },
        "documentDescribes": ["SPDXRef-Root"],
        "packages": packages,
        "relationships": relationships,
        "annotations": [
            {
                "annotationDate": GENERATED_AT,
                "annotationType": "OTHER",
                "annotator": "Tool: VOISS stdlib architecture generator-1",
                "comment": "Node and Python lock identities are complete. Transitive edges are partial. Native tools and external runtimes are curated partial coverage. Dependency licenses remain NOASSERTION.",
            }
        ],
    }


def package_readme(snapshot: str, counts: dict[str, int]) -> str:
    return f"""# Repository Technical Architecture Report

這個 package 是 Project AURA + VOISS implemented MVP 的 source-backed architecture snapshot。

## Evidence contract

- Status: `{STATUS}`
- Product milestone: `{PRODUCT_MILESTONE}`
- Scoped live run status: `{LIVE_RUN_STATUS}`
- Source baseline: `{BASELINE}`，只表示 AURA source lineage
- Current MVP evidence: uncommitted source and retained-validation snapshot `{snapshot}`
- Artifact timestamp: `{GENERATED_AT}`（normalized；不代表產品runtime觀測時間）
- Retained evidence: `docs/validation/2026-07-24-local-e2e.md`記錄一個controlled fixture live flow、final-source quality matrix與single-host Podman runtime；本generator不宣稱自己執行了這些產品命令

本 package 包含：

- {counts["reports"]} 份 report Markdown
- {counts["diagrams"]} 份 Mermaid source
- {counts["inventories"]} 份 machine-readable inventory JSON
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
"""


def package_metadata(
    snapshot: str,
    source_records: list[dict[str, Any]],
    node_records: list[dict[str, Any]],
    python_records: list[dict[str, Any]],
) -> dict[str, Any]:
    dirty_lines = [
        line
        for line in git("status", "--porcelain=v1", "--untracked-files=all").splitlines()
        if "docs/architecture/repository-technical-architecture-report/" not in line
    ]
    return {
        "$schema": f"{SCHEMA_PREFIX}.package-metadata.v1",
        "title": "Repository Technical Architecture Report",
        "status": STATUS,
        "product_milestone": PRODUCT_MILESTONE,
        "scoped_live_run_status": LIVE_RUN_STATUS,
        "generated_at": GENERATED_AT,
        "generated_at_semantics": "normalized_artifact_timestamp_not_wall_clock_observation",
        "source_baseline": BASELINE,
        "source_baseline_role": "lineage_only_not_live_mvp_proof",
        "git_head_at_generation": git("rev-parse", "HEAD"),
        "current_evidence": {
            "kind": "uncommitted_source_and_retained_validation_snapshot",
            "sha256": snapshot,
            "source_file_count": len(source_records),
            "dirty_path_count_excluding_this_package": len(dirty_lines),
            "published": False,
            "runtime_validated_by_generator": False,
            "build_validated_by_generator": False,
            "tests_validated_by_generator": False,
            "retained_validation": {
                "record": VALIDATION_RECORD,
                "scope": "one_controlled_synthetic_AURA_and_Git_fixture_flow",
                "persisted_run_events": 1139,
                "exported_write_run_codex_events": 366,
                "terminal_patch_validations_passed": 2,
                "terminal_mutation_generation": 6,
                "audit_events_total": 11,
                "audit_events_live_correlation": 10,
                "copilotkit_parent_linked_invocations": 3,
                "separate_active_egress_denial_canary": True,
                "production_or_multi_repository_repeatability": False,
            },
            "retained_demo_evidence": {
                "screenshot": DEMO_SCREENSHOT,
                "screenshot_sha256": DEMO_SCREENSHOT_SHA256,
                "walkthrough_outer_file_sha256": DEMO_WALKTHROUGH_SHA256,
                "classification": "deterministic_demo_evidence",
            },
        },
        "deliverable_counts": {
            "reports": len(REPORT_FILES),
            "mermaid_sources": len(DIAGRAM_FILES),
            "inventories": len(INVENTORY_FILES),
            "sboms": 2,
        },
        "dependency_coverage": {
            "node_resolved_component_identities": {"status": "complete", "records": len(node_records)},
            "python_resolved_component_identities": {"status": "complete", "records": len(python_records)},
            "transitive_relationship_edges": "partial",
            "native_tools": "partial_curated_source_detected",
            "external_models_and_runtimes": "partial_curated_source_detected",
            "licenses": "partial_NOASSERTION",
        },
        "generator": {
            "language": "Python",
            "dependency_policy": "standard_library_only",
            "deterministic_timestamp": True,
        },
    }


def build_inventories(
    snapshot: str,
    node_records: list[dict[str, Any]],
    python_records: list[dict[str, Any]],
) -> dict[str, dict[str, Any]]:
    return {
        INVENTORY_FILES[0]: component_inventory(snapshot),
        INVENTORY_FILES[1]: entry_point_inventory(snapshot),
        INVENTORY_FILES[2]: api_inventory(snapshot),
        INVENTORY_FILES[3]: ag_ui_inventory(snapshot),
        INVENTORY_FILES[4]: codex_mapping_inventory(snapshot),
        INVENTORY_FILES[5]: environment_inventory(snapshot),
        INVENTORY_FILES[6]: external_service_inventory(snapshot),
        INVENTORY_FILES[7]: database_inventory(snapshot),
        INVENTORY_FILES[8]: queue_event_inventory(snapshot),
        INVENTORY_FILES[9]: dependency_inventory(snapshot, node_records, python_records),
        INVENTORY_FILES[10]: license_inventory(snapshot, node_records, python_records),
        INVENTORY_FILES[11]: test_inventory(snapshot),
        INVENTORY_FILES[12]: compact_inventory(
            "risks",
            snapshot,
            RISKS,
            {
                "risk_register": "current_architecture_review",
                "runtime_resolution": "one_controlled_live_flow_and_separate_egress_canary_retained",
                "claim_ceiling": "not_production_or_multi_repository_repeatability",
            },
            [evidence_item("KNOWN_LIMITATIONS.md", "known limitations"), evidence_item("docs/release-checklist.md", "release gates")],
        ),
        INVENTORY_FILES[13]: compact_inventory(
            "controls",
            snapshot,
            CONTROLS,
            {
                "implemented_control_definitions": "complete_curated",
                "live_effectiveness": "partial_one_controlled_fixture_flow",
                "dedicated_live_negative_paths": "deny_run_scope_stop_recovery_and_callback_approvals_open",
            },
            [
                evidence_item("apps/voiss-aura-web/lib/trust-store.ts", "active controls", "initialControls"),
                evidence_item("docs/security-model.md", "security model"),
                evidence_item(VALIDATION_RECORD, "one-run control effectiveness evidence", "Runtime validity"),
            ],
        ),
        INVENTORY_FILES[14]: compact_inventory(
            "assets",
            snapshot,
            ASSETS,
            {
                "architecture_assets": "complete_curated",
                "host_instances": "one_verified_host_for_Podman_Codex_lane",
                "external_model_runtime_instances": "separate_activation_gates",
            },
            [
                evidence_item("apps/voiss-aura-web/lib/trust-store.ts", "runtime assets", "initialAssets"),
                evidence_item("services/codex-bridge/Containerfile", "Codex container asset", "FROM docker.io"),
                evidence_item(VALIDATION_RECORD, "verified host asset instance", "Release identity"),
            ],
        ),
        INVENTORY_FILES[15]: compact_inventory(
            "findings",
            snapshot,
            FINDINGS,
            {"release_findings": "current_architecture_review", "closure": "evidence_required"},
            [
                evidence_item("services/codex-bridge/src/server.ts", "plan delta source", "plan.delta"),
                evidence_item("packages/ag-ui-codex-adapter/src/index.ts", "closed plan-delta adapter case", 'case "item/plan/delta"'),
                evidence_item(VALIDATION_RECORD, "mitigated single-run live finding evidence", "Live workflow evidence"),
            ],
        ),
        INVENTORY_FILES[16]: scheduled_inventory(snapshot),
        INVENTORY_FILES[17]: ci_inventory(snapshot),
        INVENTORY_FILES[18]: container_inventory(snapshot),
    }


def checksum_targets() -> list[Path]:
    targets = []
    for path in PACKAGE_DIR.rglob("*"):
        if not path.is_file():
            continue
        relative = path.relative_to(PACKAGE_DIR).as_posix()
        if relative in {"validation/manifest.json", "validation/checksums.sha256"}:
            continue
        if "__pycache__" in path.parts:
            continue
        targets.append(path)
    return sorted(targets, key=lambda item: item.relative_to(PACKAGE_DIR).as_posix())


def build_validation(snapshot: str) -> tuple[dict[str, Any], str]:
    artifacts = []
    checksum_lines = []
    for path in checksum_targets():
        relative = path.relative_to(PACKAGE_DIR).as_posix()
        digest = sha256_file(path)
        artifacts.append({"path": relative, "bytes": path.stat().st_size, "sha256": digest})
        checksum_lines.append(f"{digest}  {relative}")
    manifest = {
        "$schema": f"{SCHEMA_PREFIX}.validation-manifest.v1",
        "status": "PASS",
        "validated_at": GENERATED_AT,
        "timestamp_semantics": "normalized_artifact_timestamp_not_wall_clock_observation",
        "source_baseline": BASELINE,
        "source_snapshot_sha256": snapshot,
        "checksum_scope": "all package files except validation/manifest.json and validation/checksums.sha256",
        "expected_counts": {"reports": 20, "mermaid_sources": 12, "inventories": 19, "sboms": 2},
        "observed_counts": {
            "reports": len(list(REPORT_DIR.glob("*.md"))),
            "mermaid_sources": len(list(DIAGRAM_DIR.glob("*.mmd"))),
            "inventories": len(list(INVENTORY_DIR.glob("*.json"))),
            "sboms": len(list(SBOM_DIR.glob("*.json"))),
        },
        "checks": [
            {"id": "exact_counts", "status": "PASS"},
            {"id": "json_parse", "status": "PASS"},
            {"id": "inventory_envelopes", "status": "PASS"},
            {"id": "dependency_identity_coverage", "status": "PASS"},
            {"id": "sbom_minimum_structure", "status": "PASS"},
            {"id": "package_snapshot_coherence", "status": "PASS"},
            {"id": "report_required_sections", "status": "PASS"},
            {"id": "mermaid_source_header", "status": "PASS"},
            {"id": "retained_validation_record", "status": "PASS"},
            {"id": "retained_demo_screenshot_digest", "status": "PASS"},
            {"id": "source_snapshot", "status": "PASS"},
            {"id": "artifact_checksums", "status": "PASS"},
        ],
        "artifacts": artifacts,
    }
    return manifest, "\n".join(checksum_lines) + "\n"


REQUIRED_REPORT_MARKERS = [
    "## Report control",
    "| Status |",
    "| Product milestone |",
    "| Scoped live run status |",
    "| Source baseline |",
    "## Architecture finding",
    "## Evidence paths",
    "## Assumptions",
    "## Limitations",
    "## Decisions",
    "## Risks",
    "## Next validation",
]
MERMAID_PREFIXES = ("flowchart ", "sequenceDiagram", "stateDiagram-v2", "classDiagram", "erDiagram", "graph ")


def validate_package(
    expected_snapshot: str | None = None,
    require_validation_artifacts: bool = True,
) -> list[str]:
    errors: list[str] = []
    observed = {
        "reports": sorted(path.name for path in REPORT_DIR.glob("*.md")),
        "diagrams": sorted(path.name for path in DIAGRAM_DIR.glob("*.mmd")),
        "inventories": sorted(path.name for path in INVENTORY_DIR.glob("*.json")),
        "sboms": sorted(path.name for path in SBOM_DIR.glob("*.json")),
    }
    expected = {
        "reports": REPORT_FILES,
        "diagrams": DIAGRAM_FILES,
        "inventories": INVENTORY_FILES,
        "sboms": ["cyclonedx.json", "spdx.json"],
    }
    for key, expected_names in expected.items():
        if observed[key] != sorted(expected_names):
            errors.append(f"{key}: expected {len(expected_names)} exact files, observed {observed[key]}")

    json_paths = [
        PACKAGE_DIR / "metadata.json",
        *INVENTORY_DIR.glob("*.json"),
        *SBOM_DIR.glob("*.json"),
    ]
    if require_validation_artifacts:
        json_paths.append(VALIDATION_DIR / "manifest.json")
    for path in json_paths:
        try:
            json.loads(path.read_text(encoding="utf-8"))
        except Exception as exc:
            errors.append(f"invalid JSON {path.relative_to(PACKAGE_DIR)}: {exc}")

    for path in INVENTORY_DIR.glob("*.json"):
        try:
            inventory = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            continue
        required_keys = {
            "$schema",
            "status",
            "source_baseline",
            "source_baseline_role",
            "current_evidence",
            "coverage",
            "evidence",
            "records",
        }
        missing = sorted(required_keys - inventory.keys())
        if missing:
            errors.append(f"{path.name}: missing inventory envelope keys {missing}")
        if inventory.get("source_baseline") != BASELINE:
            errors.append(f"{path.name}: source baseline mismatch")

    dependency_path = INVENTORY_DIR / "10-dependencies.json"
    if dependency_path.exists():
        dependency_data = json.loads(dependency_path.read_text(encoding="utf-8"))
        dependency_records = dependency_data.get("records", {})
        if len(dependency_records.get("node_lock_records", [])) != EXPECTED_NODE_LOCK_RECORDS:
            errors.append(
                f"dependency inventory does not contain all {EXPECTED_NODE_LOCK_RECORDS} pnpm lock records"
            )
        if len(dependency_records.get("python_lock_records", [])) != EXPECTED_PYTHON_LOCK_RECORDS:
            errors.append(
                f"dependency inventory does not contain all {EXPECTED_PYTHON_LOCK_RECORDS} uv lock records"
            )

    cyclonedx_path = SBOM_DIR / "cyclonedx.json"
    if cyclonedx_path.exists():
        cdx = json.loads(cyclonedx_path.read_text(encoding="utf-8"))
        if cdx.get("bomFormat") != "CycloneDX" or cdx.get("specVersion") != "1.6":
            errors.append("CycloneDX identity/version mismatch")
        if len(cdx.get("components", [])) < EXPECTED_NODE_LOCK_RECORDS + EXPECTED_PYTHON_LOCK_RECORDS:
            errors.append("CycloneDX does not cover all Node and Python lock identities")
    spdx_path = SBOM_DIR / "spdx.json"
    if spdx_path.exists():
        spdx_data = json.loads(spdx_path.read_text(encoding="utf-8"))
        if spdx_data.get("spdxVersion") != "SPDX-2.3":
            errors.append("SPDX version mismatch")
        if len(spdx_data.get("packages", [])) < 1 + EXPECTED_NODE_LOCK_RECORDS + EXPECTED_PYTHON_LOCK_RECORDS:
            errors.append("SPDX does not cover root plus all Node and Python lock identities")

    for path in REPORT_DIR.glob("*.md"):
        text = path.read_text(encoding="utf-8")
        for marker in REQUIRED_REPORT_MARKERS:
            if marker not in text:
                errors.append(f"{path.name}: missing {marker}")
        if BASELINE not in text:
            errors.append(f"{path.name}: missing source baseline")
        if not any(
            f"| Status | `{status}` |" in text
            for status in ("Confirmed", "Partially Verified", "Inferred")
        ):
            errors.append(f"{path.name}: unsupported report status")

    for path in DIAGRAM_DIR.glob("*.mmd"):
        text = path.read_text(encoding="utf-8").lstrip()
        if not text.startswith(MERMAID_PREFIXES):
            errors.append(f"{path.name}: unsupported Mermaid header")

    retained_validation_path = ROOT / VALIDATION_RECORD
    if not retained_validation_path.exists():
        errors.append(f"retained validation record is missing: {VALIDATION_RECORD}")
    else:
        retained_text = retained_validation_path.read_text(encoding="utf-8")
        required_retained_markers = (
            f"Product milestone: `{PRODUCT_MILESTONE}`",
            f"Live-run status: `{LIVE_RUN_STATUS}`",
            "| Codex events in the exported write-run packet | 366 |",
            "| Architecture package regeneration and `generate.py --check` | PASS |",
            DEMO_SCREENSHOT_SHA256,
            DEMO_WALKTHROUGH_SHA256,
        )
        for marker in required_retained_markers:
            if marker not in retained_text:
                errors.append(f"retained validation record is missing marker: {marker}")

    demo_screenshot_path = ROOT / DEMO_SCREENSHOT
    if not demo_screenshot_path.exists():
        errors.append(f"retained demo screenshot is missing: {DEMO_SCREENSHOT}")
    elif sha256_file(demo_screenshot_path) != DEMO_SCREENSHOT_SHA256:
        errors.append("retained demo screenshot SHA-256 mismatch")

    metadata_path = PACKAGE_DIR / "metadata.json"
    if metadata_path.exists():
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        actual_snapshot, _ = implementation_snapshot()
        recorded_snapshot = metadata.get("current_evidence", {}).get("sha256")
        if recorded_snapshot != actual_snapshot:
            errors.append(f"source snapshot drift: metadata {recorded_snapshot}, current {actual_snapshot}")
        if expected_snapshot and recorded_snapshot != expected_snapshot:
            errors.append(f"generated snapshot mismatch: {recorded_snapshot} != {expected_snapshot}")
        if metadata.get("source_baseline") != BASELINE:
            errors.append("metadata source baseline mismatch")
        if recorded_snapshot:
            for path in REPORT_DIR.glob("*.md"):
                if recorded_snapshot not in path.read_text(encoding="utf-8"):
                    errors.append(f"{path.name}: source snapshot mismatch")
            for path in INVENTORY_DIR.glob("*.json"):
                inventory = json.loads(path.read_text(encoding="utf-8"))
                if inventory.get("current_evidence", {}).get("sha256") != recorded_snapshot:
                    errors.append(f"{path.name}: current evidence snapshot mismatch")
            if cyclonedx_path.exists():
                cdx_text = cyclonedx_path.read_text(encoding="utf-8")
                if recorded_snapshot not in cdx_text:
                    errors.append("CycloneDX source snapshot mismatch")
            if spdx_path.exists():
                spdx_text = spdx_path.read_text(encoding="utf-8")
                if recorded_snapshot not in spdx_text:
                    errors.append("SPDX source snapshot mismatch")

    manifest_path = VALIDATION_DIR / "manifest.json"
    if require_validation_artifacts:
        if not manifest_path.exists():
            errors.append("validation/manifest.json is missing")
        else:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            recorded = {item["path"]: item["sha256"] for item in manifest.get("artifacts", [])}
            current = {
                path.relative_to(PACKAGE_DIR).as_posix(): sha256_file(path)
                for path in checksum_targets()
            }
            if recorded != current:
                errors.append("validation manifest checksum set does not match package files")
            checksum_path = VALIDATION_DIR / "checksums.sha256"
            expected_lines = "\n".join(f"{digest}  {path}" for path, digest in sorted(current.items())) + "\n"
            if not checksum_path.exists() or checksum_path.read_text(encoding="utf-8") != expected_lines:
                errors.append("checksums.sha256 does not match package files")
            expected_counts = {"reports": 20, "mermaid_sources": 12, "inventories": 19, "sboms": 2}
            if manifest.get("observed_counts") != expected_counts:
                errors.append("validation manifest observed counts mismatch")
    return errors


def generate() -> None:
    head = git("rev-parse", "HEAD")
    if git("merge-base", BASELINE, head) != BASELINE:
        raise SystemExit(
            f"Refusing a source lineage that does not descend from the pinned baseline: {head}"
        )
    snapshot, source_records = implementation_snapshot()
    node_records = parse_pnpm_lock()
    python_records = parse_uv_lock()
    if len(node_records) != EXPECTED_NODE_LOCK_RECORDS:
        raise SystemExit(f"Unexpected pnpm lock record count: {len(node_records)}")
    if len(python_records) != EXPECTED_PYTHON_LOCK_RECORDS:
        raise SystemExit(f"Unexpected uv lock record count: {len(python_records)}")

    for directory in (REPORT_DIR, DIAGRAM_DIR, INVENTORY_DIR, SBOM_DIR, VALIDATION_DIR):
        directory.mkdir(parents=True, exist_ok=True)

    for spec in report_specs():
        write_text(REPORT_DIR / spec["file"], render_report(spec, snapshot))
    for filename, source in diagrams().items():
        write_text(DIAGRAM_DIR / filename, source)
    inventories = build_inventories(snapshot, node_records, python_records)
    for filename, value in inventories.items():
        write_text(INVENTORY_DIR / filename, json_dump(value))
    write_text(SBOM_DIR / "cyclonedx.json", json_dump(cyclonedx(snapshot, node_records, python_records)))
    write_text(SBOM_DIR / "spdx.json", json_dump(spdx(snapshot, node_records, python_records)))
    write_text(
        PACKAGE_DIR / "metadata.json",
        json_dump(package_metadata(snapshot, source_records, node_records, python_records)),
    )
    write_text(
        PACKAGE_DIR / "README.md",
        package_readme(snapshot, {"reports": 20, "diagrams": 12, "inventories": 19}),
    )

    pre_manifest_errors = validate_package(
        expected_snapshot=snapshot,
        require_validation_artifacts=False,
    )
    if pre_manifest_errors:
        raise SystemExit("\n".join(pre_manifest_errors))
    manifest, checksums = build_validation(snapshot)
    write_text(VALIDATION_DIR / "manifest.json", json_dump(manifest))
    write_text(VALIDATION_DIR / "checksums.sha256", checksums)
    errors = validate_package(expected_snapshot=snapshot)
    if errors:
        raise SystemExit("\n".join(errors))
    print(
        json.dumps(
            {
                "status": "PASS",
                "source_snapshot_sha256": snapshot,
                "reports": 20,
                "mermaid_sources": 12,
                "inventories": 19,
                "sboms": 2,
                "node_lock_records": len(node_records),
                "python_lock_records": len(python_records),
            },
            ensure_ascii=False,
        )
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true", help="validate without regenerating")
    args = parser.parse_args()
    if args.check:
        errors = validate_package()
        if errors:
            print("\n".join(errors), file=sys.stderr)
            raise SystemExit(1)
        metadata = json.loads((PACKAGE_DIR / "metadata.json").read_text(encoding="utf-8"))
        print(
            json.dumps(
                {
                    "status": "PASS",
                    "source_snapshot_sha256": metadata["current_evidence"]["sha256"],
                    "reports": 20,
                    "mermaid_sources": 12,
                    "inventories": 19,
                    "sboms": 2,
                },
                ensure_ascii=False,
            )
        )
        return
    generate()


if __name__ == "__main__":
    main()
