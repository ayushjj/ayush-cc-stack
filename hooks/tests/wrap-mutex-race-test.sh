#!/usr/bin/env bash
# wrap-mutex-race-test.sh — red/green proof for the concurrent-wrap mutex.
#
# Three parts:
#   A. git-sync-lock.js unit smoke (acquire/release/stale-reclaim/fail-open)
#   B. check-wrap-collision.js bidirectional smoke (warn vs silent) — pipes REAL
#      stdin JSON (the harness contract); one explicit legacy-env fallback case.
#   C. THE RACE, three phases over N trials each:
#        RED      (no lock):        overlap must be >0 (test has teeth)
#        GREEN    (mutex):          overlap 0, lost-work 0; co-mingling still
#                                   expected (git add -A is greedy) — info only
#        MANIFEST (mutex+manifest): overlap 0, lost-work 0, co-mingled commits
#                                   ASSERTED 0 — the S46 per-session staging fix
#                                   (session-manifest.js stage + pathspec commit)
#
# A race test that never reproduces the bug is worthless — Part C asserts RED has
# teeth before trusting GREEN/MANIFEST. macOS bash 3.2 compatible. Uses absolute
# paths / `git -C` (no cd-persistence leak).
#
# Usage: bash wrap-mutex-race-test.sh [N_TRIALS]   (default 30)

set -u
N="${1:-30}"
LOCKJS="$HOME/.claude/hooks/git-sync-lock.js"
WARNJS="$HOME/.claude/hooks/check-wrap-collision.js"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/wrapmutex.XXXXXX" 2>/dev/null || mktemp -d)"
REPO="$WORK/repo"
LOCKDIR="$WORK/lock"        # CLAUDE_GIT_SYNC_LOCK_DIR override (never touches real ~/.claude)
GATE="$WORK/GO"
WORKER="$WORK/worker.sh"
TRIALLOG="$WORK/trial.log"   # per-trial "<sess> <enter_ms> <exit_ms>" critical-section timings
pass=0; fail=0
ok(){ pass=$((pass+1)); printf '  PASS  %s\n' "$1"; }
no(){ fail=$((fail+1)); printf '  FAIL  %s\n' "$1"; }

echo "workdir: $WORK"
echo "lock:    $LOCKJS"
echo

# ---------------------------------------------------------------------------
# Part A — git-sync-lock.js unit smoke
# ---------------------------------------------------------------------------
echo "== Part A: lock unit smoke =="
export CLAUDE_GIT_SYNC_LOCK_DIR="$LOCKDIR"
export CLAUDE_GIT_SYNC_LOCK_TIMEOUT_MS=800
export CLAUDE_GIT_SYNC_LOCK_POLL_MS=50

# a live "owner" process to point the lock at
sleep 60 & LIVEPID=$!
LIVESTART="$(ps -p $LIVEPID -o lstart=)"

rm -rf "$LOCKDIR"
held="$(CLAUDE_CODE_SESSION_ID=s1 node "$LOCKJS" status)"
case "$held" in *'"held":false'*) ok "status on free lock => held:false";; *) no "free-lock status: $held";; esac

CLAUDE_CODE_SESSION_ID=s1 node "$LOCKJS" acquire "$LIVEPID" "$LIVESTART" >/dev/null 2>&1
st="$(CLAUDE_CODE_SESSION_ID=s1 node "$LOCKJS" status)"
if echo "$st" | grep -q '"held":true' && echo "$st" | grep -q '"live":true'; then ok "acquire on free lock => held:true,live:true"; else no "after-acquire status: $st"; fi

# second session, lock held by live owner, short timeout => fail-open exit 0
CLAUDE_CODE_SESSION_ID=s2 node "$LOCKJS" acquire 2>/tmp/wm_failopen.txt; rc=$?
if [ "$rc" -eq 0 ] && grep -q "timed out" /tmp/wm_failopen.txt; then ok "contended acquire => fail-open exit 0 + warning"; else no "fail-open rc=$rc"; fi
st="$(CLAUDE_CODE_SESSION_ID=s1 node "$LOCKJS" status)"
case "$st" in *'"owner_session":"s1"'*) ok "lock still owned by s1 after s2 fail-open";; *) no "owner after fail-open: $st";; esac

# release by NON-owner s2 => skipped, lock intact
CLAUDE_CODE_SESSION_ID=s2 node "$LOCKJS" release >/dev/null 2>&1
st="$(CLAUDE_CODE_SESSION_ID=s1 node "$LOCKJS" status)"
case "$st" in *'"held":true'*) ok "release by non-owner => lock intact";; *) no "non-owner release removed lock: $st";; esac

# release by owner s1 => gone
CLAUDE_CODE_SESSION_ID=s1 node "$LOCKJS" release >/dev/null 2>&1
st="$(node "$LOCKJS" status)"
case "$st" in *'"held":false'*) ok "release by owner => lock gone";; *) no "after owner-release: $st";; esac

# double release => no error, exit 0
node "$LOCKJS" release >/dev/null 2>&1; [ $? -eq 0 ] && ok "double release => exit 0" || no "double release errored"

# stale reclaim: lock owned by a DEAD pid => acquire reclaims
kill "$LIVEPID" 2>/dev/null; wait "$LIVEPID" 2>/dev/null
mkdir -p "$LOCKDIR"; printf 's_dead\t%s\t%s\n' "$LIVEPID" "$LIVESTART" > "$LOCKDIR/owner"
sleep 30 & NEWPID=$!; NEWSTART="$(ps -p $NEWPID -o lstart=)"
CLAUDE_CODE_SESSION_ID=s3 node "$LOCKJS" acquire "$NEWPID" "$NEWSTART" >/dev/null 2>&1
st="$(node "$LOCKJS" status)"
if echo "$st" | grep -q '"owner_session":"s3"' && echo "$st" | grep -q '"live":true'; then ok "stale (dead-pid) lock reclaimed by new acquirer"; else no "stale reclaim: $st"; fi
kill "$NEWPID" 2>/dev/null; wait "$NEWPID" 2>/dev/null
rm -rf "$LOCKDIR"
echo

# ---------------------------------------------------------------------------
# Part B — check-wrap-collision.js bidirectional smoke
# ---------------------------------------------------------------------------
echo "== Part B: warn-hook bidirectional =="
sleep 60 & OWNPID=$!; OWNSTART="$(ps -p $OWNPID -o lstart=)"
mkdir -p "$LOCKDIR"; printf 'owner_sess\t%s\t%s\n' "$OWNPID" "$OWNSTART" > "$LOCKDIR/owner"
CLAUDEDIR="$HOME/.claude"

warn_run(){ # $1=session $2=command $3=cwd  -> echoes stderr. REAL harness channel:
  # payload JSON on stdin, command nested under tool_input (P72: test the channel
  # production uses, not a fallback).
  printf '{"session_id":"%s","cwd":"%s","tool_input":{"command":"%s"}}' "$1" "$3" "$2" | \
  CLAUDE_CODE_SESSION_ID="$1" CLAUDE_GIT_SYNC_LOCK_DIR="$LOCKDIR" \
  node "$WARNJS" 2>&1 1>/dev/null
}

out="$(warn_run other_sess "git add -A" "$CLAUDEDIR")"
[ -n "$out" ] && ok "other live owner + git add in ~/.claude => WARN (stdin)" || no "expected warn, got silence"

# legacy env-var fallback channel still honored when stdin is empty
out="$(CLAUDE_CODE_SESSION_ID=other_sess CLAUDE_GIT_SYNC_LOCK_DIR="$LOCKDIR" \
  CLAUDE_TOOL_INPUT="{\"command\":\"git add -A\",\"cwd\":\"$CLAUDEDIR\"}" \
  node "$WARNJS" 2>&1 1>/dev/null </dev/null)"
[ -n "$out" ] && ok "legacy env fallback => WARN" || no "env fallback dead"

out="$(warn_run owner_sess "git add -A" "$CLAUDEDIR")"
[ -z "$out" ] && ok "MY OWN lock + git add => silent" || no "warned on own lock: $out"

out="$(warn_run other_sess "git status" "$CLAUDEDIR")"
[ -z "$out" ] && ok "other owner + non-write (git status) => silent" || no "warned on git status: $out"

out="$(warn_run other_sess "git add -A" "/tmp/somerepo")"
[ -z "$out" ] && ok "other owner + git add OUTSIDE ~/.claude => silent" || no "warned outside ~/.claude: $out"

rm -rf "$LOCKDIR"
out="$(warn_run other_sess "git add -A" "$CLAUDEDIR")"
[ -z "$out" ] && ok "no lock + git add => silent" || no "warned with no lock: $out"

# stale (dead-pid) lock => don't cry wolf
kill "$OWNPID" 2>/dev/null; wait "$OWNPID" 2>/dev/null
mkdir -p "$LOCKDIR"; printf 'other_sess\t%s\t%s\n' "$OWNPID" "$OWNSTART" > "$LOCKDIR/owner"
out="$(warn_run my_sess "git add -A" "$CLAUDEDIR")"
[ -z "$out" ] && ok "other owner but STALE (dead) => silent" || no "warned on stale lock: $out"
rm -rf "$LOCKDIR"
echo

# ---------------------------------------------------------------------------
# Part C — THE RACE (red/green)
# ---------------------------------------------------------------------------
echo "== Part C: race reproduction ($N trials each) =="

cat > "$WORKER" <<'WORKER_EOF'
#!/usr/bin/env bash
set -u
sess="$1"; prefix="$2"; mode="$3"; race="$4"; predelay="$5"   # mode: 0=nolock, 1=lock, manifest=lock+per-session staging
REPO="$6"; LOCKDIR="$7"; GATE="$8"; LOCKJS="$9"; TRIALLOG="${10}"
SMJS="${SMJS:-$HOME/.claude/hooks/session-manifest.js}"
export CLAUDE_CODE_SESSION_ID="$sess"
export CLAUDE_GIT_SYNC_LOCK_DIR="$LOCKDIR"
export CLAUDE_GIT_SYNC_LOCK_TIMEOUT_MS=30000
export CLAUDE_GIT_SYNC_LOCK_POLL_MS=20
now_ms(){ node -e 'process.stdout.write(String(Date.now()))'; }
pid=$$
lstart="$(ps -p $pid -o lstart=)"
printf '%s\n' "$sess" > "$REPO/${prefix}_1.txt"
printf '%s\n' "$sess" > "$REPO/${prefix}_2.txt"
printf '%s\n' "$sess" > "$REPO/${prefix}_3.txt"
if [ "$mode" = "manifest" ]; then
  # what the PostToolUse record hook does in production: one stdin JSON per write
  export CLAUDE_MANIFEST_REPO="$REPO"
  export CLAUDE_SESSION_MANIFEST_DIR="$REPO/.session-manifests"
  for i in 1 2 3; do
    printf '{"session_id":"%s","tool_input":{"file_path":"%s"}}' "$sess" "$REPO/${prefix}_${i}.txt" | node "$SMJS" record
  done
fi
while [ ! -f "$GATE" ]; do sleep 0.005; done
[ "$predelay" != "0" ] && sleep "$predelay"
# CRITICAL SECTION = the git index/commit work. Under the mutex it must be held
# alone; the enter/exit timestamps let the harness prove serialization directly.
if [ "$mode" != "0" ]; then node "$LOCKJS" acquire "$pid" "$lstart" >/dev/null 2>&1; fi
tenter="$(now_ms)"
if [ "$mode" = "manifest" ]; then
  node "$SMJS" stage >/dev/null 2>&1
  sleep "$race"
  git -C "$REPO" commit -q --pathspec-from-file="$REPO/.session-manifests/${sess}.commit-pathspec" -m "wrap $sess" >/dev/null 2>&1
  node "$SMJS" prune >/dev/null 2>&1
else
  git -C "$REPO" add -A >/dev/null 2>&1
  sleep "$race"
  git -C "$REPO" commit -q -m "wrap $sess" >/dev/null 2>&1
fi
texit="$(now_ms)"
if [ "$mode" != "0" ]; then node "$LOCKJS" release >/dev/null 2>&1; fi
printf '%s %s %s\n' "$sess" "$tenter" "$texit" >> "$TRIALLOG"
WORKER_EOF
chmod +x "$WORKER"

setup_repo(){
  rm -rf "$REPO"; mkdir -p "$REPO"
  git -C "$REPO" init -q
  git -C "$REPO" config user.email t@t; git -C "$REPO" config user.name t
  printf 'base\n' > "$REPO/base.txt"; git -C "$REPO" add -A >/dev/null 2>&1
  git -C "$REPO" commit -q -m base >/dev/null 2>&1
  git -C "$REPO" tag -f base >/dev/null 2>&1   # ref so `base..HEAD` ranges resolve (NOT just the commit message)
}

# Returns 1 if any single commit since base mixes A_ and B_ files (collision).
mixed_commit(){
  local shas sha files hasA hasB
  shas="$(git -C "$REPO" log --format=%H base..HEAD 2>/dev/null)"
  for sha in $shas; do
    files="$(git -C "$REPO" show --name-only --format= "$sha" 2>/dev/null)"
    hasA=0; hasB=0
    case "$files" in *A_*) hasA=1;; esac
    case "$files" in *B_*) hasB=1;; esac
    if [ "$hasA" = 1 ] && [ "$hasB" = 1 ]; then return 1; fi
  done
  return 0
}

overlap_trial(){ # reads $TRIALLOG -> return 0 if the two critical sections overlapped in time
  local ae ax be bx
  ae="$(awk '$1=="A"{print $2}' "$TRIALLOG" 2>/dev/null)"
  ax="$(awk '$1=="A"{print $3}' "$TRIALLOG" 2>/dev/null)"
  be="$(awk '$1=="B"{print $2}' "$TRIALLOG" 2>/dev/null)"
  bx="$(awk '$1=="B"{print $3}' "$TRIALLOG" 2>/dev/null)"
  [ -n "$ae" ] && [ -n "$ax" ] && [ -n "$be" ] && [ -n "$bx" ] || return 1
  [ "$ae" -lt "$bx" ] && [ "$be" -lt "$ax" ]   # intervals intersect?
}

run_phase(){ # $1=mode (0|1|manifest)  -> echoes "overlaps lost mixed"
  local mode="$1" i ov=0 lost=0 mix=0 committed
  for i in $(seq 1 "$N"); do
    setup_repo
    rm -rf "$LOCKDIR" "$GATE" "$TRIALLOG"
    # B staggered 0.05s so adds don't microsecond-clash on index.lock; 0.3s window
    # keeps both critical sections open long enough to overlap WITHOUT the mutex.
    "$WORKER" A A "$mode" 0.30 0    "$REPO" "$LOCKDIR" "$GATE" "$LOCKJS" "$TRIALLOG" &
    pA=$!
    "$WORKER" B B "$mode" 0.30 0.05 "$REPO" "$LOCKDIR" "$GATE" "$LOCKJS" "$TRIALLOG" &
    pB=$!
    touch "$GATE"          # release both workers together
    wait "$pA"; wait "$pB"
    # GUARANTEE 1 (serialization): did the two critical sections run concurrently?
    overlap_trial && ov=$((ov+1))
    # GUARANTEE 2 (no lost work): all 6 files committed somewhere?
    committed="$(git -C "$REPO" log --format= --name-only base..HEAD 2>/dev/null | grep -cE '^(A|B)_[0-9]')"
    [ "$committed" -ne 6 ] && lost=$((lost+1))
    # INFO (accepted limitation): a single commit holding both sessions' files.
    mixed_commit || mix=$((mix+1))
  done
  echo "$ov $lost $mix"
}

echo "RED  (no lock): reproducing concurrency..."
red="$(run_phase 0)"; set -- $red; red_ov="$1"; red_lost="$2"; red_mix="$3"
echo "  overlapping critical sections: $red_ov/$N   lost-work: $red_lost/$N   co-mingled commits: $red_mix/$N"
echo "GREEN (mutex):  proving serialization..."
grn="$(run_phase 1)"; set -- $grn; grn_ov="$1"; grn_lost="$2"; grn_mix="$3"
echo "  overlapping critical sections: $grn_ov/$N   lost-work: $grn_lost/$N   co-mingled commits: $grn_mix/$N"
export SMJS="$HOME/.claude/hooks/session-manifest.js"
echo "MANIFEST (mutex + per-session staging): proving attribution..."
man="$(run_phase manifest)"; set -- $man; man_ov="$1"; man_lost="$2"; man_mix="$3"
echo "  overlapping critical sections: $man_ov/$N   lost-work: $man_lost/$N   co-mingled commits: $man_mix/$N"
echo

# ---------------------------------------------------------------------------
# Verdict — the mutex GUARANTEES serialization + no-loss; the session manifest
# GUARANTEES attribution (co-mingling 0, ASSERTED — decision ship-manifest-staging,
# 2026-07-04, superseding ship-mutex-accept-co-mingling). GREEN's co-mingling
# must stay >0: it proves add -A greed is real, i.e. the MANIFEST zero has teeth.
# ---------------------------------------------------------------------------
echo "== Verdict =="
[ "$red_ov" -gt 0 ] && ok "RED: critical sections overlap ($red_ov/$N) — harness creates real concurrency" \
                    || no "RED: 0 overlap — harness can't create concurrency (test invalid)"
[ "$grn_ov" -eq 0 ] && ok "GREEN: mutex serialized every trial (0/$N overlap)" \
                    || no "GREEN: $grn_ov/$N trials overlapped — mutex failed to serialize"
{ [ "$red_lost" -eq 0 ] && [ "$grn_lost" -eq 0 ]; } && ok "no lost work in RED/GREEN (all files committed)" \
                    || no "lost work: RED $red_lost/$N, GREEN $grn_lost/$N"
[ "$grn_mix" -gt 0 ] && ok "GREEN co-mingles ($grn_mix/$N) — add -A greed is real; MANIFEST's zero has teeth" \
                    || no "GREEN co-mingling 0 — manifest assertion would be vacuous (test invalid)"
[ "$man_ov" -eq 0 ] && ok "MANIFEST: serialized every trial (0/$N overlap)" \
                    || no "MANIFEST: $man_ov/$N trials overlapped"
[ "$man_lost" -eq 0 ] && ok "MANIFEST: no lost work (all 6 files committed every trial)" \
                    || no "MANIFEST: lost work in $man_lost/$N trials"
[ "$man_mix" -eq 0 ] && ok "MANIFEST: ZERO co-mingled commits (asserted — each session commits only its own files)" \
                    || no "MANIFEST: $man_mix/$N trials co-mingled — per-session staging leaked"

echo
echo "unit/smoke: $pass passed, $fail failed"
rm -rf "$WORK" /tmp/wm_failopen.txt 2>/dev/null
{ [ "$fail" -eq 0 ] && [ "$red_ov" -gt 0 ] && [ "$grn_ov" -eq 0 ] && [ "$red_lost" -eq 0 ] && [ "$grn_lost" -eq 0 ] \
  && [ "$man_ov" -eq 0 ] && [ "$man_lost" -eq 0 ] && [ "$man_mix" -eq 0 ]; } \
  && { echo "ALL GREEN"; exit 0; } || { echo "FAILURES PRESENT"; exit 1; }
