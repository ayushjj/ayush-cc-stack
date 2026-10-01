#!/usr/bin/env node
// PreToolUse hook: blocks a `git commit` that AUTHORS a new decision entry
// (`### D<n>`) inside the same commit that carries this session's WRAP artifacts.
//
// WHY THIS EXISTS
//   "D-entries authored at wrap, not at decision-time" sat in the mistake table
//   for 10 fires and re-logged twice past its own stop order ("BUILD
//   check-d-entry-timing.js or DELETE this row"). A tally is not a gate. The
//   Authoring Discipline it enforces: capture a decision WHEN IT IS MADE, because
//   the reasoning that justified it is in context then and reconstructed later.
//   A D-entry written at wrap is a summary of a decision, not a record of one.
//
// THE PREDICATE (pure function of the staged diff — no session identity, no flag
// file, nothing to go stale)
//   BLOCK  iff  the staged diff ADDS a new `### D<n>` heading to a `decisions.md`
//               AND the same staged diff also touches a wrap artifact.
//   A wrap artifact is the structural signature of a wrap commit: a file under
//   `learnings/`, a `MEMORY.md`, a `session-registry.yaml`, or anything under
//   `telemetry/`. Those are cross-project wrap conventions, so this hook stays
//   universal by construction (P68) — no project name, path, or session id in it.
//
// FALSIFIABILITY (P72 — the check must be able to FAIL, and to PASS, on inputs
// you can actually construct; all three are covered by tests/d-entry-timing-canary.sh)
//   BLOCKS: decisions.md gains `### D144` + learnings/2026-01-01-foo.md staged.
//   PASSES: decisions.md gains `### D144` and NOTHING else is staged
//           (the decision-time commit — exactly the behaviour we want).
//   PASSES: a wrap commit that EDITS existing D-entry prose but adds no new
//           `### D<n>` heading (fixing a typo at wrap is not authoring).
//
// WHAT IT CANNOT DO
//   It cannot retroactively fix timing — by commit time the D-entry is already
//   written late. Its job is to make the violation un-ignorable and force an
//   EXPLICIT override instead of a silent 11th repeat. If you are blocked and the
//   entry genuinely belongs in this commit, take the skip valve and say so.
//
// Skip entirely: CLAUDE_D_ENTRY_TIMING_SKIP=1
// Warn-only:    CLAUDE_D_ENTRY_TIMING_WARN_ONLY=1

'use strict';

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// Always-on guard: an unloadable reader must NOT block every Bash call in the
// session, so this fails open — loudly. (Same stance as check-cd-persistence.)
let command;
let hookLib;
try {
  hookLib = require('./lib/hook-input.js');
  command = hookLib.readToolCommand();
} catch (err) {
  process.stderr.write(`d-entry-timing guard DISABLED: ${err.message}\n`);
  process.exit(0);
}
if (!command) process.exit(0);

// The override is read from the ENV **or** from an inline prefix on the command
// under inspection. It used to be env-only, which meant the escape this hook
// prints could never work from inside an agent session: a PreToolUse hook is a
// separate process and never sees `VAR=1 git commit`'s assignment. The gate was
// therefore a hard stop for the agent, and several /wrap runs died at the final
// commit for the human to finish by hand. See lib/hook-input.js § DELIBERATE-
// OVERRIDE DETECTION for the false-positive handling (quoted spans and heredoc
// bodies are stripped, so merely writing this token in a doc does not disarm it).
if (hookLib.bypassed('CLAUDE_D_ENTRY_TIMING_SKIP', command, { appliesTo: ['git'] })) process.exit(0);

// ---------------------------------------------------------------------------
// Is this a `git commit`, and against which directory?
//
// The parser now lives in lib/hook-input.js — it was duplicated verbatim here and
// in skills/review/scripts/check-review-gate.js, and BOTH copies needed the same
// `return`→`break` fix and then both carried the same newline defect (S184: a
// multi-LINE `git add …⏎git commit …` cell went dark in both gates, which is the
// form /wrap emits). Two addresses for one bug; see that function's header for
// the measurements, the fail-closed heredoc trade, and the residuals.
// ONE scan, reused. matchGitCommit stays exported for check-review-gate.js (its
// only other consumer, signature unchanged), but deriving the same segment twice
// here invited the two derivations to drift apart under a later edit.
// WHICH commit segment is the real one? scanGitSegments deliberately does not strip
// quoted spans or heredoc bodies (stripping them breaks `-C "my dir"`), so a
// `git commit` appearing as TEXT reads as a segment, and a phantom on either side of
// the real commit can claim it. Position alone cannot separate them — both of these
// are live shapes with canary coverage, and they point opposite ways:
//     `echo "now git commit runs" && git -C R add -A && git -C R commit`  phantom FIRST
//     `git -C R commit -F - <<'EOF' … git commit … EOF`                   phantom LAST
// Taking the last fixed the first shape and regressed the second from fail-CLOSED
// (its documented, intended residual) to fail-OPEN — caught by override-reachability
// §9, which is why that canary is worth running on a change to this file.
//
// Discriminate by CONTENT instead: a phantom in prose or a message body does not
// carry `-C <path>`; the house's real commits do. Prefer the first commit segment
// bearing a `-C`, else fall back to the first — which is exactly the pre-existing
// behaviour, so a cell with no `-C` anywhere is unchanged.
const commitSegs = hookLib.scanGitSegments(command).filter(s => s.sub === 'commit');
const commitSeg = commitSegs.find(s => s.cPath) || commitSegs[0];
if (!commitSeg) process.exit(0);
const m = { matched: true, cPath: commitSeg.cPath };

// execFileSync does NOT shell-expand `~`; without this, `git -C ~/.claude commit`
// makes rev-parse fail and the gate exits 0 (fail-open). Same fix as the review gate.
const rawDir = m.cPath || process.cwd();
let dir = rawDir.replace(/^~(?=\/|$)/, os.homedir());

function git(args) {
  return execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: 32 * 1024 * 1024,
  });
}

function stagedIn() {
  return git(['diff', '--cached', '--name-only']).split('\n').map(s => s.trim()).filter(Boolean);
}

// Diagnostics accumulated anywhere below and flushed once, before the verdict.
// Declared up here because the resolvers need it: a branch that cannot evaluate
// must SAY so, and one that returns a bare null instead is indistinguishable from
// "nothing to report" — which is this gate's entire failure mode.
const notes = [];

// PATH BASE (S186 review). Every git command that PRINTS paths prints them
// repo-root-relative; every git command that CONSUMES a path resolves it against
// the process cwd, which `-C` sets. Those agree only when `-C` names the repo root.
// Point it at a SUBDIRECTORY and `add --dry-run` emits `proj/docs/decisions.md`
// while the follow-up `diff -- proj/docs/decisions.md` run from `proj/` matches
// nothing — the gate goes dark, silently, on every contributor at once.
//
// So: consumers run from the TOP LEVEL, where root-relative paths are correct.
// Producers keep running from `dir`, because user-supplied pathspecs (the cell's
// own `add` args, the commit's `--` specs) are cwd-relative and must stay so.
let top = dir;   // resolved AFTER the -C fallback below; see there.

function gitTop(args) {
  return execFileSync('git', ['-C', top, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: 32 * 1024 * 1024,
  });
}

// ---------------------------------------------------------------------------
// WHAT THIS COMMIT WILL CONTAIN (S186)
//
// A PreToolUse hook runs BEFORE the shell, so `git diff --cached` reports the index
// as it stood BEFORE anything the cell does. Measured, same repo content each way:
//     pre-staged, `git commit -m wrap`                         -> exit 2 (blocked)
//     `git add decisions.md learnings/x.md && git commit`      -> exit 0 (DARK)
// The canary passed 18/18 across BOTH runs, including a case literally named
// "BLOCKS through compound commands (the real workflow invocation)" — because that
// case pre-staged its files first. It proved the PARSER sees through `&&`; it never
// varied the index, which is the thing that was wrong. §9 varies exactly that.
//
// THE ROOT CAUSE IS BROADER THAN THE INDEX, and the first pass at this fix missed
// how much broader (caught in review, all four verified by repro). Git sources a
// commit's content FOUR ways, and only the first is visible in `--cached`:
//     1. the index                                    `git diff --cached`
//     2. a same-cell `git add`                        replay it
//     3. `git commit -a`                              tracked modifications
//     4. a pathspec ON THE COMMIT — `git commit -- <paths>` /
//        `--pathspec-from-file=F`                     worktree for those paths
// (3) and (4) are ONE root cause — "the commit takes content from the working tree,
// not the index" — so fixing (3) alone was patching a symptom (Checklist 8). (4) is
// not hypothetical: `skills/wrapping-session/SKILL.md:544` commits via
// `--pathspec-from-file`, and :557's degraded path uses `commit -m … -- <paths>`.
// The gate was dark on the exact form its own house workflow emits.
//
// Reconstruction REPLAYS pathspecs through `git add --dry-run` rather than
// reimplementing pathspec semantics. That buys `-A`, `.`, globs, `:(exclude)` and
// .gitignore from git itself, and writes nothing — --dry-run touches neither the
// index nor the object store.
function dryRunAdd(args) {
  // Our flags go FIRST so a caller arg cannot be read as their value, and so a
  // caller-supplied `--` still terminates flag parsing for the pathspecs after it.
  // We deliberately do NOT append our own `--`: the caller's args may already carry
  // one. `--ignore-missing` is ONE deliberate divergence from the real add: a bad
  // pathspec would abort the real add entirely (staging nothing), whereas here it
  // keeps the rest of the replay alive. So this can OVER-report, which on a gate
  // fails closed — a loud, overridable block — and that is the safe direction.
  const out = git(['add', '--dry-run', '--ignore-missing', ...args]);
  const paths = [];
  for (const line of out.split('\n')) {
    // Format is `add 'path'` (also `remove 'path'` under -A). Only additions can
    // carry a new D-heading, and a DELETED learnings file is not the signature of
    // a wrap commit either, so `remove` is deliberately ignored. Verified: git does
    // NOT apply core.quotePath here and does not escape, so a greedy capture to the
    // LAST quote handles paths containing quotes, spaces and non-ASCII. The one
    // mis-parse is a path with an embedded NEWLINE, which splits the line; that
    // drops the path (fail-open) and is accepted.
    const hit = /^add '(.*)'$/.exec(line.trim());
    if (hit) paths.push(hit[1]);
  }
  return paths;
}

// scanGitSegments only unquotes a token whose FIRST character is a quote, so a
// `--flag="value"` keeps its quotes. Strip them off a flag's value explicitly.
//
// Without this the gate was dark on the house workflow AGAIN, one review later:
// SKILL.md:544 writes `--pathspec-from-file="$HOME/…"`, and the leading `"` made
// path.isAbsolute false, path.join miss, and the read throw — silently. The §11
// canary passed only because its fixture wrote the flag UNQUOTED. Third time in
// this change that a fixture was built so the failing case could not arise.
function unquoteValue(s) {
  const q = s[0];
  return (q === '"' || q === "'") && s.length > 1 && s.endsWith(q) ? s.slice(1, -1) : s;
}

// Contributor 4: a pathspec on the COMMIT itself. `git commit -- a b` and
// `git commit --pathspec-from-file=F` take working-tree content for those paths and
// bypass the index entirely. Returns null when the commit carries no pathspec.
//
// Every un-evaluable branch pushes a NOTE rather than returning a bare null: the
// prior version claimed the unexpanded case was "announced by the unresolvable
// path", but `unresolvable` is computed over the ADD segments and never inspects
// the commit, so that branch printed nothing at all.
function commitPathspecOf(seg) {
  const fromFile = seg.args.find(a => a.startsWith('--pathspec-from-file='));
  if (fromFile) {
    const f = unquoteValue(fromFile.slice('--pathspec-from-file='.length));
    // `-` means git reads the pathspec list from STDIN, which a PreToolUse hook
    // cannot see. Reading a literal file named `-` would be wrong in both
    // directions: usually ENOENT (dark), or a real `-` file (false block).
    if (f === '-') {
      notes.push('this commit takes its pathspec from STDIN (`--pathspec-from-file=-`), ' +
        'which a PreToolUse hook cannot read. Those files were not checked.');
      return null;
    }
    if (hookLib.unexpandedPath(f)) {
      notes.push(`this commit's \`--pathspec-from-file=${f}\` contains an unexpanded shell ` +
        'variable, which a PreToolUse hook cannot resolve. Those files were not checked.');
      return null;
    }
    try {
      // Resolved against `dir`, NOT the repo top level — git resolves this file
      // against its own process cwd, which is exactly what `-C` sets. Verified.
      const raw = fs.readFileSync(path.isAbsolute(f) ? f : path.join(dir, f), 'utf8');
      // `--pathspec-file-nul` uses NUL separators; support both rather than
      // mis-reading a NUL-separated file as one giant pathspec.
      const sep = seg.args.includes('--pathspec-file-nul') ? '\0' : '\n';
      const specs = raw.split(sep).map(s => unquoteValue(s.trim())).filter(Boolean);
      return specs.length > 0 ? specs : null;
    } catch (err) {
      notes.push(`could not read this commit's pathspec file ${f} ` +
        `(${String(err.message).split('\n')[0]}). Those files were not checked.`);
      return null;
    }
  }
  // A bare `--` separator: everything after it is a pathspec. `git commit -m x -- a`
  // A `--` inside a quoted commit MESSAGE cannot reach here: rejoinQuotedArg folds
  // the message into ONE arg before this scan (verified — `-m "fix -- really"` still
  // blocks correctly).
  const dd = seg.args.indexOf('--');
  if (dd >= 0) {
    const specs = seg.args.slice(dd + 1).map(unquoteValue).filter(Boolean);
    return specs.length > 0 ? specs : null;
  }
  return null;
}

// Does this path have a HEAD side to diff against? The untracked fallback below
// needs to ASK, not infer. Inferring it from an empty diff conflated two states and
// produced a false BLOCK: a tracked decisions.md whose worktree equals HEAD but
// whose INDEX differs is listed by `git add --dry-run` (worktree-vs-index), so it
// landed in the "untracked" branch, was read whole, and every heading committed
// months ago was reported as newly authored.
function isTracked(p) {
  try {
    gitTop(['ls-files', '--error-unmatch', '--', p]);
    return true;
  } catch (err) {
    // `--error-unmatch` exits 1 for "no such path". ANY other failure (repo lock,
    // permissions, a pathspec git dislikes) is a git error, and mapping it onto
    // "untracked" re-enters the false-block class this function exists to close —
    // the whole file would be read and every historical heading reported as new.
    if (err && err.status === 1) return false;
    notes.push(`could not determine whether ${p} is tracked ` +
      `(${String(err && err.message).split('\n')[0]}); skipped the untracked fallback.`);
    return true; // fail toward "no evidence", never toward a block
  }
}

// Not a git repo / git unavailable -> the commit will fail on its own merits.
//
// EXCEPT when `-C` carried an unexpanded shell variable. A PreToolUse hook sees the
// command TEXT, so `git -C "$W" commit` hands us the literal `$W`; `git -C '$W'`
// fatals and this catch used to exit 0 — silently, on the worktree form the house
// uses constantly (S183's Rails WIP commit was exactly `git -C "$W" commit -q -F -`).
// Found by committing through the real harness; every earlier probe passed a
// literal path, so no fixture could surface it. Fall back to cwd, and if the gate
// then has nothing to say, SAY THAT — an unevaluated gate must not print nothing.
let stagedFiles;
let fellBack = false;
try {
  stagedFiles = stagedIn();
} catch {
  if (!hookLib.unexpandedPath(rawDir)) process.exit(0); // genuinely not a repo
  dir = process.cwd();
  fellBack = true;
  try {
    stagedFiles = stagedIn();
  } catch {
    process.stderr.write(
      `d-entry-timing guard NOT EVALUATED: \`-C ${rawDir}\` is an unexpanded shell ` +
      `variable and the fallback cwd (${dir}) is not a git repo. Nothing was checked.\n`);
    process.exit(0);
  }
}
if (fellBack) {
  process.stderr.write(
    `d-entry-timing NOTE: \`-C ${rawDir}\` could not be expanded by the hook; ` +
    `evaluated the cwd repo (${dir}) instead. If the commit targets a DIFFERENT ` +
    `repo, this gate did not see it — re-run with a literal path to get a real check.\n`);
}

// NOW resolve the top level — `dir` is final only at this point. Computing it
// earlier meant an unexpanded `-C "$W"` left `top` holding the literal `$W` even
// after the fallback repaired `dir` to the cwd repo, so every consumer call fatal'd
// and the gate went dark on the worktree form §6d exists to cover. Caught by §6d.
try {
  top = git(['rev-parse', '--show-toplevel']).trim() || dir;
} catch { /* not a repo / no HEAD — the callers below degrade on their own */ }
// ---------------------------------------------------------------------------
// Reconstruct what this cell will actually commit — the four contributors named in
// the header block. Every one that cannot be resolved gets ANNOUNCED, never
// swallowed: this gate's whole premise is that an unevaluated check must not print
// nothing, and each silent `catch` here is one more way to be dark.
const commitAll = commitSeg.args.some(
  t => t === '--all' || /^-[a-zA-Z]*a[a-zA-Z]*$/.test(t)); // regex covers -a and -am

// A `cd` in the same cell moves the target out from under us. The hook is handed
// command TEXT and cannot know where a `cd` lands, so `dir` (from `-C`, else the
// hook's cwd) may name a DIFFERENT repo than the commit. That used to be harmless —
// we read the wrong repo's INDEX, which mid-session is usually empty, so the gate
// exited 0. Replaying `git add -A` changes the stakes: it reads the wrong repo's
// WORKTREE, which mid-wrap is exactly where an uncommitted D-entry lives, so the
// gate would BLOCK a commit going somewhere else while quoting a heading that
// commit does not touch. A false block on an innocent repo is worse than a miss.
// Scanned with quoted spans BLANKED, and matching every form that moves the shell.
// The raw-text version failed in both directions, each verified:
//   FALSE POSITIVE (dark): the word `cd` inside a commit MESSAGE satisfied it, so
//     `git add -A && git commit -m "ran: foo; cd x; make"` printed a NOTE and let a
//     real violation through. A NOTE is not a gate, and multi-line wrap messages
//     routinely contain prose like this. (The sibling cd-persistence hook fired on
//     exactly this shape while I was probing it — same class, same raw-text scan.)
//   FALSE NEGATIVE (false block): `(` was not a separator and `pushd`/bare `cd`/
//     `builtin cd` were not matched, so `(cd OTHER && git add -A && git commit)` —
//     the form check-cd-persistence.js itself RECOMMENDS — blocked a commit going
//     to another repo while quoting this repo's heading.
// Residual, deliberate: stripQuotedRegions blanks from the first `<<`, so a heredoc
// followed by a real `cd` under-detects. That lands on the false-block side, which
// is the cheaper one here, and matches the module's documented stance.
const cdsAway =
  /(^|[|;&()\n\r])[ \t]*(builtin[ \t]+)?(cd|pushd|popd)(\s|$)/
    .test(hookLib.stripQuotedRegions(command)) && !m.cPath;

// Only adds targeting THIS repo matter; an add with its own `-C elsewhere` stages a
// different index. Compare RESOLVED paths — an exact string compare dropped `-C $R/`
// and `-C $R/.` as foreign, silently reverting to pre-S186 behaviour on a trailing
// slash. Both directions of that predicate fail open, which is the direction that
// matters here.
const resolve = p => path.resolve(p.replace(/^~(?=\/|$)/, os.homedir()));
const sameTarget = seg =>
  seg.cPath ? resolve(seg.cPath) === resolve(dir)
            : (!m.cPath || fellBack); // no -C on the add: it inherits the cell's cwd

const allAdds = hookLib.matchGitAdds(command);
// Computed BEFORE the sameTarget filter: for `git -C "$W" add … && git -C "$W" commit`
// the add's cPath is the literal `$W`, which never resolves to `dir`, so filtering
// first dropped it as "foreign" and this notice — written for exactly that worktree
// form — could never fire.
const unresolvable = allAdds.filter(
  s => s.args.some(a => hookLib.unexpandedPath(a)) || hookLib.unexpandedPath(s.cPath || ''));
const addSegs = allAdds.filter(sameTarget);

let prospective = [];
if (cdsAway && (addSegs.length > 0 || commitAll)) {
  notes.push(
    `this cell changes directory (\`cd …\`) and the commit carries no \`-C\`, so the ` +
    `hook cannot tell which repo it targets. Only the ALREADY-STAGED files of ` +
    `${dir} were checked. Use \`git -C <path> commit\` to get a real check.`);
} else {
  for (const s of addSegs) {
    if (unresolvable.includes(s)) continue;
    try {
      prospective = prospective.concat(dryRunAdd(s.args));
    } catch (err) {
      // NOT only "a pathspec git rejects" — index-lock contention, permissions and
      // unanticipated repo states land here too, and each one silently reduced the
      // gate to its staged half.
      notes.push(`could not replay \`git ${s.sub} ${s.args.join(' ')}\` ` +
        `(${String(err.message).split('\n')[0]}). Its files were not checked.`);
    }
  }
  // A replay that yields ZERO paths while the cell plainly contains a `git add` is
  // just as unevaluated as one that threw. It happens for real: shell redirections
  // ride along in the parsed args (`git add -A 2>/dev/null` -> args ['-A','2>/dev/null']),
  // and git then SUCCEEDS with empty output because the bogus pathspec restricts the
  // add to nothing. rc=0, no output, no catch, gate dark.
  if (addSegs.length > 0 && prospective.length === 0 && unresolvable.length === 0) {
    notes.push(`the cell stages (\`git ${addSegs[0].sub} ${addSegs[0].args.join(' ')}\`) but ` +
      `replaying it matched no files — possibly a redirection or shell syntax parsed as a ` +
      `pathspec. Only the ALREADY-STAGED files were checked.`);
  }

  // Contributors 3 and 4: both take content from the WORKING TREE rather than the
  // index, which is why they are one root cause and are handled together. `-a`
  // sweeps tracked modifications; a pathspec on the commit takes those paths.
  const commitPathspec = commitPathspecOf(commitSeg);
  if (commitAll || commitPathspec) {
    try {
      const args = ['diff', '--name-only', 'HEAD'];
      if (commitPathspec) args.push('--', ...commitPathspec);
      prospective = prospective.concat(
        git(args).split('\n').map(t => t.trim()).filter(Boolean));
    } catch (err) {
      // A repo with no HEAD (initial commit) is the benign case; anything else is
      // evidence dropped, so distinguish them instead of swallowing both.
      try {
        git(['rev-parse', '--verify', 'HEAD']);
        notes.push(`could not read the working-tree diff for this commit's ` +
          `${commitPathspec ? 'pathspec' : '`-a` sweep'} ` +
          `(${String(err.message).split('\n')[0]}). Those files were not checked.`);
      } catch { /* no HEAD yet: the index really is the whole story */ }
    }
  }
}

if (unresolvable.length > 0) {
  notes.push(
    `this cell stages via unexpanded shell variable(s) ` +
    `(\`git ${unresolvable[0].sub} ${unresolvable[0].args.join(' ')}\`), which a PreToolUse ` +
    `hook cannot resolve. Anything those variables add was not seen. Stage with ` +
    `literal paths to get a full check.`);
}
for (const n of notes) process.stderr.write(`d-entry-timing NOTE: ${n}\n`);

const prospectiveSet = new Set(prospective);
const willCommit = [...new Set([...stagedFiles, ...prospective])];

// Nothing staged AND nothing this cell will stage -> the commit fails on its own
// merits. (Previously this returned on the staged half alone, which is what made
// the combined-cell form dark.)
if (willCommit.length === 0) process.exit(0);

// ---------------------------------------------------------------------------
// The two halves of the predicate.

const isDecisionsDoc = p => path.basename(p).toLowerCase() === 'decisions.md';

// Wrap artifacts: the structural signature of a wrap commit.
const WRAP_ARTIFACT = [
  { test: p => /(^|\/)learnings\//.test(p), label: 'learnings/' },
  { test: p => path.basename(p) === 'MEMORY.md', label: 'MEMORY.md' },
  { test: p => path.basename(p) === 'session-registry.yaml', label: 'session-registry.yaml' },
  { test: p => /(^|\/)telemetry\//.test(p), label: 'telemetry/' },
];

const decisionsDocs = willCommit.filter(isDecisionsDoc);
if (decisionsDocs.length === 0) process.exit(0);

const wrapHits = [];
for (const p of willCommit) {
  const hit = WRAP_ARTIFACT.find(w => w.test(p));
  if (hit) wrapHits.push({ path: p, label: hit.label });
}
if (wrapHits.length === 0) process.exit(0); // decisions.md alone = the decision-time commit we WANT

// Added D-entry headings only. `-U0` keeps the hunk bodies out, so a `+` line is
// genuinely an addition rather than context. Strikethrough forms (`### ~~D12~~`)
// are deliberately NOT matched: marking an entry superseded is a documentation
// act, not authoring a new decision.
//
// Registers are not all bare `D<n>`: prefixed (`D-MI25`, `D-CR8`), letter-only
// (`D-A`..`D-L`), `DP1`, `VR-3`, `Decision 3`, optionally wrapped in `**` or a backtick.
// An id that ENDS IN A DIGIT needs nothing after it (`D-MI26 identity refresh` is an
// entry). A LETTER-ONLY `D-<CAPS>` id must be followed by `:`, `(`, a dash (— – -) or
// end of line, since otherwise it cannot be told from `### D-API design notes`; so a bare
// `## D-UI` heading does block — accepted. After `D`, a digit or `-` + capitals is
// required, so `## D-series conventions`, `## D.1`, `## Decisions Index` stay unmatched.
// Amendment headings (`### D2 Addendum:`) matched before this change and still do.
// Both directions are pinned in the canary's §15.
const D_HEADING = /^\+\s{0,3}#{1,6}\s+(?:\*\*|`)?(?:D\d+\b|D-[A-Z]{1,3}\d+\b|D-[A-Z]{1,3}(?=\s*(?:[:(\u2014\u2013-]|$))|DP\d+\b|VR-\d+\b|Decision \d+\b)/;

const authored = [];
for (const doc of decisionsDocs) {
  let diff;
  try {
    // Source must match how this doc reaches the commit. For a doc the cell is
    // about to `add`, the committed content is the WORKING TREE, so diffing
    // `--cached` would compare the wrong pair and report no new heading — the
    // file-set fix alone would still have gone dark here. `diff HEAD` spans both
    // staged and unstaged edits, which is exactly what the add will capture.
    diff = prospectiveSet.has(doc)
      ? gitTop(['diff', '-U0', 'HEAD', '--', doc])
      : gitTop(['diff', '--cached', '-U0', '--', doc]);
  } catch {
    continue; // unreadable single-file diff -> treat as no evidence, keep going
  }
  // An UNTRACKED decisions.md has no HEAD side to diff against, so the command
  // above yields nothing; every line in it is new by definition.
  //
  // ASK whether it is tracked — do not infer it from an empty diff. Those are
  // different predicates, and conflating them produced a FALSE BLOCK: a tracked
  // decisions.md whose worktree matches HEAD but whose index differs is listed by
  // `git add --dry-run` (worktree-vs-index), so it reached this branch, was read
  // whole, and every heading committed months ago was reported as authored now —
  // on a commit whose decisions.md delta was empty. The message even named the
  // wrong heading, which makes it misleading rather than merely noisy.
  if (!diff.trim() && prospectiveSet.has(doc) && !isTracked(doc)) {
    try {
      diff = fs.readFileSync(path.join(top, doc), 'utf8')
        .split('\n').map(l => '+' + l).join('\n');
    } catch { continue; }
  }
  for (const line of diff.split('\n')) {
    if (D_HEADING.test(line)) {
      authored.push({ doc, heading: line.replace(/^\+\s*/, '').trim() });
    }
  }
}

if (authored.length === 0) process.exit(0); // wrap commit that only EDITS existing entries

// ---------------------------------------------------------------------------

const msg = [
  '════════════════════════════════════════════════════════════════',
  '⚠  D-ENTRY TIMING: a decision is being authored inside a WRAP commit.',
  '',
  `   New D-entr${authored.length === 1 ? 'y' : 'ies'} in this commit:`,
  ...authored.map(a => `     ${a.heading}   (${a.doc})`),
  '',
  '   Wrap artifacts staged alongside them:',
  ...wrapHits.slice(0, 6).map(w => `     ${w.path}  [${w.label}]`),
  ...(wrapHits.length > 6 ? [`     … and ${wrapHits.length - 6} more`] : []),
  '',
  '   A D-entry written at wrap is a SUMMARY of a decision, not a record of',
  '   one — the reasoning that justified it was in context when the decision',
  '   was made, and is reconstructed here. Capture decisions inline.',
  '',
  '   This gate cannot fix the timing retroactively. It exists so the pattern',
  '   is explicit rather than silently repeated (it had 10 prior fires and its',
  '   own stop order). If the entry genuinely belongs in this commit, override',
  '   deliberately — put the assignment at the FRONT of the command, and say in',
  '   the commit message why the entry could not be authored inline:',
  '     CLAUDE_D_ENTRY_TIMING_SKIP=1 git commit -m "..."',
  '',
  '   Warn-only for a session: CLAUDE_D_ENTRY_TIMING_WARN_ONLY=1 <command>',
  '',
  '   Both forms are read from the command itself as well as the environment,',
  '   and every use is appended to ~/.claude/.hook-overrides.log.',
  '════════════════════════════════════════════════════════════════',
];

process.stderr.write(msg.join('\n') + '\n');

if (hookLib.bypassed('CLAUDE_D_ENTRY_TIMING_WARN_ONLY', command, { appliesTo: ['git'] })) process.exit(0);

process.exit(2);
