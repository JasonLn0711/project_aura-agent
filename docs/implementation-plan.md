# VOISS AURA Control Room — Implementation Plan

Status: Implemented and locally validated
Source baseline: `6807f516d1083051d75373f110ac871f677f75ce`

## FIRST PRINCIPLE routing

- Scarce resource: trustworthy movement from reviewed meeting evidence to engineering execution.
- Canonical home: AURA session artifacts and validated review events.
- Control-plane role: locate evidence, collect approval, orchestrate local agents, surface validation, and export proof.
- Evidence path: AURA artifact reference → review decision → confirmed action → run correlation → diff/test evidence → trust control → export checksum.
- Scope control: loopback-only, single operator, read-only first, network off, isolated write worktree, no remote Git or deployment authority.
- Next gate: owner review of the final-source quality evidence and regenerated
  architecture package, followed by a separately authorized target commit.

## Repository delta map

| Area | Baseline | P0 delta |
|---|---|---|
| AURA evidence | Claim review, FTS search, audio-span resolver, audit | Headless typed application service and protected loopback API |
| Operator UI | PyQt desktop tabs | Companion Next.js Control Room with six named screens |
| Agent runtime | Deferred | CopilotKit runtime with `voiss_orchestrator`, `codex_engineer`, and `demo_agent` |
| Engineering execution | None | Codex app-server bridge, read-only plan, explicit approvals, isolated write worktree |
| Trust | AURA runtime report and audit primitives | Assets, controls, findings, correlation timeline, export verification |
| Demo | Individual fixtures | One named deterministic four-scenario fixture with synthetic audio |
| Architecture proof | Baseline source-analysis ZIP | Implemented-system reports, diagrams, inventories, SBOMs, and validation logs |

## Confirmed integration points

1. Reuse `record_claim_review` and `record_claim_edit` for claim decisions.
2. Reuse `EvidenceSearch` for session evidence, audio-span lookup, and confirmed-action discovery.
3. Keep the headless bridge independent of `aura.ui.transcription_tab`.
4. Use Codex app-server v2 `thread/start`, `turn/start`, `turn/interrupt`, approval requests, item events, plan updates, and diff updates.
5. Use AG-UI events only as a normalized presentation stream; authoritative approval state remains server-side.

## Implementation sequence

1. Lock the Node and Python dependency surfaces.
2. Build typed domain contracts, demo fixture, and trusted UI shell.
3. Add AURA Bridge endpoints and boundary/security tests.
4. Add Codex process manager, event adapter, worktree isolation, and integration tests.
5. Join approval, audit, trust, export, and deterministic demo workflows.
6. Run unit, component, bridge, E2E, accessibility, build, and frozen AURA regression gates.
7. Generate and verify the architecture package and release evidence.

## Initial unknowns and validation

- Codex availability of `gpt-5.6-sol` is verified at run start and recorded
  without silent substitution; the 2026-07-24 target host completed one
  official `max` live run without rerouting.
- AURA artifact variations are covered by fixture and canonical-path tests before local-mode release.
- Native/GPU/model inventory remains partial until live probes produce retained evidence.
- Hosted authentication, multi-tenancy, and remote execution remain P1 activation paths.
