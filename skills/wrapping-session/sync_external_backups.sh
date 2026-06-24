#!/usr/bin/env bash
# sync_external_backups.sh — auto-back-up external git repos at /wrap.
#
# Reads a newline-delimited list of absolute repo paths from
#   $HOME/.claude/.wrap-backup-targets   (gitignored, machine-local)
# Lines starting with # and blank lines are ignored. For each path that is a git
# work-tree with an `origin` remote, stages everything; if anything changed,
# commits with a timestamp and pushes. Missing config, missing paths, and
# non-repos are skipped silently — so this is a safe no-op on any machine or in
# any project where no targets are configured.
#
# Universal by construction: contains NO personal paths (P68). The personal
# path(s) live only in the gitignored config. Also callable standalone, so a
# shell `notes-sync` alias can simply invoke this (one source of truth).

set -uo pipefail

CONFIG="${HOME}/.claude/.wrap-backup-targets"
if [ ! -f "$CONFIG" ]; then
  echo "external-backup: no targets configured (skip)"
  exit 0
fi

status=0
while IFS= read -r line || [ -n "$line" ]; do
  line="${line%%#*}"                                   # strip trailing comment
  line="$(printf '%s' "$line" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  [ -z "$line" ] && continue
  dir="$line"

  if [ ! -d "$dir/.git" ]; then
    echo "external-backup: skip (not a git repo here): $dir"
    continue
  fi
  if ! git -C "$dir" remote get-url origin >/dev/null 2>&1; then
    echo "external-backup: skip (no origin remote): $dir"
    continue
  fi

  if ! git -C "$dir" add -A; then
    echo "external-backup: git add failed: $dir"; status=1; continue
  fi
  if git -C "$dir" diff --cached --quiet; then
    echo "external-backup: nothing new: $dir"
    continue
  fi
  if git -C "$dir" commit -q -m "wrap backup: $(date '+%Y-%m-%d %H:%M')" && git -C "$dir" push -q; then
    echo "external-backup: pushed ✓ $dir"
  else
    echo "external-backup: commit/push FAILED: $dir"; status=1
  fi
done < "$CONFIG"

exit $status
