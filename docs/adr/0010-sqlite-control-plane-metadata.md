# ADR 0010: SQLite control-plane metadata

- Status: Accepted
- Date: 2026-07-24

## Context

The local product needs durable assets, controls, findings, approvals, correlations, and export records with no external database.

## Decision

Use SQLite for local metadata and append-only event references. Store hashes and AURA artifact locators instead of duplicating canonical meeting content.

## Consequences

The single-operator install remains portable and transactionally safe. Hosted tenancy and database migration follow a separate activation path.
