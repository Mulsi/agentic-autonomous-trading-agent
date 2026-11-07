#!/usr/bin/env bash
# The deterministic gate: Claude proposes, code disposes.
# Runs the job's checks itself so no agent can self-report green, and decides
# by rule which changes a human must approve. Agents never override it.
#
#   factory/gate.sh <job-id>      writes factory/jobs/<job-id>/gate.md
#
# Exit 0 = PASS, 1 = FAIL (send back to builder), 2 = TRIPWIRE (stop, human).
set -uo pipefail

# Any changed path matching one of these needs a human, whatever the approver says.
PROTECTED='RISK_POLICY|/src/risk/|/src/execution/|/src/claude/|/src/config/|/src/db/migrations/|/prompts/'
PROTECTED="$PROTECTED"'|^\.claude/|^factory/|^CLAUDE\.md$|^SLICE_1_PLAN\.md$|^Autonomous_Claude|\.env'

# Added lines matching these stop the job: slice 1 has no keys and no real orders.
TRIPWIRES='BINANCE_(API_)?(KEY|SECRET)|X-MBX-APIKEY|/api/v3/order|/fapi/v[0-9]+/order|/sapi/|withdraw'
TRIPWIRES="$TRIPWIRES"'|sk-ant-|(TRADER_MODE|mode).{0,40}["'"'"'`]live["'"'"'`]'

# Test files may name these to prove they are rejected, so they are not scanned.
TEST_FILES='\.spec\.ts$|^local-trading-agent-backend/test/'

JOB="${1:?usage: factory/gate.sh <job-id>}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TREE="$ROOT/.worktrees/$JOB"
OUT="$ROOT/factory/jobs/$JOB/gate.md"
BASE="main"
APP="local-trading-agent-backend"

if [ ! -d "$TREE" ]; then echo "no worktree at $TREE" >&2; exit 1; fi
. "$ROOT/factory/env.sh"

status=0
body=""
note() { body="$body$1"$'\n'; }

check() { # check <label> <command...>
  local label="$1"; shift
  local log
  if log="$("$@" 2>&1)"; then
    note "- PASS \`$label\`"
  else
    note "- FAIL \`$label\`"
    note ""; note '```'; note "$(printf '%s\n' "$log" | tail -30)"; note '```'; note ""
    status=1
  fi
}

note "## Checks"
cd "$TREE/$APP" || exit 1
check "pnpm install --frozen-lockfile" pnpm install --frozen-lockfile
check "pnpm test" pnpm test
check "pnpm lint" pnpm lint
check "pnpm build" pnpm build
cd "$TREE" || exit 1

changed="$(git diff --name-only "$BASE...HEAD")"

note ""; note "## Test integrity"
removed="$(git diff --name-only --diff-filter=D -M "$BASE...HEAD" | grep -E "$TEST_FILES" || true)"
skips=""
while IFS= read -r f; do
  [ -z "$f" ] && continue
  found="$(git diff -U0 "$BASE...HEAD" -- "$f" | grep -E '^\+[^+]' | grep -E '\.(skip|only|todo)\(|\b(xit|xdescribe|fit|fdescribe)\(' || true)"
  if [ -n "$found" ]; then skips="$skips$f"$'\n'"$found"$'\n'; fi
done <<< "$(printf '%s\n' "$changed" | grep -E "$TEST_FILES" || true)"
if [ -n "$removed$skips" ]; then
  status=1
  note "- FAIL tests deleted or skipped:"
  note '```'; note "$removed"; note "$skips"; note '```'
else
  note "- PASS no test deleted or skipped"
fi

note ""; note "## Tripwires"
scan="$(printf '%s\n' "$changed" | grep -Ev "$TEST_FILES" | grep -Ev '\.md$|pnpm-lock\.yaml$' || true)"
hits=""
while IFS= read -r f; do
  [ -z "$f" ] && continue
  found="$(git diff -U0 "$BASE...HEAD" -- "$f" | grep -E '^\+[^+]' | grep -E "$TRIPWIRES" || true)"
  if [ -n "$found" ]; then hits="$hits$f"$'\n'"$found"$'\n'; fi
done <<< "$scan"
if [ -n "$hits" ]; then
  status=2
  note "- TRIPWIRE keys, order endpoints or live mode added:"
  note '```'; note "$hits"; note '```'
else
  note "- PASS none"
fi

note ""; note "## Protected paths"
protected="$(printf '%s\n' "$changed" | grep -E "$PROTECTED" || true)"
if [ -n "$protected" ]; then
  note "These changes need a human:"
  note '```'; note "$protected"; note '```'
  needs_human="yes"
else
  note "None."
  needs_human="no"
fi

case "$status" in
  0) verdict="PASS" ;;
  2) verdict="TRIPWIRE" ;;
  *) verdict="FAIL" ;;
esac

{
  echo "GATE: $verdict"
  echo "NEEDS_HUMAN: $needs_human"
  echo
  printf '%s' "$body"
} > "$OUT"

echo "GATE: $verdict  NEEDS_HUMAN: $needs_human  ($OUT)"
exit "$status"
