#!/usr/bin/env node
// PreToolUse hook: warns when committing source code in a project that has
// no test files. Hamel's thesis: "unsuccessful products almost always share
// a common root cause: a failure to create robust evaluation systems."
//
// Behavior:
//   - Only runs on git commit commands
//   - Only warns if staged files include source code (.ts, .js, .py, .rb, .go, etc.)
//   - Does NOT warn for: markdown-only, config-only, or CLAUDE.md-only commits
//   - Does NOT warn if any test file already exists in the project
//   - Default: WARN only (stderr message, exit 0)
//   - Block mode: set CLAUDE_EVAL_FIRST_BLOCK=1 to exit 2 instead of warn
//   - Skip entirely: set CLAUDE_EVAL_FIRST_SKIP=1 for projects that don't need tests

const { execSync } = require('node:child_process');

// Always-on guard: fail open (loudly) if the shared reader cannot load, rather than
// blocking every commit. The opt-in safety guards (/careful, /freeze) fail closed.
let command;
let hookLib;
try {
  hookLib = require('./lib/hook-input.js');
  command = hookLib.readToolCommand();
} catch (err) {
  process.stderr.write(`eval-first guard DISABLED: ${err.message}\n`);
  process.exit(0);
}

// Only gate git commit commands
if (!/\bgit\s+commit\b/.test(command)) {
  process.exit(0);
}

// Allow skipping for projects that genuinely don't need tests. Honoured from an
// inline `VAR=1 git commit ...` prefix as well as from the environment — env-only
// was unreachable for an agent, since a PreToolUse hook is a separate process and
// never sees the command's own assignment prefix.
if (hookLib.bypassed('CLAUDE_EVAL_FIRST_SKIP', command, { appliesTo: ['git'] })) {
  process.exit(0);
}

function tryExec(cmd) {
  try {
    return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

// Check if we're in a git repo
const isGit = tryExec('git rev-parse --is-inside-work-tree');
if (isGit !== 'true') {
  process.exit(0);
}

// Every git query runs from the repo TOP: `git ls-files` pathspecs are cwd-relative, so a
// session working in a subdirectory found 0 tests in a repo holding 126 (S81 replay trial).
const top = tryExec('git rev-parse --show-toplevel');
const q = (p) => "'" + String(p).replace(/'/g, "'\\''") + "'";
const atTop = top ? `git -C ${q(top)} ` : 'git ';

// Check staged files for source code — plus what an `add` / `commit -a` in this SAME cell
// will stage, which the index cannot show yet (hook-input.js pendingStage).
let staged = tryExec(atTop + 'diff --cached --name-only');
const pend = hookLib.pendingStage(command);
const spec = (ps) => ' -- ' + ps.map(q).join(' ');
// Whole-tree queries from the repo TOP; pathspec queries from the cwd the shell will use.
if (pend.whole) staged += '\n' + tryExec(atTop + 'ls-files -m -o --exclude-standard');
if (pend.trackedWhole) staged += '\n' + tryExec(atTop + 'ls-files -m');
if (pend.paths.length) staged += '\n' + tryExec('git ls-files -m -o --exclude-standard' + spec(pend.paths));
if (pend.trackedPaths.length) staged += '\n' + tryExec('git ls-files -m' + spec(pend.trackedPaths));
staged = staged.trim();
if (!staged) {
  process.exit(0);
}

const sourceExtensions = /\.(ts|tsx|js|jsx|py|rb|go|rs|java|cs|swift|kt)$/;
const stagedFiles = staged.split('\n').filter(Boolean);
const hasSourceCode = stagedFiles.some(f => sourceExtensions.test(f));

if (!hasSourceCode) {
  // Only committing docs/config/markdown — no warning needed
  process.exit(0);
}

// Check if any test files exist anywhere in the project.
//
// Anchored to test-file NAMES, never to directory names (fixed /hook-review 2026-08-21).
// The previous list carried `"tests/*" "test/*" "spec/*"` and their `*/` forms, which match
// ANY tracked file under a test-shaped directory. A repo holding `tests/README.md` and zero
// real tests therefore committed source code silently — the guard failed OPEN, which is
// indistinguishable from "this project has evals". Reproduced, then closed, by canary.
//
// The earlier defect this replaces is kept as a warning: the original loose globs `*test_*`
// / `*_test.*` matched any path CONTAINING the substring, so Rails view templates like
// `_latest_enquiries.html.erb` (`latest_e` contains `test_e`) passed the gate.
//
// Measured before changing: across 16 local repos this list produces an IDENTICAL
// warn/silent verdict to the old one — it drops only redundant matches ([redacted]
// 662 -> 512 matched files, still silent on 477 real specs). `__tests__/*` is kept as a
// directory glob because that directory name is itself the Jest test convention.
const testFileSearch = tryExec(
  atTop + 'ls-files ' +
    '"*.test.*" "*.spec.*" ' +
    '"**/test_*.py" "**/test_*.rb" "**/test_*.ts" "**/test_*.js" ' +
    '"**/*_test.py" "**/*_test.go" "**/*_test.rb" "**/*_test.ts" "**/*_test.js" ' +
    '"**/*_spec.rb" "**/*_spec.py" "**/*_spec.ts" "**/*_spec.js" ' +
    '"**/*-canary.sh" "**/*_test.sh" "**/*-test.sh" ' +
    '"__tests__/*" "*/__tests__/*"'
);

if (testFileSearch) {
  // Tests exist — project has eval infrastructure
  process.exit(0);
}

const msg = [
  '════════════════════════════════════════════════════════════════',
  '⚠  EVAL-FIRST (Hamel): Committing source code with NO test',
  '   files in this project.',
  '',
  '   "Unsuccessful products almost always share a common root',
  '   cause: a failure to create robust evaluation systems."',
  '   — Hamel Husain',
  '',
  '   Consider writing 3-5 assertions before the first feature.',
  '   Rule 7: evaluate before scaling.',
  '',
  '   Skip this warning: CLAUDE_EVAL_FIRST_SKIP=1',
  '════════════════════════════════════════════════════════════════',
];

process.stderr.write(msg.join('\n') + '\n');

if (process.env.CLAUDE_EVAL_FIRST_BLOCK === '1') {
  process.exit(2);
}

process.exit(0);
