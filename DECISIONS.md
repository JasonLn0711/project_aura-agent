# VOISS AURA Control Room — Decisions

The accepted decisions live in `docs/adr/`. This register provides the current operating view.

| ADR | Decision | Status |
|---|---|---|
| 0001 | Build a companion web control plane in the AURA monorepo | Accepted |
| 0002 | Keep AURA canonical artifacts as the evidence source of truth | Accepted |
| 0003 | Expose AURA through a token-protected loopback bridge | Accepted |
| 0004 | Integrate Codex through `codex app-server` | Accepted |
| 0005 | Use trusted static UI for consequential decisions | Accepted |
| 0006 | Keep open-ended generated UI outside P0 | Accepted |
| 0007 | Create one isolated Git worktree for each approved write run | Accepted |
| 0008 | Start Codex read-only with network access disabled | Accepted |
| 0009 | Provide an explicit, deterministic, credential-free demo mode | Accepted |
| 0010 | Store local control-plane metadata in SQLite | Accepted |
| 0011 | End MVP authority at local patch and evidence export | Accepted |
| 0012 | Gate release claims on retained reports and validation evidence | Accepted |

## Implementation interpretation

The web application owns orchestration and presentation. AURA owns meeting evidence and review rules. The Codex bridge owns process lifecycle, approvals, sandbox policy, worktree isolation, and event normalization. The trust engine owns control results and findings. Correlation IDs join these layers without copying private source material into control-plane metadata.
