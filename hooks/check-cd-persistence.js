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

if (process.env.CLAUDE_CD_PERSISTENCE_SKIP === '1') {
  process.exit(0);
}

const input = JSON.parse(process.env.CLAUDE_TOOL_INPUT || '{}');
const command = input.command || '';

if (!command) {
  process.exit(0);
}

// Strip subshell groups `(...)` from the command before scanning — anything
// inside a subshell can't leak cwd to the parent Bash tool process.
// Naive but sufficient: remove `( ... )` substrings non-greedily.
let stripped = command;
let prev;
do {
  prev = stripped;
  stripped = stripped.replace(/\([^()]*\)/g, '');
} while (stripped !== prev);

// Find `cd <arg>` occurrences in the stripped command.
// Matches `cd` as its own token (preceded by start/&&/;/|/&/whitespace-then-newline)
// followed by an argument up to the next shell separator.
const cdPattern = /(^|[;&|\n]|\&\&|\|\|)\s*cd\s+([^\s;&|\n]+)/g;

const offenders = [];
let match;
while ((match = cdPattern.exec(stripped)) !== null) {
  const arg = match[2];

  // Allow well-known safe forms
  if (arg === '-') continue;                     // cd -
  if (arg === '~' || arg.startsWith('~/')) continue; // cd ~ / cd ~/foo
  if (arg.startsWith('$HOME')) continue;         // cd $HOME / cd $HOME/foo
  if (arg.startsWith('/')) continue;             // cd /absolute

  // Relative path — leak risk
  offenders.push(arg);
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

if (process.env.CLAUDE_CD_PERSISTENCE_WARN_ONLY === '1') {
  process.exit(0);
}

process.exit(2);
