#!/usr/bin/env bash
# scripts/plan-mirror-check.sh
#
# What this is for
#   `bun scripts/plan-publish.mjs --check --all` exits 1 when any plan mirror
#   in the Obsidian vault is missing or stale. Nothing ran it on a schedule, so
#   drift was only ever noticed when a human happened to remember to look. This
#   wraps that check so it runs daily and its verdict is recorded whether or not
#   anyone is watching.
#
# Why a local systemd --user timer and NOT a GitHub Actions workflow
#   plans.publish.json points `vault` at an absolute local path
#   (~/Dokumen/Obsidian Vault) and enumerates the Snipset, ram-audit and
#   ai-skills repositories by absolute path. A workflow on a GitHub runner can
#   see none of that. It would either fail permanently on the missing vault
#   path, or pass vacuously by enumerating zero plans and reporting "all
#   mirrors match". A gate that passes vacuously is worse than no gate at all,
#   because it manufactures confidence that was never earned. The check needs
#   the vault, this repository, and two sibling repositories -- precisely the
#   things that a checkout of a single repository does not have. Drift here is
#   a property of one machine's filesystem, so the watchdog belongs to one
#   machine, and a systemd --user timer is the honest place to put it.
#
# Contract
#   exit 0  every mirror matches its source
#   exit 1  at least one mirror is missing or stale
#   exit 127  the check could not be run at all (bun missing, repo gone)
#   The check's status is propagated on purpose. Swallowing it would make this
#   a log-dumper instead of a watchdog, and systemd --user is precisely what
#   turns the non-zero status into something visible: a failed unit shows up in
#   `systemctl --user --failed` without anyone having to read the log.
#
# Safety
#   This script only ever runs the publisher in --check mode, which never
#   writes to the vault. There is deliberately no publish path in this file.
#
# Log
#   ~/.local/state/plan-mirror/mirror-check.log, one bounded record per run:
#   a verdict line, the publisher's own summary, and at most 20 detail lines.
#   The file is trimmed back to MAX_RECORDS lines after each run, so a daily
#   job cannot grow it forever. Both the per-record and total size are capped;
#   capping only one of them would still let the log grow without bound.
#
# Disable
#   systemctl --user disable --now plan-mirror-check.timer
#   systemctl --user reset-failed plan-mirror-check.service
#   Units live in ~/.config/systemd/user/. To forget the thing entirely:
#   rm those two unit files, then `systemctl --user daemon-reload`.
set -euo pipefail

# Resolve the repository root from this file's own location, so the script
# works from any working directory. The repo path contains no spaces, but the
# vault path does ("Obsidian Vault"), so every expansion below stays quoted.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

LOG_DIR="$HOME/.local/state/plan-mirror"
LOG_FILE="$LOG_DIR/mirror-check.log"
MAX_RECORDS=500   # ~22 runs of history, trimmed after every run
MAX_DETAIL=20     # failing plans listed per run; the summary line has the true count

mkdir -p "$LOG_DIR"

# systemd --user services start with a minimal environment, so a bare `bun`
# that works in an interactive shell may not be on PATH here. Fall back to the
# standard bun install location before giving up.
BUN_BIN="$(command -v bun || true)"
if [ -z "$BUN_BIN" ] && [ -x "$HOME/.bun/bin/bun" ]; then
  BUN_BIN="$HOME/.bun/bin/bun"
fi

if [ -z "$BUN_BIN" ]; then
  printf '%s exit=127 could not run check: bun not found on PATH or at $HOME/.bun/bin/bun\n' \
    "$(date -Is)" >>"$LOG_FILE"
  echo "plan-mirror-check: bun not found on PATH or at \$HOME/.bun/bin/bun" >&2
  exit 127
fi

# Run the check from the repository root. `--all` because we want the whole
# vault, not one plan. Capturing combined output lets us record the publisher's
# own summary line, which is the one line worth keeping in the log.
run_output="$(cd "$REPO_DIR" && "$BUN_BIN" scripts/plan-publish.mjs --check --all 2>&1)" && status=0 || status=$?

# The publisher prints its verdict as "All N mirror(s) match their source." or
# "N/M mirror(s) drifted or missing."; both land on stderr, hence 2>&1 above.
summary="$(printf '%s\n' "$run_output" | grep -E 'mirror\(s\)' | tail -n 1 || true)"
if [ -z "$summary" ]; then
  summary="(publisher printed no summary line)"
fi

stamp="$(date -Is)"
if [ "$status" -eq 0 ]; then
  verdict="clean"
else
  verdict="DRIFT"
fi

# One record, appended then trimmed. Written with >> deliberately: the log is
# an append-only audit trail, and clobbering it would destroy history.
{
  printf '%s exit=%s %s %s\n' "$stamp" "$status" "$verdict" "$summary"
  if [ "$status" -ne 0 ]; then
    printf '%s\n' "$run_output" | grep -E '❌|⚠️|Error|error' | head -n "$MAX_DETAIL" || true
  fi
} >>"$LOG_FILE"

# Keep the log bounded. tail into a temp file, then move it over the original
# in one step -- a plain in-place rewrite would leave a truncated log if the
# script were interrupted mid-write.
if [ -f "$LOG_FILE" ]; then
  current_lines="$(wc -l <"$LOG_FILE")"
  if [ "$current_lines" -gt "$MAX_RECORDS" ]; then
    tail -n "$MAX_RECORDS" "$LOG_FILE" >"$LOG_FILE.tmp"
    mv -f "$LOG_FILE.tmp" "$LOG_FILE"
  fi
fi

# Echo the check's own output so the timer runs in the journal read like a
# normal command, and re-propagate the real status as our exit status.
printf '%s\n' "$run_output"
exit "$status"
