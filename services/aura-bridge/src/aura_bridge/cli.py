from __future__ import annotations

import argparse
import os
from pathlib import Path

import uvicorn

from aura_bridge.app import BridgeConfig, create_app


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Run the loopback-only VOISS AURA Bridge."
    )
    parser.add_argument(
        "--artifact-root",
        default=os.environ.get("AURA_ARTIFACT_ROOT"),
        help="Canonical AURA artifact root (AURA_ARTIFACT_ROOT).",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=int(os.environ.get("AURA_BRIDGE_PORT", "8765")),
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    if not args.artifact_root:
        raise SystemExit("AURA_ARTIFACT_ROOT or --artifact-root is required")
    token = os.environ.get("AURA_BRIDGE_TOKEN", "")
    if len(token) < 16:
        raise SystemExit("AURA_BRIDGE_TOKEN must contain at least 16 characters")
    if not 1 <= args.port <= 65535:
        raise SystemExit("AURA_BRIDGE_PORT must be between 1 and 65535")
    root = Path(args.artifact_root).expanduser()
    state_root = root / ".voiss-aura"
    configured_origins = (
        os.environ.get("AURA_ALLOWED_ORIGINS")
        or os.environ.get("VOISS_ALLOWED_ORIGINS")
        or "http://127.0.0.1:3000"
    )
    origins = tuple(
        item.strip() for item in configured_origins.split(",") if item.strip()
    )
    config = BridgeConfig(
        artifact_root=root,
        evidence_index=Path(
            os.environ.get("AURA_EVIDENCE_INDEX", state_root / "evidence.sqlite3")
        ),
        audit_root=Path(os.environ.get("AURA_AUDIT_ROOT", state_root / "audit")),
        export_root=Path(os.environ.get("VOISS_EXPORT_ROOT", state_root / "exports")),
        launch_token=token,
        allowed_origins=origins,
    )
    uvicorn.run(create_app(config), host="127.0.0.1", port=args.port, log_config=None)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
