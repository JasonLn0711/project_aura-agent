from __future__ import annotations

import datetime
import json
import re
from pathlib import Path

from aura.review import _atomic_write


CLAIM_REVIEW_STATUSES = {"unreviewed", "confirmed", "rejected", "edited"}
CORRELATION_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$")


def _summary_claims(session_dir: Path) -> list[dict]:
    try:
        payload = json.loads((session_dir / "summary.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"Cannot read summary claims from {session_dir}") from exc
    claims = payload.get("claims", []) if isinstance(payload, dict) else []
    if not isinstance(claims, list):
        raise ValueError("summary.json claims must be a list")
    return [dict(claim) for claim in claims if isinstance(claim, dict)]


def _review_overrides(session_dir: Path) -> dict[str, dict[str, str]]:
    path = session_dir / "review_events.jsonl"
    if not path.exists():
        return {}
    overrides = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError as exc:
            raise ValueError(f"Invalid review event in {path}") from exc
        claim_id = str(event.get("claim_id") or "")
        changes = event.get("changes", {})
        if not claim_id or not isinstance(changes, dict):
            continue
        override = overrides.setdefault(claim_id, {})
        status = changes.get("review_status", {}).get("to")
        text = changes.get("text", {}).get("to")
        if status in CLAIM_REVIEW_STATUSES:
            override["review_status"] = status
        if isinstance(text, str) and text.strip():
            override["text"] = text.strip()
    return overrides


def load_claims(session_dir: str | Path) -> list[dict]:
    directory = Path(session_dir)
    overrides = _review_overrides(directory)
    claims = _summary_claims(directory)
    for claim in claims:
        claim_id = str(claim.get("claim_id") or "")
        claim["review_status"] = "unreviewed"
        claim.update(overrides.get(claim_id, {}))
    return claims


def _append_event(session_dir: Path, event: dict) -> None:
    path = session_dir / "review_events.jsonl"
    existing = path.read_text(encoding="utf-8") if path.exists() else ""
    _atomic_write(
        path,
        existing + json.dumps(event, ensure_ascii=False, sort_keys=True) + "\n",
    )


def _correlation(correlation_id: str | None) -> dict[str, str]:
    if correlation_id is None:
        return {}
    if not CORRELATION_ID_PATTERN.fullmatch(correlation_id):
        raise ValueError("invalid claim review correlation id")
    return {"correlation_id": correlation_id}


def _require_current_evidence(session_dir: Path, claim: dict) -> None:
    try:
        session = json.loads(
            (session_dir / "session.json").read_text(encoding="utf-8")
        )
        summary = json.loads(
            (session_dir / "summary.json").read_text(encoding="utf-8")
        )
        segments_payload = json.loads(
            (session_dir / "segments.json").read_text(encoding="utf-8")
        )
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError("Claim confirmation requires current session evidence") from exc
    if not isinstance(session, dict) or not isinstance(summary, dict):
        raise ValueError("Claim confirmation requires current session evidence")
    session_hash = str(session.get("transcript_sha256") or "")
    summary_hash = str(summary.get("transcript_sha256") or "")
    if not session_hash or summary_hash != session_hash:
        raise ValueError("Claim evidence transcript hash is stale")
    rows = (
        segments_payload.get("segments", [])
        if isinstance(segments_payload, dict)
        else segments_payload
    )
    if not isinstance(rows, list):
        raise ValueError("Claim confirmation requires current session segments")
    current_segment_ids = {
        str(item.get("segment_id"))
        for item in rows
        if isinstance(item, dict) and item.get("segment_id")
    }
    source_segment_ids = claim.get("source_segment_ids")
    if not isinstance(source_segment_ids, list) or not source_segment_ids:
        raise ValueError("A claim needs source evidence before confirmation")
    if any(
        not isinstance(segment_id, str)
        or not segment_id
        or segment_id not in current_segment_ids
        for segment_id in source_segment_ids
    ):
        raise ValueError("Claim source segment is missing from the current session")


def record_claim_review(
    session_dir: str | Path,
    claim_id: str,
    review_status: str,
    correlation_id: str | None = None,
) -> dict:
    if review_status not in {"confirmed", "rejected"}:
        raise ValueError(f"unsupported claim review status: {review_status}")
    directory = Path(session_dir)
    claims = load_claims(directory)
    claim = next(
        (item for item in claims if str(item.get("claim_id") or "") == claim_id),
        None,
    )
    if claim is None:
        raise KeyError(claim_id)
    if review_status == "confirmed":
        if (
            claim.get("support_status") == "unsupported"
            or not claim.get("source_segment_ids")
        ):
            raise ValueError("A claim needs source evidence before confirmation")
        _require_current_evidence(directory, claim)
    previous = str(claim.get("review_status") or "unreviewed")
    if previous == review_status:
        return claim
    event = {
        "timestamp": datetime.datetime.now().astimezone().isoformat(timespec="seconds"),
        "event": f"claim.{review_status}",
        "claim_id": claim_id,
        **_correlation(correlation_id),
        "changes": {
            "review_status": {
                "from": previous,
                "to": review_status,
            }
        },
    }
    _append_event(directory, event)
    claim["review_status"] = review_status
    return claim


def record_claim_edit(
    session_dir: str | Path,
    claim_id: str,
    text: str,
    correlation_id: str | None = None,
) -> dict:
    replacement = str(text).strip()
    if not replacement:
        raise ValueError("claim text is required")
    directory = Path(session_dir)
    claim = next(
        (
            item
            for item in load_claims(directory)
            if str(item.get("claim_id") or "") == claim_id
        ),
        None,
    )
    if claim is None:
        raise KeyError(claim_id)
    previous = str(claim.get("text") or "")
    if previous == replacement:
        return claim
    previous_status = str(claim.get("review_status") or "unreviewed")
    _append_event(
        directory,
        {
            "timestamp": datetime.datetime.now()
            .astimezone()
            .isoformat(timespec="seconds"),
            "event": "claim.edited",
            "claim_id": claim_id,
            **_correlation(correlation_id),
            "changes": {
                "text": {"from": previous, "to": replacement},
                "review_status": {"from": previous_status, "to": "edited"},
            },
        },
    )
    claim["text"] = replacement
    claim["review_status"] = "edited"
    return claim
