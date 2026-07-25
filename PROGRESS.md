# VOISS AURA Control Room — Progress

Source baseline: `6807f516d1083051d75373f110ac871f677f75ce`
Working branch: `feat/voiss-aura-control-room`
Last updated: 2026-07-25

## Current milestone

Status: `LOCAL_E2E_VALIDATED`

- [x] Verified the complete AURA checkout at the pinned commit.
- [x] Preserved the original dirty checkout and created a clean feature worktree.
- [x] Read the AURA architecture package and traced review, evidence-search, audio-span, and audit flows.
- [x] Verified current CopilotKit package contracts and Codex app-server v2 schemas.
- [x] Recorded the twelve required architecture decisions.
- [x] Implement the deterministic Control Room and named CopilotKit agents.
- [x] Implement and validate the loopback AURA Bridge.
- [x] Implement and validate the Codex app-server bridge.
- [x] Persist Codex run/thread/event/approval/validation/export lifecycle state,
  restore read-only thread capability after restart, and expose cursor replay
  plus explicit thread archive.
- [x] Persist CopilotKit thread/run history in its own owner-controlled SQLite
  file, preserve parent-linked resume invocations, and settle runner state after
  approval completion.
- [x] Preserve approval timeout as paused/resumable state and reconcile stale,
  normally closed, or crashed active lifecycle metadata to bounded
  blocked/interrupted outcomes.
- [x] Implement P0 trust controls, audit correlation, evidence-gated exports,
  and automated negative security checks.
- [x] Complete one full local Web → AURA → official Codex live validation run.
- [x] Re-run the complete frozen quality gate and deterministic five-minute demo on the final source state.
- [x] Regenerate the implemented-system architecture package and retained validation evidence from the final source state.

## Evidence already established

- AURA claim decisions route through `src/aura/claim_review.py`.
- Evidence search and audio-span resolution route through `src/aura/evidence_search.py`.
- AURA audit records are hash chained by `src/aura/audit.py`.
- Codex CLI `0.145.0` is installed and reports ChatGPT sign-in.
- Rootless Podman provides the verified Linux execution lane for Codex
  `managed-bubblewrap`: the app-server retains model connectivity while run
  policy reports network-off for approved read-only or workspace-write tools.
- A separate managed-sandbox socket canary attempted `1.1.1.1:443` and exited
  with `PermissionError: [Errno 1] Operation not permitted`, providing active
  egress-denial evidence without conflating it with the policy field.
- The 2026-07-25 final-source local E2E completed real AURA evidence loading, claim review,
  read-only Codex planning, explicit `allow_once`, an isolated worktree,
  `queue.Queue(maxsize=8)`, two successful retained validation checks, patch
  export, SHA-256 verification, and ten correlation-scoped events inside a
  valid cumulative audit chain.
- The same guarded run retained 366 exported Codex events and a CopilotKit
  plan → write interrupt → resume child lineage with a settled runner state.
- Current working-state gates pass 116 JS/TS tests, including 55 Codex Bridge
  tests, plus 14 focused AURA Bridge tests and 398 full Python tests.
- The baseline architecture package is source-analysis evidence; it is not implementation proof for this MVP.

## Next gate

The local P0 evidence package is ready for owner review. The owner activated
repository publication to `JasonLn0711/project_aura-agent` as a bounded
closeout step on 2026-07-25; the planning control plane records the final
commit and push evidence. This source publication does not expand the Control
Room runtime authority: merge, pull request, deploy, and external-message
actions remain separately activated work packages. The next presentation gate
is one spoken five-minute fixture-boundary rehearsal plus reviewer sign-off.
Browser auto-reattach, cross-process write-thread resume, target-host
crash/reconnect traces, and the remaining target-host approval/stop traces form
the next lifecycle validation layer.
