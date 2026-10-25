// PreToolUse hook: blocks `git push` / `gh pr create` when what the push SENDS
// contains UNREVIEWED CODE. S81 moved it here from `git commit` (owner rule: review
// per slice, self-check per commit; 875 commit-time fires, 30% bypassed). The
// surface is branchBase->HEAD (diff-chunks.js): every committed change since this
// branch left the default branch. /review and the flag writer read branchBase->
// working tree, so reviewing uncommitted work still covers it once committed.
// The rest of this header predates S81 and says "commit" where it now means push. Delta-aware (S256): the flag stores per-file chunk hashes of the diff
// that /review saw; this gate recomputes them, takes the chunks that are new or
// changed since that review (the DELTA), classifies the delta with
// classify-diff.js, and blocks ONLY if the delta contains code. Consequences:
//   - applying the review's own findings then committing: flag written post-apply
//     (SKILL.md Step 7.5/8) → delta empty → pass. No re-review loop.
//   - wrap commits (reviewed code + docs + telemetry .jsonl): delta is
//     content-only → pass. No wrap-time block.
//   - docs-only commits with NO flag at all: whole diff is the delta, it is
//     content-only → pass. No /review round-trip for inert changes.
//   - any genuinely new/edited code since the review → block, and /review
//     re-runs scoped to that delta only (SKILL.md Step 3 uses this script's
//     --delta mode, so hook and skill share ONE delta definition, P72).
//
// Flag file: $TMPDIR/.claude-review-done-<sha256(repo realpath)[0:12]> — JSON
// {repo, verdict, ts, fileHashes}, written by scripts/write-review-flag.js
// (SKILL.md Step 8). PER-REPO so another session's /review in another repo
// never clobbers this repo's flag (S255 wrap-block cause). P51 PAIRED CONTRACT
// via shared diff-chunks.js — contract row in governance.md "Skill-coupling
// contracts". Legacy formats (0-byte, or S47 {diffHash}) carry no per-file
// coverage → whole diff is the delta (fails toward review).
//
// History: S47 scoped a 0-byte global flag to repo+full-diffHash+verdict; S256
// made it delta-aware — the opaque full-diff hash meant the review invalidated
// itself by succeeding (operator-raised; mechanism + fix priority in
// ~/.claude/learnings/2026-07-09-review-gate-delta-diagnosis.md).
//
// CLI mode: `--delta [--repo <path>]` prints the unreviewed part of the current
// diff on stdout (whole diff when no valid PASS flag) and exits 0.
//
// Hook mode reads tool input as JSON from stdin (hook contract, verified
// 2026-07-04). Blocks via exit 2 + stderr. Skip valve: CLAUDE_REVIEW_GATE_SKIP=1

const fs = require('fs');
const os = require('os');
const path = require('path');
const tty = require('tty');
const { execFileSync } = require('child_process');
const { chunks, plainDefaultRef, fileHashesFrom, flagPath, gitDiff, MAX_DIFF_BUFFER } = require('./diff-chunks.js');

function repoTopLevel(dir) {
  const top = execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  try { return fs.realpathSync(top); } catch { return top; }
}

// Valid delta-format flag for this repo, or null. Repo field must match the
// per-repo path's realpath (belt-and-braces on top of the hashed filename).
function readFlag(repo) {
  try {
    const f = JSON.parse(fs.readFileSync(flagPath(repo), 'utf8'));
    if (!f || !f.repo || !f.fileHashes || !f.verdict) return null;
    let flagRepo = f.repo;
    try { flagRepo = fs.realpathSync(f.repo); } catch {}
    return flagRepo === repo ? f : null;
  } catch { return null; }
}

// The unreviewed part of the current diff: every chunk whose hash is not in the
// PASS-flag's coverage. No flag / non-PASS / legacy format → whole diff.
// Returns null when git itself failed (fail toward review — S256 review, 5×).
// A non-empty diff that yields ZERO chunks (unforeseen format) is returned
// whole: classify-diff's unparseable branch fails it toward code.
// {text: null} = git failed; {noBase: true} = the gate asked for a branch base
// ({to} / {requireBase}) and none exists — the caller blocks with that reason.
function deltaDiff(repo, flag, opts) {
  const { diff, errored, noBase } = gitDiff(repo, opts);
  if (noBase) return { text: '', noBase: true };
  if (errored) return { text: null };
  const cur = chunks(diff);
  if (diff.trim() !== '' && cur.length === 0) return { text: diff };
  const reviewed = (flag && flag.verdict === 'PASS') ? flag.fileHashes : {};
  const hashes = fileHashesFrom(cur);
  return { text: cur.filter(c => reviewed[c.key] !== hashes[c.key]).map(c => c.text).join('') };
}

// ---- CLI mode: print the unreviewed delta (consumed by /review Step 3) ----
if (process.argv.includes('--delta')) {
  const i = process.argv.indexOf('--repo');
  const dir = (i !== -1 && process.argv[i + 1]) ? process.argv[i + 1] : process.cwd();
  let repo;
  try { repo = repoTopLevel(dir); } catch {
    process.stderr.write('check-review-gate --delta: not a git repo\n');
    process.exit(1);
  }
  const d = deltaDiff(repo, readFlag(repo)).text;
  // writeFileSync(1), NOT stdout.write + exit — the async pipe drops everything
  // past 64KB on exit(0), silently truncating the review surface (S256 review,
  // verified). On git error emit an unparseable sentinel: downstream classify
  // fails it toward code even though this pipeline has no pipefail.
  fs.writeFileSync(1, d === null ? 'diff --git <git-error> <git-error>\n' : d);
  process.exit(0);
}

// ---- Hook mode ----
// NOTE: the skip check moved BELOW the command parse. It used to sit here and read
// only process.env, which made the escape hatch this gate PRINTS unreachable from an
// agent session: a PreToolUse hook is a separate process spawned before the command
// runs, so it never sees `CLAUDE_REVIEW_GATE_SKIP=1 git commit`'s assignment prefix.
// The env var could only be set by a human editing settings.json, so an agent that hit
// this gate mid-/wrap simply stopped — which is how several wraps ended half-finished.
// Same root cause as check-d-entry-timing / check-cd-persistence / check-eval-first.

// Tool input arrives as JSON on stdin. Legacy CLAUDE_TOOL_INPUT env (never set by
// the harness — the bug that silently disabled this gate) retained as fallback.
let command = '';
{
  let raw = '';
  // tty.isatty(0), NOT process.stdin.isTTY — touching process.stdin flips fd 0
  // to O_NONBLOCK and readFileSync(0) then EAGAINs on a slow first byte →
  // command='' → silent fail-open. The exact S167 bug classify-diff.js:55-62
  // documents; reintroduced in this rewrite, caught by 5 reviewers (S256).
  try { if (!tty.isatty(0)) raw = fs.readFileSync(0, 'utf8'); } catch {}
  if (!raw.trim() && process.env.CLAUDE_TOOL_INPUT) raw = process.env.CLAUDE_TOOL_INPUT;
  try {
    const p = raw.trim() ? JSON.parse(raw) : {};
    command = (p.tool_input && p.tool_input.command) || p.command || '';
  } catch { /* unparseable → empty command → fail open */ }
}

// Deliberate-override check, now that `command` exists. Honours the env var (as
// before) OR an inline `CLAUDE_REVIEW_GATE_SKIP=1 <cmd>` prefix. The shared helper
// strips heredoc bodies and quoted spans first, so a commit MESSAGE quoting this
// escape does not disarm the gate — that matters here, because this gate's own
// stderr names the token and those words routinely end up inside commit messages.
// Required defensively: this script deliberately duplicates the stdin reader rather
// than importing it, so a missing lib must degrade to env-only, never brick commits.
{
  let bypassed = process.env.CLAUDE_REVIEW_GATE_SKIP === '1';
  if (!bypassed) {
    try {
      // Module-relative for the same reason as the matcher require below: an
      // os.homedir() path silently degrades this valve to env-only whenever HOME
      // points elsewhere (canary tilde case, real `git -C ~/x commit` invocations).
      bypassed = require('../../../hooks/lib/hook-input.js')
        .bypassed('CLAUDE_REVIEW_GATE_SKIP', command, { appliesTo: ['git', 'gh'] });
    } catch { /* lib unavailable → env-only, the pre-existing behaviour */ }
  }
  if (bypassed) process.exit(0);
}

// Only gate git commit commands. The parser lives in hooks/lib/hook-input.js: it
// was duplicated verbatim here and in hooks/check-d-entry-timing.js, both copies
// needed the same `return`→`break` fix, and both then carried the same NEWLINE
// defect — a multi-LINE `git add …⏎git commit …` cell (the form /wrap emits) went
// dark in both gates, measured S184. One bug with two addresses; see that
// function's header for the measurements, the fail-closed heredoc trade, and the
// residuals (`--git-dir <path>` space-form, `~user/`).
//
// The lib stays OPTIONAL, per this script's standing rule that a missing lib must
// never brick commits — but the degradation is LOUD, not silent. Detecting no
// commit means this gate does not fire, and a gate that goes quiet without saying
// so is the exact failure being fixed. (Same stance as check-d-entry-timing.js.)
// Resolved RELATIVE TO THIS FILE, not via os.homedir(): `git -C ~/x commit` is a
// house-style invocation, and the canary exercises it by overriding HOME to a temp
// dir so the tilde resolves. Under that override os.homedir() points away from
// ~/.claude, the require fails, and the gate degrades to "no commit detected" —
// caught immediately by gate-hooks-canary's tilde case, which is what a loud
// fail-open is for. A module-relative path has no such dependency.
let m;
try {
  const hi = require('../../../hooks/lib/hook-input.js');
  m = hi.matchGitPush(command);
  if (!m.matched) m = hi.matchGhPrCreate(command);
} catch (err) {
  process.stderr.write(`REVIEW GATE DISABLED: push/PR parser unavailable (${err.message})\n`);
  process.exit(0);
}
if (!m.matched) process.exit(0);
// A `cd <dir> && git commit …` prefix is how a commit lands in a WORKTREE that is not
// the session's cwd. This hook sees only the command TEXT — it cannot observe the `cd` —
// so without this it resolved process.cwd(), i.e. the SESSION's repo, and gated the
// commit against a DIFFERENT worktree's files. Measured 2026-08-01: a one-file docs
// commit in a linked worktree was blocked by 13 unreviewed files that exist ONLY in the
// primary worktree. Note the failure runs BOTH ways — it is not merely an annoyance:
// when the session cwd happens to be clean, the same misresolution lets genuinely
// unreviewed code through. Worktrees share one .git, so this is the normal shape of
// parallel-session work, not an exotic case.
//
// Precedence: explicit `git -C` (the author said where) > `cd` prefix > cwd.
//
// MUST return null unless the target is a real directory: a dirArg that fails rev-parse
// exits 0 below ("genuinely not a repo"), so a bogus path scraped out of prose would not
// merely mis-target the gate — it would DISABLE it. Guarding here keeps every
// unparseable case falling back to cwd, the pre-existing behaviour.
function cdTarget(rawCmd, pushAt) {
  // Offsets from the matchers index the continuation-joined text, so scan that.
  let cmd = rawCmd;
  try { cmd = require('../../../hooks/lib/hook-input.js').joinContinuations(rawCmd); } catch {}
  // Neutralise quoted spans first so a commit MESSAGE containing "cd /somewhere &&"
  // cannot redirect resolution. Cost: a legitimately QUOTED cd path stops matching and
  // falls back to cwd — the safe direction, and unquoted is what agents actually emit.
  let scan = cmd;
  try { scan = require('../../../hooks/lib/hook-input.js').stripQuotedRegions(cmd); }
  catch { /* lib unavailable → scan raw; worst case a quoted path fails to match */ }

  // Only a `cd` PRECEDING the git invocation sets its working directory.
  // The keyword is found in `scan` (so a quoted "cd /x" is ignored) but the ARGUMENT
  // is read from the raw command at the same offset — stripping keeps lengths — so
  // `cd "$R"` still yields `$R` for variable resolution below.
  // `git` as a COMMAND word only — a bare \bgit\b also hits `R=~/dev/git-tools` or a
  // `.git` path, putting gitAt before the cd and silently ignoring it.
  // S81 review: anchor on the MATCHED push, not the first git word — in
  // `git status && cd ../wt && git push` the cd governs the push.
  let gitAt = typeof pushAt === 'number' ? pushAt : -1;
  if (gitAt === -1) {
    const gitM = /(?:^|&&|\|\||;|\n|\()[ \t]*(?:git|gh)[ \t]/.exec(scan);
    gitAt = gitM ? gitM.index : -1;
  }
  // Match only `cd<blank>` in scan: a trailing `\s+` would also swallow the spaces a
  // blanked `"$R"` became and start the argument read at the next `&&`; and `\s` would
  // let `cd⏎git …` read `git` as the directory.
  const re = /(?:^|&&|\|\||;|\n|\()[ \t]*cd[ \t]/g;   // `(` = subshell cd
  let last = null;
  let mm;
  while ((mm = re.exec(scan)) !== null) {
    if (gitAt !== -1 && mm.index > gitAt) break;
    const argAt = mm.index + mm[0].length - 1;
    const arg = /^[ \t]+("[^"]*"|'[^']*'|[^\s;&|]+)/.exec(cmd.slice(argAt));
    if (arg) last = { raw: arg[1], value: arg[1].replace(/^(["'])(.*)\1$/, '$2'), at: argAt };
  }
  if (last === null) return null;

  // Single quotes: bash does not expand `cd '$R'`, so neither do we.
  const value = last.raw[0] === "'" ? last.value : resolveVars(last.value, cmd, last.at);
  const dir = existingDir(value);
  return dir ? { dir, resolvedFrom: value !== last.value ? last.value : null } : null;
}

// `W=/abs; git -C "$W" commit` / `R=/abs; cd "$R"`: fill the variable from a standalone
// assignment earlier in the same cell (hooks/lib/hook-input.js resolveAssignedVars).
// The catch is defensive only — a missing lib already exited at the matchGitCommit
// require above ("REVIEW GATE DISABLED"), so this path is not a tested degradation.
function resolveVars(value, cmd, before) {
  try {
    return require('../../../hooks/lib/hook-input.js').resolveAssignedVars(value, cmd, before);
  } catch { return value; }
}

// The path only if it is an existing directory, else null. A resolved value that is
// NOT a directory must never become dirArg: rev-parse would fail on a path with no
// `$` left in it, and the catch below reads that as "genuinely not a repo" → exit 0,
// i.e. a wrong guess would DISABLE the gate instead of falling back to cwd.
function existingDir(p) {
  if (typeof p !== 'string' || !p) return null;
  const expanded = p.replace(/^~(?=\/|$)/, os.homedir());
  try {
    return fs.statSync(expanded).isDirectory() ? expanded : null;
  } catch {
    return null; // nonexistent → fall back to cwd, never disable the gate
  }
}

// execFileSync does NOT shell-expand ~ — without this, `git -C ~/.claude commit`
// (the wrap Step 8 house style) makes rev-parse fail and the gate exits 0: fail-open.
// A `-C "$W"` whose variable resolved to a real directory uses that; otherwise the raw
// value, so an unresolvable `$W` still reaches the cwd fallback + NOTE below.
// `resolved` records any variable the HOOK filled in: a resolution is a guess about
// what the shell will do, so it is always announced, and if it fails it falls back to
// cwd rather than taking the "genuinely not a repo" exit (review 2026-09-15: a guess
// landing on an existing non-repo directory silently disabled the gate).
const cResolved = m.cPathResolved !== m.cPath ? existingDir(m.cPathResolved) : null;
const cd = (cResolved || m.cPath) ? null : cdTarget(command, m.offset);
const resolved = cResolved ? { from: m.cPath, dir: cResolved }
  : (cd && cd.resolvedFrom) ? { from: cd.resolvedFrom, dir: cd.dir } : null;
const dirArg = (cResolved || m.cPath || (cd && cd.dir) || process.cwd())
  .replace(/^~(?=\/|$)/, os.homedir());

function block(msg) {
  process.stderr.write(
    'REVIEW GATE: push / PR blocked — ' + msg +
    ' Fix: run /review — it covers everything this branch adds since it left the' +
    ' default branch that no earlier review saw (docs-only changes auto-pass) — then' +
    ' push. Commits are not gated. The skip flag is the owner\'s — never set it yourself;' +
    ' if the listed code is not yours, stop and tell the user.\n');
  process.exit(2);
}

// Resolve the repo being committed to. If it is not a git repo, the commit will
// fail on its own — nothing to gate here.
//
// EXCEPT when `-C` carried an unexpanded shell variable. This hook sees the command
// TEXT, so `git -C "$W" commit` hands over the literal `$W`, rev-parse fatals, and
// this catch exited 0 — silently, on the worktree form the house uses for every
// parent-repo commit (S183's Rails WIP commit was `git -C "$W" commit -q -F -`, so
// the review gate never evaluated it). Found S184 by committing through the real
// harness; every earlier probe passed a literal path. Fall back to cwd, and if even
// that fails, say so — a gate that goes quiet is the failure being fixed.
let commitRepo = '';
let cwdFallback = false;
try {
  commitRepo = repoTopLevel(dirArg);
} catch {
  let unexpanded = false;
  try { unexpanded = require('../../../hooks/lib/hook-input.js').unexpandedPath(dirArg); } catch {}
  if (!unexpanded && !resolved) process.exit(0); // genuinely not a repo
  try {
    commitRepo = repoTopLevel(process.cwd());
    cwdFallback = true;
  } catch {
    process.stderr.write(
      `REVIEW GATE NOT EVALUATED: \`${resolved ? resolved.from : dirArg}\` is a shell ` +
      `variable the hook could not resolve to a repo, and the fallback cwd is not a git ` +
      `repo. Nothing was reviewed-checked.\n`);
    process.exit(0);
  }
}
if (resolved && !cwdFallback) {
  process.stderr.write(
    `REVIEW GATE NOTE: resolved \`${resolved.from}\` to ${resolved.dir} from an assignment ` +
    `in this command and checked ${commitRepo}. If the shell would not apply that ` +
    `assignment (a failed condition, a subshell), this gate checked the wrong repo.\n`);
}
if (cwdFallback) {
  process.stderr.write(
    `REVIEW GATE NOTE: \`-C ${resolved ? resolved.from : dirArg}\` could not be expanded to a repo by the hook; checked ` +
    `the cwd repo (${commitRepo}) instead. If the commit targets a DIFFERENT repo, ` +
    `this gate did not see it — use a literal path for a real check.\n`);
}

// ~/.claude is exempt (owner, 2026-10-10): wrap Step 8 sync is never held by this gate.
try {
  if (fs.realpathSync(commitRepo) === fs.realpathSync(path.join(os.homedir(), '.claude'))) process.exit(0);
} catch {}

// ---- What does this push SEND? (S81 review round) ----
// Each refspec source (or gh --head) is diffed against where IT left the default
// branch; --all/--mirror/--tags/`:` enumerate every local branch/tag not yet merged
// into the default branch. A source that is the checked-out commit uses this
// worktree's flag; a branch checked out in another worktree uses THAT worktree's
// flag (reviewed there, pushed by name from here); otherwise this repo's flag.
const hiLib = require('../../../hooks/lib/hook-input.js');
const segs = hiLib.scanGitSegments(command);
// State changes earlier in the SAME cell (commit, add, checkout/switch, …) have not
// happened when this hook runs: what the push will send may still be only in the
// working tree, on a branch that may not exist yet. In such a cell the gate checks
// BOTH every resolvable source's committed tip AND base→worktree (+ untracked when
// an `add` runs first), and an unresolvable source is not a block — the worktree
// view covers it. (S81 re-check: `checkout feat && commit -am && push origin feat`
// sent uncommitted code unchecked; `checkout -b new && … && push origin new`
// blocked on "cannot resolve"; a same-cell empty commit hid committed code.)
const STATE_SUBS = new Set(['commit', 'add', 'checkout', 'switch', 'merge', 'rebase',
  'reset', 'cherry-pick', 'revert', 'stash', 'pull', 'am', 'apply', 'restore', 'rm', 'mv']);
const stateFirst = segs.some(x => STATE_SUBS.has(x.sub) && x.offset < m.offset);
const addFirst = segs.some(x => (x.sub === 'add' || x.sub === 'stash') && x.offset < m.offset);

function gitOut(args) {
  return execFileSync('git', ['-C', commitRepo, ...args],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: MAX_DIFF_BUFFER }).trim();
}
function tryOut(args) { try { return gitOut(args); } catch { return null; } }
const NO_BASE = 'no default branch to compare against (tried origin/HEAD, origin/main, ' +
  'origin/master, any remote HEAD) — run `git fetch` / `git remote set-head origin -a`, ' +
  'or this push cannot be checked.';

const headSha = tryOut(['rev-parse', '-q', '--verify', 'HEAD^{commit}']);
const refs = [...(m.sources || ['HEAD'])];
if (m.all || m.tags) {
  const dref = plainDefaultRef(commitRepo);   // NOT review.base: a ref merged into it would skip branchBase's fallback
  if (!dref) block(NO_BASE);
  const kinds = [...(m.all ? ['refs/heads'] : []), ...(m.tags ? ['refs/tags'] : [])];
  const listed = tryOut(['for-each-ref', '--format=%(refname)', '--no-merged=' + dref, ...kinds]);
  if (listed === null) block('could not list the branches/tags this push sends.');
  refs.push(...listed.split('\n').filter(Boolean));
}

function worktreeFor(ref) {
  const want = ref.startsWith('refs/') ? ref : 'refs/heads/' + ref;
  const out = tryOut(['worktree', 'list', '--porcelain']) || '';
  let wt = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) wt = line.slice(9);
    else if (line === 'branch ' + want && wt) {
      try { return fs.realpathSync(wt); } catch { return wt; }
    }
  }
  return null;
}

// A tag created earlier in the SAME cell (`git tag v1 [<commit>] && git push origin v1`)
// does not exist yet: resolve it to the commit it will point at, so it is checked like
// any branch tip instead of blocking as unresolvable (automate-me 2026-10-24).
const newTags = new Map();
for (const sg of segs) {
  if (sg.sub !== 'tag' || sg.offset >= m.offset) continue;
  const pos = [];
  for (let i = 0; i < sg.args.length; i++) {
    const a = sg.args[i];
    if (/^(-m|-F|-u|--message|--file|--local-user|--cleanup)$/.test(a)) { i++; continue; }
    if (/^(-d|--delete|-l|--list|-v|--verify)$/.test(a)) { pos.length = 0; break; }
    if (a.startsWith('-')) continue;
    pos.push(a);
  }
  if (pos.length) newTags.set(pos[0], pos[1] || 'HEAD');
}
let text = '';
let anyFlag = false;
for (const ref of [...new Set(refs)]) {
  const tagName = ref.replace(/^refs\/tags\//, '');
  const tip = tryOut(['rev-parse', '-q', '--verify', ref + '^{commit}'])
    || tryOut(['rev-parse', '-q', '--verify', 'refs/remotes/origin/' + ref + '^{commit}'])
    || (newTags.has(tagName) ? tryOut(['rev-parse', '-q', '--verify', newTags.get(tagName) + '^{commit}']) : '');
  if (!tip) {
    if (stateFirst) continue;   // created/moved later in this cell — worktree view below
    block('cannot resolve `' + ref + '` to a commit, so what it sends cannot be checked.');
  }
  const isHead = tip === headSha;
  const flagRepo = isHead ? commitRepo : (worktreeFor(ref) || commitRepo);
  const flag = readFlag(flagRepo);
  if (flag) anyFlag = true;
  // A REVISE verdict blocks outright — must-fix items are outstanding on code the
  // review already saw; an inert delta cannot discharge them.
  if (flag && flag.verdict !== 'PASS') {
    block('the last /review verdict was ' + flag.verdict +
      ' — address the must-fix items, then re-run /review.');
  }
  const d = deltaDiff(commitRepo, flag, { to: tip });
  if (d.noBase) block(NO_BASE);
  if (d.text === null) {
    block('`git diff` itself failed (oversized diff, lock contention, or repo error)' +
      ' — coverage cannot be verified, failing toward review.');
  }
  text += d.text;
}
if (stateFirst) {
  const flag = readFlag(commitRepo);
  if (flag) anyFlag = true;
  if (flag && flag.verdict !== 'PASS') {
    block('the last /review verdict was ' + flag.verdict +
      ' — address the must-fix items, then re-run /review.');
  }
  const d = deltaDiff(commitRepo, flag, { requireBase: true, untracked: addFirst });
  if (d.noBase) block(NO_BASE);
  if (d.text === null) {
    block('`git diff` itself failed (oversized diff, lock contention, or repo error)' +
      ' — coverage cannot be verified, failing toward review.');
  }
  text += d.text;
}
const delta = text;
if (delta.trim() === '') process.exit(0); // everything the push sends was reviewed

// Classify the unreviewed delta; only CODE in it blocks. Classifier failure
// fails toward review (P72 asymmetry) — same direction as classify-diff itself.
let cls = null;
try {
  cls = JSON.parse(execFileSync(process.execPath, [path.join(__dirname, 'classify-diff.js')],
    // timeout: a pathological diff must BLOCK (cls stays null → "classifier unavailable"),
    // not hang the push past the hook's own timeout. Largest real diff in 300 commits
    // (428 KB) classifies in 72 ms, so 2 s is ~28× headroom (2026-09-15 security review).
    { input: delta, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], maxBuffer: MAX_DIFF_BUFFER, timeout: 2000 }));
} catch {}
if (cls && cls.contentOnly === true) process.exit(0); // docs/telemetry/data only

const files = (cls && Array.isArray(cls.codeFiles) && cls.codeFiles.length)
  ? cls.codeFiles.join(', ') : '<classifier unavailable — failing toward review>';
block((anyFlag ? 'this push carries CODE no /review has seen: '
               : '/review has not covered this code: ') + files + '.');
