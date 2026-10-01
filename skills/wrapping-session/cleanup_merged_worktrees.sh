#!/usr/bin/env bash
# Wrap Step 7d — remove git worktrees whose work is finished. Owner, 2026-09-26 ([redacted] S418):
# "deleting temporary worktrees should be part of the wrapping up".
#
# REMOVES a worktree only when ALL hold:
#   - it is not the main checkout and not the repo this wrap runs in
#   - its branch has a MERGED PR whose head commit IS the worktree's HEAD (`headRefOid`) — a reused
#     branch name, or commits made after the merge, or a never-pushed branch all fail this
#   - no tracked file is modified
#   - no IGNORED file other than a symlink or regenerable junk (tmp/ log/ node_modules/ coverage/):
#     plain `git worktree remove` DELETES ignored files without warning (review S418, reproduced) —
#     a local .env, a notes folder, a DB dump would go silently
#   - no running process has its working directory inside it (a live session / server)
#   - plain `git worktree remove` (NO --force) accepts it
# Branches are NEVER deleted. Everything else is listed with its reason, not touched.
# A check that cannot run (no repo, gh or lsof failing) prints NOT RUN — never "nothing to clean".
# Always exits 0: advisory, a wrap must not stop here.
set -u
top=$(git rev-parse --show-toplevel 2>/dev/null) || { echo "worktree cleanup: NOT RUN (not a git repo)"; exit 0; }
command -v gh >/dev/null 2>&1 || { echo "worktree cleanup: NOT RUN (gh unavailable — cannot see PR state)"; exit 0; }
lsof_out=$(lsof -d cwd -Fn 2>/dev/null) || [ -n "$lsof_out" ] || { echo "worktree cleanup: NOT RUN (lsof failed — cannot see live processes)"; exit 0; }
main=$(git -C "$top" worktree list --porcelain | awk '/^worktree /{print substr($0,10); exit}')
JUNK='^(tmp|log|node_modules|coverage)/'
removed=0; kept=0
while IFS=$'\t' read -r w b; do
  [ -z "$b" ] && continue
  if [ "$w" = "$main" ] || [ "$w" = "$top" ]; then continue; fi
  why=""
  if ! pr=$(gh pr list --head "$b" --state all --json state,headRefOid --jq '.[0] | "\(.state) \(.headRefOid)"' 2>/dev/null); then
    echo "worktree cleanup: NOT RUN (gh pr list failed — auth or network)"; exit 0
  fi
  state=${pr%% *}; oid=${pr#* }
  [ "$state" = "null" ] && state=""
  head=$(git -C "$w" rev-parse HEAD 2>/dev/null)
  if [ "$state" != "MERGED" ]; then why="PR ${state:-none}"
  elif [ "$oid" != "$head" ]; then why="HEAD is not the merged PR's head commit"
  fi
  if [ -z "$why" ]; then
    dirty=$(git -C "$w" status --porcelain --untracked-files=no 2>/dev/null | wc -l | tr -d ' ')
    [ "$dirty" != "0" ] && why="$dirty modified files"
  fi
  if [ -z "$why" ]; then
    precious=""
    while IFS= read -r path; do
      [ -z "$path" ] && continue
      [ -L "$w/${path%/}" ] && continue
      echo "$path" | grep -Eq "$JUNK" && continue
      precious="$path"; break
    done < <(git -C "$w" status --porcelain --ignored=matching 2>/dev/null | sed -n 's/^!! //p')
    [ -n "$precious" ] && why="holds ignored file(s), e.g. $precious"
  fi
  if [ -z "$why" ]; then
    real=$(cd "$w" 2>/dev/null && pwd -P) || real="$w"
    if printf '%s\n' "$lsof_out" | grep -Fx -e "n$real" -e "n$w" >/dev/null ||
       printf '%s\n' "$lsof_out" | grep -F -e "n$real/" -e "n$w/" >/dev/null; then
      why="in use by a running process"
    fi
  fi
  if [ -z "$why" ]; then
    if out=$(git -C "$top" worktree remove "$w" 2>&1); then
      echo "removed  $w ($b)"; removed=$((removed + 1)); continue
    fi
    why="git refused: $(echo "$out" | head -1)"
  fi
  echo "kept     $w ($b) — $why"; kept=$((kept + 1))
done < <(git -C "$top" worktree list --porcelain | awk '/^worktree /{w=substr($0,10)} /^branch /{sub("refs/heads/","",$2); print w"\t"$2}')
echo "worktree cleanup: removed $removed, kept $kept (branches untouched)"
exit 0
