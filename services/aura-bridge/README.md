# VOISS AURA Bridge

Loopback-only FastAPI access to AURA canonical session artifacts. The bridge
reuses `aura.claim_review` and `aura.evidence_search`; it does not initialize
PyQt or expose absolute filesystem paths.

```bash
export AURA_ARTIFACT_ROOT=/absolute/path/to/aura-sessions
export AURA_BRIDGE_TOKEN="$(python -c 'import secrets; print(secrets.token_urlsafe(32))')"
export AURA_ALLOWED_ORIGINS=http://127.0.0.1:3000

PYTHONPATH=../../src uv run --project . aura-bridge
```

The service always binds `127.0.0.1`. Every API request uses
`Authorization: Bearer $AURA_BRIDGE_TOKEN`. Mutating and media operations add
an `X-Correlation-ID` response header and append a redacted, hash-chained event
to `AURA_AUDIT_ROOT` (default: `<artifact-root>/.voiss-aura/audit`).

Optional configuration:

- `AURA_EVIDENCE_INDEX` — derived SQLite index, default
  `<artifact-root>/.voiss-aura/evidence.sqlite3`
- `AURA_AUDIT_ROOT` — bridge audit directory
- `VOISS_EXPORT_ROOT` — evidence-packet directory
- `AURA_BRIDGE_PORT` — loopback port, default `8765`

Run focused tests without changing the repository lockfiles:

```bash
PYTHONPATH=src:../../src uv run --no-project \
  --with fastapi==0.116.1 --with httpx==0.28.1 --with pytest==8.4.1 \
  pytest -q tests
```
