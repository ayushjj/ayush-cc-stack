// PreToolUse hook: warn-only size visibility for MEMORY.md and CLAUDE.md writes.
// Never blocks — always exits 0. Prints a one-line stderr warning if the write
// would push MEMORY.md past 20 KB or CLAUDE.md past 50 KB.
//
// Part of the governance trio (templates at write-time, /catchup state-health,
// /prune-memory deliberate archival). This hook closes the commission-time gap —
// bloat is visible at the moment of writing, not one session later.
//
// Honors CLAUDE_MEMORY_GATE_QUIET=1 for bulk archival work (silent).
// Wrapped in try/catch so any internal error still exits 0 (buggy hook must
// miss warnings, never block writes — same guarantee as check-freeze.js).

const MEMORY_SOFT_BYTES = 20 * 1024;
const CLAUDE_SOFT_BYTES = 50 * 1024;

try {
  if (process.env.CLAUDE_MEMORY_GATE_QUIET === '1') {
    process.exit(0);
  }

  const fs = require('fs');
  const path = require('path');
  const os = require('os');

  const input = JSON.parse(process.env.CLAUDE_TOOL_INPUT || '{}');
  const filePath = input.file_path || '';
  if (!filePath) {
    process.exit(0);
  }

  const resolved = path.resolve(filePath);
  const baseName = path.basename(resolved);
  const claudeMdPath = path.resolve(path.join(os.homedir(), '.claude', 'CLAUDE.md'));

  const isMemoryMd = baseName === 'MEMORY.md';
  const isClaudeMd = resolved === claudeMdPath;

  if (!isMemoryMd && !isClaudeMd) {
    process.exit(0);
  }

  const currentSize = fs.existsSync(resolved) ? fs.statSync(resolved).size : 0;

  // Compute projected size after the write based on the tool.
  // Tool name comes from CLAUDE_TOOL_NAME (harness convention).
  const toolName = process.env.CLAUDE_TOOL_NAME || '';
  let projectedSize = currentSize;

  if (toolName === 'Write') {
    projectedSize = Buffer.byteLength(input.content || '', 'utf-8');
  } else if (toolName === 'Edit') {
    const oldLen = Buffer.byteLength(input.old_string || '', 'utf-8');
    const newLen = Buffer.byteLength(input.new_string || '', 'utf-8');
    const replaceAll = input.replace_all === true;
    if (replaceAll && fs.existsSync(resolved) && oldLen > 0) {
      const content = fs.readFileSync(resolved, 'utf-8');
      const occurrences = content.split(input.old_string).length - 1;
      projectedSize = currentSize + (newLen - oldLen) * occurrences;
    } else {
      projectedSize = currentSize + (newLen - oldLen);
    }
  } else if (toolName === 'MultiEdit') {
    let delta = 0;
    for (const edit of (input.edits || [])) {
      delta += Buffer.byteLength(edit.new_string || '', 'utf-8') - Buffer.byteLength(edit.old_string || '', 'utf-8');
    }
    projectedSize = currentSize + delta;
  }

  const softBytes = isMemoryMd ? MEMORY_SOFT_BYTES : CLAUDE_SOFT_BYTES;
  const softKB = softBytes / 1024;

  if (projectedSize > softBytes) {
    const projKB = (projectedSize / 1024).toFixed(1);
    process.stderr.write(
      `[memory-size-gate] ${baseName} would become ${projKB}KB after this write ` +
      `(soft threshold ${softKB}KB). Consider /prune-memory when convenient. ` +
      `No block — write proceeding.\n`
    );
  }

  process.exit(0);
} catch (err) {
  try {
    process.stderr.write(`[memory-size-gate] internal error: ${err.message} — allowing write\n`);
  } catch (_) { /* stderr failed — still exit 0 */ }
  process.exit(0);
}
