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

const input = JSON.parse(process.env.CLAUDE_TOOL_INPUT || '{}');
const command = input.command || '';

// Only gate git commit commands
if (!/\bgit\s+commit\b/.test(command)) {
  process.exit(0);
}

// Allow skipping for projects that genuinely don't need tests
if (process.env.CLAUDE_EVAL_FIRST_SKIP === '1') {
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

// Check staged files for source code
const staged = tryExec('git diff --cached --name-only');
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
// NOTE: globs are anchored to extension or directory to avoid false matches.
// The previous loose globs `*test_*` / `*_test.*` matched any path with the
// substring `test_` — e.g. Rails view templates like `_latest_enquiries.html.erb`
// (`latest_e` contains `test_e`). That silently passed eval-first in any project
// with such files. Tighter patterns below.
const testFileSearch = tryExec(
  'git ls-files ' +
    '"*.test.*" "*.spec.*" ' +
    '"**/test_*.py" "**/test_*.rb" "**/test_*.ts" "**/test_*.js" ' +
    '"**/*_test.py" "**/*_test.go" "**/*_test.rb" "**/*_test.ts" "**/*_test.js" ' +
    '"tests/*" "test/*" "__tests__/*" "spec/*"'
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
