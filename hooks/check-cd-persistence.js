#!/usr/bin/env node
// PreToolUse hook: blocks `cd <relative>` in Bash commands because the Bash
// tool's cwd persists across calls (P34 — repeated incidents motivated this gate).
//
// Why: `cd scripts/X && cmd` leaves the next Bash call starting in scripts/X.
// Detection by P50 (right-context): block when `cd` targets a relative path,
// regardless of what follows in the chain — even `cd dir && cmd` leaks.
//
// Allowed (no leak / well-known intent):
//   - cd $HOME, cd ~, cd ~/...    (home, no surprise)
//   - cd -                          (revert to previous)
//   - cd /absolute/path             (absolute, no surprise)
//   - cd $TMPDIR, cd $T              (var whose every assignment is absolute — see below)
//   - (cd <rel> && cmd)             (subshell — cwd doesn't leak)
//
// Skip entirely: set CLAUDE_CD_PERSISTENCE_SKIP=1
// Warn-only:    set CLAUDE_CD_PERSISTENCE_WARN_ONLY=1

// Always-on guard: an unloadable reader must NOT block every Bash call, so this one
// fails open — loudly. (The opt-in safety guards, /careful and /freeze, fail closed.)
let command;
let hookLib;
try {
  hookLib = require('./lib/hook-input.js');
  command = hookLib.readToolCommand();
} catch (err) {
  process.stderr.write(`cd-persistence guard DISABLED: ${err.message}\n`);
  process.exit(0);
}

if (!command) {
  process.exit(0);
}

// Read the override AFTER the command, because it is honoured from an inline
// `VAR=1 <cmd>` prefix as well as from the environment. Env-only was unreachable
// for an agent: a PreToolUse hook is a separate process and never sees the
// command's own assignment prefix. (check-anticheat.js has always done this
// correctly, via its ANTICHEAT-OK: token read straight off the command.)
if (hookLib.bypassed('CLAUDE_CD_PERSISTENCE_SKIP', command)) {
  process.exit(0);
}

// A subagent's Bash cwd resets between calls, so a `cd` there cannot leak (verified live,
// fire audit 2026-09-15: 39 of 58 fires were subagents). Same discriminator as read-size.
if (hookLib.isSubagentCall()) {
  process.exit(0);
}

// Blank subshell groups `(...)` before scanning — anything inside a subshell can't leak cwd
// to the parent Bash tool process. Groups are FOUND on the quote-stripped text, so a quoted
// `(` … `)` pair (grep patterns like "foo(") can no longer swallow the real code between
// them (review 2026-09-15). They are BLANKED to spaces, not deleted, so every offset below
// indexes the same position in `command` and `stripped`.
// Known residual (fail-closed): stripQuotedRegions blanks everything after a heredoc `<<`,
// so a subshell after a heredoc is not blanked and its `cd` is judged like a top-level one.
let stripped = command;
{
  let scan = hookLib.stripQuotedRegions(command);
  const chars = command.split('');
  let m;
  while ((m = /\([^()]*\)/.exec(scan)) !== null) { // innermost group first; blanked, so progress
    const end = m.index + m[0].length;
    scan = scan.slice(0, m.index) + ' '.repeat(m[0].length) + scan.slice(end);
    for (let k = m.index; k < end; k++) chars[k] = ' ';
  }
  stripped = chars.join('');
}

// Find `cd <arg>` occurrences in the stripped command.
//
// Quote-aware by necessity (measured /hook-review 2026-08-21). The previous regex
// `/(^|[;&|\n]|&&)\s*cd\s+([^\s;&|\n]+)/g` had three defects, all producing BLOCKS on
// commands that leak nothing — 31 of 37 fires in a 14-day window:
//   1. It matched `cd` inside quoted data, so a grep whose PATTERN contained the two
//      letters `cd` blocked itself. This happened five times while writing this fix.
//   2. It captured the arg WITH its quotes, so `arg.startsWith('/')` saw `"` and
//      `cd "/abs/path"` was blocked while bare `cd /abs/path` passed. Same for the
//      `~` and `$HOME` allowances.
//   3. It could not see through `VAR=/abs/path; cd $VAR`, which lands on an ABSOLUTE
//      path — the exact form the allow-list below already permits as `cd /absolute`.
//      Of 28 such fires, every one that could be resolved pointed at an absolute path.
//
// The scanner below walks the string tracking quote state, so `cd` counts only as a
// command word at quote depth 0. Returns `[{arg, at, argAt}]`: arg already unquoted, at =
// offset of the `cd` in `src`, argAt = offset of the argument's first character.
// Known gap (pre-existing): a `cd` after a keyword or env prefix (`then cd rel`,
// `FOO=1 cd rel`) is not a command start here and is never checked.
function findCdArgs(src) {
  const isSep = (c) => c === ' ' || c === '\t' || c === ';' || c === '&' || c === '|' || c === '\n';
  const args = [];
  let i = 0;
  let atCmdStart = true; // can a command word begin at this position?

  const readWord = (capture) => {
    let out = '';
    while (i < src.length && !isSep(src[i])) {
      const c = src[i];
      if (c === "'" || c === '"') {
        i++;
        while (i < src.length && src[i] !== c) { out += src[i]; i++; }
        i++; // closing quote (or EOF on an unbalanced quote — treat as terminated)
      } else if (c === '\\') {
        i++; if (i < src.length) { out += src[i]; i++; }
      } else {
        out += c; i++;
      }
    }
    return capture ? out : '';
  };

  while (i < src.length) {
    const ch = src[i];
    if (ch === ';' || ch === '&' || ch === '|' || ch === '\n') { atCmdStart = true; i++; continue; }
    if (ch === ' ' || ch === '\t') { i++; continue; }
    // A `cd` that starts a command word, at quote depth 0, with an argument after it.
    if (atCmdStart && src.startsWith('cd', i) && (src[i + 2] === ' ' || src[i + 2] === '\t')) {
      const at = i;
      i += 2;
      while (i < src.length && (src[i] === ' ' || src[i] === '\t')) i++;
      args.push({ argAt: i, arg: readWord(true), at });
      atCmdStart = false;
      continue;
    }
    readWord(false); // consume this word (quoted runs included) without inspecting it
    atCmdStart = false;
  }
  return args;
}

// Resolve `$VAR` / `${VAR}` with the shared resolver (lib resolveAssignedVars — see its docs
// for what counts as a standalone assignment), resolved against `stripped`, NOT the raw
// command: an assignment inside a subshell never reaches the parent shell — `(W=/abs); cd $W`.
//
// The lib picks the LAST assignment and says a resolution is "still a guess". This hook
// allows SILENTLY, so it resolves only when the guess cannot be wrong: every variable in the
// chain (`$R`, and `$S` inside `R=$S/x`) has EXACTLY ONE textual assignment before the cd,
// and that assignment is not behind `&&` / `||`. Otherwise the arg stays `$VAR` → offender.
// (The `&&`/`||` rule is redundant with the count rule on every canary case — a mutant
// removing it survives; kept as a belt for vars inherited from the environment.)
// Measured bypasses this closes (review 2026-09-15): `W=sub; false && W=/abs; cd $W`,
// `[ -d x ] && D=/x`, `if …; then W=/abs; fi` over an earlier relative W, and
// `W=/abs; W=\`echo rel\`` (the backtick value never matches the lib's regex, so the lib
// fell back to /abs). Cost, fail-closed: an unconditional reassignment `W=a; W=/b; cd $W`
// now blocks too.
const MAX_RESOLVE_CHARS = 20000; // lib scan is quadratic; above this, leave vars unresolved

function assignmentsAreCertain(raw, at) {
  const scan = hookLib.stripQuotedRegions(stripped.slice(0, at));
  const pending = [...raw.matchAll(/\$\{?(\w+)/g)].map(v => v[1]);
  const seen = new Set();
  while (pending.length > 0) {
    const name = pending.pop();
    if (seen.has(name)) continue;
    seen.add(name);
    const hits = [...scan.matchAll(new RegExp('(^|[^\\w$])' + name + '\\+?=', 'g'))];
    if (hits.length === 0) continue; // never assigned here: the lib leaves it as `$NAME`
    if (hits.length > 1) return false;
    const eq = hits[0].index + hits[0][1].length;
    if (/(?:&&|\|\|)[ \t]*(?:export[ \t]+)?$/.test(scan.slice(0, eq))) return false;
    const value = stripped.slice(eq + name.length + 1).match(/^\S*/)[0];
    for (const v of value.matchAll(/\$\{?(\w+)/g)) pending.push(v[1]);
  }
  return true;
}

// Absolute-valued variables (2026-10-04). The certain-resolution path above refuses any
// `$(…)`, any conditional assignment and anything it cannot textually expand, so it blocked
// `cd $TMPDIR`, `T=$(mktemp -d); cd $T`, `… && S=/abs && cd $S` and loop variables.
// Transcript replay of main-session fires: 12 of the 17 `cd $VAR` commands the hook still
// blocked landed absolute (1 was genuinely relative, 4 were unknowable). This judges only
// where the target is ANCHORED, never its full value: `$S/sub` is as absolute as `$S`.
//
// A variable is absolute when it is a well-known absolute env var, or when it has at least
// one assignment (or `for NAME in` word list) before the cd and EVERY one of them is
// absolute. "Every", not "the last", is what makes conditionals safe: whichever assignment
// actually ran, the cd lands absolute. The one way to be wrong is a var none of whose
// assignments ran AND that arrived relative from the environment — shell variables do not
// survive between Bash calls, so only an exported profile var could, and the cost of that
// miss is cwd drift, not damage. Unknown stays blocked: a false block costs one turn.
//
// Deliberately NOT absolute: `$PWD` and `$(pwd)` — `cd $PWD/sub` is `cd sub` with extra
// steps, the exact leak this hook exists for. `$(mktemp …)` counts only when it creates
// under TMPDIR (no template, `-t`, or a template that is itself absolute); `mktemp -d x.XX`
// creates in the cwd. Assignments are found on `stripped` (subshells blanked, so `(W=/a)`
// never counts) but values are read from `command`, where `$(…)` is still intact.
//
// Review of 7aa0703 (2026-10-04), four false ALLOWS closed: (1) a relative `-p`/`--tmpdir`
// dir was never examined because `-t` short-circuited and `-` tokens were skipped; (2) a
// well-known name reassigned in the same command (`TMPDIR=build; cd $TMPDIR`) — ABSOLUTE_ENV
// now applies only when the name is never assigned, else the every-assignment rule; (3) a
// quoted tilde (`D="~/x"`) is literal in bash; (4) single quotes (`cd '$TMPDIR'`) expand
// nothing, and `~+` / `~-` are $PWD / $OLDPWD, not $HOME. `~` itself is judged as $HOME.
// Known gap: assignments made by `read`, `printf -v`, `eval`, `mapfile` or `source` are
// invisible here, so `read TMPDIR; cd $TMPDIR` or `D=/a; printf -v D sub; cd $D` still allow.
const ABSOLUTE_ENV = new Set(['HOME', 'TMPDIR', 'OLDPWD']);

function substitutionIsAbsolute(inner, before, depth) {
  const s = inner.trim();
  if (/^git(?:[ \t]+-C[ \t]+\S+)?[ \t]+rev-parse[ \t]+--show-toplevel$/.test(s)) return true;
  const mk = s.match(/^mktemp((?:[ \t]+\S+)*)$/);
  if (!mk) return false;
  const tokens = mk[1].trim().split(/[ \t]+/).filter(Boolean);
  const templates = [];
  let dir = null; // the `-p DIR` / `--tmpdir=DIR` value: when given, it alone decides
  let prefixFlag = false;
  for (let k = 0; k < tokens.length; k++) {
    const tk = tokens[k];
    let m;
    if ((m = tk.match(/^--tmpdir=(.*)$/)) !== null) dir = m[1];
    else if ((m = tk.match(/^-[dqu]*p(.*)$/)) !== null) dir = m[1] !== '' ? m[1] : (tokens[++k] || '');
    else if (tk === '-t') prefixFlag = true;                  // macOS: prefix under TMPDIR
    else if (!tk.startsWith('-')) templates.push(tk);
  }
  if (dir !== null) return dir !== '' && leadingIsAbsolute(dir, before, depth + 1);
  if (prefixFlag || templates.length === 0) return varIsAbsolute('TMPDIR', before, depth + 1);
  return templates.every(t => leadingIsAbsolute(t, before, depth + 1));
}

// `text` is the source starting at a word (a cd arg or an assignment value).
function leadingIsAbsolute(text, before, depth) {
  const q = text[0] === '"' || text[0] === "'" ? text[0] : '';
  const t = q ? text.slice(1) : text;
  if (t[0] === '/') return true;
  if (q === "'") return false;                                 // single quotes expand nothing
  if (t[0] === '~') {                                          // bare `~` / `~/` = $HOME, unquoted only
    return q === '' && /^~(?:\/|$|[\s;&|)`])/.test(t) && varIsAbsolute('HOME', before, depth + 1);
  }
  if (t.startsWith('$(')) {
    let d = 0;
    for (let k = 1; k < t.length; k++) {
      if (t[k] === '(') d++;
      else if (t[k] === ')' && --d === 0) return substitutionIsAbsolute(t.slice(2, k), before, depth);
    }
    return false;
  }
  if (t[0] === '`') {
    const end = t.indexOf('`', 1);
    return end > 0 && substitutionIsAbsolute(t.slice(1, end), before, depth);
  }
  const v = t.match(/^\$(?:\{(\w+)\}|(\w+))/);
  return v !== null && varIsAbsolute(v[1] || v[2], before, depth + 1);
}

// Offsets (into `command`) where each assignment value / for-list word of NAME begins before
// `before`; null when an untracked form (`NAME+=`) appears.
function assignedValues(name, before) {
  const scan = stripped.slice(0, before);
  const quoteless = hookLib.stripQuotedRegions(scan);
  const inComment = (pos) =>
    /(?:^|\s)#/.test(quoteless.slice(quoteless.lastIndexOf('\n', pos - 1) + 1, pos));
  const values = [];
  for (const m of scan.matchAll(new RegExp('(^|[^\\w$])' + name + '(\\+?)=', 'g'))) {
    const pos = m.index + m[1].length;
    if (inComment(pos)) continue;
    if (m[2] === '+') return null;                               // `W+=x`: not tracked
    values.push(pos + name.length + 1);
  }
  const forRe = new RegExp('(^|[\\s;&|])for[ \\t]+' + name + '[ \\t]+in[ \\t]+([^;\\n]*)', 'g');
  for (const m of scan.matchAll(forRe)) {
    if (inComment(m.index + m[1].length)) continue;
    const listAt = m.index + m[0].length - m[2].length;
    for (const w of m[2].matchAll(/\S+/g)) values.push(listAt + w.index);
  }
  return values;
}

function varIsAbsolute(name, before, depth) {
  if (depth > 4 || !/^[A-Za-z_]\w*$/.test(name)) return false; // `$1`, `$_`: unknown
  const values = assignedValues(name, before);
  if (values === null) return false;
  if (values.length === 0) return ABSOLUTE_ENV.has(name);       // well-known AND never reassigned
  return values.every(at => leadingIsAbsolute(command.slice(at), at, depth));
}

const offenders = [];
for (const { arg: raw, at, argAt } of findCdArgs(stripped)) {
  if (raw === '') continue;
  const arg = stripped.length <= MAX_RESOLVE_CHARS && assignmentsAreCertain(raw, at)
    ? hookLib.resolveAssignedVars(raw, stripped, at)
    : raw;

  // Allow well-known safe forms
  // `~` / `$HOME` are judged on the SOURCE (leadingIsAbsolute), never on `arg`: the resolver
  // drops quotes (`D="~/x"` came back as a bare `~/x`) and cannot see `HOME=build`.
  if (arg === '-') continue;                         // cd -
  if (arg.startsWith('/')) continue;                 // cd /absolute (quoted or not)
  // Direct `cd "~/foo"` stays allowed (false_positive_canary.py "quoted tilde"): bash takes
  // it literally, but a dir named `~` under the cwd essentially never exists, so the cd fails
  // and nothing leaks. Judged on `raw` (the cd's own word), so `D="~/x"; cd $D` is not covered.
  if ((raw === '~' || raw.startsWith('~/')) && stripped.length <= MAX_RESOLVE_CHARS && varIsAbsolute('HOME', argAt, 0)) continue;
  if (stripped.length <= MAX_RESOLVE_CHARS) {
    if (leadingIsAbsolute(command.slice(argAt), argAt, 0)) continue; // cd ~, $HOME, $TMPDIR, $T
  } else if (/^(?:~(?:\/|$|[\s;&|])|\$(?:HOME\b|\{HOME\}))/.test(command.slice(argAt)) &&
             (assignedValues('HOME', argAt) || [0]).length === 0) {
    continue;                                        // oversized command: plain cd ~ / $HOME only
  }

  // Relative path — leak risk
  offenders.push(raw);
}

if (offenders.length === 0) {
  process.exit(0);
}

const msg = [
  '════════════════════════════════════════════════════════════════',
  '⚠  CD-PERSISTENCE (P34): `cd <relative>` leaks cwd across Bash calls.',
  '',
  '   Offending args: ' + offenders.map(o => `\`cd ${o}\``).join(', '),
  '',
  '   The Bash tool\'s cwd persists across calls — both parallel',
  '   (siblings in one message) AND sequential (across messages).',
  '   (Repeated session-state-drift incidents triggered this hook\'s deployment.)',
  '',
  '   Use instead:',
  '     - git -C <path> <git-cmd>           (for git operations)',
  '     - <cmd> <path>                       (most tools take a path arg)',
  '     - (cd <path> && <cmd>)               (subshell — no leak)',
  '     - cd /absolute/path                  (absolute — no surprise)',
  '',
  '   Skip this hook: CLAUDE_CD_PERSISTENCE_SKIP=1',
  '   Warn-only:     CLAUDE_CD_PERSISTENCE_WARN_ONLY=1',
  '════════════════════════════════════════════════════════════════',
];

process.stderr.write(msg.join('\n') + '\n');

if (hookLib.bypassed('CLAUDE_CD_PERSISTENCE_WARN_ONLY', command)) {
  process.exit(0);
}

process.exit(2);
