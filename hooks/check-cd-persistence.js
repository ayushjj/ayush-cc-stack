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
// command word at quote depth 0. Returns `[{arg, at}]`: arg already unquoted, at = offset
// of the `cd` in `src`.
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
      args.push({ arg: readWord(true), at });
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

const offenders = [];
for (const { arg: raw, at } of findCdArgs(stripped)) {
  if (raw === '') continue;
  const arg = stripped.length <= MAX_RESOLVE_CHARS && assignmentsAreCertain(raw, at)
    ? hookLib.resolveAssignedVars(raw, stripped, at)
    : raw;

  // Allow well-known safe forms
  if (arg === '-') continue;                         // cd -
  if (arg === '~' || arg.startsWith('~/')) continue; // cd ~ / cd ~/foo
  if (arg.startsWith('$HOME')) continue;             // cd $HOME / cd $HOME/foo
  if (arg.startsWith('/')) continue;                 // cd /absolute (quoted or not)

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
