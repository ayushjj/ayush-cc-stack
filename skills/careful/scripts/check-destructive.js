// PreToolUse hook: blocks destructive Bash commands when /careful mode is active.
// Flag file: $TEMP/.claude-careful-mode (created by /careful skill, removed on deactivation)
// Reads tool input from CLAUDE_TOOL_INPUT env var.
// Blocks via exit code 2 + stderr message.

const fs = require('fs');
const os = require('os');
const path = require('path');

const flagPath = path.join(os.tmpdir(), '.claude-careful-mode');

if (!fs.existsSync(flagPath)) {
  process.exit(0);
}

const input = JSON.parse(process.env.CLAUDE_TOOL_INPUT || '{}');
const command = input.command || '';

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
