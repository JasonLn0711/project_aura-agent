# ADR 0007: Isolated Git worktree for every write run

- Status: Accepted
- Date: 2026-07-24

## Context

Engineering execution needs recoverable workspace writes without mixing operator changes or parallel runs.

## Decision

After approval, create one allowlisted Git worktree and branch per run. Validate the repository root and base revision before creation. All write commands and diffs stay inside that worktree.

## Consequences

Runs are inspectable, stoppable, and independently removable. A dirty source checkout remains protected, and patch export has a clear base.
