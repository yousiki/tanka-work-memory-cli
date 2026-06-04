#!/usr/bin/env bash
# tanka-wm — Linux container "real cron trigger" test.
#
# Covers what container-e2e.sh does not: beyond verifying that
# `tanka-wm cron install` writes the correct crontab, this script starts a
# **real cron daemon**, waits for it to fire `tanka-wm sync` at the next
# minute boundary, and uses the side effects (manifest appearing + sync
# lines in wm.log) to prove the scheduler actually triggered.
#
# Cron's finest granularity is one minute, so we use `* * * * *` (every
# minute boundary) and wait for the next one.
set -uo pipefail
RED=$'\033[31m'; GRN=$'\033[32m'; YLW=$'\033[33m'; DIM=$'\033[2m'; RST=$'\033[0m'
step(){ printf '\n%s▶ %s%s\n' "$YLW" "$*" "$RST"; }
ok(){   printf '%s  ✓ %s%s\n' "$GRN" "$*" "$RST"; }
info(){ printf '%s    %s%s\n' "$DIM" "$*" "$RST"; }
die(){  printf '%s  ✗ %s%s\n' "$RED" "$*" "$RST" >&2; exit 1; }

# ── 0. Environment setup ────────────────────────────────────────────
step "0. Environment setup"
export HOME=/root
export TANKA_WM_HOME="$HOME/.tanka-wm"   # matches default tuiHome — consistent even when cron doesn't inherit this export
mkdir -p "$TANKA_WM_HOME"
LOG="$TANKA_WM_HOME/wm.log"

[ -r /seed/credentials.json ] || die "missing /seed/credentials.json"
TOKEN=$(jq -er '.token' /seed/credentials.json) || die "credentials.json missing token"
ENVNAME=$(jq -er '.env' /seed/credentials.json 2>/dev/null || echo prod)
ENV_VAR="TANKA_API_URL_$(echo "$ENVNAME" | tr '[:lower:]' '[:upper:]')"
BASE_URL="${!ENV_VAR:-}"
[ -n "$BASE_URL" ] || die "env var $ENV_VAR is not set — pass it via docker run -e"
install -m 600 /seed/credentials.json "$TANKA_WM_HOME/credentials.json"
ok "env=${ENVNAME}  token=${TOKEN:0:6}…"

# ── 1. Create project + write config + create session (same as e2e, but do NOT sync upfront) ──
step "1. Prepare isolated project and mock session (kept in pending-upload state)"
PROJECT_NAME="cron-live-$(date +%Y%m%d-%H%M%S)"
CREATE_RESP=$(curl -sS -X POST "$BASE_URL/link/workmemory/auth/project/save" \
  -H "token: $TOKEN" -H 'Content-Type: application/json' \
  -d "$(jq -nc --arg n "$PROJECT_NAME" '{displayName:$n,lookbackDays:14,reportLanguage:"en"}')") \
  || die "project/save failed"
[ "$(jq -r '.code // empty' <<<"$CREATE_RESP")" = "0" ] || die "project/save non-0: $CREATE_RESP"
REMOTE_ID=$(jq -er '.data.projectId' <<<"$CREATE_RESP") || die "no projectId: $CREATE_RESP"
ok "project ${PROJECT_NAME} → ${REMOTE_ID}"

MOCK_CWD=/work/cron-proj; mkdir -p "$MOCK_CWD"
jq -nc --arg cwd "$MOCK_CWD" --arg rid "$REMOTE_ID" --arg name "$PROJECT_NAME" \
  '{version:1,mode:"select",wizardStep:"done",
    cwds:[{id:"cron-proj",name:"cron-proj",cwd:$cwd}],
    projects:[{id:"cron-proj",remoteProjectId:$rid,name:$name,cwdIds:["cron-proj"],origin:"created"}]}' \
  > "$TANKA_WM_HOME/config.json"

ENCODED=$(printf '%s' "$MOCK_CWD" | sed 's/[^a-zA-Z0-9]/-/g')
CC_DIR="$HOME/.claude/projects/$ENCODED"; mkdir -p "$CC_DIR"
SESSION_ID="cron-$(cat /proc/sys/kernel/random/uuid)"
TS=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
{
  jq -nc --arg c "$MOCK_CWD" --arg s "$SESSION_ID" --arg t "$TS" \
    '{type:"summary",cwd:$c,sessionId:$s,version:"1.0.0",gitBranch:"main",timestamp:$t,message:{model:"claude-opus-4-8"}}'
  jq -nc --arg c "$MOCK_CWD" --arg s "$SESSION_ID" --arg t "$TS" \
    '{type:"user",cwd:$c,sessionId:$s,timestamp:$t,message:{role:"user",content:"cron live mock"}}'
} > "$CC_DIR/$SESSION_ID.jsonl"
ok "session ${SESSION_ID} (not yet uploaded)"

MANIFEST="$TANKA_WM_HOME/uploads/$ENVNAME/$REMOTE_ID.json"
[ -f "$MANIFEST" ] && die "manifest should not exist yet"
: > "$LOG"   # clear the log: any sync lines appearing afterward must come from the cron trigger
info "wm.log cleared; manifest does not exist yet — clean baseline before trigger"

# ── 2. Install per-minute cron + start real daemon ──────────────────
# `*/1 * * * *` = every minute. Plain `* * * * *` is rejected by the CLI validator
# (it only accepts expressions that map to fixed intervals).
step "2. Install cron (*/1 * * * *, every minute) and start real cron daemon"
INST=$(tanka-wm cron install "*/1 * * * *" 2>&1) || die "cron install failed: $INST"
info "$INST"
info "actual crontab contents:"
crontab -l 2>/dev/null | sed 's/^/      /'

# debian-slim has no procps (pgrep/ps), use /proc/*/comm to check if cron is running.
cron_running(){ grep -lx cron /proc/[0-9]*/comm >/dev/null 2>&1; }
cron 2>/dev/null || service cron start 2>/dev/null || die "unable to start cron daemon"
sleep 1
cron_running && ok "cron daemon is running" || die "cron daemon did not start"

NOW_S=$(date +%S)
info "current time $(date -u +%H:%M:%S)UTC (sec=${NOW_S}) — waiting for next minute boundary, up to ~$((60-10#$NOW_S+5))s"

# ── 3. Poll for real trigger ────────────────────────────────────────
step "3. Waiting for cron to run sync automatically (up to 140s)"
DEADLINE=$(( $(date +%s) + 140 ))
TRIGGERED=0
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  if [ -f "$MANIFEST" ] && jq -e --arg s "$SESSION_ID" '.[$s]//empty' "$MANIFEST" >/dev/null 2>&1; then
    TRIGGERED=1; break
  fi
  sleep 4
  printf '%s.%s' "$DIM" "$RST"
done
echo
[ "$TRIGGERED" -eq 1 ] || {
  printf '%s  ✗ timed out: cron did not trigger sync within 140s%s\n' "$RED" "$RST" >&2
  echo "  — wm.log contents —"; cat "$LOG" 2>/dev/null | sed 's/^/    /'
  echo "  — processes (/proc/*/comm) —"
  for p in /proc/[0-9]*/comm; do c=$(cat "$p" 2>/dev/null); case "$c" in cron|tanka*) echo "    $c";; esac; done
  exit 1
}

# ── 4. Evidence ─────────────────────────────────────────────────────
step "4. Trigger evidence"
ok "manifest written by cron-triggered sync (session ${SESSION_ID})"
echo "  — [sync] lines in wm.log (all from cron, since log was cleared before trigger) —"
grep -n '\[sync\]\|^sync:' "$LOG" | sed 's/^/    /' || true
UPLOADED=$(grep -c 'uploaded' "$LOG" || true)
info "log contains ${UPLOADED} line(s) with 'uploaded'"
echo "  — manifest contents —"
jq '.' "$MANIFEST" | sed 's/^/    /'

# Clean up the schedule (data is kept by design)
tanka-wm cron remove >/dev/null 2>&1 || true
pkill -x cron 2>/dev/null || true

step "Real cron timer trigger verification passed ✅"
echo "  project:    ${PROJECT_NAME} (${REMOTE_ID})"
echo "  session:    ${SESSION_ID}"
echo "  proof:      cron daemon fired /usr/local/bin/tanka-wm sync at the minute boundary, completing a real upload"
echo "  data kept:  not cleaned up, log in to ${ENVNAME} env to inspect"
