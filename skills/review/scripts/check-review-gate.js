// PreToolUse hook: blocks git commit unless /review has been run this session.
// Flag file: $TMPDIR/.claude-review-done (created by /review skill on completion)
// Reads tool input from CLAUDE_TOOL_INPUT env var.
// Blocks via exit code 2 + stderr message.

const fs = require('fs');
const os = require('os');
const path = require('path');

const flagPath = path.join(os.tmpdir(), '.claude-review-done');
const input = JSON.parse(process.env.CLAUDE_TOOL_INPUT || '{}');
const command = input.command || '';

// Only gate git commit commands
if (!/\bgit\s+commit\b/.test(command)) {
  process.exit(0);
}

// Check if /review was run this session
if (fs.existsSync(flagPath)) {
  process.exit(0);
}

process.stderr.write(
  'REVIEW GATE: git commit blocked — /review has not been run this session. ' +
  'Run /review first to ensure code quality. ' +
  'For content-only changes, /review scope guard will auto-pass and create the flag.'
);
process.exit(2);
