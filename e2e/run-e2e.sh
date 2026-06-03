#!/usr/bin/env bash
# tanka-wm — Linux end-to-end test, host machine orchestration script.
#
# On the host (macOS): cross-compile the Linux binary for the current arch →
# build the test image → run a Linux container via Docker Desktop, where
# container-e2e.sh executes the full assertion suite.
#
# token/env uses the host's real configuration: credentials.json is bind-mounted
# read-only into the container ($TANKA_WM_HOME/credentials.json or
# ~/.tanka-wm/credentials.json) — never baked into the image.
#
# Usage:
#   e2e/run-e2e.sh             # full flow: build → image → run core e2e assertions
#   e2e/run-e2e.sh --cron      # run the "real cron daemon trigger" test instead (long-lived container, ~1-2 min)
#   e2e/run-e2e.sh --no-build  # skip binary compilation (reuse dist/); can combine with --cron
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

DO_BUILD=1
SUITE=e2e   # e2e | cron
for arg in "$@"; do
  case "$arg" in
    --no-build) DO_BUILD=0 ;;
    --cron)     SUITE=cron ;;
    *) echo "unknown argument: ${arg} (supported: --cron / --no-build)" >&2; exit 2 ;;
  esac
done

# ── Select target arch: Apple Silicon → arm64 (native container, no qemu) ──
case "$(uname -m)" in
  arm64|aarch64) BUN_TARGET=linux-arm64; DOCKER_PLATFORM=linux/arm64 ;;
  x86_64|amd64)  BUN_TARGET=linux-x64;   DOCKER_PLATFORM=linux/amd64 ;;
  *) echo "unknown host arch $(uname -m), falling back to linux-x64/amd64" >&2
     BUN_TARGET=linux-x64; DOCKER_PLATFORM=linux/amd64 ;;
esac
echo "▶ target: $BUN_TARGET  ($DOCKER_PLATFORM)"

# ── Locate real credentials ─────────────────────────────────────────
CRED="${TANKA_WM_HOME:-$HOME/.tanka-wm}/credentials.json"
[ -r "$CRED" ] || { echo "✗ cannot find real credentials at $CRED — configure token/env on the host first" >&2; exit 1; }
echo "▶ credentials: $CRED (env=$(jq -r '.env // "prod"' "$CRED" 2>/dev/null || echo '?'))"

# ── Docker availability ─────────────────────────────────────────────
docker version >/dev/null 2>&1 || { echo "✗ Docker is not running, please start Docker Desktop" >&2; exit 1; }

# ── 1. Cross-compile the Linux binary ───────────────────────────────
if [ $DO_BUILD -eq 1 ]; then
  echo "▶ compiling $BUN_TARGET binary…"
  bun scripts/build-binaries.mjs "$BUN_TARGET"
fi
SRC_BIN="dist/tanka-wm-$BUN_TARGET"
[ -f "$SRC_BIN" ] || { echo "✗ missing ${SRC_BIN} (remove --no-build)" >&2; exit 1; }
# Dockerfile COPY uses a fixed name to avoid arch suffix coupling
cp "$SRC_BIN" dist/tanka-wm-linux
echo "▶ binary ready: $SRC_BIN ($(du -h "$SRC_BIN" | cut -f1))"

# ── 2. Build image ──────────────────────────────────────────────────
IMAGE=tanka-wm-e2e:latest
echo "▶ building image ${IMAGE} …"
docker build --platform "$DOCKER_PLATFORM" -f e2e/Dockerfile -t "$IMAGE" .

# ── 3. Run container ────────────────────────────────────────────────
if [ "$SUITE" = cron ]; then
  ENTRYPOINT=/usr/local/bin/container-cron-live.sh
  echo "▶ running cron live-trigger container (long-lived, ~1-2 min)…"
else
  ENTRYPOINT=/usr/local/bin/container-e2e.sh
  echo "▶ running core e2e container…"
fi
set +e
ENV_FLAGS=()
for key in TANKA_API_URL_DEV TANKA_API_URL_TEST TANKA_API_URL_UAT TANKA_API_URL_PROD; do
  [ -n "${!key:-}" ] && ENV_FLAGS+=(-e "$key=${!key}")
done
docker run --rm --platform "$DOCKER_PLATFORM" \
  -v "$CRED:/seed/credentials.json:ro" \
  "${ENV_FLAGS[@]}" \
  --entrypoint "$ENTRYPOINT" \
  "$IMAGE"
RC=$?
set -e

echo
if [ $RC -eq 0 ]; then echo "✅ all tests passed (suite=${SUITE})"; else echo "❌ tests failed (suite=${SUITE}, rc=${RC})"; fi
exit $RC
