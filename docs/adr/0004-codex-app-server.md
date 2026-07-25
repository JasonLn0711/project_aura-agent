# ADR 0004: Codex app-server integration

- Status: Accepted
- Date: 2026-07-24

## Context

Codex already provides authentication status, thread lifecycle, sandboxing, approvals, streamed items, interruption, and diff events.

## Decision

Run `codex app-server --stdio` server-side and speak its versioned JSON-RPC contract. Use `account/read` for status and never read or forward authentication tokens.

## Consequences

The bridge preserves Codex-native execution semantics and avoids a parallel provider adapter. Schema/version compatibility becomes an explicit startup control.
