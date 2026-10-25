#!/usr/bin/env node
// PreToolUse hook: prompts for an alignment pass when a session turns multi-file
// without one. Rule 0's confirm-approach gate is scoped "INVESTIGATE/PLAN only",
// which excludes IMPLEMENT — the exact path all the logged misalignment failures
// took ("jumped to implementation instead of the literal verb" 4x, "substituted
// approach without checking plan" 5x, "scope-balloon without rescope" 2x).
// A prompt-level rule did not catch them because attention-based gates fail
// silently when context is busy (P57); this fires at the moment of the edit.
//
// Behavior:
//   - Counts DISTINCT source files edited per session (docs/config never count)
//   - On the 2nd distinct source file, writes the alignment prompt to stderr
//   - WARN only (exit 0). Never blocks: the chosen enforcement is "ask 3-5
//     questions, then proceed", so blocking would overshoot the design.
//   - Fires ONCE per session. Later edits stay silent.
//   - Skip: CLAUDE_ALIGNMENT_SKIP=1 (env, or an inline VAR=1 prefix)
//   - Fails OPEN on any error: a broken recorder must not gum up every edit.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

let payload = {};
try {
  payload = require('./lib/hook-input.js').readHookPayload();
} catch (err) {
  process.stderr.write(`alignment gate DISABLED: ${err.message}\n`);
  process.exit(0);
}

if (process.env.CLAUDE_ALIGNMENT_SKIP === '1') process.exit(0);

const ti = (payload.tool_input && typeof payload.tool_input === 'object') ? payload.tool_input : {};
const filePath = ti.file_path || ti.notebook_path || '';
if (!filePath) process.exit(0);

// Source code only. Prose, config and data are how a session records its
// thinking; counting them would fire the gate on note-taking.
const SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|cs|swift|kt|php|sh|sql|erb|vue|svelte)$/;
if (!SOURCE.test(filePath)) process.exit(0);

// Scratch space is where experiments and throwaway rigs live; edits there are
// not the multi-file implementation this gate is looking for.
const SCRATCH = /(\/tmp\/|\/scratchpad\/|\/node_modules\/|\/\.git\/|\/dist\/|\/build\/)/;
if (SCRATCH.test(filePath)) process.exit(0);

const sessionId =
  payload.session_id || process.env.CLAUDE_CODE_SESSION_ID || `pid-${process.ppid}`;
const stateFile = path.join(
  os.tmpdir(),
  `.claude-align-${crypto.createHash('sha256').update(String(sessionId)).digest('hex').slice(0, 12)}.json`
);

const THRESHOLD = 2; // the 2nd distinct source file is the earliest reliable
                     // multi-file signal; firing on the 1st would fire on every
                     // one-line fix, which is how a gate earns being disabled.

let state = { files: [], warned: false };
try {
  if (fs.existsSync(stateFile)) {
    const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (parsed && Array.isArray(parsed.files)) state = { files: parsed.files, warned: !!parsed.warned };
  }
} catch {
  // Unreadable state: treat as a fresh session rather than failing the edit.
}

let resolved = filePath;
try { resolved = fs.realpathSync(path.resolve(filePath)); } catch { resolved = path.resolve(filePath); }

if (!state.files.includes(resolved)) state.files.push(resolved);

const shouldWarn = state.files.length >= THRESHOLD && !state.warned;
if (shouldWarn) state.warned = true;

let persisted = true;
try {
  fs.writeFileSync(stateFile, JSON.stringify(state), 'utf8');
} catch (err) {
  persisted = false;
  // M6 (found by /harden, 2026-08-21): silence here made the gate fail OPEN.
  // Without persistence the file list never accumulates, THRESHOLD is never
  // reached, and the gate never fires again for the rest of the session --
  // indistinguishable from "nothing to warn about". A dead recorder must
  // announce itself, the same way check-eval-first reports DISABLED.
  process.stderr.write(
    `alignment gate DISABLED (cannot persist state: ${err.message}) -- ` +
    `multi-file detection is OFF for this session\n`
  );
}

if (!shouldWarn) process.exit(0);

// warnModel, not stderr: exit-0 stderr never reaches the model (S81 probe).
const warn = (t) => { try { require('./lib/hook-input.js').warnModel(t); } catch { process.stderr.write(t); } };
warn([
  '════════════════════════════════════════════════════════════════',
  '⚠  ALIGN (Rule 0): this session just went multi-file with no',
  '   alignment pass on record.',
  '',
  '   State the Rule 0 classification and what "done" means in one',
  '   line. Then ask the user ONLY if one of these holds:',
  '     - the request could be advice, not a go-ahead to build',
  '     - the work is outward-facing or hard to undo',
  '     - a business/product/UX/money choice is unstated',
  '   Engineering approach choices are yours (decision rights):',
  '   state the choice and proceed. An advice-request is not an',
  '   action-authorization.',
  '',
  '   Fires once per session. Skip: CLAUDE_ALIGNMENT_SKIP=1',
  '════════════════════════════════════════════════════════════════',
  ''
].join('\n'));

process.exit(0);
