#!/usr/bin/env bash
# Canary for check-d-entry-timing.js.
#
# The hook's whole value is that its predicate can FAIL and can PASS on inputs you
# can construct (P72). A gate that blocks everything, or nothing, carries no
# information — so this canary asserts BOTH directions, and §5 proves its own teeth
# by mutating the hook and demanding the mutant get caught.
#
# Run: bash ~/.claude/hooks/tests/d-entry-timing-canary.sh

set -uo pipefail

HOOK="$HOME/.claude/hooks/check-d-entry-timing.js"
TMP="$(mktemp -d)"

# ONE cleanup, registered ONCE. Each mutation section appends its file to $MUTANTS
# instead of re-registering a trap listing every mutant so far — that pattern was
# correct but required whoever adds §13 to remember §8's, §10's AND §12's files, and
# forgetting one strands a MUTATED COPY OF A LIVE GATE in the hooks dir. INT/TERM/HUP
# as well as EXIT: a bash EXIT trap does NOT run on SIGINT, and Ctrl-C during this
# canary stranded exactly that (verified). No hook loads by directory glob, so it
# could never fire as a gate — but it is untracked in a repo whose wrap stages
# broadly, i.e. a mutated commit-gate could be committed.
MUTANTS=""
cleanup() { rm -rf "$TMP"; [ -n "$MUTANTS" ] && rm -f $MUTANTS; return 0; }
trap cleanup EXIT INT TERM HUP

pass=0; fail=0
ok()   { printf '  ✓ %s\n' "$1"; pass=$((pass+1)); }
bad()  { printf '  ✗ %s\n' "$1"; fail=$((fail+1)); }

# Run the hook against repo $1 with a `git commit` payload; echo its exit code.
run_hook() {
  local repo="$1"
  printf '{"tool_input":{"command":"git -C %s commit -m x"}}' "$repo" \
    | node "$HOOK" >/dev/null 2>&1
  echo $?
}

new_repo() {
  local repo="$TMP/$1"
  mkdir -p "$repo/docs" "$repo/learnings"
  git -C "$repo" init -q
  git -C "$repo" config user.email t@t.t
  git -C "$repo" config user.name t
  # A decisions.md with one pre-existing entry, committed so later diffs are real.
  printf '# Decisions\n\n### D001 — first\n\nbody\n' > "$repo/docs/decisions.md"
  git -C "$repo" add -A
  git -C "$repo" commit -qm base
  echo "$repo"
}

echo "== §1 BLOCKS: new D-entry staged alongside a wrap artifact =="
r=$(new_repo block1)
printf '\n### D144 — authored at wrap\n\nbody\n' >> "$r/docs/decisions.md"
printf '# S200\n' > "$r/learnings/2026-01-01-s200.md"
git -C "$r" add -A
rc=$(run_hook "$r")
[ "$rc" = "2" ] && ok "exit 2 (blocked)" || bad "expected exit 2, got $rc"

echo "== §2 PASSES: the same D-entry committed ALONE (decision-time commit) =="
r=$(new_repo pass_alone)
printf '\n### D144 — authored when decided\n\nbody\n' >> "$r/docs/decisions.md"
git -C "$r" add -A
rc=$(run_hook "$r")
[ "$rc" = "0" ] && ok "exit 0 (allowed)" || bad "expected exit 0, got $rc"

echo "== §3 PASSES: wrap commit that only EDITS existing entry prose =="
r=$(new_repo pass_edit)
# Change the BODY of D001; add no new `### D<n>` heading.
printf '# Decisions\n\n### D001 — first\n\nbody, reworded at wrap\n' > "$r/docs/decisions.md"
printf '# S200\n' > "$r/learnings/2026-01-01-s200.md"
git -C "$r" add -A
rc=$(run_hook "$r")
[ "$rc" = "0" ] && ok "exit 0 (allowed)" || bad "expected exit 0, got $rc"

echo "== §4 PASSES: wrap artifacts with no decisions.md at all =="
r=$(new_repo pass_wraponly)
printf '# S200\n' > "$r/learnings/2026-01-01-s200.md"
git -C "$r" add -A
rc=$(run_hook "$r")
[ "$rc" = "0" ] && ok "exit 0 (allowed)" || bad "expected exit 0, got $rc"

echo "== §5 PASSES: not a git commit at all (hook must ignore other Bash) =="
r=$(new_repo pass_notcommit)
printf '\n### D144 — x\n' >> "$r/docs/decisions.md"
printf '# S200\n' > "$r/learnings/2026-01-01-s200.md"
git -C "$r" add -A
rc=$(printf '{"tool_input":{"command":"git -C %s status"}}' "$r" | node "$HOOK" >/dev/null 2>&1; echo $?)
[ "$rc" = "0" ] && ok "exit 0 (ignored)" || bad "expected exit 0, got $rc"

echo "== §6 BLOCKS through git global options (git -c k=v commit bypass) =="
r=$(new_repo block_globalopt)
printf '\n### D145 — x\n' >> "$r/docs/decisions.md"
printf '# S200\n' > "$r/learnings/2026-01-01-s200.md"
git -C "$r" add -A
rc=$(printf '{"tool_input":{"command":"git -c core.pager=cat -C %s commit -m x"}}' "$r" \
      | node "$HOOK" >/dev/null 2>&1; echo $?)
[ "$rc" = "2" ] && ok "exit 2 (blocked)" || bad "expected exit 2, got $rc"

# The gate must survive COMPOUND commands. §1-§6 all probe a single `git … commit …` segment, and
# that single shape is exactly why the dispatch bug shipped green: matchGitCommit used to
# `return {matched:false}` on the FIRST git segment that was not `commit`, so `git add -A && git
# commit` — the house workflow's actual invocation — sailed straight through a gate that reported
# "passed N, failed 0". A canary that only tests the shape the parser already handles certifies nothing.
echo "== §6b BLOCKS through compound commands (the real workflow invocation) =="
r=$(new_repo block_compound)
printf '\n### D148 — x\n' >> "$r/docs/decisions.md"
printf '# S200\n' > "$r/learnings/2026-01-01-s200.md"
git -C "$r" add -A
for sub in "add -A" "status" "diff --cached"; do
  form="git -C $r $sub && git -C $r commit -m x"
  rc=$(printf '{"tool_input":{"command":"%s"}}' "$form" | node "$HOOK" >/dev/null 2>&1; echo $?)
  if [ "$rc" = "2" ]; then ok "exit 2 — git $sub && git commit"; else bad "expected 2, got $rc — git $sub && git commit"; fi
done

echo "== §6c BLOCKS through NEWLINE-separated commands (the form /wrap actually emits) =="
# WHY THIS CASE EXISTS: §6b above tested `&&`, `;` and pipes and passed — while the
# gate was DARK on a multi-LINE Bash cell, which is what /wrap Step 8 sends. The
# segment class excluded `| ; &` but not newline, so the greedy match swallowed the
# line breaks, read `add` as the subcommand and resumed scanning past the commit.
# Measured on S183's real wrap command (3 D-entries + learnings/ staged): exit 0.
# §6b's author reached for shell metacharacters; the harness's separator is \n.
# A suite of compound-command cases that omits the one the workflow uses is a
# fixture built so the failing case cannot arise.
r=$(new_repo block_newline)
printf '\n### D149 — x\n' >> "$r/docs/decisions.md"
printf '# S201\n' > "$r/learnings/2026-01-01-s201.md"
git -C "$r" add -A
# `\n` stays literal through printf's %s and is decoded by the hook's JSON parse.
for form in \
  "git -C $r add -A\\ngit -C $r commit -m x" \
  "git -C $r add -A\\ngit -C $r status --short\\ngit -C $r commit -q -F -" ; do
  rc=$(printf '{"tool_input":{"command":"%s"}}' "$form" | node "$HOOK" >/dev/null 2>&1; echo $?)
  if [ "$rc" = "2" ]; then ok "exit 2 — newline form ($(printf '%s' "$form" | tr -d '\n' | cut -c1-40)…)"
  else bad "expected 2, got $rc — newline form: $form"; fi
done
# BOTH DIRECTIONS: a multi-line cell with no commit in it must still be ignored,
# so the fix is "newline is a separator", not "match any cell mentioning git".
rc=$(printf '{"tool_input":{"command":"git -C %s add -A\\ngit -C %s status --short"}}' "$r" "$r" \
  | node "$HOOK" >/dev/null 2>&1; echo $?)
[ "$rc" = "0" ] && ok "exit 0 — newline form with NO commit is ignored" \
  || bad "expected 0, got $rc — newline form without a commit"

echo "== §6d EVALUATES when -C carries an UNEXPANDED shell variable =="
# A PreToolUse hook receives the command TEXT, so `git -C \$W commit` gives it the
# literal `\$W`; `git -C '\$W' diff --cached` fatals and the catch exited 0. SILENT,
# on the worktree form the house uses for every parent-repo commit (S183's Rails WIP
# commit was `git -C "\$W" commit -q -F -`). §1-§6c all missed it because every one
# passes a LITERAL path — it only surfaced by committing through the real harness.
# Behaviour now: fall back to the cwd repo and announce the substitution.
r=$(new_repo unexpanded)
printf '\n### D150 — x\n' >> "$r/docs/decisions.md"
printf '# S202\n' > "$r/learnings/2026-01-01-s202.md"
git -C "$r" add -A
# cwd IS the repo here, so the fallback has something real to evaluate.
out=$(cd "$r" && printf '{"tool_input":{"command":"git -C \\"$W\\" commit -m x"}}' | node "$HOOK" 2>&1 >/dev/null; :)
rc=$(cd "$r" && printf '{"tool_input":{"command":"git -C \\"$W\\" commit -m x"}}' | node "$HOOK" >/dev/null 2>&1; echo $?)
[ "$rc" = "2" ] && ok "exit 2 — unexpanded -C falls back to cwd and still blocks" \
  || bad "expected 2, got $rc — unexpanded -C went dark"
case "$out" in *"could not be expanded"*) ok "the substitution is ANNOUNCED, not silent";;
  *) bad "no NOTE emitted — a gate that swaps its target must say so";; esac
# BOTH DIRECTIONS: unexpanded -C with a clean cwd repo must NOT block.
r2=$(new_repo unexpanded_clean)
rc=$(cd "$r2" && printf '{"tool_input":{"command":"git -C \\"$W\\" commit -m x"}}' | node "$HOOK" >/dev/null 2>&1; echo $?)
[ "$rc" = "0" ] && ok "exit 0 — unexpanded -C, nothing staged in cwd repo" \
  || bad "expected 0, got $rc — fallback must not block a clean repo"

echo "== §7 escape valves =="
r=$(new_repo valves)
printf '\n### D146 — x\n' >> "$r/docs/decisions.md"
printf '# S200\n' > "$r/learnings/2026-01-01-s200.md"
git -C "$r" add -A
rc=$(printf '{"tool_input":{"command":"git -C %s commit -m x"}}' "$r" \
      | CLAUDE_D_ENTRY_TIMING_SKIP=1 node "$HOOK" >/dev/null 2>&1; echo $?)
[ "$rc" = "0" ] && ok "SKIP=1 allows" || bad "SKIP=1 expected 0, got $rc"
rc=$(printf '{"tool_input":{"command":"git -C %s commit -m x"}}' "$r" \
      | CLAUDE_D_ENTRY_TIMING_WARN_ONLY=1 node "$HOOK" >/dev/null 2>&1; echo $?)
[ "$rc" = "0" ] && ok "WARN_ONLY=1 allows" || bad "WARN_ONLY=1 expected 0, got $rc"

echo "== §8 TEETH: a mutant that ignores the wrap-artifact half must be CAUGHT =="
# If the hook blocked on "new D-entry" alone, §2 (the decision-time commit we WANT)
# would break. Prove this canary would notice, by running that exact mutant.
#
# The mutant MUST live beside the real hook: it inherits `require('./lib/hook-input.js')`,
# which resolves relative to the script's own directory. Run it from a temp dir and the
# require throws, the guard's fail-open path prints "DISABLED" and exits 0 — the mutant
# then "passes" for a reason that has nothing to do with the mutation, and §8 silently
# certifies a canary with no teeth. (Observed on this canary's first run.)
MUT="$HOME/.claude/hooks/.d-entry-timing-mutant.tmp.js"
# INT/TERM/HUP as well as EXIT: a bash EXIT trap does NOT run on SIGINT, so Ctrl-C during
# the canary stranded a MUTATED copy of the gate in the live hooks dir (verified). No hook is
# loaded by directory glob, so it could never fire as a gate — but it is untracked in a repo whose
# wrap stages broadly, i.e. a mutated commit-gate could be committed.
MUTANTS="$MUTANTS $MUT"
sed 's|^if (wrapHits.length === 0) process.exit(0);.*$|// mutated: wrap-artifact half removed|' "$HOOK" > "$MUT"
# Positive control: the mutation must actually have landed, else §8 tests the original.
if grep -q 'wrapHits.length === 0' "$MUT"; then
  bad "mutation did NOT apply — §8 would be testing the unmutated hook"
fi
r=$(new_repo teeth)
printf '\n### D147 — decision-time, alone\n' >> "$r/docs/decisions.md"
git -C "$r" add -A
rc=$(printf '{"tool_input":{"command":"git -C %s commit -m x"}}' "$r" | node "$MUT" >/dev/null 2>&1; echo $?)
if [ "$rc" = "2" ]; then
  ok "mutant blocks the decision-time commit — §2 has teeth"
else
  bad "mutant was NOT caught (got $rc) — §2 cannot discriminate; the canary is theatre"
fi

echo "== §9 EVALUATES the PROSPECTIVE index, not the one that exists at hook time =="
# WHY THIS SECTION EXISTS (S186)
#   A PreToolUse hook runs before the shell, so on a `git add … && git commit` cell
#   `--cached` reports the index BEFORE the add — empty on a fresh wrap — and the gate
#   exited 0. Dark on the exact shape /wrap emits; worked around by hand twice in S185.
#   §6b/§6c already covered compound and newline cells and passed through both the
#   broken and fixed hook, because they `git add -A` FIRST and only then invoke the
#   hook. They vary the SEPARATOR; the bug was in the INDEX. Every case below leaves
#   the index deliberately EMPTY, so the hook must reconstruct the commit from the
#   cell's own `git add` args to see anything at all.

# Run the hook against an arbitrary command string; echo its exit code.
run_cmd() {
  printf '{"tool_input":{"command":%s}}' "$1" | node "$HOOK" >/dev/null 2>&1
  echo $?
}

r=$(new_repo prospective)
printf '\n### D200 — authored at wrap\n\nbody\n' >> "$r/docs/decisions.md"
printf '# S200\n' > "$r/learnings/2026-01-01-s200.md"
# NOTE: no `git add` here. The index is empty; only the cell text says what lands.
rc=$(run_cmd "\"git -C $r add docs/decisions.md learnings/2026-01-01-s200.md && git -C $r commit -m wrap\"")
[ "$rc" = "2" ] && ok "exit 2 — combined add+commit, nothing pre-staged" || bad "expected 2, got $rc (DARK)"

rc=$(run_cmd "\"git -C $r add -A\ngit -C $r commit -m wrap\"")
[ "$rc" = "2" ] && ok "exit 2 — newline form, add -A, nothing pre-staged" || bad "expected 2, got $rc (DARK)"

# Both directions (P72): the decision-time commit must still PASS through the same path.
r=$(new_repo prospective_alone)
printf '\n### D201 — authored when decided\n' >> "$r/docs/decisions.md"
rc=$(run_cmd "\"git -C $r add docs/decisions.md && git -C $r commit -m 'D201'\"")
[ "$rc" = "0" ] && ok "exit 0 — decisions.md alone via add+commit still allowed" || bad "expected 0, got $rc"

# An add in a DIFFERENT repo must not be folded into this commit's file set.
r=$(new_repo prospective_other); r2=$(new_repo prospective_elsewhere)
printf '\n### D202 — decision-time\n' >> "$r/docs/decisions.md"
printf '# unrelated\n' > "$r2/learnings/2026-01-01-other.md"
rc=$(run_cmd "\"git -C $r2 add -A && git -C $r add docs/decisions.md && git -C $r commit -m x\"")
[ "$rc" = "0" ] && ok "exit 0 — a wrap artifact added in ANOTHER repo is not counted" || bad "expected 0, got $rc"

# `git commit -a` sweeps TRACKED modifications, so the gate must see them...
r=$(new_repo commit_all)
printf 'prior\n' > "$r/learnings/2026-01-01-prior.md"
git -C "$r" add -A; git -C "$r" commit -qm "track the learning"
printf '\n### D203 — at wrap\n' >> "$r/docs/decisions.md"
printf 'edited at wrap\n' >> "$r/learnings/2026-01-01-prior.md"
rc=$(run_cmd "\"git -C $r commit -am wrap\"")
[ "$rc" = "2" ] && ok "exit 2 — commit -a sweeps tracked wrap artifacts into view" || bad "expected 2, got $rc"

# ...and must NOT hallucinate ones it does not sweep. Positive control for the above:
# same -a flag, D-entry present, wrap artifact reverted -> the other branch must fire.
git -C "$r" checkout -q -- learnings/2026-01-01-prior.md
rc=$(run_cmd "\"git -C $r commit -am wrap\"")
[ "$rc" = "0" ] && ok "exit 0 — commit -a with the D-entry alone still allowed" || bad "expected 0, got $rc"

# An UNTRACKED decisions.md has no HEAD side to diff; its headings are all new.
r=$(new_repo untracked_doc)
mkdir -p "$r/docs/specs"
printf '# Decisions\n\n### D300 — brand new file\n' > "$r/docs/specs/decisions.md"
printf '# S300\n' > "$r/learnings/2026-01-01-s300.md"
rc=$(run_cmd "\"git -C $r add -A && git -C $r commit -m wrap\"")
[ "$rc" = "2" ] && ok "exit 2 — a NEW decisions.md file is read as authoring" || bad "expected 2, got $rc"

# Unexpandable staging paths: cannot evaluate -> must ANNOUNCE, never exit quietly.
r=$(new_repo unexpanded_add)
printf '\n### D204 — at wrap\n' >> "$r/docs/decisions.md"
printf '# S204\n' > "$r/learnings/2026-01-01-s204.md"
out=$(printf '{"tool_input":{"command":"git -C %s add $FILES && git -C %s commit -m wrap"}}' "$r" "$r" \
  | node "$HOOK" 2>&1 >/dev/null)
case "$out" in
  *"unexpanded shell variable"*) ok "the unresolvable half is ANNOUNCED, not silent" ;;
  *) bad "unexpanded add pathspec produced no notice: '$out'" ;;
esac

echo "== §10 TEETH: a mutant that reads only the CURRENT index must be CAUGHT by §9 =="
# Without this, §9 could pass for the wrong reason (e.g. if the hook started blocking
# any cell containing the word `add`). The mutation restores the exact pre-S186 defect.
MUT2="$HOME/.claude/hooks/.d-entry-timing-mutant2.tmp.js"
MUTANTS="$MUTANTS $MUT2"
sed 's|^const willCommit = .*$|const willCommit = [...new Set([...stagedFiles])]; // mutated: prospective index ignored|' "$HOOK" > "$MUT2"
if grep -q 'const willCommit = \[\.\.\.new Set(\[\.\.\.stagedFiles, \.\.\.prospective\])\]' "$MUT2"; then
  bad "mutation did NOT apply — §10 would be testing the unmutated hook"
fi
r=$(new_repo teeth_prospective)
printf '\n### D205 — at wrap\n' >> "$r/docs/decisions.md"
printf '# S205\n' > "$r/learnings/2026-01-01-s205.md"
rc=$(printf '{"tool_input":{"command":"git -C %s add -A && git -C %s commit -m wrap"}}' "$r" "$r" \
  | node "$MUT2" >/dev/null 2>&1; echo $?)
if [ "$rc" = "0" ]; then
  ok "mutant goes dark on the combined cell — §9 has teeth"
else
  bad "mutant was NOT caught (got $rc) — §9 cannot discriminate; it is theatre"
fi

echo "== §11 the OTHER three content sources, and the false-BLOCK directions =="
# WHY (S186 review). §9 fixed `git add` + `commit -a` and I called the job done. A
# correctness pass found git sources a commit's content FOUR ways and the union was
# missing the one the HOUSE WORKFLOW USES: skills/wrapping-session/SKILL.md:544
# commits via `--pathspec-from-file`, :557's fallback via `commit -m … -- <paths>`.
# Both take WORKING-TREE content with an empty index and no `git add` to replay, so
# both were dark — and §9/§10 could not catch it, because they test the file-set
# union, not a missing contributor. Same review found the fix had introduced two
# FALSE-BLOCK classes that did not exist before it. Both directions live here now.

r=$(new_repo pathspec_commit)
printf 'prior\n' > "$r/learnings/2026-01-01-prior.md"
git -C "$r" add -A; git -C "$r" commit -qm "track the learning"
printf '\n### D400 — at wrap\n' >> "$r/docs/decisions.md"
printf 'edited at wrap\n' >> "$r/learnings/2026-01-01-prior.md"
rc=$(run_cmd "\"git -C $r commit -m wrap -- docs/decisions.md learnings/2026-01-01-prior.md\"")
[ "$rc" = "2" ] && ok "exit 2 — commit -- <paths> (index empty, worktree content)" || bad "expected 2, got $rc (DARK)"

printf 'docs/decisions.md\nlearnings/2026-01-01-prior.md\n' > "$r/spec.txt"
rc=$(run_cmd "\"git -C $r commit --pathspec-from-file=$r/spec.txt -m wrap\"")
[ "$rc" = "2" ] && ok "exit 2 — commit --pathspec-from-file (the /wrap Step 8 form)" || bad "expected 2, got $rc (DARK)"

# Both directions (P72): a pathspec commit of the D-entry ALONE is decision-time.
r=$(new_repo pathspec_alone)
printf '\n### D401 — decision-time\n' >> "$r/docs/decisions.md"
rc=$(run_cmd "\"git -C $r commit -m d401 -- docs/decisions.md\"")
[ "$rc" = "0" ] && ok "exit 0 — pathspec commit of decisions.md alone still allowed" || bad "expected 0, got $rc"

# FALSE-BLOCK #1: a TRACKED decisions.md that is in the add's file set but whose
# worktree equals HEAD. `git add --dry-run` lists it (worktree-vs-INDEX), while
# `diff HEAD` is empty — the untracked fallback used to fire and report every
# heading in the file's history as newly authored, naming the WRONG heading.
r=$(new_repo tracked_empty_delta)
printf '# Decisions\n\n### D001 — first\n\n### D500 — staged then reverted\n' > "$r/docs/decisions.md"
git -C "$r" add docs/decisions.md
printf '# Decisions\n\n### D001 — first\n\nbody\n' > "$r/docs/decisions.md"   # back to HEAD content
printf '# S500\n' > "$r/learnings/2026-01-01-s500.md"
rc=$(run_cmd "\"git -C $r add -A && git -C $r commit -m wrap\"")
[ "$rc" = "0" ] && ok "exit 0 — tracked doc with empty worktree delta does NOT false-block" || bad "expected 0, got $rc (FALSE BLOCK)"

# FALSE-BLOCK #2: the commit targets another repo via `cd`, which the hook cannot
# follow. Replaying `add -A` against the hook's OWN cwd (mid-wrap: an uncommitted
# D-entry) would block a commit going elsewhere, quoting a heading it never touches.
other=$(new_repo cd_away_target)
printf 'readme\n' > "$other/README.md"; git -C "$other" add -A; git -C "$other" commit -qm base
printf 'edit\n' >> "$other/README.md"
dirty=$(new_repo cd_away_cwd)
printf '\n### D501 — mid-session, NOT being committed\n' >> "$dirty/docs/decisions.md"
printf '# wip\n' > "$dirty/learnings/2026-01-01-wip.md"
rc=$(cd "$dirty" && printf '{"tool_input":{"command":"cd %s && git add -A && git commit -m unrelated"}}' "$other" \
  | node "$HOOK" >/dev/null 2>&1; echo $?)
[ "$rc" = "0" ] && ok "exit 0 — a cd-retargeted commit does NOT block on the cwd repo" || bad "expected 0, got $rc (FALSE BLOCK)"
out=$(cd "$dirty" && printf '{"tool_input":{"command":"cd %s && git add -A && git commit -m unrelated"}}' "$other" \
  | node "$HOOK" 2>&1 >/dev/null)
case "$out" in *"changes directory"*) ok "…and says so rather than exiting quietly" ;;
  *) bad "cd-retargeted commit was not announced: '$out'" ;; esac

# Attribution must survive cosmetic path variation: an exact string compare dropped
# these adds as "foreign" and silently reverted to pre-S186 blindness.
r=$(new_repo path_variants)
printf '\n### D502 — at wrap\n' >> "$r/docs/decisions.md"
printf '# S502\n' > "$r/learnings/2026-01-01-s502.md"
rc=$(run_cmd "\"git -C $r add -A && git -C $r/ commit -m wrap\"")
[ "$rc" = "2" ] && ok "exit 2 — trailing slash on the commit's -C still attributes the add" || bad "expected 2, got $rc"
rc=$(run_cmd "\"git -C $r/. add -A && git -C $r commit -m wrap\"")
[ "$rc" = "2" ] && ok "exit 2 — '/.'-suffixed -C on the add still attributes it" || bad "expected 2, got $rc"

# The add-boundary anchors on the LAST commit: a `git commit` in quoted TEXT must
# not push the boundary to offset 0 and filter out every real add (fail-OPEN), and
# a genuine decision-commit-then-wrap-commit cell must keep the second commit's adds.
r=$(new_repo phantom_commit)
printf '\n### D503 — at wrap\n' >> "$r/docs/decisions.md"
printf '# S503\n' > "$r/learnings/2026-01-01-s503.md"
rc=$(run_cmd "\"echo \\\"now git commit runs\\\" && git -C $r add -A && git -C $r commit -m wrap\"")
[ "$rc" = "2" ] && ok "exit 2 — a phantom 'git commit' in text does not disarm the replay" || bad "expected 2, got $rc (DARK)"
r=$(new_repo two_commits)
printf '\n### D504 — at wrap\n' >> "$r/docs/decisions.md"
printf '# S504\n' > "$r/learnings/2026-01-01-s504.md"
rc=$(run_cmd "\"git -C $r commit -m first --allow-empty && git -C $r add -A && git -C $r commit -m wrap\"")
[ "$rc" = "2" ] && ok "exit 2 — adds belonging to the SECOND commit are not dropped" || bad "expected 2, got $rc (DARK)"

# A replay that matches nothing is as unevaluated as one that threw. Shell
# redirections ride along in the parsed args and git SUCCEEDS with empty output.
r=$(new_repo redirection_arg)
printf '\n### D505 — at wrap\n' >> "$r/docs/decisions.md"
printf '# S505\n' > "$r/learnings/2026-01-01-s505.md"
out=$(printf '{"tool_input":{"command":"git -C %s add -A 2>/dev/null && git -C %s commit -m wrap"}}' "$r" "$r" \
  | node "$HOOK" 2>&1 >/dev/null)
case "$out" in *"matched no files"*) ok "a replay matching NOTHING is announced, not silent" ;;
  *) bad "zero-match replay produced no notice: '$out'" ;; esac

# The worktree form the unresolvable notice was written for must actually reach it.
r=$(new_repo unresolvable_reaches)
printf '\n### D506 — at wrap\n' >> "$r/docs/decisions.md"
out=$(printf '{"tool_input":{"command":"git -C \\"$W\\" add -A && git -C \\"$W\\" commit -m wrap"}}' \
  | node "$HOOK" 2>&1 >/dev/null)
case "$out" in *"unexpanded shell variable"*) ok "the \$W worktree form reaches the unresolvable notice" ;;
  *) bad "\$W form did not announce its unresolvable stage: '$out'" ;; esac

echo "== §12 TEETH: a mutant that drops the commit-pathspec contributor must be CAUGHT =="
MUT3="$HOME/.claude/hooks/.d-entry-timing-mutant3.tmp.js"
MUTANTS="$MUTANTS $MUT3"
sed 's|^  const commitPathspec = commitPathspecOf(commitSeg);$|  const commitPathspec = null; // mutated: contributor 4 dropped|' "$HOOK" > "$MUT3"
if grep -q 'const commitPathspec = commitPathspecOf(commitSeg);' "$MUT3"; then
  bad "mutation did NOT apply — §12 would be testing the unmutated hook"
fi
r=$(new_repo teeth_pathspec)
printf 'prior\n' > "$r/learnings/2026-01-01-prior.md"
git -C "$r" add -A; git -C "$r" commit -qm "track"
printf '\n### D507 — at wrap\n' >> "$r/docs/decisions.md"
printf 'edited\n' >> "$r/learnings/2026-01-01-prior.md"
rc=$(printf '{"tool_input":{"command":"git -C %s commit -m wrap -- docs/decisions.md learnings/2026-01-01-prior.md"}}' "$r" \
  | node "$MUT3" >/dev/null 2>&1; echo $?)
if [ "$rc" = "0" ]; then
  ok "mutant goes dark on the pathspec commit — §11 has teeth"
else
  bad "mutant was NOT caught (got $rc) — §11 cannot discriminate; it is theatre"
fi

echo "== §13 the shapes §11's own fixtures were built to avoid =="
# WHY (S186, second review). §11 asserted `--pathspec-from-file` and passed — with
# the flag written UNQUOTED. The house workflow writes it QUOTED and variable-bearing
# (`skills/wrapping-session/SKILL.md:544`), and scanGitSegments only unquotes a token
# whose FIRST char is a quote, so `--pathspec-from-file="…"` kept its quotes, the
# read threw, and the gate went dark AGAIN — on the same house form, one fix later.
# Third instance in this change of a fixture built so the failing case cannot arise;
# hook-input.js:259 already carries that sentence. Every case below is a shape a
# previous green canary could not express.

r=$(new_repo quoted_pathspec)
printf 'prior\n' > "$r/learnings/2026-01-01-prior.md"
git -C "$r" add -A; git -C "$r" commit -qm track
printf '\n### D600 — at wrap\n' >> "$r/docs/decisions.md"
printf 'edited\n' >> "$r/learnings/2026-01-01-prior.md"
printf 'docs/decisions.md\nlearnings/2026-01-01-prior.md\n' > "$r/spec.txt"
rc=$(run_cmd "\"git -C $r commit --pathspec-from-file=\\\"$r/spec.txt\\\" -m wrap\"")
[ "$rc" = "2" ] && ok "exit 2 — QUOTED --pathspec-from-file (the SKILL.md:544 form)" || bad "expected 2, got $rc (DARK)"

# Unreadable / unresolvable pathspec sources must ANNOUNCE. A silent exit 0 here is
# indistinguishable from "nothing to report", which is this gate's failure mode.
out=$(printf '{"tool_input":{"command":"git -C %s commit --pathspec-from-file=- -m wrap"}}' "$r" | node "$HOOK" 2>&1 >/dev/null)
case "$out" in *STDIN*) ok "--pathspec-from-file=- (reads stdin) is announced" ;;
  *) bad "stdin pathspec form was silent: '$out'" ;; esac
out=$(printf '{"tool_input":{"command":"git -C %s commit --pathspec-from-file=\\"$SPEC\\" -m wrap"}}' "$r" | node "$HOOK" 2>&1 >/dev/null)
case "$out" in *"unexpanded shell variable"*) ok "an unexpanded pathspec-file variable is announced" ;;
  *) bad "unexpanded pathspec file was silent: '$out'" ;; esac

# The cd-detection scan must read past quoted spans. Matching the WORD `cd` in a
# commit MESSAGE downgraded the gate to staged-files-only and let a real violation
# through behind a NOTE — and multi-line wrap messages routinely contain prose.
r=$(new_repo cd_in_message)
printf '\n### D601 — at wrap\n' >> "$r/docs/decisions.md"
printf '# S601\n' > "$r/learnings/2026-01-01-s601.md"
rc=$(cd "$r" && printf '{"tool_input":{"command":"git add -A && git commit -m \\"ran: foo; %s x; make\\""}}' "c""d" \
  | node "$HOOK" >/dev/null 2>&1; echo $?)
[ "$rc" = "2" ] && ok "exit 2 — the word 'cd' in a commit MESSAGE does not disarm the gate" || bad "expected 2, got $rc (DARK)"

# ...and the other direction: real directory changes the raw-text regex missed, each
# of which FALSE-BLOCKED a commit going to a different repo. `(cd X && …)` is the
# form check-cd-persistence.js itself recommends, so this house writes it constantly.
target=$(new_repo cd_forms_target)
printf 'readme\n' > "$target/README.md"; git -C "$target" add -A; git -C "$target" commit -qm base
printf 'edit\n' >> "$target/README.md"
dirty=$(new_repo cd_forms_cwd)
printf '\n### D602 — mid-session, NOT being committed\n' >> "$dirty/docs/decisions.md"
printf '# wip\n' > "$dirty/learnings/2026-01-01-wip.md"
for form in "(%s %s && git add -A && git commit -m unrelated)" \
            "pushd %s >/dev/null && git add -A && git commit -m unrelated" \
            "builtin %s %s && git add -A && git commit -m unrelated"; do
  case "$form" in
    *pushd*) cell=$(printf "$form" "$target") ;;
    *) cell=$(printf "$form" "c""d" "$target") ;;
  esac
  rc=$(cd "$dirty" && printf '{"tool_input":{"command":"%s"}}' "$cell" | node "$HOOK" >/dev/null 2>&1; echo $?)
  [ "$rc" = "0" ] && ok "exit 0 — $(printf '%s' "$cell" | cut -c1-32)… does not false-block" \
    || bad "expected 0, got $rc — FALSE BLOCK on: $cell"
done

# `-C <subdir>` : producers print repo-root-relative paths, consumers resolve against
# the process cwd. They agree only at the top level; below it the gate went dark on
# every contributor at once, silently.
r=$(new_repo subdir_base)
mkdir -p "$r/proj/docs" "$r/proj/learnings"
printf '# Decisions\n\n### D001 — first\n' > "$r/proj/docs/decisions.md"
printf 'prior\n' > "$r/proj/learnings/2026-01-01-prior.md"
git -C "$r" add -A; git -C "$r" commit -qm "subdir base"
printf '\n### D603 — at wrap\n' >> "$r/proj/docs/decisions.md"
printf 'edited\n' >> "$r/proj/learnings/2026-01-01-prior.md"
rc=$(run_cmd "\"git -C $r/proj add -A && git -C $r/proj commit -m wrap\"")
[ "$rc" = "2" ] && ok "exit 2 — add+commit run from a SUBDIRECTORY of the repo" || bad "expected 2, got $rc (DARK)"
rc=$(run_cmd "\"git -C $r/proj commit -m wrap -- docs/decisions.md learnings/2026-01-01-prior.md\"")
[ "$rc" = "2" ] && ok "exit 2 — pathspec commit from a SUBDIRECTORY" || bad "expected 2, got $rc (DARK)"

echo "== §14 TEETH: a mutant that stops unquoting flag values must be CAUGHT =="
MUT4="$HOME/.claude/hooks/.d-entry-timing-mutant4.tmp.js"
MUTANTS="$MUTANTS $MUT4"
sed 's|^function unquoteValue(s) {$|function unquoteValue(s) { return s; /* mutated */|' "$HOOK" > "$MUT4"
if ! grep -q 'mutated' "$MUT4"; then
  bad "mutation did NOT apply — §14 would be testing the unmutated hook"
fi
r=$(new_repo teeth_unquote)
printf 'prior\n' > "$r/learnings/2026-01-01-prior.md"
git -C "$r" add -A; git -C "$r" commit -qm track
printf '\n### D604 — at wrap\n' >> "$r/docs/decisions.md"
printf 'edited\n' >> "$r/learnings/2026-01-01-prior.md"
printf 'docs/decisions.md\nlearnings/2026-01-01-prior.md\n' > "$r/spec.txt"
rc=$(printf '{"tool_input":{"command":"git -C %s commit --pathspec-from-file=\\"%s/spec.txt\\" -m wrap"}}' "$r" "$r" \
  | node "$MUT4" >/dev/null 2>&1; echo $?)
if [ "$rc" = "0" ]; then
  ok "mutant goes dark on the QUOTED house form — §13 has teeth"
else
  bad "mutant was NOT caught (got $rc) — §13 cannot discriminate; it is theatre"
fi

echo "== §15 HEADING SHAPES: prefixed registers block, lookalike prose does not =="
# Decision registers are not all bare D<n>: identity/company registers use D-MI25 /
# D-CR8, infra uses letter-only D-A..D-L, prototypes DP1, vendor work VR-3, older
# specs `Decision 3`. The original `D\d+` pattern was blind to every one of them, so
# an identity decision authored at wrap passed the gate. The must-NOT set is the
# other direction: a tolerant `D[-A-Za-z]*` would block on `## D-series conventions`
# or `## Decisions Index`, which are not decisions. Each case is its own repo so one
# shape cannot mask another.
d_shape_case() {
  local want="$1" heading="$2" name="shape_$3"
  local r; r=$(new_repo "$name")
  printf '\n%s\n\nbody\n' "$heading" >> "$r/docs/decisions.md"
  printf '# S200\n' > "$r/learnings/2026-01-01-s200.md"
  git -C "$r" add -A
  local rc; rc=$(run_hook "$r")
  if [ "$rc" = "$want" ]; then ok "exit $want — $heading"
  else bad "expected $want, got $rc — $heading"; fi
}
i=0
for h in '## D141: x' '## D30.1: x' '## D18 — x' '## D-MI25: x' '## D-MI6 (v2): x' \
         '## D-CR8: x' '## D-L: x' '## DP1: x' '## VR-3: x' '## Decision 3: x' '#### D-MI26: deep' \
         '## D-MI26 identity refresh' '## D-MI26 – en dash' '## D-MI26 - hyphen' '## **D-MI26**: bold' \
         '## `D-MI26`: code' '## D-L' '## D-L — x' '## D-A – x' '## D-L - x'; do
  i=$((i+1)); d_shape_case 2 "$h" "yes$i"
done
i=0
for h in '## D-series conventions' '## D — notes' '## D.1 x' '## Design' '## Data' '## Decisions Index' \
         '### D-API design notes' '## D-UI layout'; do
  i=$((i+1)); d_shape_case 0 "$h" "no$i"
done

echo
printf 'passed %d, failed %d\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
