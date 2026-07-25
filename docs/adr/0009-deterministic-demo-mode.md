# ADR 0009: Explicit deterministic demo mode

- Status: Accepted
- Date: 2026-07-24

## Context

Product review must work without credentials, GPU services, Ollama, private audio, or a writable repository.

## Decision

Ship a named sanitized fixture, synthetic audio, scripted AG-UI events, expected diff, expected tests, and deterministic trust results. Demo and local mode require explicit selection and display a persistent badge.

## Consequences

The complete scripted workflow has a credential-free, lockfile-pinned
reproduction path. A final-source frozen install and browser rehearsal provide
the clean-machine release evidence. Demo output is clearly classified and
never presented as live Codex or AURA evidence.
