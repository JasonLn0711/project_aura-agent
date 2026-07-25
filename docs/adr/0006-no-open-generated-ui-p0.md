# ADR 0006: Open-ended generated UI stays outside P0

- Status: Accepted
- Date: 2026-07-24

## Context

Arbitrary generated components expand the trust, accessibility, and injection surface without improving the core five-minute workflow.

## Decision

P0 uses static trusted components and bounded read-only presentation schemas. Open-ended generated UI follows a separate validation and governance path.

## Consequences

The initial release has a small auditable rendering surface and deterministic acceptance tests.
