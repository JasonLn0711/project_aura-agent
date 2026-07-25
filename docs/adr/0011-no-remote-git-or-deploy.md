# ADR 0011: MVP authority ends at local export

- Status: Accepted
- Date: 2026-07-24

## Context

Push, merge, pull request, deployment, publication, and external messaging affect systems and people beyond the local evidence-to-execution loop.

## Decision

P0 can plan, edit an isolated worktree, run validation, show a trusted diff, stop a run, and export a patch/evidence packet. It cannot perform remote Git or deployment actions.

## Consequences

The operator retains the release decision. Future remote actions enter through separately reviewed credentials, policies, and approvals.
