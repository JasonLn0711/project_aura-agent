# ADR 0001: Companion web control plane

- Status: Accepted
- Date: 2026-07-24

## Context

`TranscriptionTab` already coordinates desktop capture and review and is a high-coupling risk surface. The MVP adds agent orchestration, approvals, trust controls, and evidence export.

## Decision

Build a companion Next.js control plane inside the AURA monorepo. It communicates with AURA through a headless loopback bridge and does not import or extend `TranscriptionTab`.

## Consequences

The desktop workflow stays stable, while the control room gains an independently testable lifecycle. Shared behavior is extracted behind AURA application services only when both interfaces require it.
