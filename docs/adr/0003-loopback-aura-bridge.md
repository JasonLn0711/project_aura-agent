# ADR 0003: Token-protected loopback AURA Bridge

- Status: Accepted
- Date: 2026-07-24

## Context

The web process needs typed access to local artifacts while path and media boundaries remain server-controlled.

## Decision

Expose a Python HTTP service bound to `127.0.0.1`. Require a launch token, exact local-origin CORS, canonical root checks, symlink protection, opaque audio URLs, bounded outputs, and existing AURA review logic.

## Consequences

Browser code never receives arbitrary filesystem authority. The bridge can be contract-tested without loading PyQt or model workers.
