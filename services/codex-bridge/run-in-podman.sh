#!/usr/bin/env bash
set -euo pipefail

: "${CODEX_VENDOR_DIR:?CODEX_VENDOR_DIR must name the installed Codex Linux vendor directory}"
: "${CODEX_AUTH_FILE:?CODEX_AUTH_FILE must name the Codex auth.json file}"
: "${VOISS_ALLOWED_REPOSITORIES:?VOISS_ALLOWED_REPOSITORIES is required}"

image="${CODEX_PODMAN_IMAGE:-localhost/voiss-codex-runtime:0.145.0}"
mounts=(
  "--volume=${CODEX_VENDOR_DIR}:/opt/codex:ro"
  "--volume=${CODEX_AUTH_FILE}:/root/.codex/auth.json:ro"
)

IFS=',' read -r -a repositories <<< "$VOISS_ALLOWED_REPOSITORIES"
for root in "${repositories[@]}"; do
  case "$root" in
    /*) mounts+=("--volume=$root:$root:rw") ;;
    *) printf '%s\n' "VOISS_ALLOWED_REPOSITORIES must contain absolute paths" >&2; exit 2 ;;
  esac
done

for root in "${VOISS_WORKTREE_ROOT:-}" "${CODEX_EXPORT_ROOT:-}"; do
  [ -z "$root" ] && continue
  case "$root" in
    /*) mounts+=("--volume=$root:$root:rw") ;;
    *) printf '%s\n' "Podman mount roots must be absolute paths" >&2; exit 2 ;;
  esac
done

exec podman run --rm -i --security-opt label=disable "${mounts[@]}" \
  "$image" /opt/codex/bin/codex "$@"
