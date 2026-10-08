#!/bin/bash
# Started by launchd each morning (`wf agenda install`). Two deliberately
# separate jobs:
#
#   1. Always: post the day's agenda as a comment, computed by `wf agenda`.
#      This is arithmetic over the snapshot — no model, no cost, nothing to
#      go wrong, and it still works when the assistant is unavailable.
#
#   2. Only when something has actually fallen overdue, and only with
#      --triage: start one headless session to look at those tasks and say
#      something useful about them. No overdue work means no session: waking a
#      model to report "nothing to do" is how an automation becomes noise and
#      gets switched off.
#
# Shares wake.config with the wake trigger and the weekly sweep.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
CONFIG="$HERE/wake.config"
[[ -f "$CONFIG" ]] || { echo "$(date -Iseconds) no wake.config — run: wf wake install" >&2; exit 1; }
# shellcheck source=/dev/null
source "$CONFIG"          # BRIDGE_ROOT, WAKE_DIR, WORK_DIR, CLAUDE_BIN, LOG_FILE
[[ -n "${WAKE_PATH:-}" ]] && export PATH="$WAKE_PATH:$PATH"
export WF_BRIDGE="$BRIDGE_ROOT"

LOG="${LOG_FILE%/*}/claude-agenda.log"
log() { echo "$(date -Iseconds) $*" >> "$LOG"; }

POST_TO="${AGENDA_POST_TO:-}"
TRIAGE="${AGENDA_TRIAGE:-0}"

JSON=$("$HERE/wf" agenda --json 2>>"$LOG") || { log "wf agenda failed"; exit 1; }
OVERDUE=$(printf '%s' "$JSON" | /usr/bin/python3 -c 'import json,sys; print(json.load(sys.stdin)["counts"]["overdue"])')
TODAY=$(printf '%s' "$JSON" | /usr/bin/python3 -c 'import json,sys; print(json.load(sys.stdin)["counts"]["today"])')

# 1 — the digest, always, as long as there is anything to say.
if [[ "$OVERDUE" -gt 0 || "$TODAY" -gt 0 ]]; then
    if [[ -n "$POST_TO" ]]; then
        "$HERE/wf" agenda --post "$POST_TO" >>"$LOG" 2>&1 || log "posting the agenda failed"
    else
        "$HERE/wf" agenda >>"$LOG" 2>&1
    fi
    log "agenda posted — $OVERDUE overdue, $TODAY due today"
else
    log "nothing overdue or due today; no digest, no session"
    exit 0
fi

# 2 — judgement, only where judgement is needed.
if [[ "$TRIAGE" != "1" || "$OVERDUE" -eq 0 ]]; then
    exit 0
fi

command -v "$CLAUDE_BIN" >/dev/null 2>&1 || { log "claude binary not found at $CLAUDE_BIN"; exit 1; }

PROMPT="$OVERDUE task(s) have fallen overdue in WorkFlow. Run 'wf agenda --json' for the
list. For each overdue task: read it with 'wf show <id>', then post ONE short comment
saying what it is waiting on and what the next concrete step is. Where a task is clearly
stale rather than late, say so and propose a new date — do NOT change any due date
yourself, and do not complete anything. Keep it to one comment per task and stop."

cd "$WORK_DIR" 2>/dev/null || cd "$HOME"
log "waking a session to triage $OVERDUE overdue task(s)"
"$CLAUDE_BIN" -p "$PROMPT" >>"$LOG" 2>&1 || log "triage session exited non-zero"
