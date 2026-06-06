#!/usr/bin/env bash
#
# coordinator.sh — orchestrates the 8 parallel feature branches that push
# every quality dimension of Tessera to 8-9.
#
# Responsibilities:
#   1. (optional) create the 8 feature branches from `main`
#   2. monitor CI on each branch's PR
#   3. merge the branches into `main` in a fixed dependency-aware order,
#      pausing for manual conflict resolution when a merge is not clean.
#
# This script is intentionally thin: the per-branch implementation work is
# done by separate Devin sessions (one per branch). The coordinator only
# manages branch lifecycle, CI gating, and ordered integration.
#
# Requirements: git, gh (authenticated against the Tessera remote), jq.
#
# Usage:
#   scripts/coordinator.sh create    # create+push the 8 branches off main
#   scripts/coordinator.sh status    # print CI status for every branch's PR
#   scripts/coordinator.sh merge     # merge branches into main in order
#   scripts/coordinator.sh all       # status (must be green) then merge
#
set -euo pipefail

# --- configuration ----------------------------------------------------------

REPO="${TESSERA_REPO:-kennguy3n/Tessera}"
BASE_BRANCH="${TESSERA_BASE:-main}"

# All 8 work-stream branches.
BRANCHES=(
  "arch/migration-framework"
  "feat/editor-enhancements"
  "feat/tasks-automations-v2"
  "perf/large-corpus"
  "opt/install-size"
  "sec/fido2-pqc"
  "dx/maintainability"
  "feat/kchat-v2"
)

# Merge order is dependency-aware: foundational/infra branches first
# (architecture, optimization, performance, security, developer-experience),
# then the larger feature branches (editors, tasks, kchat) which are most
# likely to carry conflicts and benefit from rebasing onto the others.
MERGE_ORDER=(
  "arch/migration-framework"
  "opt/install-size"
  "perf/large-corpus"
  "sec/fido2-pqc"
  "dx/maintainability"
  "feat/editor-enhancements"
  "feat/tasks-automations-v2"
  "feat/kchat-v2"
)

log()  { printf '\033[1;34m[coordinator]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[coordinator]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[coordinator]\033[0m %s\n' "$*" >&2; exit 1; }

require() { command -v "$1" >/dev/null 2>&1 || die "missing required tool: $1"; }

# --- commands ---------------------------------------------------------------

cmd_create() {
  require git
  git fetch origin "$BASE_BRANCH"
  for b in "${BRANCHES[@]}"; do
    if git ls-remote --exit-code --heads origin "$b" >/dev/null 2>&1; then
      log "branch already exists on origin: $b (skipping)"
      continue
    fi
    log "creating branch $b from origin/$BASE_BRANCH"
    git branch "$b" "origin/$BASE_BRANCH"
    git push origin "$b"
  done
}

# Print the CI rollup state for a branch's PR. Echoes one of:
#   SUCCESS | FAILURE | PENDING | NO_PR
pr_state() {
  local branch="$1"
  local json
  json="$(gh pr list --repo "$REPO" --head "$branch" --state open \
            --json number,statusCheckRollup 2>/dev/null || true)"
  if [[ -z "$json" || "$json" == "[]" ]]; then
    echo "NO_PR"; return
  fi
  # Reduce the rollup to a single verdict.
  echo "$json" | jq -r '
    .[0].statusCheckRollup as $checks
    | if ($checks | length) == 0 then "PENDING"
      elif ([$checks[] | select((.conclusion // .state) == "FAILURE"
            or (.conclusion // .state) == "ERROR"
            or (.conclusion // .state) == "CANCELLED"
            or (.conclusion // .state) == "TIMED_OUT")] | length) > 0 then "FAILURE"
      elif ([$checks[] | select((.conclusion // .state) == "SUCCESS"
            or (.conclusion // .state) == "NEUTRAL"
            or (.conclusion // .state) == "SKIPPED")] | length)
           == ($checks | length) then "SUCCESS"
      else "PENDING" end'
}

cmd_status() {
  require gh; require jq
  local all_green=1
  for b in "${BRANCHES[@]}"; do
    local state; state="$(pr_state "$b")"
    printf '  %-30s %s\n' "$b" "$state"
    [[ "$state" == "SUCCESS" ]] || all_green=0
  done
  if [[ "$all_green" -eq 1 ]]; then
    log "all branches green"; return 0
  fi
  warn "not all branches are green yet"; return 1
}

cmd_merge() {
  require gh; require jq; require git
  git fetch origin "$BASE_BRANCH"
  for b in "${MERGE_ORDER[@]}"; do
    local state; state="$(pr_state "$b")"
    if [[ "$state" != "SUCCESS" ]]; then
      warn "skipping $b — CI state is $state (must be SUCCESS to merge)"
      continue
    fi
    log "merging $b into $BASE_BRANCH"
    # --merge keeps full history; CI on the PR is already green. If GitHub
    # reports the branch is not mergeable (conflicts), stop so a human (or
    # the owning session) can rebase/resolve before re-running.
    if ! gh pr merge --repo "$REPO" --merge --delete-branch \
          "$(gh pr list --repo "$REPO" --head "$b" --state open --json number -q '.[0].number')"; then
      die "merge of $b failed (likely conflicts) — resolve, push, and re-run 'merge'"
    fi
    git fetch origin "$BASE_BRANCH"
  done
  log "merge sequence complete"
}

main() {
  local sub="${1:-all}"
  case "$sub" in
    create) cmd_create ;;
    status) cmd_status ;;
    merge)  cmd_merge ;;
    all)    cmd_status && cmd_merge ;;
    *) die "usage: $0 {create|status|merge|all}" ;;
  esac
}

main "$@"
