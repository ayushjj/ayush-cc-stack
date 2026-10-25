'use strict';
// ONE reader for the hook payload the harness writes to fd 0.
//
// Hooks used to hand-roll this. The idiom was byte-identical across eight files, so
// when the read was wrong it was wrong eight times — and fixing one copy left the
// other seven broken.
//
// SCOPE (accurate as of this commit; do not upgrade to a universal claim without
// checking). Six command/tool-input readers import this module:
//   check-anticheat, check-cd-persistence, check-eval-first, check-destructive, check-freeze,
//   check-read-size (payload reader — needs tool_name to dispatch Read vs Bash)
// Still reading fd 0 directly, and NOT covered by this module:
//   check-skill-slug, check-review-gate, classify-diff  — correct (tty.isatty), duplicated
//   check-wrap-collision, memory-size-gate, session-manifest — still on the racing idiom
//     below; harmless only because every one of their code paths exits 0 (warn-only).
//   Give any of those three a block path and it inherits a silent fail-open.
//
// THE BUG THIS EXISTS TO DELETE
//   `if (!process.stdin.isTTY) fs.readFileSync(0, 'utf8')`
//   Touching `process.stdin` flips fd 0 to O_NONBLOCK. readFileSync(0) then
//   throws EAGAIN if the first byte is slow, the catch swallows it, `raw` stays
//   '', the command comes back '', and the guard exits 0 — silently allowing the
//   very thing it exists to block. `tty.isatty(0)` answers the same question
//   without touching the stream.
//   Incident history: learnings/2026-07-09-hook-liveness-fail-open.md
//
//   This failure is invisible to a NAIVE piped-stdin canary: a pipe delivers its
//   first byte instantly, so the race never fires. It IS catchable, but only by a
//   test that deliberately delays the first byte — see §6 of
//   hooks/tests/hook-liveness-canary.sh, which proves its own teeth each run by
//   first asserting a reconstructed racing reader DOES fail open. Module
//   (prevention: one place to be right) and canary (detection: any reintroduction)
//   are both required; neither subsumes the other.
//
// FAIL MODE (deliberate, not an oversight)
//   No input / unparseable input → `{}` → callers see an empty command → exit 0.
//   Fail-OPEN is correct here: a hook that blocks on garbage bricks every Bash
//   call in the session. "Fails closed" is not automatically safe — ask closed
//   onto what. The defense against a silently-dead guard is the liveness canary
//   (hooks/tests/hook-liveness-canary.sh), not a fail-closed read.

const fs = require('node:fs');
const tty = require('node:tty');
// Explicit, though Node >=25 exposes builtins as globals: matchGitCommit's
// path.join runs only on a REPEATED `-C`, so an implicit global would have
// resolved here and thrown on Node 22 LTS with nothing testing the branch.
const path = require('node:path');

let _raw; // fd 0 is drainable exactly once per process

function rawInput() {
  if (_raw !== undefined) return _raw;
  let raw = '';
  try {
    if (!tty.isatty(0)) raw = fs.readFileSync(0, 'utf8');
  } catch {
    raw = '';
  }
  // Legacy fallback. The harness has never set this; retained only so an older
  // harness (or a canary that injects it) keeps working. Never the primary path.
  if (!raw.trim() && process.env.CLAUDE_TOOL_INPUT) raw = process.env.CLAUDE_TOOL_INPUT;
  _raw = raw;
  return raw;
}

/** Full hook payload, e.g. { tool_name, tool_input, session_id }. `{}` if absent. */
function readHookPayload() {
  const raw = rawInput();
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * True only when the hook fires inside a subagent: `agent_id` is a non-empty string
 * (captured from real payloads 2026-09-15 — see check-read-size.js for the history).
 * Missing/blank/non-string → treated as the main session, so the gate applies.
 * NOT `agent_type`: it is also sent for a main session started with `--agent`.
 */
function isSubagentCall() {
  const id = readHookPayload().agent_id;
  return typeof id === 'string' && id.trim() !== '';
}

/** The tool's own arguments. Falls back to the payload for flat/legacy shapes. */
function readToolInput() {
  const p = readHookPayload();
  return (p.tool_input && typeof p.tool_input === 'object') ? p.tool_input : p;
}

/** The Bash command string. '' when there is none — callers must treat '' as "allow". */
function readToolCommand() {
  const p = readHookPayload();
  const cmd = (p.tool_input && p.tool_input.command) || p.command || '';
  return typeof cmd === 'string' ? cmd : '';
}

// ─────────────────────────────────────────────────────────────────────────────
// DELIBERATE-OVERRIDE DETECTION
//
// THE BUG THIS EXISTS TO DELETE
//   Every gate hook documented its escape as `CLAUDE_X_SKIP=1 git commit ...` and
//   then tested `process.env.CLAUDE_X_SKIP`. Those are different scopes. A
//   PreToolUse hook is a SEPARATE process spawned before the command runs; it
//   inherits Claude Code's environment, never the command's inline assignment
//   prefix. So the printed escape could not work, for any hook, ever — and the
//   only actor who could set the real env var was the human.
//
//   Consequence, observed across several sessions before it was diagnosed: an
//   agent-run /wrap hit a gate at the final commit and simply stopped, leaving the
//   human to finish the wrap by hand. The gate was correct; its escape hatch was
//   fiction. A gate with an unreachable override is a hard stop wearing the
//   costume of a soft one.
//
// WHY READING THE COMMAND IS THE RIGHT FIX (not a loosening)
//   The inline prefix is a BETTER audit record than the env var: it is written
//   into the command, so it appears verbatim in the transcript and in this
//   module's own log. An env var set in settings.json disables the gate invisibly
//   for every future session; a prefix disables it for exactly one call.
//
// FALSE-POSITIVE SAFETY (this direction fails OPEN, so it is handled explicitly)
//   A command that merely MENTIONS the token must not disable the gate — writing
//   this very file, or a doc containing the escape, would otherwise silently
//   switch the gate off. Two defenses:
//     1. Heredoc bodies and quoted spans are stripped before scanning, so the
//        token has to appear as real shell syntax, not as text.
//     2. The assignment must sit at a COMMAND-START position (string start, or
//        after ; && || | & ( or newline) and be followed by a command word —
//        i.e. exactly where a shell would treat it as an env prefix.
//   Anything short of that is "not an override", which is the safe side.

/**
 * Blank out heredoc bodies and quoted spans so only executable shell syntax remains.
 * Spans become spaces (length preserved) so positions stay meaningful.
 */
function stripQuotedRegions(cmd) {
  if (typeof cmd !== 'string' || !cmd) return '';
  let s = cmd;

  // 1. HEREDOCS — blanked from the FIRST `<<` to end of command, unconditionally.
  //
  // The obvious implementation matches each heredoc's terminator line and blanks
  // just that span. It was written that way, reviewed, and broke in FIVE distinct
  // ways, every one of them fail-OPEN (a doc heredoc silently disarming a live
  // commit gate), and every one confirmed against bash 3.2.57:
  //   1. `^[ \t]*EOF$` accepted an INDENTED terminator; bash requires column 0 for
  //      `<<`, so the parser closed the heredoc early and read body text as shell.
  //   2. For `<<-` bash strips only TABS; the same class accepted spaces.
  //   3. The delimiter capture `[A-Za-z_][A-Za-z0-9_]*` cannot express `<<'DOC.md'`
  //      or `<<'---'`, so the backreference failed and the body was never blanked.
  //   4. Two heredocs on one line: blanking the first swallowed the second's `<<`
  //      marker, leaving body 2 entirely scannable.
  //   5. JS `/m` treats a lone `\r` as a line terminator and bash does not, so
  //      `EOF\r` closed the heredoc for the parser only.
  //
  // Each was a separate way for my model of heredoc termination to disagree with
  // the shell's. The fix is to stop modelling it: anything from the first `<<`
  // onward is unscannable, so an override must appear BEFORE any heredoc. That is
  // a fail-CLOSED trade on a shape the operator controls — `VAR=1 git commit -F -
  // <<EOF` (the form a wrap actually uses) still works, because the prefix
  // precedes the heredoc. The only loss is `cat <<EOF … && VAR=1 git commit`,
  // which now under-detects; split it into two Bash calls.
  const hd = s.indexOf('<<');
  if (hd !== -1) s = s.slice(0, hd) + ' '.repeat(s.length - hd);

  // 2. Quoted spans. Single quotes are literal; double quotes honour backslash escapes.
  let out = '';
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote === null) {
      if (ch === "'" || ch === '"') { quote = ch; out += ' '; continue; }
      if (ch === '\\' && i + 1 < s.length) { out += '  '; i++; continue; }
      out += ch;
    } else {
      if (quote === '"' && ch === '\\' && i + 1 < s.length) { out += '  '; i++; continue; }
      out += ' ';
      if (ch === quote) quote = null;
    }
  }
  return out;
}

/**
 * True when the caller deliberately asked to bypass `varName`.
 * Honours process.env[varName]==='1' (unchanged) OR an inline `varName=1` env
 * prefix at a command-start position in `command`.
 */
function overrideRequested(varName, command, opts) {
  if (process.env[varName] === '1') return true;
  if (typeof command !== 'string' || !command) return false;
  if (!/^[A-Z][A-Z0-9_]*$/.test(varName)) return false; // never build a loose regex

  // `appliesTo` narrows the grant to prefixes attached to a specific program.
  // In a real shell an env prefix scopes to ONE simple command, but a naive
  // "appears anywhere at a command-start position" test does not: reviewed and
  // confirmed, `CLAUDE_REVIEW_GATE_SKIP=1 npm test && git commit -m x` ungated the
  // commit, which is wider than what the operator wrote. Gates that guard a single
  // program pass e.g. ['git'] so the prefix must sit on THAT invocation, while
  // `git add -A && VAR=1 git commit` — the shape a wrap really uses — still works.
  const words = Array.isArray(opts && opts.appliesTo) ? opts.appliesTo : null;
  const target = words && words.length
    ? `(?:${words.map((w) => String(w).replace(/[^A-Za-z0-9_-]/g, '')).filter(Boolean).join('|')})\\b`
    : String.raw`\S`;

  const scannable = stripQuotedRegions(command);
  const re = new RegExp(
    String.raw`(?:^|[;&|(]|\n)[ \t]*(?:[A-Za-z_][A-Za-z0-9_]*=\S*[ \t]+)*` +
      varName + String.raw`=(?:1|true)[ \t]+` + target,
  );
  return re.test(scannable);
}

/** One-line audit record when an override fires. Best-effort; never blocks. */
function logOverride(varName, command, source) {
  try {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      var: varName,
      source, // 'env' | 'command'
      cwd: process.cwd(),
      command: typeof command === 'string' ? command.slice(0, 400) : '',
    });
    fs.appendFileSync(`${process.env.HOME}/.claude/.hook-overrides.log`, line + '\n');
  } catch {
    /* auditing is best-effort — never turn a log failure into a hook failure */
  }
}

/**
 * The one call a gate hook should make. Returns true (and audits) when bypassed.
 * @param {object} [opts] {appliesTo: ['git']} to require the prefix on that program.
 */
function bypassed(varName, command, opts) {
  if (process.env[varName] === '1') { logOverride(varName, command, 'env'); return true; }
  if (overrideRequested(varName, command, opts)) { logOverride(varName, command, 'command'); return true; }
  return false;
}

// ---------------------------------------------------------------------------
// COMMIT DETECTION — shared, because it has now been fixed TWICE in two copies.
//
// This function lived verbatim in both hooks/check-d-entry-timing.js and
// skills/review/scripts/check-review-gate.js. Both copies needed the same
// `return`→`break` fix (compound commands read the first git subcommand and
// abandoned the scan), and both then carried the SAME second defect below. A
// predicate duplicated across two live gates is one bug with two addresses (P2),
// so it lives here now and both callers require it.
//
// Consumes git's GLOBAL options before reading the subcommand, because a regex
// allowing only `-C <dir>` is bypassed by `git -c k=v commit` / `git --no-pager
// commit`. Repeated -C values compose left-to-right, as git does.
//
// THE NEWLINE DEFECT (found S184; the reason this function moved here)
//   The segment class was `[^|;&]*` — it excludes shell metacharacters but NOT
//   newline, so on a multi-LINE Bash cell the greedy match starting at the first
//   `git` swallowed the line breaks and every later command, read `add` as the
//   subcommand, `break`ed, and resumed scanning PAST the commit. Measured on the
//   pre-fix source with a new `### D99` + `learnings/` staged:
//     `git commit -m x`                    -> exit 2   (blocked)
//     `git add -A && git commit -m x`      -> exit 2   (blocked)
//     `git add …\ngit status\ngit commit …` -> exit 0   (DARK)
//   The third form is what /wrap Step 8 emits, so both gates were dark on the
//   only invocation that mattered. check-d-entry-timing's canary passed 12/12
//   INCLUDING a mutation test and a case named "BLOCKS through compound commands
//   (the real workflow invocation)" — it tested `&&`, `;` and pipes and never a
//   line break. A fixture built so the failing case cannot arise is not a test.
//   Both canaries now carry the newline case; keep it there.
//
// WHY QUOTES ARE NOT STRIPPED FIRST
//   stripQuotedRegions() would be the obvious pre-pass, but it blanks quoted
//   spans too, so `git -C "my dir" commit` tokenizes as `-C commit` — the -C
//   consumes `commit` as its value and the gate goes dark. Fail-open, i.e. the
//   defect being fixed. So the raw command is scanned.
//
// RESIDUAL, accepted deliberately (fail-CLOSED side)
//   A heredoc BODY line beginning `git commit` now reads as a commit, so a
//   non-commit cell writing such a body can draw a spurious block. That block is
//   loud, names its reason, and has an override; the alternative (truncating at
//   the first `<<`, as stripQuotedRegions does) restores SILENT non-firing when a
//   heredoc precedes the real commit. Asymmetric failure — the safe side wins.
//   Also residual, unchanged: space-form `--git-dir <path>` and `~user/` paths.
//   This is a workflow gate, not an adversarial boundary.
//
// @returns {{matched: boolean, cPath?: string|null}} cPath = composed `-C` value.
function matchGitCommit(cmd) {
  const seg = scanGitSegments(cmd).find(s => s.sub === 'commit');
  if (!seg) return { matched: false };
  // cPathResolved: `-C "$W"` with the variable filled in from an earlier literal
  // assignment in the same cell (resolveAssignedVars). Offsets are into the
  // continuation-joined text, so resolve against that same string.
  return { matched: true, cPath: seg.cPath,
    cPathResolved: resolveAssignedVars(seg.cPath, joinContinuations(cmd), seg.offset) };
}

/**
 * Blank heredoc BODIES (length-preserving: every char but `\` and newline → space)
 * so a body that merely MENTIONS `git push` / `gh pr create` — a commit message, a
 * doc — is not read as a send. Used ONLY by the push/PR matchers.
 *
 * WHY this is safe where stripQuotedRegions refused (its five fail-open bugs): it
 * blanks a body only when it finds the terminator EXACTLY as bash does, and if
 * any heredoc is unterminated it returns the input UNCHANGED. Every doubt keeps
 * text scannable, so the failure direction is a spurious block, never a hidden send:
 *   - terminator = a line equal to the delimiter; `<<-` strips leading TABS only;
 *     an indented terminator for `<<` does not close (bash 1/2)
 *   - delimiter may be quoted with any chars ('DOC.md', '---') (bash 3)
 *   - several markers on one line queue their bodies in order (bash 4)
 *   - split on `\n` only, so `EOF\r` is not a terminator, as in bash (bash 5)
 *   - markers inside quotes or after a word-start `#` are ignored; `<<<` is a
 *     here-string. Measured live S81: the fix-round commit message quoted
 *     `gh pr create --head X` and the gate blocked that COMMIT.
 */
function heredocMarkers(line) {
  const out = [];
  let q = null;
  // S81 re-check: shapes where bash's reading of the line differs from ours — a
  // trailing `\` joins the next line (so it is not body), `((`/`$((` makes `<<` a
  // shift. Refuse to model them: null keeps the whole cell scannable.
  if (/\\$/.test(line) || line.indexOf('((') !== -1) return null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (q === '"' && ch === '\\') { i++; continue; }
      if (ch === q) q = null;
      continue;
    }
    if (ch === '\\') { i++; continue; }
    if (ch === "'" || ch === '"') { q = ch; continue; }
    if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]))) break;
    if (ch === '<' && line[i + 1] === '<') {
      if (line[i + 2] === '<') { i += 2; continue; }          // here-string
      let j = i + 2;
      const tabs = line[j] === '-';
      if (tabs) j++;
      while (line[j] === ' ' || line[j] === '\t') j++;
      const m = /^(?:'([^']*)'|"([^"]*)"|((?:\\.|[^\s;&|<>()'"])+))/.exec(line.slice(j));
      if (!m) return null;                                     // unparseable → caller fails closed
      // `'EOF'x` / `EOF"x"`: bash's delimiter continues past the quote — refuse.
      const after = line[j + m[0].length];
      if (after !== undefined && !/[\s;&|<>()]/.test(after)) return null;
      const delim = m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3].replace(/\\(.)/g, '$1');
      out.push({ delim, tabs });
      i = j + m[0].length - 1;
    }
  }
  if (q) return null;            // quote still open at end of line: a multi-line string
  return out;
}
function blankHeredocBodies(cmd) {
  if (typeof cmd !== 'string' || cmd.indexOf('<<') === -1) return cmd;
  const lines = cmd.split('\n');
  const out = [];
  let pending = [];
  for (const line of lines) {
    if (pending.length) {
      const h = pending[0];
      if ((h.tabs ? line.replace(/^\t+/, '') : line) === h.delim) { pending.shift(); out.push(line); continue; }
      out.push(line.replace(/[^\\]/g, ' '));
      continue;
    }
    out.push(line);
    const mk = heredocMarkers(line);
    if (mk === null) return cmd;
    pending = mk;
  }
  return pending.length ? cmd : out.join('\n');
}

/**
 * Every `git push` in a cell that sends commits, merged (S81: the review gate moved
 * here from commit; review round S81 made it refspec-aware).
 *
 * WHY sources, not "HEAD": a push names what it sends. `git push origin feat` from a
 * clean main, `feat:main`, `--all`, and `:` (matching) all sent unreviewed code past
 * a HEAD-only gate (reproduced by 3 of 5 reviewers). So each refspec's SOURCE side is
 * returned; the gate diffs each one.
 *
 * Returns {matched, cPath, cPathResolved, offset, sources[], all, tags}:
 *   sources  refspec sources ('HEAD' for a bare `git push`), deletes (`:dst`) dropped
 *   all      --all / --mirror / --branches / a `:` or `+:` matching refspec
 *   tags     --tags (not --follow-tags: its tags are reachable from the sources)
 * Not matched: --dry-run/-n, --delete/-d, or only `:dst` delete refspecs. Options that
 * take a VALUE (-o/--push-option, --repo, --receive-pack, --exec) consume it, so
 * `-o -n` is not read as dry-run. Same tokenizer + fail-closed text residual as
 * matchGitCommit (a heredoc BODY line `git push` reads as a push — see stripQuotedRegions
 * for why heredoc termination is not modelled).
 */
const PUSH_VALUE_OPTS = new Set(['-o', '--push-option', '--repo', '--receive-pack', '--exec']);
function parsePush(args) {
  const r = { send: true, sources: [], all: false, tags: false };
  const pos = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    // Shell redirections never reach here: scanGitSegments drops them (S84 rule, moved
    // there 2026-10-15 so add/commit/push share one copy).
    if (PUSH_VALUE_OPTS.has(a)) { i++; continue; }
    if (a === '--dry-run' || a === '-n' || a === '--delete' || a === '-d') { r.send = false; return r; }
    if (a === '--all' || a === '--mirror' || a === '--branches') { r.all = true; continue; }
    // --follow-tags adds only annotated tags reachable from what is pushed, which
    // the pushed sources already cover; enumerating every unmerged tag false-blocked.
    if (a === '--tags') { r.tags = true; continue; }
    if (a.startsWith('-')) continue;
    pos.push(a);
  }
  const refspecs = pos.slice(1); // pos[0] is the remote
  for (const spec of refspecs) {
    const s = spec.replace(/^\+/, '');
    if (s === ':') { r.all = true; continue; }
    const c = s.indexOf(':');
    const src = c === -1 ? s : s.slice(0, c);
    if (src) r.sources.push(src);           // empty src = `:dst` delete, sends nothing
  }
  if (refspecs.length === 0 && !r.all) r.sources.push('HEAD');
  if (!r.sources.length && !r.all && !r.tags) r.send = false; // deletes only
  return r;
}
function matchGitPush(cmd) {
  const segs = scanGitSegments(blankHeredocBodies(cmd)).filter(s => s.sub === 'push')
    .map(s => ({ s, p: parsePush(s.args) })).filter(x => x.p.send);
  if (!segs.length) return { matched: false };
  const first = segs[0].s;
  return {
    matched: true, cPath: first.cPath, offset: first.offset,
    cPathResolved: resolveAssignedVars(first.cPath, joinContinuations(cmd), first.offset),
    sources: [...new Set(segs.flatMap(x => x.p.sources))],
    all: segs.some(x => x.p.all), tags: segs.some(x => x.p.tags),
  };
}

/**
 * `gh pr create` / `gh pr new`, with gh options before or after `pr`
 * (`gh -R o/r pr create`, `gh pr -R o/r create`). Unanchored like scanGitSegments'
 * `\bgit`, so `env gh`, `command gh`, `if …; then gh …`, `{ gh …; }` and backticks
 * all match (the anchored first cut missed every one). Between `gh`/`pr`/`create`
 * only option tokens may appear, so `gh pr list --search create` is not a create.
 * `--head`/`-H` names the branch the PR sends (`owner:branch` → branch); else HEAD.
 * Repo resolution is the caller's (cwd / `cd` prefix) — gh has no `-C`.
 * Residual: `gh api …/pulls` (raw API) is not matched.
 */
function matchGhPrCreate(cmd) {
  if (typeof cmd !== 'string' || !cmd) return { matched: false };
  const joined = joinContinuations(blankHeredocBodies(cmd));
  const OPT = String.raw`(?:[ \t]+--?[A-Za-z][\w-]*(?:=\S+|[ \t]+(?!-)[^\s;&|)]+)?)*?`;
  const re = new RegExp(String.raw`\bgh` + OPT + String.raw`[ \t]+pr` + OPT + String.raw`[ \t]+(?:create|new)\b([^\n;&|]*)`);
  const mm = re.exec(joined);
  if (!mm) return { matched: false };
  const h = /(?:^|[ \t])(?:--head|-H)(?:=|[ \t]+)("[^"]*"|'[^']*'|\S+)/.exec(mm[1]);
  const head = h ? h[1].replace(/^(["'])(.*)\1$/, '$2').replace(/^.*:/, '') : 'HEAD';
  return { matched: true, cPath: null, cPathResolved: null, offset: mm.index,
    sources: [head || 'HEAD'], all: false, tags: false };
}


// Join backslash-newline continuations so `git \<newline> commit -m x` still
// reads as one segment once newline becomes a separator below.
function joinContinuations(cmd) {
  return cmd.replace(/\\[ \t]*\r?\n/g, ' ');
}

/**
 * Fill `$NAME` / `${NAME}` in a path from literal `NAME=value` assignments that
 * appear in `cmd` BEFORE offset `before`. A hook sees command TEXT, so
 * `W=/abs/wt; git -C "$W" commit` hands it the literal `$W` — measured 2026-09-15
 * fire audit: 7 review-gate fires checked the session's repo instead of the target
 * (4 via `-C $W`, 3 via `cd "$R"` with `R="$S/verify-hooks"`).
 *
 * Only a STANDALONE assignment statement counts — one the shell actually applies to
 * the current shell: at command start (string start, `;` `&&` `||` newline, optional
 * `export`), followed by a separator, and not inside quotes / a heredoc body / a
 * `#` comment / an unclosed `(` or `{`. So these stay unresolved (review 2026-09-15,
 * each measured to mis-target before this rule): the prefix form `W=/x git -C "$W"`
 * (bash expands $W before the prefix applies), `( W=/x ); …`, `f(){ W=/x; }`,
 * `echo " W=/x "`, `# W=/x`, and any `W+=`.
 *
 * Rules: the LAST such assignment before the use wins (`W=/a; W=/b` → /b); a value
 * may be several quoted/bare pieces (`W="$S"/sub`) and is resolved recursively against
 * assignments before ITS OWN position (`S=/a; R=$S/x`); `$(…)`, backticks, `${W:-x}`,
 * `$` inside single quotes and assignments from an earlier Bash call stay unexpanded.
 * Returns the input unchanged where nothing resolves.
 *
 * Still a guess — `[ -d /wt ] && W=/wt` resolves even when the test fails. Callers
 * must therefore make every resolution LOUD and never let a failed one exit quietly.
 */
function resolveAssignedVars(value, cmd, before, depth = 0) {
  if (typeof value !== 'string' || !/[$`]/.test(value) || typeof cmd !== 'string') return value;
  if (depth > 4) return value;
  const text = cmd.slice(0, before);
  const scan = stripQuotedRegions(text); // same length; quoted/heredoc spans blanked
  return value.replace(/\$\{(\w+)\}|\$(\w+)/g, (whole, braced, bare) => {
    const name = braced || bare;
    if (new RegExp('(?:^|\\W)' + name + '\\+=').test(scan)) return whole;
    const re = new RegExp('(?:^|;|&&|\\|\\||\\n)[ \\t]*(?:export[ \\t]+)?' + name +
      '=((?:"[^"]*"|\'[^\']*\'|[^\\s;&|()"\'])*)(?=[ \\t]*(?:;|&&|\\|\\||\\n)|$)', 'g');
    let last = null;
    let mm;
    while ((mm = re.exec(text)) !== null) {
      const at = mm.index + mm[0].lastIndexOf(name + '=');
      if (scan.slice(at, at + name.length + 1) !== name + '=') continue; // quoted / heredoc
      if (inCommentOrGroup(scan, at)) continue;
      last = mm;
    }
    if (!last) return whole;
    const pieces = last[1].match(/"[^"]*"|'[^']*'|[^"']+/g) || [];
    if (pieces.some(p => p[0] === "'" && /[$`]/.test(p))) return whole;
    const joined = pieces.map(p => (p[0] === '"' || p[0] === "'") ? p.slice(1, -1) : p).join('');
    if (joined === '' || joined.includes('$(') || joined.includes('`')) return whole;
    return resolveAssignedVars(joined, cmd, last.index, depth + 1);
  });
}

// True when position `at` of a quote-stripped command sits after a `#` comment start on
// its line, or inside an unclosed `(` / `{` (subshell, function body, brace group —
// the last is applied by bash, but treating it as unknown only costs the cwd fallback).
function inCommentOrGroup(scan, at) {
  const lineStart = scan.lastIndexOf('\n', at - 1) + 1;
  if (/(?:^|\s)#/.test(scan.slice(lineStart, at))) return true;
  let depth = 0;
  for (let i = 0; i < at; i++) {
    const c = scan[i];
    if (c === '(' || c === '{') depth++;
    else if ((c === ')' || c === '}') && depth > 0) depth--;
  }
  return depth > 0;
}

/**
 * Every `git <subcommand>` invocation in a Bash cell, in source order.
 *
 * Factored out of matchGitCommit (S186) so a second consumer — "what else does
 * this cell do to the index BEFORE the commit?" — does not become the THIRD copy
 * of this parser. The header above documents what two copies cost; the newline
 * defect needed the same fix in both and then both grew the same follow-on bug.
 * matchGitCommit is now a one-line projection of this scan, so the two cannot
 * drift: there is one tokenizer.
 *
 * Ordering matters. `git commit … && git add …` must NOT be read as staging-then-
 * committing, so each segment carries its byte offset in the (continuation-joined)
 * command string, and matchGitAdds() below drops any `add` lying after the commit's.
 *
 * @returns {Array<{sub: string, cPath: string|null, args: string[], offset: number}>}
 *          `args` = tokens AFTER the subcommand, global options consumed, quoted
 *          values already rejoined and unquoted.
 */
// Tokens arrive whitespace-split, so a quoted value containing spaces is in pieces.
// Re-join from `i` and unquote, returning [value, nextIndex].
//
// This existed TWICE for one day: inline here for `-C "my dir"`, and again in
// check-d-entry-timing.js for `git add "some path"`. The two had already drifted —
// on a lone `"` token the inline loop's `!v.endsWith(q)` treats the opening quote as
// its own terminator and the other's `!(v.length > 1 && v.endsWith(q))` does not,
// giving `['"','a"'] -> ['"','a"']` vs `[' a']`. One tokenizer, one quoting rule:
// the header above is a monument to what a second address for one bug costs, and
// "it's only three lines" has lost that argument twice in this file.
function rejoinQuotedArg(toks, i) {
  let v = toks[i];
  const q = v[0] === '"' || v[0] === "'" ? v[0] : null;
  while (q && !(v.length > 1 && v.endsWith(q)) && i + 1 < toks.length) v += ' ' + toks[++i];
  if (q && v.length > 1 && v.endsWith(q)) v = v.slice(1, -1);
  return [v, i];
}

function scanGitSegments(cmd) {
  if (typeof cmd !== 'string' || !cmd) return [];

  const joined = joinContinuations(cmd);

  // Newline is a command separator, exactly like `;` `&` `|`.
  const seg = /\bgit[ \t]+([^|;&\n\r]*)/g;
  const out = [];
  let s;
  while ((s = seg.exec(joined))) {
    const toks = s[1].trim().split(/\s+/);
    let cPath = null;
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (t === '-C' || t === '-c') {
        if (++i >= toks.length) continue;
        let v;
        [v, i] = rejoinQuotedArg(toks, i);
        if (t === '-C' && v) cPath = cPath ? path.join(cPath, v) : v;
        continue;
      }
      if (t.startsWith('-')) continue; // --flag / --flag=v / -m etc.
      // Record and stop scanning THIS segment — but keep scanning later ones.
      // (The pre-factoring code `break`ed here for the same reason.)
      //
      // `args` is rejoined+unquoted here so consumers never need their own copy of
      // the quoting rule — that seam is what let the two implementations drift.
      const args = [];
      for (let j = i + 1; j < toks.length; j++) {
        // Shell redirections are not arguments (S84 for push; hook-review 2026-10-15 for
        // add/commit). `git add -A 2>/dev/null` replayed `2>/dev/null` as a pathspec that
        // matched nothing and the D-entry gate went dark; `add x > f` replayed `f` as a
        // pathspec. `&` cuts the segment, so `2>&1` arrives as a bare `2>`; a bare operator
        // (`>`, `2>>`, `<`) owns its target token. Tested on the RAW token, before unquoting,
        // so a quoted `">x"` argument is kept.
        if (/^\d*(?:>|<)/.test(toks[j])) { if (/^\d*(?:>>?|>\||<)$/.test(toks[j])) j++; continue; }
        let v;
        [v, j] = rejoinQuotedArg(toks, j);
        args.push(v);
      }
      // `(cd x && git push)`: the subshell's `)` sticks to the last token; strip it
      // from the subcommand so the push is still recognised (S81 review round).
      out.push({ sub: t.replace(/\)+$/, ''), cPath, args, offset: s.index });
      break;
    }
  }
  return out;
}

/**
 * The pathspec-staging commands in a cell that run BEFORE its `git commit`.
 *
 * WHY: a PreToolUse hook runs before the shell does, so `git diff --cached` in a
 * gate reads the index as it stands BEFORE any `git add` in the same cell. On a
 * `git add <paths> && git commit` cell the gate therefore inspects an EMPTY index
 * and exits 0 — dark, on precisely the shape /wrap emits. Measured S186, same repo
 * content both ways: pre-staged + commit-only cell -> exit 2; combined cell -> exit 0.
 *
 * Callers use this to reconstruct what a commit will actually contain — see the
 * "WHAT THIS COMMIT WILL CONTAIN" block in check-d-entry-timing.js.
 *
 * Only same-target segments count: an `add` in a different repo (`-C elsewhere`)
 * does not affect the commit under inspection, so cPath is returned per-segment
 * for the caller to compare.
 *
 * ANCHORED ON THE LAST COMMIT, not the first — deliberately different from
 * matchGitCommit, because the two want opposite failure directions. scanGitSegments
 * does not strip quoted spans or heredoc bodies (documented above: stripping them
 * breaks `-C "my dir"`), so a `git commit` appearing as TEXT reads as a commit. For
 * matchGitCommit that residual is fail-CLOSED — a spurious, loud, overridable block.
 * Anchoring the add-boundary on that same phantom would push it to offset ~0 and
 * filter out every real add, turning the residual fail-OPEN and silently reverting
 * this gate to its pre-S186 blindness. Taking the LAST commit also handles the real
 * `git commit -m first && git add … && git commit -m wrap` shape, where the wrap
 * commit — the one carrying the artifacts — is the second one.
 */
function matchGitAdds(cmd) {
  const segs = scanGitSegments(cmd);
  let boundary = -1;
  for (const s of segs) if (s.sub === 'commit') boundary = s.offset;
  if (boundary < 0) return [];
  return segs.filter(s => (s.sub === 'add' || s.sub === 'stage') && s.offset < boundary);
}

/**
 * True when a `-C` value still contains shell syntax a hook cannot expand.
 *
 * A PreToolUse hook is handed the command TEXT, before the shell runs, so
 * `git -C "$W" commit` yields the literal `$W`. Both gates then ran
 * `git -C '$W' diff --cached`, git fatal'd, and the catch exited 0 — silently, on
 * a form this house uses constantly for worktrees (S183's Rails WIP commit was
 * `git -C "$W" commit -q -F -`). Found S184 by committing through the real harness
 * instead of spawning the hook directly: every prior probe passed a literal path,
 * so no fixture could surface it.
 *
 * Callers must treat a true result as "target unknown" and say so out loud rather
 * than exiting quietly — an unevaluated gate that prints nothing is the failure
 * mode all of this exists to remove.
 */
function unexpandedPath(p) {
  return typeof p === 'string' && /[$`]/.test(p);
}

/**
 * A WARN-ONLY hook's warning, on the channel that REACHES THE MODEL.
 *
 * Probed 2026-10-04 (claude -p, Claude Code 2.1.289, positive + negative controls, 2 runs)
 * and confirmed by code.claude.com/docs/en/hooks: for PreToolUse/PostToolUse, exit-0
 * stdout and stderr go to the debug log only — "Claude never sees it". Only stdout JSON
 * `hookSpecificOutput.additionalContext` is added to the model's context. Every warning
 * the alignment, memory-size and wrap-collision hooks ever printed was invisible to the
 * model (alignment cited 0/159 next turns). stderr is still written so the text stays in
 * the debug log / transcript. Call ONCE per hook run: stdout must hold one JSON object.
 * Canary: hooks/tests/warning-delivery-canary.sh.
 */
function warnModel(text, event = 'PreToolUse') {
  const t = String(text);
  try { process.stderr.write(t.endsWith('\n') ? t : t + '\n'); } catch { /* best-effort */ }
  // writeSync(1), not stdout.write: every caller exits right after, and an async pipe
  // write can be cut off on exit (the same fix check-review-gate.js --delta needed).
  try {
    require('fs').writeSync(1, JSON.stringify({
      hookSpecificOutput: { hookEventName: event, additionalContext: t.trim() },
    }) + '\n');
  } catch { /* stdout closed (EPIPE): the stderr copy above is the record; never crash a tool call */ }
}

/**
 * What a cell will stage BEFORE its commit — invisible to `git diff --cached` because a
 * PreToolUse hook runs before the shell does. S81 replay trial: 7 of 8 trial commits were
 * `git add … && git commit …` in one cell, and both check-anticheat and check-eval-first
 * read an empty index and went dark on every one.
 *
 * Returns {any, whole, trackedWhole, paths, trackedPaths}:
 *   whole         tracked + untracked, whole tree   (`add -A` / `add --all` with no path)
 *   trackedWhole  modified TRACKED files, whole tree (`commit -a`, `add -u` with no path)
 *   paths         pathspecs whose tracked + untracked files are staged (`add <p>`, `add -A <p>`)
 *   trackedPaths  pathspecs, tracked files only (`add -u <p>`, `commit … -- <p>`)
 * Pathspecs are cwd-relative, as the shell sees them; whole-tree queries must run from the
 * repo top (a subdirectory `git ls-files` sees only that subdirectory).
 * Only adds aimed at the SAME repo as the commit count (`-C` compared); `commit -a` always
 * adds the whole tracked tree, whatever other adds the cell has (review of 18d86ef: an
 * unrelated add used to narrow it). Residuals, all pre-existing: variables in pathspecs,
 * `(cd x && git add y)`, escaped spaces, `git rm`, and a commit message whose text contains
 * `git add` / `git commit` lines (fail-closed: a spurious block).
 */
function pendingStage(cmd) {
  const out = { any: false, whole: false, trackedWhole: false, paths: [], trackedPaths: [] };
  const segs = scanGitSegments(cmd);
  let commit = null;
  for (const s of segs) if (s.sub === 'commit') commit = s;
  if (!commit) return out;
  // commit's own flags: -a / --all / combined short flags containing a (-am, -av); a pathspec
  // after `--` commits those paths' working-tree state.
  const dd = commit.args.indexOf('--');
  const cflags = dd === -1 ? commit.args : commit.args.slice(0, dd);
  if (cflags.some(a => a === '--all' || /^-[A-Za-z]*a[A-Za-z]*$/.test(a))) out.trackedWhole = true;
  if (dd !== -1) out.trackedPaths.push(...commit.args.slice(dd + 1));
  for (const s of segs) {
    if ((s.sub !== 'add' && s.sub !== 'stage') || s.offset >= commit.offset) continue;
    if ((s.cPath || null) !== (commit.cPath || null)) continue;     // another repo
    let all = false, upd = false;
    const ps = [];
    let afterDD = false;
    for (const a of s.args) {
      if (!afterDD && a === '--') { afterDD = true; continue; }
      if (!afterDD && (a === '-A' || a === '--all')) all = true;
      else if (!afterDD && (a === '-u' || a === '--update')) upd = true;
      else if (afterDD || !a.startsWith('-')) ps.push(a);
    }
    if (ps.length) (upd && !all ? out.trackedPaths : out.paths).push(...ps);
    else if (all) out.whole = true;
    else if (upd) out.trackedWhole = true;
  }
  out.any = out.whole || out.trackedWhole || out.paths.length > 0 || out.trackedPaths.length > 0;
  return out;
}

module.exports = {
  pendingStage,
  warnModel,
  readHookPayload,
  isSubagentCall,
  readToolInput,
  readToolCommand,
  stripQuotedRegions,
  overrideRequested,
  bypassed,
  matchGitCommit,
  matchGitPush,
  matchGhPrCreate,
  joinContinuations,
  blankHeredocBodies,
  scanGitSegments,
  matchGitAdds,
  unexpandedPath,
  resolveAssignedVars,
};
