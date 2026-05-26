// PreToolUse hook: blocks Edit/Write/MultiEdit outside a frozen directory.
// Flag file: $TEMP/.claude-freeze-dir (contains the allowed directory path)
// Reads tool input from CLAUDE_TOOL_INPUT env var.
// Blocks via exit code 2 + stderr message.

const fs = require('fs');
const os = require('os');
const path = require('path');

const flagPath = path.join(os.tmpdir(), '.claude-freeze-dir');

if (!fs.existsSync(flagPath)) {
  process.exit(0);
}

const allowedDir = fs.readFileSync(flagPath, 'utf-8').trim();
if (!allowedDir) {
  process.exit(0);
}

const input = JSON.parse(process.env.CLAUDE_TOOL_INPUT || '{}');
const filePath = input.file_path || '';

if (!filePath) {
  process.exit(0);
}

// Normalize both paths to absolute, forward-slash, lowercase (Windows-safe)
function normalizePath(p) {
  return path.resolve(p).replace(/\\/g, '/').toLowerCase();
}

const normalizedFile = normalizePath(filePath);
const normalizedAllowed = normalizePath(allowedDir);

// Allow if the file is inside the frozen (allowed) directory
if (normalizedFile.startsWith(normalizedAllowed + '/') || normalizedFile === normalizedAllowed) {
  process.exit(0);
}

process.stderr.write(
  `FREEZE MODE BLOCKED: Edit/Write to "${filePath}" is outside the allowed directory "${allowedDir}". ` +
  `While /freeze is active, only files within the frozen directory can be modified. ` +
  `To edit this file, first run: deactivate freeze mode`
);
process.exit(2);
