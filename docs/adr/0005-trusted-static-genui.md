# ADR 0005: Trusted static UI for consequential actions

- Status: Accepted
- Date: 2026-07-24

## Context

Claim decisions, delegation, approvals, cancellation, diff acceptance, and export change operator-trusted state.

## Decision

Render these operations with reviewed static components and typed server contracts. Agent output can propose content, while the component controls labels, options, validation, and state transitions.

## Consequences

Consequential interactions remain predictable, accessible, and testable. Read-only bounded reports may use A2UI where their schema is constrained.
