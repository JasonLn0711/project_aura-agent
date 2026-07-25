from __future__ import annotations

import hashlib
import io
import json
import math
import struct
import wave
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from aura_bridge.app import (
    OBSERVABILITY_LOG_MAX_BYTES,
    BridgeConfig,
    BridgeFailure,
    create_app,
)
from aura_bridge.cli import main as cli_main


TOKEN = "test-launch-token-123456"
ORIGIN = "http://127.0.0.1:3000"
AUTH = {"Authorization": f"Bearer {TOKEN}", "Origin": ORIGIN}


def test_cli_supports_generic_allowed_origin_alias(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    captured: dict[str, object] = {}
    monkeypatch.setenv("AURA_ARTIFACT_ROOT", str(tmp_path))
    monkeypatch.setenv("AURA_BRIDGE_TOKEN", TOKEN)
    monkeypatch.delenv("AURA_ALLOWED_ORIGINS", raising=False)
    monkeypatch.setenv("VOISS_ALLOWED_ORIGINS", "http://127.0.0.1:3123")
    monkeypatch.setattr(
        "aura_bridge.cli.uvicorn.run",
        lambda app, **options: captured.update(app=app, options=options),
    )

    assert cli_main([]) == 0
    app = captured["app"]
    assert getattr(app, "state").store.config.allowed_origins == (
        "http://127.0.0.1:3123",
    )


def _write_wav(path: Path, seconds: float = 1.0, rate: int = 8_000) -> None:
    samples = [
        int(8_000 * math.sin(2 * math.pi * 440 * index / rate))
        for index in range(int(rate * seconds))
    ]
    with wave.open(str(path), "wb") as target:
        target.setnchannels(1)
        target.setsampwidth(2)
        target.setframerate(rate)
        target.writeframes(b"".join(struct.pack("<h", sample) for sample in samples))


def _fixture(root: Path) -> Path:
    session = root / "demo-session"
    session.mkdir()
    _write_wav(session / "demo.wav")
    (session / "session.json").write_text(
        json.dumps(
            {
                "schema_version": 1,
                "meeting_id": "meeting-001",
                "title": "VOISS 架構會議",
                "status": "ready",
                "workflow": "recording",
                "capture_mode": "mixed",
                "started_at": "2026-07-24T09:00:00+08:00",
                "ended_at": "2026-07-24T09:10:00+08:00",
                "transcript_sha256": "current-hash",
                "summary_status": "ready",
                "audio_tracks": {"mixed": "demo.wav"},
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    (session / "segments.json").write_text(
        json.dumps(
            {
                "schema_version": 1,
                "meeting_id": "meeting-001",
                "audio_path": str((session / "demo.wav").resolve()),
                "segments": [
                    {
                        "segment_id": "seg-001",
                        "start_ms": 100,
                        "end_ms": 300,
                        "text": "即時 ASR queue 目前沒有上限。",
                        "speaker": "Max",
                        "state": "confirmed",
                        "revision": 1,
                    },
                    {
                        "segment_id": "seg-002",
                        "start_ms": 300,
                        "end_ms": 500,
                        "text": "我們會保留 durable audio。",
                        "speaker": "Jason",
                        "state": "final",
                        "revision": 1,
                    },
                ],
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    (session / "summary.json").write_text(
        json.dumps(
            {
                "meeting_id": "meeting-001",
                "transcript_sha256": "current-hash",
                "summary": {
                    "meeting_topic": "VOISS 架構會議",
                    "action_items": [
                        {
                            "task": "加入 bounded queue",
                            "owner": "Jason",
                            "deadline": "2026-07-31",
                        },
                        {
                            "task": "無來源動作",
                            "owner": "",
                            "deadline": "",
                        },
                    ],
                },
                "claims": [
                    {
                        "claim_id": "action-supported",
                        "field": "action_items",
                        "text": "加入 bounded queue",
                        "source_segment_ids": ["seg-001", "seg-002"],
                        "support_status": "supported",
                        "review_status": "unreviewed",
                    },
                    {
                        "claim_id": "action-unsupported",
                        "field": "action_items",
                        "text": "無來源動作",
                        "source_segment_ids": [],
                        "support_status": "unsupported",
                        "review_status": "unreviewed",
                    },
                ],
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    return session


@pytest.fixture
def bridge(tmp_path: Path):
    root = tmp_path / "artifacts"
    root.mkdir()
    session = _fixture(root)
    config = BridgeConfig(
        artifact_root=root,
        evidence_index=root / ".derived" / "evidence.sqlite3",
        audit_root=tmp_path / "audit",
        export_root=tmp_path / "exports",
        launch_token=TOKEN,
        allowed_origins=(ORIGIN, "http://localhost:3000"),
    )
    with TestClient(create_app(config)) as client:
        yield client, root, session, config


def test_bearer_token_and_exact_cors(bridge) -> None:
    client, *_ = bridge
    assert client.get("/v1/health").status_code == 401
    assert (
        client.get(
            "/v1/health", headers={"Authorization": "Bearer wrong-token"}
        ).status_code
        == 401
    )

    allowed = client.options(
        "/v1/health",
        headers={
            "Origin": ORIGIN,
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": "authorization",
        },
    )
    assert allowed.status_code == 200
    assert allowed.headers["access-control-allow-origin"] == ORIGIN

    denied = client.get(
        "/v1/health",
        headers={
            "Authorization": f"Bearer {TOKEN}",
            "Origin": "http://127.0.0.1:3000.evil.example",
        },
    )
    assert denied.status_code == 403
    assert "access-control-allow-origin" not in denied.headers


def test_session_claim_action_and_search_contracts(bridge) -> None:
    client, *_ = bridge
    health = client.get("/v1/health", headers=AUTH)
    assert health.status_code == 200
    assert health.json()["bind"] == "127.0.0.1"

    sessions = client.get("/v1/sessions", headers=AUTH).json()["sessions"]
    assert sessions[0]["session_id"] == "meeting-001"
    assert sessions[0]["transcript_hash_state"] == "current"
    assert "/tmp/" not in json.dumps(sessions)

    detail = client.get("/v1/sessions/meeting-001", headers=AUTH).json()
    assert detail["segment_count"] == 2
    assert detail["claim_count"] == 2
    assert detail["audio_tracks"] == ["mixed"]

    segments = client.get("/v1/sessions/meeting-001/segments", headers=AUTH).json()[
        "segments"
    ]
    assert segments[0]["start_ms"] == 100
    assert segments[0]["segment_id"] == "seg-001"

    claims = client.get("/v1/sessions/meeting-001/claims", headers=AUTH).json()[
        "claims"
    ]
    assert {item["claim_id"] for item in claims} == {
        "action-supported",
        "action-unsupported",
    }

    confirmed = client.post(
        "/v1/sessions/meeting-001/claims/action-supported/review",
        headers={**AUTH, "X-Correlation-ID": "review-correlation-1"},
        json={"decision": "confirmed"},
    )
    assert confirmed.status_code == 200
    assert confirmed.json()["review_status"] == "confirmed"

    actions = client.get("/v1/actions", headers=AUTH).json()["actions"]
    assert actions == [
        {
            "action_id": "action-supported",
            "meeting_id": "meeting-001",
            "task": "加入 bounded queue",
            "owner": "Jason",
            "deadline": "2026-07-31",
            "source_segment_ids": ["seg-001", "seg-002"],
            "support_status": "supported",
            "review_status": "confirmed",
            "delegable": True,
        },
        {
            "action_id": "action-unsupported",
            "meeting_id": "meeting-001",
            "task": "無來源動作",
            "owner": "",
            "deadline": "",
            "source_segment_ids": [],
            "support_status": "unsupported",
            "review_status": "unreviewed",
            "delegable": False,
        },
    ]

    search = client.get(
        "/v1/evidence/search",
        headers=AUTH,
        params={"q": "queue", "scope": "segments"},
    )
    assert search.status_code == 200
    assert search.json()["results"][0]["item_id"] == "seg-001"

    audit = client.get("/v1/audit/events", headers=AUTH).json()["events"]
    assert audit[-1]["correlation_id"] == "review-correlation-1"
    assert audit[-1]["previous_hash"] == "0" * 64


def test_unsupported_claim_cannot_be_confirmed(bridge) -> None:
    client, _, session, _ = bridge
    response = client.post(
        "/v1/sessions/meeting-001/claims/action-unsupported/review",
        headers=AUTH,
        json={"decision": "confirmed"},
    )
    assert response.status_code == 409
    events = session / "review_events.jsonl"
    assert not events.exists()


def test_stale_transcript_hash_cannot_be_confirmed(bridge) -> None:
    client, _, session, _ = bridge
    summary_path = session / "summary.json"
    summary = json.loads(summary_path.read_text(encoding="utf-8"))
    summary["transcript_sha256"] = "stale-hash"
    summary_path.write_text(json.dumps(summary), encoding="utf-8")

    response = client.post(
        "/v1/sessions/meeting-001/claims/action-supported/review",
        headers=AUTH,
        json={"decision": "confirmed"},
    )

    assert response.status_code == 409
    assert not (session / "review_events.jsonl").exists()
    stale_session = client.get("/v1/sessions", headers=AUTH).json()["sessions"][0]
    assert stale_session["transcript_hash_state"] == "stale"
    assert stale_session["confirmed_action_count"] == 0


def test_missing_source_segment_cannot_be_confirmed(bridge) -> None:
    client, _, session, _ = bridge
    summary_path = session / "summary.json"
    summary = json.loads(summary_path.read_text(encoding="utf-8"))
    summary["claims"][0]["source_segment_ids"].append("seg-phantom")
    summary_path.write_text(json.dumps(summary), encoding="utf-8")

    response = client.post(
        "/v1/sessions/meeting-001/claims/action-supported/review",
        headers=AUTH,
        json={"decision": "confirmed"},
    )

    assert response.status_code == 409
    assert not (session / "review_events.jsonl").exists()


def test_review_event_retains_correlation_when_bridge_audit_write_fails(
    bridge, monkeypatch
) -> None:
    client, _, session, _ = bridge
    store = client.app.state.store

    def fail_audit(**_event):
        raise BridgeFailure("simulated audit write failure")

    monkeypatch.setattr(store.audit, "append", fail_audit)
    response = client.post(
        "/v1/sessions/meeting-001/claims/action-supported/review",
        headers={**AUTH, "X-Correlation-ID": "corr-audit-failure"},
        json={"decision": "confirmed"},
    )

    assert response.status_code == 500
    event = json.loads(
        (session / "review_events.jsonl").read_text(encoding="utf-8").splitlines()[-1]
    )
    assert event["event"] == "claim.confirmed"
    assert event["correlation_id"] == "corr-audit-failure"
    metrics = client.get("/v1/health", headers=AUTH).json()["observability"]
    assert metrics["audit_write_failure_count"] == 1


def test_claim_edit_and_reject_contracts(bridge) -> None:
    client, *_ = bridge
    edited = client.post(
        "/v1/sessions/meeting-001/claims/action-supported/review",
        headers=AUTH,
        json={
            "decision": "edited",
            "edited_text": "加入 bounded queue 與 overload telemetry",
        },
    )
    assert edited.status_code == 200
    assert edited.json()["review_status"] == "edited"
    assert edited.json()["text"].endswith("overload telemetry")

    rejected = client.post(
        "/v1/sessions/meeting-001/claims/action-supported/review",
        headers=AUTH,
        json={"decision": "rejected"},
    )
    assert rejected.status_code == 200
    assert rejected.json()["review_status"] == "rejected"


def test_path_traversal_and_symlink_audio_are_rejected(bridge, tmp_path: Path) -> None:
    client, _, session, _ = bridge
    outside = tmp_path / "outside.wav"
    _write_wav(outside)
    manifest_path = session / "session.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

    manifest["audio_tracks"]["mixed"] = "../../outside.wav"
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    traversal = client.post(
        "/v1/evidence/audio-span",
        headers=AUTH,
        json={
            "meeting_id": "meeting-001",
            "start_ms": 0,
            "end_ms": 100,
            "track": "mixed",
        },
    )
    assert traversal.status_code == 403
    assert str(tmp_path) not in traversal.text

    link = session / "linked.wav"
    link.symlink_to(outside)
    manifest["audio_tracks"]["mixed"] = "linked.wav"
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    symlink = client.post(
        "/v1/evidence/audio-span",
        headers=AUTH,
        json={
            "meeting_id": "meeting-001",
            "start_ms": 0,
            "end_ms": 100,
            "track": "mixed",
        },
    )
    assert symlink.status_code == 403
    assert str(outside) not in symlink.text


def test_audio_span_returns_only_requested_wav_range(bridge) -> None:
    client, *_ = bridge
    response = client.post(
        "/v1/evidence/audio-span",
        headers={**AUTH, "X-Correlation-ID": "audio-correlation-1"},
        json={
            "meeting_id": "meeting-001",
            "start_ms": 100,
            "end_ms": 300,
            "track": "mixed",
        },
    )
    assert response.status_code == 200
    assert response.headers["content-type"] == "audio/wav"
    assert (
        hashlib.sha256(response.content).hexdigest()
        == response.headers["x-content-sha256"]
    )
    with wave.open(io.BytesIO(response.content), "rb") as audio:
        assert audio.getframerate() == 8_000
        assert audio.getnframes() == 1_600


def test_export_is_opaque_bounded_and_downloadable(bridge, tmp_path: Path) -> None:
    client, _, _, config = bridge
    client.post(
        "/v1/sessions/meeting-001/claims/action-supported/review",
        headers=AUTH,
        json={"decision": "confirmed"},
    )
    response = client.post(
        "/v1/evidence/export",
        headers={**AUTH, "X-Correlation-ID": "export-correlation-1"},
        json={"meeting_id": "meeting-001", "format": "json"},
    )
    assert response.status_code == 200
    metadata = response.json()
    assert metadata["download_url"].endswith(metadata["export_id"])
    target = config.export_root / metadata["filename"]
    assert target.is_file()
    assert hashlib.sha256(target.read_bytes()).hexdigest() == metadata["sha256"]

    downloaded = client.get(metadata["download_url"], headers=AUTH)
    assert downloaded.status_code == 200
    assert downloaded.content == target.read_bytes()
    packet = downloaded.json()
    assert packet["session"]["session_id"] == "meeting-001"
    assert str(tmp_path) not in downloaded.text
    assert all(ref.startswith("aura-") for ref in packet["evidence_refs"])

    audit = client.get("/v1/audit/events", headers=AUTH).json()["events"]
    assert audit[-1]["action"] == "evidence.exported"
    assert audit[-1]["correlation_id"] == "export-correlation-1"
    assert audit[-1]["previous_hash"] == audit[-2]["hash"]


def test_invalid_limits_and_audio_ranges_are_rejected(bridge) -> None:
    client, *_ = bridge
    assert client.get("/v1/sessions?limit=101", headers=AUTH).status_code == 422
    assert (
        client.post(
            "/v1/evidence/audio-span",
            headers=AUTH,
            json={
                "meeting_id": "meeting-001",
                "start_ms": 300,
                "end_ms": 100,
                "track": "mixed",
            },
        ).status_code
        == 422
    )


def test_health_exposes_bounded_redacted_operational_metrics(bridge) -> None:
    client, _, _, config = bridge
    confirmed = client.post(
        "/v1/sessions/meeting-001/claims/action-supported/review",
        headers={**AUTH, "X-Correlation-ID": "corr-review-success"},
        json={"decision": "confirmed"},
    )
    assert confirmed.status_code == 200
    blocked = client.post(
        "/v1/sessions/meeting-001/claims/action-unsupported/review",
        headers={**AUTH, "X-Correlation-ID": "corr-review-blocked"},
        json={"decision": "confirmed"},
    )
    assert blocked.status_code == 409
    assert (
        client.get(
            "/v1/evidence/search",
            headers={**AUTH, "X-Correlation-ID": "corr-search"},
            params={"q": "queue"},
        ).status_code
        == 200
    )
    assert (
        client.post(
            "/v1/evidence/audio-span",
            headers={**AUTH, "X-Correlation-ID": "corr-audio-failure"},
            json={
                "meeting_id": "meeting-001",
                "start_ms": 300,
                "end_ms": 100,
                "track": "mixed",
            },
        ).status_code
        == 422
    )

    store = client.app.state.store

    metrics = client.get("/v1/health", headers=AUTH).json()["observability"]
    assert metrics["claim_review_count"] == 2
    assert metrics["claim_review_completed_count"] == 1
    assert metrics["claim_review_failure_count"] == 1
    assert metrics["unsupported_claim_block_count"] == 1
    assert metrics["evidence_search_count"] == 1
    assert metrics["evidence_search_latency_ms"]["count"] == 1
    assert metrics["audio_span_failure_count"] == 1
    assert metrics["audit_write_failure_count"] == 0
    assert metrics["retention_max_bytes_per_file"] == 5 * 1024 * 1024
    assert metrics["retention_file_count"] == 2

    log_path = config.observability_root / "aura-bridge.jsonl"
    store.observability.record(
        "redaction.test",
        "corr-redaction",
        {
            "authorization": f"Bearer {TOKEN}",
            "path": str(config.artifact_root),
        },
    )
    retained = log_path.read_text(encoding="utf-8")
    assert "corr-review-success" in retained
    assert "[REDACTED]" in retained
    assert TOKEN not in retained
    assert str(config.artifact_root) not in retained
    assert (config.audit_root / "voiss-aura-bridge.jsonl").is_file()

    log_path.write_bytes(b"x" * OBSERVABILITY_LOG_MAX_BYTES)
    store.observability.record("rotation.test", "corr-rotation")
    assert log_path.stat().st_size <= OBSERVABILITY_LOG_MAX_BYTES
    assert (
        config.observability_root / "aura-bridge.jsonl.1"
    ).stat().st_size == OBSERVABILITY_LOG_MAX_BYTES


def test_bridge_has_no_pyqt_or_transcription_tab_import() -> None:
    source = Path(__file__).parents[1] / "src" / "aura_bridge" / "app.py"
    text = source.read_text(encoding="utf-8")
    assert "PyQt" not in text
    assert "aura.ui.transcription_tab" not in text
