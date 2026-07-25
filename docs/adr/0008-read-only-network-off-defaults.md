# ADR 0008: Read-only and network-off defaults

- Status: Accepted
- Date: 2026-07-24

## Context

A meeting action first needs a plan and impact review. Workspace and network authority are separate capabilities.

## Decision

Start planning in a read-only Codex thread with network access disabled. A
trusted approval launches a separate workspace-write thread whose only writable
scope is the isolated run worktree; network authority remains off in both
threads. P0 does not activate network authority.

## Consequences

Planning is immediately useful while mutation remains explicit. Unknown sandbox state fails closed and becomes a trust finding.
