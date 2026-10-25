#!/usr/bin/env bash
# Known-answer canary for check-subagent-restore.js (2026-10-12).
# Both directions: a subagent's work-discarding git command MUST block (exit 2);
# branch work, read-only git, quoted text and ALL main-session calls MUST pass (exit 0).
set -u
HOOK="${HOOK:-$HOME/.claude/hooks/check-subagent-restore.js}"
pass=0; fail=0
run() { # who(sub|main) expect(0|2) command
  local id=""; [ "$1" = sub ] && id='"agent_id":"a123",'
  local payload; payload=$(node -e 'process.stdout.write(JSON.stringify({tool_name:"Bash",tool_input:{command:process.argv[1]}}))' "$3")
  payload="{${id}${payload#\{}"
  printf '%s' "$payload" | node "$HOOK" >/dev/null 2>&1; local rc=$?
  if [ "$rc" = "$2" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "  FAIL [$1 expect $2 got $rc] $3"; fi
}
echo "MUST BLOCK (subagent)"
run sub 2 'git checkout -- app/models/item.rb'
run sub 2 'git checkout .'
run sub 2 'git checkout HEAD -- .'
run sub 2 'git -C ~/dev/[redacted] checkout -- app'
run sub 2 'git restore src/a.rb'
run sub 2 'git restore .'
run sub 2 'git stash'
run sub 2 'git stash push -m tmp'
run sub 2 'git stash drop'
run sub 2 'git clean -fd'
run sub 2 'git reset --hard'
run sub 2 'git reset --hard origin/master'
run sub 2 'git checkout -f main'
run sub 2 'ls && git restore --worktree x.rb'
run sub 2 '(git restore .)'
run sub 2 'x=$(git stash)'
run sub 2 'echo `git checkout -- a.rb`'
run sub 2 '{ git reset --hard; }'
run sub 2 'bash -c "git checkout -- ."'
run sub 2 "sh -c 'git clean -fd'"
run sub 2 'eval "git restore src"'
run sub 2 'echo a.rb | xargs git checkout --'
run sub 2 'git -c core.x=1 checkout -- a.rb'
run sub 2 '/usr/bin/git checkout -- a.rb'
run sub 2 'git --work-tree=/x --git-dir=/x/.git restore .'
run sub 2 'GIT_DIR=/x/.git git reset --hard'
# Heredoc controls (hook-review 2026-10-15): a heredoc a SHELL runs, an unquoted heredoc
# whose body substitutes, and a real command AFTER a prose heredoc must all still block.
run sub 2 $'bash <<\'EOF\'\ngit checkout -- a.rb\nEOF'
run sub 2 $'cat <<EOF | sh\ngit stash\nEOF'
run sub 2 $'cat <<EOF > notes.md\n$(git checkout -- a.rb)\nEOF'
run sub 2 $'cat > notes.md <<\'EOF\'\nprose\nEOF\ngit checkout -- a.rb'
run sub 2 'echo "x" && echo `git restore a.rb`'
echo "MUST PASS"
run sub 0 'git checkout -b feat/x origin/master'
run sub 0 'git checkout main'
run sub 0 'git restore --staged x.rb'
run sub 0 'git stash list'
run sub 0 'git status && git diff'
run sub 0 'echo "never run git reset --hard here"'
run sub 0 'git reset HEAD~1'
# Report prose is data (hook-review 2026-10-15: 11 of 40 live fires 10-01..10-15 were a
# subagent WRITING its report about the blocked command, then blocked again for the prose).
run sub 0 $'cat >> notes.md <<\'EOF\'\nthe hook blocked `git checkout -- Gemfile.lock`, so the main session must restore it.\nEOF'
run sub 0 $'mkdir -p d && cat > d/r.md <<\'EOF\'\n**F1.** `git stash` was refused; nothing discarded.\nEOF'
run sub 0 'echo "blocked \`git checkout -- Gemfile.lock\`, main must restore" >> notes.md'
run main 0 'git checkout -- app/models/item.rb'
run main 0 'git stash'
echo "pass=$pass fail=$fail"; [ "$fail" -eq 0 ]
