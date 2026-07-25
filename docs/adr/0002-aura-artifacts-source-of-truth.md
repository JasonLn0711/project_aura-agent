# ADR 0002: AURA artifacts remain the source of truth

- Status: Accepted
- Date: 2026-07-24

## Context

AURA already owns session manifests, transcript segments, summaries, review events, audio references, and freshness rules.

## Decision

The control room stores references, hashes, decisions, correlations, and redacted excerpts. Canonical transcript, audio, and meeting-summary content remains in AURA artifacts.

## Consequences

Review and freshness semantics stay consistent across desktop and web paths. Control-plane backups remain smaller and preserve clear data stewardship.
