from __future__ import annotations

import hashlib
import io
import json
import os
import re
import secrets
import threading
import time
import uuid
import wave
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Annotated, Literal
from urllib.parse import urlsplit

from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from pydantic import BaseModel, Field, model_validator

from aura.claim_review import load_claims, record_claim_edit, record_claim_review
from aura.evidence_search import EvidenceSearch, rebuild_evidence_index


MAX_ITEMS = 100
MAX_SEGMENTS = 1_000
MAX_JSON_BYTES = 5_000_000
MAX_AUDIO_SPAN_MS = 60_000
MAX_AUDIO_BYTES = 20_000_000
MAX_TEXT = 8_000
ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
CORRELATION_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
GENESIS_HASH = "0" * 64
OBSERVABILITY_LOG_MAX_BYTES = 5 * 1024 * 1024
OBSERVABILITY_LOG_FILES = 2
OBSERVABILITY_EVENT_MAX_BYTES = 4 * 1024


class SafePathError(Exception):
    pass


class BridgeFailure(Exception):
    pass


def _canonical_directory(path: str | Path, *, create: bool = False) -> Path:
    candidate = Path(path).expanduser()
    if create:
        candidate.mkdir(parents=True, exist_ok=True)
    try:
        resolved = candidate.resolve(strict=True)
    except OSError as exc:
        raise ValueError("configured directory is unavailable") from exc
    if not resolved.is_dir():
        raise ValueError("configured path must be a directory")
    return resolved


def _validate_origin(origin: str) -> str:
    parsed = urlsplit(origin)
    if (
        parsed.scheme != "http"
        or parsed.hostname not in {"127.0.0.1", "localhost"}
        or parsed.username
        or parsed.password
        or parsed.path not in {"", "/"}
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError("allowed origins must be exact loopback HTTP origins")
    return f"{parsed.scheme}://{parsed.netloc}"


@dataclass(frozen=True)
class BridgeConfig:
    artifact_root: Path
    evidence_index: Path
    audit_root: Path
    export_root: Path
    launch_token: str = field(repr=False)
    allowed_origins: tuple[str, ...] = ("http://127.0.0.1:3000",)
    observability_root: Path | None = None

    def __post_init__(self) -> None:
        if len(self.launch_token) < 16:
            raise ValueError("launch token must contain at least 16 characters")
        artifact_root = _canonical_directory(self.artifact_root)
        audit_root = _canonical_directory(self.audit_root, create=True)
        export_root = _canonical_directory(self.export_root, create=True)
        observability_root = _canonical_directory(
            self.observability_root or audit_root.parent / "observability",
            create=True,
        )
        evidence_index = Path(self.evidence_index).expanduser().absolute()
        evidence_index.parent.mkdir(parents=True, exist_ok=True)
        if evidence_index.is_symlink() or evidence_index.parent.is_symlink():
            raise ValueError("evidence index cannot use symlinks")
        try:
            evidence_index.parent.chmod(0o700)
            export_root.chmod(0o700)
        except OSError:
            pass
        origins = tuple(
            dict.fromkeys(_validate_origin(item) for item in self.allowed_origins)
        )
        if not origins:
            raise ValueError("at least one exact local origin is required")
        object.__setattr__(self, "artifact_root", artifact_root)
        object.__setattr__(self, "evidence_index", evidence_index)
        object.__setattr__(self, "audit_root", audit_root)
        object.__setattr__(self, "export_root", export_root)
        object.__setattr__(self, "observability_root", observability_root)
        object.__setattr__(self, "allowed_origins", origins)


class DurationMetric(BaseModel):
    count: int
    total_ms: int
    max_ms: int
    last_ms: int


class AuraObservabilityMetrics(BaseModel):
    claim_review_count: int
    claim_review_completed_count: int
    claim_review_failure_count: int
    claim_review_confirmed_count: int
    claim_review_edited_count: int
    claim_review_rejected_count: int
    unsupported_claim_block_count: int
    evidence_search_count: int
    evidence_search_failure_count: int
    evidence_search_latency_ms: DurationMetric
    audio_span_failure_count: int
    audit_write_failure_count: int
    log_write_failure_count: int
    retention_max_bytes_per_file: int
    retention_file_count: int


class HealthResponse(BaseModel):
    status: Literal["ready", "degraded"]
    bind: Literal["127.0.0.1"]
    artifact_root_ready: bool
    evidence_index_ready: bool
    audit_ready: bool
    observability: AuraObservabilityMetrics


class SessionSummary(BaseModel):
    session_id: str
    title: str
    started_at: str
    ended_at: str
    workflow: str
    status: str
    transcript_hash_state: Literal["current", "stale", "missing"]
    summary_state: str
    reviewed_count: int
    unreviewed_count: int
    confirmed_action_count: int
    local_path_available: bool


class SessionListResponse(BaseModel):
    sessions: list[SessionSummary]


class SessionDetail(SessionSummary):
    capture_mode: str
    audio_tracks: list[str]
    segment_count: int
    claim_count: int


class SegmentResponse(BaseModel):
    segment_id: str
    start_ms: int
    end_ms: int
    text: str
    speaker: str
    state: str
    revision: int


class SegmentListResponse(BaseModel):
    segments: list[SegmentResponse]


class ClaimResponse(BaseModel):
    claim_id: str
    field: str
    text: str
    source_segment_ids: list[str]
    support_status: str
    review_status: str


class ClaimListResponse(BaseModel):
    claims: list[ClaimResponse]


class ClaimReviewRequest(BaseModel):
    decision: Literal["confirmed", "rejected", "edited"]
    edited_text: str | None = Field(default=None, max_length=MAX_TEXT)

    @model_validator(mode="after")
    def validate_edit(self) -> "ClaimReviewRequest":
        if self.decision == "edited" and not (self.edited_text or "").strip():
            raise ValueError("edited_text is required when decision is edited")
        if self.decision != "edited" and self.edited_text is not None:
            raise ValueError("edited_text is accepted only for an edited decision")
        return self


class ActionResponse(BaseModel):
    action_id: str
    meeting_id: str
    task: str
    owner: str
    deadline: str
    source_segment_ids: list[str]
    support_status: str
    review_status: str
    delegable: bool


class ActionListResponse(BaseModel):
    actions: list[ActionResponse]


class SearchResult(BaseModel):
    kind: Literal["meeting", "segment", "action"]
    meeting_id: str
    item_id: str
    title: str = ""
    text: str = ""
    start_ms: int | None = None
    end_ms: int | None = None
    evidence_refs: list[str] = Field(default_factory=list)


class SearchResponse(BaseModel):
    query: str
    results: list[SearchResult]


class AudioSpanRequest(BaseModel):
    meeting_id: str = Field(pattern=ID_PATTERN.pattern)
    start_ms: int = Field(ge=0)
    end_ms: int = Field(gt=0)
    track: str = Field(default="mixed", pattern=ID_PATTERN.pattern)

    @model_validator(mode="after")
    def validate_span(self) -> "AudioSpanRequest":
        if self.end_ms <= self.start_ms:
            raise ValueError("end_ms must be greater than start_ms")
        if self.end_ms - self.start_ms > MAX_AUDIO_SPAN_MS:
            raise ValueError("audio span exceeds the 60 second limit")
        return self


class AuditEventResponse(BaseModel):
    id: str
    timestamp: str
    actor_type: str
    actor_id: str
    action: str
    outcome: str
    correlation_id: str
    evidence_refs: list[str]
    previous_hash: str
    hash: str


class AuditTimelineResponse(BaseModel):
    events: list[AuditEventResponse]


class EvidenceExportRequest(BaseModel):
    meeting_id: str = Field(pattern=ID_PATTERN.pattern)
    format: Literal["json", "markdown"] = "json"


class EvidenceExportResponse(BaseModel):
    export_id: str
    filename: str
    sha256: str
    byte_count: int
    content_type: str
    download_url: str


def _safe_existing_file(root: Path, candidate: str | Path) -> Path:
    lexical = Path(os.path.abspath(Path(candidate).expanduser()))
    try:
        relative = lexical.relative_to(root)
    except ValueError as exc:
        raise SafePathError(
            "requested artifact is outside the configured root"
        ) from exc
    current = root
    for part in relative.parts:
        current /= part
        if current.is_symlink():
            raise SafePathError("symlink artifacts are not allowed")
    try:
        resolved = lexical.resolve(strict=True)
        resolved.relative_to(root)
    except (OSError, ValueError) as exc:
        raise SafePathError("requested artifact is unavailable") from exc
    if not resolved.is_file():
        raise SafePathError("requested artifact is not a file")
    return resolved


def _read_json(root: Path, path: Path) -> dict | list:
    safe = _safe_existing_file(root, path)
    if safe.stat().st_size > MAX_JSON_BYTES:
        raise BridgeFailure("artifact exceeds the configured read limit")
    try:
        return json.loads(safe.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise BridgeFailure("canonical artifact could not be read") from exc


def _clip(value: object, limit: int = MAX_TEXT) -> str:
    return str(value or "")[:limit]


def _event_hash(event: dict) -> str:
    payload = {key: value for key, value in event.items() if key != "hash"}
    encoded = json.dumps(
        payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode()
    return hashlib.sha256(encoded).hexdigest()


class LocalObservability:
    def __init__(self, root: Path):
        self.path = root / "aura-bridge.jsonl"
        self.previous_path = root / "aura-bridge.jsonl.1"
        self._lock = threading.Lock()
        self._metrics = {
            "claim_review_count": 0,
            "claim_review_completed_count": 0,
            "claim_review_failure_count": 0,
            "claim_review_confirmed_count": 0,
            "claim_review_edited_count": 0,
            "claim_review_rejected_count": 0,
            "unsupported_claim_block_count": 0,
            "evidence_search_count": 0,
            "evidence_search_failure_count": 0,
            "evidence_search_latency_ms": {
                "count": 0,
                "total_ms": 0,
                "max_ms": 0,
                "last_ms": 0,
            },
            "audio_span_failure_count": 0,
            "audit_write_failure_count": 0,
            "log_write_failure_count": 0,
        }

    def record(
        self, event: str, correlation_id: str, details: dict | None = None
    ) -> None:
        payload = {
            "timestamp": datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
            "component": "aura-bridge",
            "event": _clip(event, 64),
            "correlation_id": _clip(correlation_id, 160),
            "details": self._redact(details or {}),
        }
        encoded = (
            json.dumps(payload, ensure_ascii=False, sort_keys=True) + "\n"
        ).encode()
        if len(encoded) > OBSERVABILITY_EVENT_MAX_BYTES:
            payload["details"] = {"truncated": True}
            encoded = (
                json.dumps(payload, ensure_ascii=False, sort_keys=True) + "\n"
            ).encode()
        with self._lock:
            try:
                if (
                    self.path.exists()
                    and self.path.stat().st_size + len(encoded)
                    > OBSERVABILITY_LOG_MAX_BYTES
                ):
                    self.previous_path.unlink(missing_ok=True)
                    os.replace(self.path, self.previous_path)
                with self.path.open("ab") as handle:
                    handle.write(encoded)
                try:
                    self.path.chmod(0o600)
                except OSError:
                    pass
            except OSError:
                self._metrics["log_write_failure_count"] += 1

    def claim_review(
        self, correlation_id: str, decision: str, *, completed: bool
    ) -> None:
        with self._lock:
            self._metrics["claim_review_count"] += 1
            key = (
                f"claim_review_{decision}_count"
                if completed
                else "claim_review_failure_count"
            )
            self._metrics[key] += 1
            if completed:
                self._metrics["claim_review_completed_count"] += 1
        self.record(
            "claim.review",
            correlation_id,
            {"decision": decision, "completed": completed},
        )

    def unsupported_claim_block(self, correlation_id: str) -> None:
        with self._lock:
            self._metrics["unsupported_claim_block_count"] += 1
        self.record("claim.unsupported_blocked", correlation_id)

    def evidence_search(
        self, correlation_id: str, duration_ms: int, *, completed: bool
    ) -> None:
        duration_ms = max(0, round(duration_ms))
        with self._lock:
            self._metrics["evidence_search_count"] += 1
            if not completed:
                self._metrics["evidence_search_failure_count"] += 1
            metric = self._metrics["evidence_search_latency_ms"]
            metric["count"] += 1
            metric["total_ms"] += duration_ms
            metric["max_ms"] = max(metric["max_ms"], duration_ms)
            metric["last_ms"] = duration_ms
        self.record(
            "evidence.search",
            correlation_id,
            {"completed": completed, "duration_ms": duration_ms},
        )

    def audio_span_failure(self, correlation_id: str, status_code: int) -> None:
        with self._lock:
            self._metrics["audio_span_failure_count"] += 1
        self.record(
            "audio_span.failed",
            correlation_id,
            {"status_code": status_code},
        )

    def audit_write_failure(self, correlation_id: str) -> None:
        with self._lock:
            self._metrics["audit_write_failure_count"] += 1
        self.record("audit.write_failed", correlation_id)

    def snapshot(self) -> AuraObservabilityMetrics:
        with self._lock:
            payload = {
                **self._metrics,
                "evidence_search_latency_ms": {
                    **self._metrics["evidence_search_latency_ms"]
                },
                "retention_max_bytes_per_file": OBSERVABILITY_LOG_MAX_BYTES,
                "retention_file_count": OBSERVABILITY_LOG_FILES,
            }
        return AuraObservabilityMetrics.model_validate(payload)

    @staticmethod
    def _redact(value: object, key: str = "") -> object:
        if re.search(r"token|secret|password|authorization|cookie|path", key, re.I):
            return "[REDACTED]"
        if isinstance(value, dict):
            return {
                _clip(name, 64): LocalObservability._redact(item, str(name))
                for name, item in list(value.items())[:50]
            }
        if isinstance(value, list):
            return [LocalObservability._redact(item) for item in value[:50]]
        if isinstance(value, str):
            redacted = re.sub(r"\bBearer\s+\S+", "Bearer [REDACTED]", value, flags=re.I)
            return _clip(redacted, 512)
        return (
            value
            if isinstance(value, (bool, int, float)) or value is None
            else _clip(value, 512)
        )


class CorrelationAudit:
    def __init__(self, root: Path):
        self.path = root / "voiss-aura-bridge.jsonl"
        self._lock = threading.Lock()
        self._last_hash = GENESIS_HASH
        try:
            root.chmod(0o700)
        except OSError:
            pass
        if self.path.exists():
            events = self._read_verified(1)
            if events:
                self._last_hash = str(events[-1]["hash"])

    def _read_verified(self, limit: int) -> list[dict]:
        previous_hash = GENESIS_HASH
        events: deque[dict] = deque(maxlen=limit)
        try:
            with self.path.open(encoding="utf-8") as handle:
                for line in handle:
                    if not line.strip():
                        continue
                    event = json.loads(line)
                    if event.get("previous_hash") != previous_hash or event.get(
                        "hash"
                    ) != _event_hash(event):
                        raise BridgeFailure("audit integrity check failed")
                    previous_hash = str(event["hash"])
                    events.append(event)
        except (OSError, json.JSONDecodeError, KeyError) as exc:
            raise BridgeFailure("audit timeline could not be opened") from exc
        return list(events)

    def append(
        self,
        *,
        action: str,
        outcome: str,
        correlation_id: str,
        evidence_refs: list[str],
        details: dict | None = None,
    ) -> dict:
        with self._lock:
            event = {
                "id": str(uuid.uuid4()),
                "timestamp": datetime.now(timezone.utc).isoformat(
                    timespec="milliseconds"
                ),
                "actor_type": "user",
                "actor_id": "local-operator",
                "action": action,
                "outcome": outcome,
                "correlation_id": correlation_id,
                "evidence_refs": [_clip(item, 256) for item in evidence_refs[:20]],
                "details": {
                    str(key)[:64]: (
                        value
                        if isinstance(value, (bool, int, float))
                        else _clip(value, 256)
                    )
                    for key, value in (details or {}).items()
                    if not any(
                        secret in str(key).lower()
                        for secret in ("token", "secret", "path")
                    )
                },
                "previous_hash": self._last_hash,
            }
            event["hash"] = _event_hash(event)
            try:
                with self.path.open("a", encoding="utf-8") as handle:
                    handle.write(
                        json.dumps(event, ensure_ascii=False, sort_keys=True) + "\n"
                    )
                    handle.flush()
                    os.fsync(handle.fileno())
                try:
                    self.path.chmod(0o600)
                except OSError:
                    pass
            except OSError as exc:
                raise BridgeFailure("audit event could not be recorded") from exc
            self._last_hash = event["hash"]
            return event

    def latest(self, limit: int) -> list[dict]:
        if not self.path.exists():
            return []
        with self._lock:
            return self._read_verified(limit)


class BridgeStore:
    def __init__(self, config: BridgeConfig):
        self.config = config
        self.observability = LocalObservability(config.observability_root)
        self.audit = CorrelationAudit(config.audit_root)

    def append_audit(self, **event) -> dict:
        try:
            return self.audit.append(**event)
        except BridgeFailure:
            self.observability.audit_write_failure(
                str(event.get("correlation_id") or "unknown")
            )
            raise

    def _session_files(self) -> dict[str, Path]:
        sessions: dict[str, Path] = {}
        for path in self.config.artifact_root.rglob("session.json"):
            try:
                safe = _safe_existing_file(self.config.artifact_root, path)
                payload = _read_json(self.config.artifact_root, safe)
            except (SafePathError, BridgeFailure):
                continue
            meeting_id = _clip(
                payload.get("meeting_id") if isinstance(payload, dict) else ""
            )
            if not ID_PATTERN.fullmatch(meeting_id):
                continue
            if meeting_id in sessions:
                raise BridgeFailure("duplicate meeting identity in artifact root")
            sessions[meeting_id] = safe
        return sessions

    def session_dir(self, meeting_id: str) -> Path:
        if not ID_PATTERN.fullmatch(meeting_id):
            raise HTTPException(status_code=404, detail="session not found")
        path = self._session_files().get(meeting_id)
        if path is None:
            raise HTTPException(status_code=404, detail="session not found")
        return path.parent

    def manifest(self, meeting_id: str) -> tuple[Path, dict]:
        directory = self.session_dir(meeting_id)
        payload = _read_json(self.config.artifact_root, directory / "session.json")
        if not isinstance(payload, dict):
            raise BridgeFailure("session manifest has an invalid shape")
        return directory, payload

    def segments(self, meeting_id: str) -> list[dict]:
        directory = self.session_dir(meeting_id)
        path = directory / "segments.json"
        if not path.exists():
            return []
        payload = _read_json(self.config.artifact_root, path)
        rows = payload.get("segments", []) if isinstance(payload, dict) else payload
        if not isinstance(rows, list):
            raise BridgeFailure("segments artifact has an invalid shape")
        return [dict(item) for item in rows[:MAX_SEGMENTS] if isinstance(item, dict)]

    def claims(self, meeting_id: str) -> list[dict]:
        directory = self.session_dir(meeting_id)
        if not (directory / "summary.json").exists():
            return []
        _read_json(self.config.artifact_root, directory / "summary.json")
        review_events = directory / "review_events.jsonl"
        if review_events.exists():
            safe = _safe_existing_file(self.config.artifact_root, review_events)
            if safe.stat().st_size > MAX_JSON_BYTES:
                raise BridgeFailure("review history exceeds the configured read limit")
        try:
            return load_claims(directory)[:MAX_ITEMS]
        except (OSError, ValueError) as exc:
            raise BridgeFailure("claims could not be read") from exc

    def session_summary(self, meeting_id: str) -> SessionSummary:
        _, manifest = self.manifest(meeting_id)
        claims = self.claims(meeting_id)
        summary_path = self.session_dir(meeting_id) / "summary.json"
        summary = (
            _read_json(self.config.artifact_root, summary_path)
            if summary_path.exists()
            else {}
        )
        summary_hash = (
            summary.get("transcript_sha256") if isinstance(summary, dict) else None
        )
        transcript_hash = manifest.get("transcript_sha256")
        if not summary:
            hash_state = "missing"
        elif (
            manifest.get("summary_status") == "invalidated"
            or summary_hash != transcript_hash
        ):
            hash_state = "stale"
        else:
            hash_state = "current"
        confirmed_actions = (
            sum(
                claim.get("field") == "action_items"
                and claim.get("review_status") == "confirmed"
                and claim.get("support_status") == "supported"
                and bool(claim.get("source_segment_ids"))
                for claim in claims
            )
            if hash_state == "current"
            else 0
        )
        return SessionSummary(
            session_id=meeting_id,
            title=_clip(
                manifest.get("title") or self.session_dir(meeting_id).name, 240
            ),
            started_at=_clip(manifest.get("started_at"), 64),
            ended_at=_clip(manifest.get("ended_at"), 64),
            workflow=_clip(
                manifest.get("workflow") or manifest.get("capture_mode"), 64
            ),
            status=_clip(manifest.get("status"), 64),
            transcript_hash_state=hash_state,
            summary_state=_clip(
                manifest.get("summary_status") or ("ready" if summary else "missing"),
                64,
            ),
            reviewed_count=sum(
                claim.get("review_status") != "unreviewed" for claim in claims
            ),
            unreviewed_count=sum(
                claim.get("review_status") == "unreviewed" for claim in claims
            ),
            confirmed_action_count=confirmed_actions,
            local_path_available=True,
        )

    def refresh_index(self) -> None:
        # ponytail: rebuild on demand; add an mtime cache only when corpus latency is measurable.
        try:
            rebuild_evidence_index(
                self.config.artifact_root, self.config.evidence_index
            )
            try:
                self.config.evidence_index.chmod(0o600)
            except OSError:
                pass
        except (OSError, ValueError) as exc:
            raise BridgeFailure("evidence index could not be rebuilt") from exc

    def actions(self, meeting_id: str | None = None) -> list[ActionResponse]:
        self.refresh_index()
        try:
            with EvidenceSearch(self.config.evidence_index) as evidence:
                rows = evidence.get_actions(meeting_id)
        except (OSError, ValueError) as exc:
            raise BridgeFailure("actions could not be read") from exc
        return [
            ActionResponse(
                action_id=_clip(row.get("action_id"), 128),
                meeting_id=_clip(row.get("meeting_id"), 128),
                task=_clip(row.get("task")),
                owner=_clip(row.get("owner"), 240),
                deadline=_clip(row.get("deadline"), 64),
                source_segment_ids=[
                    _clip(item, 128)
                    for item in row.get("source_segment_ids", [])[:MAX_ITEMS]
                ],
                support_status=_clip(row.get("support_status"), 64),
                review_status=_clip(row.get("review_status"), 64),
                delegable=(
                    row.get("review_status") == "confirmed"
                    and row.get("support_status") == "supported"
                    and bool(row.get("source_segment_ids"))
                ),
            )
            for row in rows[:MAX_ITEMS]
        ]

    def validated_audio_path(self, request: AudioSpanRequest) -> Path:
        directory, manifest = self.manifest(request.meeting_id)
        tracks = manifest.get("audio_tracks")
        if not isinstance(tracks, dict) or request.track not in tracks:
            raise HTTPException(status_code=404, detail="audio track not found")
        value = tracks[request.track]
        path_value = value.get("path") if isinstance(value, dict) else value
        candidate = Path(str(path_value))
        if not candidate.is_absolute():
            candidate = directory / candidate
        prevalidated = _safe_existing_file(self.config.artifact_root, candidate)
        self.refresh_index()
        try:
            with EvidenceSearch(self.config.evidence_index) as evidence:
                span = evidence.open_audio_span(
                    request.meeting_id,
                    request.start_ms,
                    request.end_ms,
                    request.track,
                )
            indexed = _safe_existing_file(self.config.artifact_root, span["path"])
        except (OSError, ValueError, KeyError) as exc:
            raise BridgeFailure("audio evidence could not be opened") from exc
        if indexed != prevalidated:
            raise SafePathError("indexed audio identity does not match the session")
        return indexed


def _wav_span(path: Path, start_ms: int, end_ms: int) -> bytes:
    try:
        with wave.open(str(path), "rb") as source:
            rate = source.getframerate()
            start_frame = min(source.getnframes(), int(rate * start_ms / 1000))
            end_frame = min(source.getnframes(), int(rate * end_ms / 1000))
            if end_frame <= start_frame:
                raise HTTPException(
                    status_code=416, detail="audio span is outside the file"
                )
            source.setpos(start_frame)
            frames = source.readframes(end_frame - start_frame)
            output = io.BytesIO()
            with wave.open(output, "wb") as target:
                target.setparams(
                    (
                        source.getnchannels(),
                        source.getsampwidth(),
                        rate,
                        0,
                        source.getcomptype(),
                        source.getcompname(),
                    )
                )
                target.writeframes(frames)
    except wave.Error as exc:
        raise HTTPException(
            status_code=415, detail="validated WAV spans are required"
        ) from exc
    payload = output.getvalue()
    if len(payload) > MAX_AUDIO_BYTES:
        raise HTTPException(
            status_code=413, detail="audio response exceeds the output limit"
        )
    return payload


def _claim_model(item: dict) -> ClaimResponse:
    return ClaimResponse(
        claim_id=_clip(item.get("claim_id"), 128),
        field=_clip(item.get("field"), 64),
        text=_clip(item.get("text")),
        source_segment_ids=[
            _clip(value, 128)
            for value in item.get("source_segment_ids", [])[:MAX_ITEMS]
        ],
        support_status=_clip(item.get("support_status") or "unsupported", 64),
        review_status=_clip(item.get("review_status") or "unreviewed", 64),
    )


def create_app(config: BridgeConfig) -> FastAPI:
    store = BridgeStore(config)

    async def require_token(
        authorization: Annotated[str | None, Header()] = None,
    ) -> None:
        scheme, _, supplied = (authorization or "").partition(" ")
        if scheme.lower() != "bearer" or not secrets.compare_digest(
            supplied, config.launch_token
        ):
            raise HTTPException(
                status_code=401, detail="valid bridge bearer token required"
            )

    app = FastAPI(
        title="VOISS AURA Bridge",
        version="0.1.0",
        dependencies=[Depends(require_token)],
    )
    app.state.store = store
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(config.allowed_origins),
        allow_credentials=False,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type", "X-Correlation-ID"],
        expose_headers=["X-Correlation-ID", "X-Content-SHA256"],
    )

    @app.middleware("http")
    async def trust_boundary(request: Request, call_next):
        origin = request.headers.get("origin")
        correlation = request.headers.get("x-correlation-id") or str(uuid.uuid4())
        if not CORRELATION_PATTERN.fullmatch(correlation):
            correlation = str(uuid.uuid4())
        request.state.correlation_id = correlation
        started_ns = time.perf_counter_ns()
        if origin and origin not in config.allowed_origins:
            return JSONResponse(
                status_code=403,
                content={"detail": "origin is outside the local bridge allowlist"},
                headers={"X-Correlation-ID": correlation},
            )
        try:
            response = await call_next(request)
        except Exception:
            if request.url.path == "/v1/evidence/audio-span":
                store.observability.audio_span_failure(correlation, 500)
            if request.url.path == "/v1/evidence/search":
                store.observability.evidence_search(
                    correlation,
                    (time.perf_counter_ns() - started_ns) // 1_000_000,
                    completed=False,
                )
            raise
        if (
            request.url.path == "/v1/evidence/audio-span"
            and response.status_code >= 400
        ):
            store.observability.audio_span_failure(correlation, response.status_code)
        if request.url.path == "/v1/evidence/search":
            store.observability.evidence_search(
                correlation,
                (time.perf_counter_ns() - started_ns) // 1_000_000,
                completed=response.status_code < 400,
            )
        response.headers["X-Correlation-ID"] = correlation
        return response

    @app.exception_handler(SafePathError)
    async def safe_path_error(request: Request, _exc: SafePathError):
        return JSONResponse(
            status_code=403,
            content={
                "detail": "artifact path is outside the configured trust boundary",
                "correlation_id": request.state.correlation_id,
            },
        )

    @app.exception_handler(BridgeFailure)
    async def bridge_failure(request: Request, _exc: BridgeFailure):
        return JSONResponse(
            status_code=500,
            content={
                "detail": "bridge operation could not be completed",
                "correlation_id": request.state.correlation_id,
            },
        )

    @app.exception_handler(Exception)
    async def unexpected_failure(request: Request, exc: Exception):
        try:
            store.append_audit(
                action="bridge.request_failed",
                outcome="failure",
                correlation_id=request.state.correlation_id,
                evidence_refs=[],
                details={"error_class": type(exc).__name__},
            )
        except BridgeFailure:
            pass
        return JSONResponse(
            status_code=500,
            content={
                "detail": "bridge operation could not be completed",
                "correlation_id": request.state.correlation_id,
            },
        )

    @app.get("/v1/health", response_model=HealthResponse)
    def health() -> HealthResponse:
        return HealthResponse(
            status="ready" if os.access(config.artifact_root, os.R_OK) else "degraded",
            bind="127.0.0.1",
            artifact_root_ready=os.access(config.artifact_root, os.R_OK),
            evidence_index_ready=config.evidence_index.is_file(),
            audit_ready=os.access(config.audit_root, os.W_OK),
            observability=store.observability.snapshot(),
        )

    @app.get("/v1/sessions", response_model=SessionListResponse)
    def sessions(
        limit: Annotated[int, Query(ge=1, le=MAX_ITEMS)] = MAX_ITEMS,
    ) -> SessionListResponse:
        # ponytail: rescan the local corpus; cache only when session count affects latency.
        rows = [store.session_summary(item) for item in store._session_files()]
        rows.sort(key=lambda item: (item.started_at, item.session_id), reverse=True)
        return SessionListResponse(sessions=rows[:limit])

    @app.get("/v1/sessions/{session_id}", response_model=SessionDetail)
    def session_detail(session_id: str) -> SessionDetail:
        directory, manifest = store.manifest(session_id)
        summary = store.session_summary(session_id)
        segments = store.segments(session_id)
        claims = store.claims(session_id)
        tracks = (
            manifest.get("audio_tracks")
            if isinstance(manifest.get("audio_tracks"), dict)
            else {}
        )
        return SessionDetail(
            **summary.model_dump(),
            capture_mode=_clip(manifest.get("capture_mode"), 64),
            audio_tracks=sorted(_clip(name, 64) for name in tracks)[:20],
            segment_count=len(segments),
            claim_count=len(claims),
        )

    @app.get("/v1/sessions/{session_id}/segments", response_model=SegmentListResponse)
    def segments(
        session_id: str,
        limit: Annotated[int, Query(ge=1, le=MAX_SEGMENTS)] = MAX_SEGMENTS,
    ) -> SegmentListResponse:
        return SegmentListResponse(
            segments=[
                SegmentResponse(
                    segment_id=_clip(row.get("segment_id"), 128),
                    start_ms=max(0, int(row.get("start_ms") or 0)),
                    end_ms=max(0, int(row.get("end_ms") or 0)),
                    text=_clip(row.get("text")),
                    speaker=_clip(row.get("speaker"), 240),
                    state=_clip(row.get("state"), 64),
                    revision=max(0, int(row.get("revision") or 0)),
                )
                for row in store.segments(session_id)[:limit]
            ]
        )

    @app.get("/v1/sessions/{session_id}/claims", response_model=ClaimListResponse)
    def claims(session_id: str) -> ClaimListResponse:
        return ClaimListResponse(
            claims=[_claim_model(item) for item in store.claims(session_id)]
        )

    @app.post(
        "/v1/sessions/{session_id}/claims/{claim_id}/review",
        response_model=ClaimResponse,
    )
    def review_claim(
        session_id: str,
        claim_id: str,
        payload: ClaimReviewRequest,
        request: Request,
    ) -> ClaimResponse:
        directory = store.session_dir(session_id)
        _read_json(config.artifact_root, directory / "summary.json")
        review_events = directory / "review_events.jsonl"
        if review_events.exists() or review_events.is_symlink():
            _safe_existing_file(config.artifact_root, review_events)
        current = next(
            (
                item
                for item in store.claims(session_id)
                if str(item.get("claim_id") or "") == claim_id
            ),
            None,
        )
        unsupported = payload.decision == "confirmed" and bool(
            current
            and (
                current.get("support_status") == "unsupported"
                or not current.get("source_segment_ids")
            )
        )
        try:
            if payload.decision == "edited":
                result = record_claim_edit(
                    directory,
                    claim_id,
                    payload.edited_text or "",
                    correlation_id=request.state.correlation_id,
                )
            else:
                result = record_claim_review(
                    directory,
                    claim_id,
                    payload.decision,
                    correlation_id=request.state.correlation_id,
                )
        except KeyError as exc:
            store.observability.claim_review(
                request.state.correlation_id, payload.decision, completed=False
            )
            raise HTTPException(status_code=404, detail="claim not found") from exc
        except ValueError as exc:
            store.observability.claim_review(
                request.state.correlation_id, payload.decision, completed=False
            )
            if unsupported:
                store.observability.unsupported_claim_block(
                    request.state.correlation_id
                )
            raise HTTPException(
                status_code=409,
                detail="claim decision requires current source evidence and a valid transition",
            ) from exc
        store.observability.claim_review(
            request.state.correlation_id, payload.decision, completed=True
        )
        store.append_audit(
            action=f"claim.{payload.decision}",
            outcome="success",
            correlation_id=request.state.correlation_id,
            evidence_refs=[f"aura-claim:{session_id}/{claim_id}"],
        )
        return _claim_model(result)

    @app.get("/v1/actions", response_model=ActionListResponse)
    def actions(meeting_id: str | None = None) -> ActionListResponse:
        if meeting_id is not None:
            store.session_dir(meeting_id)
        return ActionListResponse(actions=store.actions(meeting_id))

    @app.get("/v1/evidence/search", response_model=SearchResponse)
    def search(
        q: Annotated[str, Query(min_length=1, max_length=240)],
        scope: Literal["meetings", "segments", "actions", "all"] = "all",
        limit: Annotated[int, Query(ge=1, le=MAX_ITEMS)] = 20,
    ) -> SearchResponse:
        store.refresh_index()
        results: list[SearchResult] = []
        try:
            with EvidenceSearch(config.evidence_index) as evidence:
                if scope in {"meetings", "all"}:
                    results.extend(
                        SearchResult(
                            kind="meeting",
                            meeting_id=_clip(row.get("meeting_id"), 128),
                            item_id=_clip(row.get("meeting_id"), 128),
                            title=_clip(row.get("title"), 240),
                            text=_clip(row.get("matched_text")),
                            evidence_refs=[f"aura-session:{row.get('meeting_id')}"],
                        )
                        for row in evidence.search_meetings(q, limit)
                    )
                if scope in {"segments", "all"}:
                    results.extend(
                        SearchResult(
                            kind="segment",
                            meeting_id=_clip(row.get("meeting_id"), 128),
                            item_id=_clip(row.get("segment_id"), 128),
                            text=_clip(row.get("text")),
                            start_ms=int(row.get("start_ms") or 0),
                            end_ms=int(row.get("end_ms") or 0),
                            evidence_refs=[
                                f"aura-segment:{row.get('meeting_id')}/{row.get('segment_id')}"
                            ],
                        )
                        for row in evidence.search_segments(q, limit)
                    )
                if scope in {"actions", "all"}:
                    query = q.casefold()
                    results.extend(
                        SearchResult(
                            kind="action",
                            meeting_id=_clip(row.get("meeting_id"), 128),
                            item_id=_clip(row.get("action_id"), 128),
                            text=_clip(row.get("task")),
                            evidence_refs=[
                                f"aura-action:{row.get('meeting_id')}/{row.get('action_id')}"
                            ],
                        )
                        for row in evidence.get_confirmed_actions()
                        if query in _clip(row.get("task")).casefold()
                        or query in _clip(row.get("owner")).casefold()
                    )
        except (OSError, ValueError) as exc:
            raise BridgeFailure("evidence search could not be completed") from exc
        return SearchResponse(query=q, results=results[:limit])

    @app.post("/v1/evidence/audio-span")
    def audio_span(payload: AudioSpanRequest, request: Request):
        path = store.validated_audio_path(payload)
        content = _wav_span(path, payload.start_ms, payload.end_ms)
        store.append_audit(
            action="evidence.audio_span_opened",
            outcome="success",
            correlation_id=request.state.correlation_id,
            evidence_refs=[f"aura-session:{payload.meeting_id}"],
            details={
                "start_ms": payload.start_ms,
                "end_ms": payload.end_ms,
                "track": payload.track,
            },
        )
        digest = hashlib.sha256(content).hexdigest()
        return StreamingResponse(
            iter([content]),
            media_type="audio/wav",
            headers={
                "Content-Disposition": 'inline; filename="audio-span.wav"',
                "X-Content-SHA256": digest,
                "X-Audio-Start-Ms": str(payload.start_ms),
                "X-Audio-End-Ms": str(payload.end_ms),
            },
        )

    @app.get("/v1/audit/events", response_model=AuditTimelineResponse)
    def audit_events(
        limit: Annotated[int, Query(ge=1, le=MAX_ITEMS)] = MAX_ITEMS,
    ) -> AuditTimelineResponse:
        return AuditTimelineResponse(
            events=[
                AuditEventResponse.model_validate(item)
                for item in store.audit.latest(limit)
            ]
        )

    @app.post("/v1/evidence/export", response_model=EvidenceExportResponse)
    def export_evidence(
        payload: EvidenceExportRequest,
        request: Request,
    ) -> EvidenceExportResponse:
        summary = store.session_summary(payload.meeting_id)
        segments_payload = [
            SegmentResponse(
                segment_id=_clip(row.get("segment_id"), 128),
                start_ms=int(row.get("start_ms") or 0),
                end_ms=int(row.get("end_ms") or 0),
                text=_clip(row.get("text")),
                speaker=_clip(row.get("speaker"), 240),
                state=_clip(row.get("state"), 64),
                revision=int(row.get("revision") or 0),
            ).model_dump()
            for row in store.segments(payload.meeting_id)
        ]
        claims_payload = [
            _claim_model(item).model_dump() for item in store.claims(payload.meeting_id)
        ]
        actions_payload = [
            item.model_dump() for item in store.actions(payload.meeting_id)
        ]
        packet = {
            "schema_version": 1,
            "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "session": summary.model_dump(),
            "segments": segments_payload,
            "claims": claims_payload,
            "actions": actions_payload,
            "evidence_refs": [
                f"aura-session:{payload.meeting_id}",
                *[
                    f"aura-segment:{payload.meeting_id}/{item['segment_id']}"
                    for item in segments_payload
                ],
            ],
        }
        if payload.format == "json":
            content = (
                json.dumps(packet, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
            ).encode()
            suffix, content_type = ".json", "application/json"
        else:
            content = (
                f"# AURA Evidence Packet — {summary.title}\n\n"
                f"- Session: `{payload.meeting_id}`\n"
                f"- Generated: `{packet['generated_at']}`\n"
                f"- Transcript state: `{summary.transcript_hash_state}`\n"
                f"- Claims: `{len(claims_payload)}`\n"
                f"- Actions: `{len(actions_payload)}`\n\n"
                "## Evidence references\n\n"
                + "\n".join(f"- `{item}`" for item in packet["evidence_refs"])
                + "\n"
            ).encode()
            suffix, content_type = ".md", "text/markdown"
        if len(content) > MAX_JSON_BYTES:
            raise HTTPException(
                status_code=413, detail="evidence export exceeds the output limit"
            )
        export_id = str(uuid.uuid4())
        filename = f"{export_id}{suffix}"
        target = config.export_root / filename
        temporary = config.export_root / f".{filename}.tmp"
        try:
            with temporary.open("xb") as handle:
                handle.write(content)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, target)
            try:
                target.chmod(0o600)
            except OSError:
                pass
        except OSError as exc:
            temporary.unlink(missing_ok=True)
            raise BridgeFailure("evidence export could not be written") from exc
        digest = hashlib.sha256(content).hexdigest()
        store.append_audit(
            action="evidence.exported",
            outcome="success",
            correlation_id=request.state.correlation_id,
            evidence_refs=[f"aura-session:{payload.meeting_id}", f"export:{export_id}"],
            details={
                "format": payload.format,
                "byte_count": len(content),
                "sha256": digest,
            },
        )
        return EvidenceExportResponse(
            export_id=export_id,
            filename=filename,
            sha256=digest,
            byte_count=len(content),
            content_type=content_type,
            download_url=f"/v1/evidence/exports/{export_id}",
        )

    @app.get("/v1/evidence/exports/{export_id}")
    def download_export(export_id: str):
        if not ID_PATTERN.fullmatch(export_id):
            raise HTTPException(status_code=404, detail="export not found")
        matches = list(config.export_root.glob(f"{export_id}.*"))
        if len(matches) != 1:
            raise HTTPException(status_code=404, detail="export not found")
        path = _safe_existing_file(config.export_root, matches[0])
        media_type = "application/json" if path.suffix == ".json" else "text/markdown"
        return FileResponse(path, media_type=media_type, filename=path.name)

    return app
