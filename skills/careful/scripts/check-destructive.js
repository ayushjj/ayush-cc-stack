// PreToolUse hook: blocks destructive Bash commands when /careful mode is active.
// Flag file: $TEMP/.claude-careful-mode (created by /careful skill, removed on deactivation)
// Tool command via hooks/lib/hook-input.js (the single fd-0 reader).
// Blocks via exit code 2 + stderr message.

const fs = require('fs');
const os = require('os');
const path = require('path');

const flagPath = path.join(os.tmpdir(), '.claude-careful-mode');

if (!fs.existsSync(flagPath)) {
  process.exit(0);
}

// Reached only when /careful is ACTIVE. If the shared reader cannot load, an
// uncaught throw would exit 1 — and exit 1 is not a block, so this guard would
// fail OPEN exactly when the user asked to be protected. Fail CLOSED instead:
// the escape is to deactivate careful mode.
let command;
try {
  command = require('../../../hooks/lib/hook-input.js').readToolCommand();
} catch (err) {
  process.stderr.write(
    'CAREFUL MODE BLOCKED: cannot load hooks/lib/hook-input.js, so this command ' +
    'cannot be inspected. Blocking rather than guessing.\n' +
    `  ${err.message}\n  To proceed, deactivate careful mode.\n`
  );
  process.exit(2);
}

const DESTRUCTIVE_PATTERNS = [
  { pattern: /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+|.*-rf\b)/, label: 'rm -rf / rm -f' },
  { pattern: /\bDROP\s+(TABLE|DATABASE)\b/i, label: 'DROP TABLE/DATABASE' },
  { pattern: /\bgit\s+push\s+.*--force\b/, label: 'git push --force' },
  { pattern: /\bgit\s+push\s+-f\b/, label: 'git push -f' },
  { pattern: /\bgit\s+reset\s+--hard\b/, label: 'git reset --hard' },
  { pattern: /\bgit\s+clean\s+-f/, label: 'git clean -f' },
  { pattern: /\bgit\s+checkout\s+\.\s*$/, label: 'git checkout .' },
  { pattern: /\bkubectl\s+delete\b/, label: 'kubectl delete' },
  { pattern: /\bTRUNCATE\s+TABLE\b/i, label: 'TRUNCATE TABLE' },
  { pattern: /\brmdir\s+\/s\b/i, label: 'rmdir /s (Windows)' },
  { pattern: /\bdel\s+\/[fq]\b/i, label: 'del /f (Windows)' },
];

for (const { pattern, label } of DESTRUCTIVE_PATTERNS) {
  if (pattern.test(command)) {
    process.stderr.write(
      `CAREFUL MODE BLOCKED: "${label}" detected in command. ` +
      `Destructive commands are blocked while /careful is active. ` +
      `To proceed, first run: deactivate careful mode`
    );
    process.exit(2);
  }
}

process.exit(0);
