#!/usr/bin/env bash
# tanka-wm — Linux container end-to-end test.
#
# Inside a clean Debian container, runs the full CLI lifecycle against a real
# Tanka backend using real token + real env (from the host configuration). The
# only mock is on the input side: a fake Claude Code session transcript. Every
# step asserts; any assertion failure exits non-zero immediately.
#
# Prerequisites (provided by run-e2e.sh / docker run):
#   /seed/credentials.json  read-only bind-mount of the host's real credentials (token + env)
#   /usr/local/bin/tanka-wm self-contained binary for the current arch
#
# Design decisions (confirmed with the team):
#   - select mode; sync creates a dedicated isolated project e2e-test-<timestamp> via API
#   - no cleanup afterward; fake data is kept on the test backend for manual inspection
set -uo pipefail

# ── Output helpers ───────────────────────────────────────────────────
RED=$'\033[31m'; GRN=$'\033[32m'; YLW=$'\033[33m'; DIM=$'\033[2m'; RST=$'\033[0m'
step()  { printf '\n%s▶ %s%s\n' "$YLW" "$*" "$RST"; }
ok()    { printf '%s  ✓ %s%s\n' "$GRN" "$*" "$RST"; }
info()  { printf '%s    %s%s\n' "$DIM" "$*" "$RST"; }
die()   { printf '%s  ✗ %s%s\n' "$RED" "$*" "$RST" >&2; exit 1; }

# Assert stdout contains a substring
assert_contains() { # <haystack> <needle> <desc>
  case "$1" in
    *"$2"*) ok "$3" ;;
    *)      printf '%s  ✗ %s%s\n' "$RED" "$3" "$RST" >&2
            printf '%s    expected: %q%s\n' "$DIM" "$2" "$RST" >&2
            printf '%s    actual output:%s\n%s\n' "$DIM" "$RST" "$1" >&2
            exit 1 ;;
  esac
}

# ── 0. Environment setup ────────────────────────────────────────────
step "0. Environment setup"
export HOME=/root
export TANKA_WM_HOME="$HOME/.tanka-wm"
mkdir -p "$TANKA_WM_HOME"

[ -r /seed/credentials.json ] || die "missing /seed/credentials.json (host real credentials not mounted)"
TOKEN=$(jq -er '.token' /seed/credentials.json) || die "credentials.json missing token"
ENVNAME=$(jq -er '.env' /seed/credentials.json 2>/dev/null || echo prod)
ENV_VAR="TANKA_API_URL_$(echo "$ENVNAME" | tr '[:lower:]' '[:upper:]')"
BASE_URL="${!ENV_VAR:-}"
[ -n "$BASE_URL" ] || die "env var $ENV_VAR is not set — pass it via docker run -e"
# Copy credentials to the state directory and restrict to 0600 (matches CLI's credential file permissions)
install -m 600 /seed/credentials.json "$TANKA_WM_HOME/credentials.json"
ok "env=$ENVNAME  base=$BASE_URL  token=${TOKEN:0:6}…(${#TOKEN} chars)"
info "$(uname -m) / $(. /etc/os-release && echo "$PRETTY_NAME")"

# ── 1. Binary smoke test: --version / --help / --check ──────────────
step "1. Binary runs on Linux"
VER=$(tanka-wm --version) || die "--version exited non-zero"
assert_contains "$VER" "tanka-wm" "tanka-wm --version → $VER"

HELP=$(tanka-wm --help) || die "--help exited non-zero"
assert_contains "$HELP" "sync" "tanka-wm --help lists sync"
assert_contains "$HELP" "cron" "tanka-wm --help lists cron"

# --check renders one TUI frame then exits 0 (verifies Ink + yoga-wasm work in a no-TTY container)
if tanka-wm --check >/dev/null 2>&1; then
  ok "tanka-wm --check exited 0 (TUI render smoke test passed)"
else
  die "tanka-wm --check exited non-zero (Ink/yoga-wasm failed in container)"
fi

# ── 2. Create a dedicated isolated test project (real API) ──────────
step "2. Create dedicated test project via real API"
PROJECT_NAME="e2e-test-$(date +%Y%m%d-%H%M%S)"
CREATE_RESP=$(curl -sS -X POST "$BASE_URL/link/workmemory/auth/project/save" \
  -H "token: $TOKEN" -H 'Content-Type: application/json' \
  -d "$(jq -nc --arg n "$PROJECT_NAME" \
        '{displayName:$n, lookbackDays:14, reportLanguage:"en"}')") \
  || die "project/save request failed (network?)"
CODE=$(jq -r '.code // empty' <<<"$CREATE_RESP")
[ "$CODE" = "0" ] || die "project/save returned non-0 envelope: $CREATE_RESP"
REMOTE_ID=$(jq -er '.data.projectId' <<<"$CREATE_RESP") \
  || die "project/save response missing data.projectId: $CREATE_RESP"
ok "created project $PROJECT_NAME → remoteProjectId=$REMOTE_ID"

# Pre-validation probe: select+created sync requires the project to appear in /project/list
# immediately; otherwise it gets skipped as not-found. Explicitly verify here to surface the risk.
LIST_RESP=$(curl -sS -X GET "$BASE_URL/link/workmemory/auth/project/list?pageSize=500" \
  -H "token: $TOKEN") || die "project/list request failed"
if jq -e --arg id "$REMOTE_ID" \
     '[(.data.content // .data.list // .data // [])[].projectId] | index($id)' \
     <<<"$LIST_RESP" >/dev/null 2>&1; then
  ok "new project appears in /project/list (sync pre-validation will pass)"
else
  info "${YLW}note: new project not yet in /project/list — if sync pre-validation skips it, this is a known backend list contract risk${RST}"
fi

# ── 3. Write config (select mode, pointing to mock cwd and new project) ──
step "3. Write select-mode config"
MOCK_CWD=/work/mock-proj
mkdir -p "$MOCK_CWD"
jq -nc \
  --arg cwd "$MOCK_CWD" \
  --arg rid "$REMOTE_ID" \
  --arg name "$PROJECT_NAME" \
  '{
     version:1, mode:"select", wizardStep:"done",
     cwds:   [ {id:"mock-proj", name:"mock-proj", cwd:$cwd} ],
     projects:[ {id:"mock-proj", remoteProjectId:$rid, name:$name,
                 cwdIds:["mock-proj"], origin:"created"} ]
   }' > "$TANKA_WM_HOME/config.json"
ok "config.json written (cwd=${MOCK_CWD} → ${REMOTE_ID})"

# ── 4. Create mock session (fake Claude Code transcript) ────────────
step "4. Generate mock Claude Code session"
# Claude Code encoded dir rule: each non-alphanumeric char in the cwd folds to '-'. /work/mock-proj → -work-mock-proj
ENCODED=$(printf '%s' "$MOCK_CWD" | sed 's/[^a-zA-Z0-9]/-/g')
CC_DIR="$HOME/.claude/projects/$ENCODED"
mkdir -p "$CC_DIR"
SESSION_ID="e2e-$(cat /proc/sys/kernel/random/uuid)"
TRANSCRIPT="$CC_DIR/$SESSION_ID.jsonl"
TS=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
# The first line must carry the fields probeClaude reads: cwd / sessionId / version / gitBranch / timestamp / message.model
# and the cwd must exactly equal the registered root (cwdEqualsAny), otherwise it's discarded as a sibling directory.
{
  jq -nc --arg cwd "$MOCK_CWD" --arg sid "$SESSION_ID" --arg ts "$TS" \
    '{type:"summary", cwd:$cwd, sessionId:$sid, version:"1.0.0",
      gitBranch:"main", timestamp:$ts, message:{model:"claude-opus-4-8"}}'
  jq -nc --arg cwd "$MOCK_CWD" --arg sid "$SESSION_ID" --arg ts "$TS" \
    '{type:"user", cwd:$cwd, sessionId:$sid, timestamp:$ts,
      message:{role:"user", content:"e2e mock prompt"}}'
  jq -nc --arg cwd "$MOCK_CWD" --arg sid "$SESSION_ID" --arg ts "$TS" \
    '{type:"assistant", cwd:$cwd, sessionId:$sid, timestamp:$ts,
      message:{role:"assistant", model:"claude-opus-4-8", content:"e2e mock reply"}}'
} > "$TRANSCRIPT"
ok "transcript: $TRANSCRIPT ($(wc -c <"$TRANSCRIPT") bytes, 3 lines)"

# ── 5. First sync — real upload to backend ──────────────────────────
step "5. First sync (real upload of mock session to $ENVNAME backend)"
SYNC1=$(tanka-wm sync "$REMOTE_ID" 2>&1); SYNC1_RC=$?
printf '%s\n' "$SYNC1" | sed 's/^/    | /'
[ $SYNC1_RC -eq 0 ] || die "sync exited non-zero (rc=${SYNC1_RC})"
assert_contains "$SYNC1" "1 uploaded" "first sync uploaded 1 session"

# After a successful upload, the manifest shard should be written (uploads/<env>/<projectId>.json)
MANIFEST="$TANKA_WM_HOME/uploads/$ENVNAME/$REMOTE_ID.json"
[ -f "$MANIFEST" ] || die "manifest not written: $MANIFEST"
jq -e --arg sid "$SESSION_ID" '.[$sid] // empty' "$MANIFEST" >/dev/null \
  && ok "manifest records session $SESSION_ID" \
  || die "manifest does not contain session record"

# ── 6. Idempotent: second sync should skip ──────────────────────────
step "6. Second sync (incremental idempotent, should skip)"
SYNC2=$(tanka-wm sync "$REMOTE_ID" 2>&1); SYNC2_RC=$?
printf '%s\n' "$SYNC2" | sed 's/^/    | /'
[ $SYNC2_RC -eq 0 ] || die "second sync exited non-zero"
assert_contains "$SYNC2" "0 uploaded" "second sync does not re-upload"
assert_contains "$SYNC2" "1 up-to-date" "second sync reports up-to-date"

# ── 7. Cron lifecycle (Linux crontab backend) ────────────────────────
step "7. cron install / status / remove (crontab backend)"
CRON_EXPR="*/30 * * * *"
INST=$(tanka-wm cron install "$CRON_EXPR" 2>&1) || die "cron install failed: $INST"
assert_contains "$INST" "$CRON_EXPR" "cron install echoes expression"

STAT=$(tanka-wm cron status 2>&1) || die "cron status failed"
assert_contains "$STAT" "installed" "cron status → installed"

RAW_TAB=$(crontab -l 2>/dev/null || true)
assert_contains "$RAW_TAB" "work-memory-tui" "crontab contains our marker block"
assert_contains "$RAW_TAB" "sync" "crontab line invokes sync"

REM=$(tanka-wm cron remove 2>&1) || die "cron remove failed"
assert_contains "$REM" "removed" "cron remove succeeded"
STAT2=$(tanka-wm cron status 2>&1)
assert_contains "$STAT2" "not installed" "after remove, status → not installed"
RAW_TAB2=$(crontab -l 2>/dev/null || true)
case "$RAW_TAB2" in
  *work-memory-tui*) die "after remove, crontab still contains marker block" ;;
  *) ok "after remove, crontab marker block is cleared" ;;
esac

# ── 8. Install script (install.sh) ──────────────────────────────────
step "8. install.sh (latest version from GitHub Releases)"
INSTALL_DIR="/tmp/tanka-wm-install-test"
rm -rf "$INSTALL_DIR"

# The install script is baked into the image at build time
INSTALL_OUT=$(TANKA_WM_INSTALL_DIR="$INSTALL_DIR" TANKA_WM_NO_MODIFY_PATH=1 \
  bash /usr/local/bin/install.sh 2>&1) || {
  printf '%s\n' "$INSTALL_OUT" | sed 's/^/    | /'
  die "install.sh exited non-zero"
}
printf '%s\n' "$INSTALL_OUT" | sed 's/^/    | /'
assert_contains "$INSTALL_OUT" "checksum verified" "install.sh verifies SHA-256 checksum"
assert_contains "$INSTALL_OUT" "installed" "install.sh reports successful installation"

[ -x "$INSTALL_DIR/tanka-wm" ] || die "installed binary not found or not executable"
INSTALLED_VER=$("$INSTALL_DIR/tanka-wm" --version 2>&1) || die "installed binary failed to run"
assert_contains "$INSTALLED_VER" "tanka-wm" "installed binary runs and prints version"
ok "install.sh installed $INSTALLED_VER to $INSTALL_DIR"

rm -rf "$INSTALL_DIR"

# ── Summary ─────────────────────────────────────────────────────────
step "All passed ✅"
echo "  project:     $PROJECT_NAME ($REMOTE_ID)"
echo "  session:     $SESSION_ID"
echo "  env/backend: $ENVNAME / $BASE_URL"
echo "  data kept:   not cleaned up, log in to $ENVNAME env to inspect the project"
