# ADR 0012: Release claims require retained evidence

- Status: Accepted
- Date: 2026-07-24

## Context

Architecture scaffolding, historical claims, smoke checks, and deterministic fixtures each support different claim depths.

## Decision

Generate the twenty-section architecture package, twelve Mermaid sources, machine-readable inventories, CycloneDX and SPDX SBOMs, validation logs, and checksums from the implemented revision. Label every artifact as confirmed, partially verified, or inferred.

## Consequences

Release status can be audited against actual commands, versions, paths, and results. Missing live evidence remains an activation gate instead of a completion claim.
