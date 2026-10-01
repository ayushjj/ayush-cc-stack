// PreToolUse hook: blocks Edit/Write/MultiEdit outside a frozen directory.
// Flag file: $TEMP/.claude-freeze-dir (contains the allowed directory path)
// Tool input via hooks/lib/hook-input.js (the single fd-0 reader).
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

// Reached only when /freeze is ACTIVE. An unloadable reader must not silently
// disarm the boundary the user turned on (exit 1 is not a block). Fail CLOSED;
// the escape is to deactivate freeze mode.
let ti;
try {
  ti = require('../../../hooks/lib/hook-input.js').readToolInput();
} catch (err) {
  process.stderr.write(
    'FREEZE MODE BLOCKED: cannot load hooks/lib/hook-input.js, so this write ' +
    'cannot be inspected. Blocking rather than guessing.\n' +
    `  ${err.message}\n  To proceed, deactivate freeze mode.\n`
  );
  process.exit(2);
}
const filePath = ti.file_path || ti.notebook_path || '';

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
