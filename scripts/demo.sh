#!/usr/bin/env bash
#
# The end-to-end demonstration.
#
# Runs saved capabilities through every path that matters: the happy path, each
# class of runtime exception, the safety refusals, determinism, and the same
# artifact against a second institution. Nothing here is mocked — every line of
# output comes from a real browser driving the simulated core.
#
# Prerequisite:  npm run meridian     (in another terminal)
# Optional:      npm run console      (for the escalation demo)

set -uo pipefail
cd "$(dirname "$0")/.."

export SWIVEL_CRED_MERIDIAN_OPERATOR_ID="${SWIVEL_CRED_MERIDIAN_OPERATOR_ID:-msr01}"
export SWIVEL_CRED_MERIDIAN_PASSWORD="${SWIVEL_CRED_MERIDIAN_PASSWORD:-meridian}"

BOLD=$'\e[1m'; DIM=$'\e[90m'; CYAN=$'\e[36m'; GREEN=$'\e[32m'; RESET=$'\e[0m'
swivel() { npx tsx packages/cli/src/main.ts "$@"; }
BAL="meridian.member-savings-balance"
STOP="meridian.stop-payment"

step() {
  printf '\n%s\n' "${DIM}────────────────────────────────────────────────────────────────────────────${RESET}"
  printf '%s\n' "${BOLD}${CYAN}▸ $1${RESET}"
  printf '%s\n\n' "${DIM}  $2${RESET}"
}

if ! curl -sf -o /dev/null http://127.0.0.1:4711/; then
  echo "MERIDIAN is not running. Start it first:  npm run meridian"
  exit 1
fi
curl -sf -X POST http://127.0.0.1:4711/__sim/reset > /dev/null

printf '\n%s\n' "${BOLD}  ◧ SWIVEL — end-to-end demonstration${RESET}"
printf '%s\n' "${DIM}  Everything below replays saved capabilities. No model is consulted.${RESET}"

step "1 · The catalogue" "Two capabilities, recorded by a model against a live legacy UI."
swivel list

step "2 · Deterministic replay" "Typed inputs in, typed outputs out. Zero model calls."
swivel replay "$BAL" --tenant pineridge --input memberNumber=0100482 --input "shareType=SPECIAL SAVINGS"

step "3 · A business outcome, not a crash" "'No such member' is an answer the calling agent branches on."
swivel replay "$BAL" --tenant pineridge --input memberNumber=9999999 --input "shareType=SPECIAL SAVINGS" --quiet --no-escalate

step "4 · Recovery: the session times out mid-flow" \
     "Re-authenticates on the same browser session and restarts — safe, because nothing was committed yet."
swivel replay "$BAL" --tenant pineridge --input memberNumber=0100482 --input "shareType=SPECIAL SAVINGS" \
  --inject session-expiry-midflow --no-escalate

step "5 · Recovery: a BSA/OFAC notice interposes itself" \
     "A flagged member raises a compliance interstitial. It is acknowledged, and the step's own checkpoint confirms the record opened."
swivel replay "$BAL" --tenant pineridge --input memberNumber=0331207 --input "shareType=REGULAR SHARE" --no-escalate

step "6 · Safety: an irreversible capability, no confirmation token" \
     "Refused in milliseconds, before a browser is even opened."
swivel replay "$STOP" --tenant pineridge --input memberNumber=0100482 --input checkNumber=1042 --input amount=412.50 \
  --quiet --no-escalate

step "7 · Safety: authority the operator does not have" \
     "A teller attempts a supervisor-level transaction. The core refuses; Swivel reports it as a business outcome."
SWIVEL_CRED_MERIDIAN_OPERATOR_ID=tlr07 swivel replay "$STOP" --tenant pineridge \
  --input memberNumber=0100482 --input checkNumber=1042 --input amount=412.50 \
  --confirm "change-ticket-CHG-4471" --quiet --no-escalate

step "8 · The core is in end-of-day processing" "A retryable business outcome — not an incident."
swivel replay "$STOP" --tenant pineridge --input memberNumber=0100482 --input checkNumber=1042 --input amount=412.50 \
  --confirm "change-ticket-CHG-4471" --inject eod-lockout --quiet --no-escalate
curl -sf -X POST http://127.0.0.1:4711/__sim/reset > /dev/null

step "9 · Authorised, confirmed, and posted" \
     "A supervisor, an explicit change ticket as the confirmation token, and a real state change."
SWIVEL_CRED_MERIDIAN_OPERATOR_ID=sup02 swivel replay "$STOP" --tenant pineridge \
  --input memberNumber=0100482 --input checkNumber=1042 --input amount=412.50 \
  --confirm "change-ticket-CHG-4471" --no-escalate
printf '\n%s\n' "${DIM}  The core's own maintenance log, proving the side effect:${RESET}"
curl -s http://127.0.0.1:4711/__sim/audit | head -c 600; echo

step "10 · Determinism" "Five consecutive replays. Same inputs, same outcome, same outputs."
swivel stability "$BAL" --tenant pineridge --runs 5 --input memberNumber=0100482 --input "shareType=SPECIAL SAVINGS"

step "11 · The control experiment: the same artifact, no overlay" \
     "Before claiming the overlay does the work, show what happens without it. The engine refuses rather than reading the wrong column."
swivel replay "$BAL" --tenant harborpoint --no-overlay --no-escalate \
  --input memberNumber=0100482 --input "shareType=SPECIAL SAVINGS" || true

step "12 · A second institution on the same vendor product" \
     "Different words, different control ids, an inserted column, and a screen this build collapses. One overlay."
swivel overlay check "$BAL" --tenant harborpoint
swivel replay "$BAL" --tenant harborpoint --input memberNumber=0100482 --input "shareType=SPECIAL SAVINGS" --no-escalate

step "13 · Evidence" "Every run leaves a hash-chained bundle. Any edit to it is detectable."
LAST=$(ls -t evidence/runs | head -1)
swivel verify "evidence/runs/$LAST"

printf '\n%s\n\n' "${GREEN}  Done. Open the console for the catalogue, evidence and operator queue:  npm run console${RESET}"
