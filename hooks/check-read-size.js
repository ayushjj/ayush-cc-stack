#!/usr/bin/env node
// PreToolUse hook (matcher `Read|Bash`): blocks a WHOLE-FILE read of a file over
// 350 lines, and tells the model to delegate / range-read / grep instead.
//
// Why: measured in learnings/2026-08-25-S66b — ~66,000 chars of Bash/Read output
// flow into MAIN context per session, at a Bash:Agent call ratio of 31:1. The
// expensive resource is not the read, it is the main-context window the read
// floods. A subagent can read the same file and hand back the conclusion for a
// fraction of the tokens. (Prior art: Spotify's "Portal shunt", which intercepts
// reads over ~350 lines and reroutes them. A Claude Code hook cannot reroute to
// another model, so this one blocks and names the three cheaper moves.)
//
// CONSERVATIVE BY CONSTRUCTION. /hook-review 2026-08-21 measured 31 of 37
// check-cd-persistence fires as false positives, all from one loose regex. A false
// block on a read costs a whole turn and trains the model to reach for the valve;
// a missed block costs some tokens. So: whitelist, never blacklist. Anything the
// matcher is not certain about PASSES.
//
// Blocked:
//   Read  { file_path: <text file >350 lines> }  with NO `limit`
//   Bash  `cat FILE` / `cat -n FILE` / `cat -A FILE`   (single existing file, bare)
// Passes (non-exhaustive, all deliberate):
//   Read with `limit` · missing/binary/huge file · directory · unreadable
//   `cat f | head` · `sed -n '1,50p' f` · `head` · `grep` · `wc` · `cat a b`
//   `cat f > out` · any chain/pipe/redirect/heredoc · `grep "cat big.txt" x`
//   prompt/template .txt (see PROMPT_BASENAME), exact count, remainder up to 3x the limit
//
// Skip entirely: CLAUDE_READ_SIZE_SKIP=1        (env, or inline `VAR=1 cmd` prefix)
// Warn-only:     CLAUDE_READ_SIZE_WARN_ONLY=1
// Threshold:     CLAUDE_READ_SIZE_LIMIT=<lines> (default 350)
//
// Telemetry: one JSON line per fire → $HOME/.claude/telemetry/read-size-gate.jsonl
// That file IS the week's measurement. Its write is best-effort and can never fail
// the hook.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_LINE_LIMIT = 350;
// Filenames are untrusted input; the override line below is a COMMAND the model is told to
// run verbatim. Single-quote it so `;`, backticks, `$` and newlines in a name are inert
// (security review 2026-09-08: `notes;touch PWNED;#.md` executed as written).
function shellQuote(p) { return `'${String(p).replace(/'/g, `'\\''`)}'`; }
const MAX_FILE_BYTES = 20 * 1024 * 1024; // over this, don't even stat-and-count — pass
const EXACT_COUNT_BYTES = 2 * 1024 * 1024; // under this, count to EOF so telemetry is exact
const CHUNK_BYTES = 64 * 1024;

// Prompt files are this gate's largest false-positive cluster: 210 of 525 blocks (40.0%),
// concentrated in FOUR files, measured 2026-09-16 over the whole telemetry log. Tuning a
// prompt needs the whole text in main context, so all three prescribed moves are wrong for
// it: a range read gives you half an instruction, a grep gives you a line out of context,
// and a subagent cannot hand back "the conclusion" of a prompt you are sitting there editing.
//
// FOUR conditions, and the count matters — every one has a positive control in canary §16:
//   1. PROMPT_BASENAME — matched against the basename, EXTENSION INCLUDED (so `x.prompt`
//      satisfies it via the extension alone; that is intended).
//   2. PROMPT_EXT — a bare /prompt/ would exempt a 3000-line promptBuilder.ts, the exact
//      flood this hook exists to stop. The ext conjunct is what keeps code out.
//   3. counted.exact — a capped count means the file is over 2 MB and its true size is
//      UNKNOWN; unknown size must not buy a pass. Without it a 12,000-line file passes AND
//      logs a fabricated exact count (adversarial review 2026-09-16, reproduced).
//   4. under PROMPT_CEILING_MULTIPLE × limit, so the exemption stays FALSIFIABLE (P72): a
//      1200-line prompt file still blocks. Observed cluster is 472–572 lines, so the ceiling
//      has headroom without being an off switch wearing a gate's costume. The ceiling tracks
//      `limit`, so raising CLAUDE_READ_SIZE_LIMIT raises it 3× too (pinned by §16 case 16n).
//
// EXTENSIONS ARE DELIBERATELY NARROW. The measured cluster is 210/210 `.txt` — zero `.md`.
// `.md` was in the first draft and was REMOVED on review: it is the extension of learnings/,
// specs/, research/ and MEMORY, where the three prescribed moves are exactly RIGHT, and
// /prompt/ matches a bare substring — `learnings/…-the-prompt-was-a-pointer.md` would have
// been pre-exempted. Widen only when telemetry shows `.md` blocks that are real prompt-tuning.
const PROMPT_BASENAME = /(prompt|template)/i;
const PROMPT_EXT = /\.(txt|prompt)$/i;
const PROMPT_CEILING_MULTIPLE = 3;

// Always-on guard: an unloadable reader must NOT block every Read/Bash call, so this
// one fails open — loudly. (Same posture as check-cd-persistence.js.)
let payload;
let hookLib;
try {
  hookLib = require('./lib/hook-input.js');
  payload = hookLib.readHookPayload();
} catch (err) {
  process.stderr.write(`read-size gate DISABLED: ${err.message}\n`);
  process.exit(0);
}

const toolName = typeof payload.tool_name === 'string' ? payload.tool_name : '';
const toolInput = (payload.tool_input && typeof payload.tool_input === 'object') ? payload.tool_input : {};

function lineLimit() {
  const raw = Number(process.env.CLAUDE_READ_SIZE_LIMIT);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_LINE_LIMIT;
}

/**
 * Resolve a candidate path to a readable regular file we are willing to count,
 * or null (= "pass") for every uncertain case: unexpanded $VAR, glob, `~`,
 * missing, directory, device, or larger than MAX_FILE_BYTES.
 */
function resolveTarget(p) {
  if (typeof p !== 'string' || !p) return null;
  if (hookLib.unexpandedPath(p)) return null;      // $VAR / backtick — we can't know where it lands
  if (/[*?[\]]/.test(p) || p.startsWith('~')) return null;
  let abs;
  try {
    abs = path.resolve(process.cwd(), p);
  } catch {
    return null;
  }
  try {
    const st = fs.statSync(abs);
    if (!st.isFile()) return null;
    if (st.size > MAX_FILE_BYTES) return null;      // never hang on a 50 MB dump
    return { abs, size: st.size };
  } catch {
    return null;                                    // missing / unreadable → pass
  }
}

/**
 * Line count, synchronous and bounded. Returns null for a binary file (NUL in the
 * first chunk) or an unreadable one. `exact` is false when counting stopped early —
 * the message must then say "> limit", never print a truncated count as if exact.
 */
function countLines(target, limit) {
  let fd;
  try {
    fd = fs.openSync(target.abs, 'r');
  } catch {
    return null;
  }
  const buf = Buffer.alloc(CHUNK_BYTES);
  let lines = 0;
  let exact = true;
  let first = true;
  const countToEof = target.size <= EXACT_COUNT_BYTES;
  try {
    for (;;) {
      const n = fs.readSync(fd, buf, 0, CHUNK_BYTES, null);
      if (n <= 0) break;
      if (first) {
        first = false;
        if (buf.subarray(0, n).indexOf(0) !== -1) return null; // NUL in first chunk = binary → pass
      }
      // Buffer.indexOf is SIMD-backed: 10x faster than a byte loop on one-long-line files (perf review 2026-09-08).
      for (let i = buf.indexOf(0x0a, 0); i !== -1 && i < n; i = buf.indexOf(0x0a, i + 1)) lines++;
      if (lines > limit && !countToEof) { exact = false; break; }
    }
  } catch {
    return null;
  } finally {
    try { fs.closeSync(fd); } catch { /* ignore */ }
  }
  return { lines, exact };
}

// ── Bash: match ONLY a bare whole-file dump ────────────────────────────────────
// Whitelist on the ENTIRE command. Any shell metacharacter at all → pass, so
// pipes, redirects, chains, heredocs, substitutions and quoted data (`grep "cat
// big.txt" x` never begins with `cat`) are out before the regex even runs. Two
// path tokens (`cat a b`) fail `\S+\s*$`. This is deliberately dumber than
// check-cd-persistence's tokenizer — that tokenizer is where the false positives
// came from, and nothing here needs it.
const BARE_CAT = /^\s*cat(?:\s+-[nA]+)?\s+(\S+)\s*$/;

function bashTargetPath(command) {
  if (/[|;&<>`\n(){}$]/.test(command)) return null;
  const m = BARE_CAT.exec(command);
  if (!m) return null;
  return m[1].replace(/^(['"])(.*)\1$/, '$2');
}

// ── Dispatch ──────────────────────────────────────────────────────────────────
// Shared reader: also honours the flat `{command}` payload shape every sibling gate accepts.
const command = toolName === 'Bash' ? (hookLib.readToolCommand() || '') : '';

// Read the override AFTER the input, because it is honoured from an inline
// `VAR=1 <cmd>` prefix as well as from the environment (a PreToolUse hook is a
// separate process and never sees the command's own assignment prefix). For the
// Read tool there is no command string, so the valve there is env-only.
if (hookLib.bypassed('CLAUDE_READ_SIZE_SKIP', command)) process.exit(0);

let candidate = null;
if (toolName === 'Read') {
  // `limit` (text) or `pages` (PDF) present = the model already chose a range. Pass.
  // `offset` ALONE is still a whole-file-from-here read, so it does not exempt.
  if (toolInput.limit == null && toolInput.pages == null) candidate = toolInput.file_path;
} else if (toolName === 'Bash') {
  candidate = command ? bashTargetPath(command) : null;
}

if (!candidate) process.exit(0);

const limit = lineLimit();
const target = resolveTarget(candidate);
if (!target) process.exit(0);

// `offset` without `limit` reads from offset to EOF: block only if the REMAINDER is
// over the limit (review 2026-09-08: offset:395 on a 400-line file was a false block).
// Read's offset is 1-based; -1 converts it to a count of lines skipped. Count to
// limit+offset, never bare limit: a truncated count minus a big offset was a bypass.
const offsetRaw = toolName === 'Read' ? Number(toolInput.offset) : NaN;
const offset = Number.isFinite(offsetRaw) ? Math.max(0, Math.floor(offsetRaw) - 1) : 0;
const counted = countLines(target, limit + offset);
if (!counted || counted.lines - offset <= limit) process.exit(0);

// Subagents exist to absorb big reads and hand back a conclusion — the flood this
// gate prevents is MAIN-context flood. Architecture review 2026-09-08: 2 of 8 early
// fires were inside subagents, prescribing a delegation that cannot happen there.
// Discriminator lives in lib (`isSubagentCall`, agent_id — captured 2026-09-15). The earlier
// `/subagents/` transcript_path test never matched a real payload: 495 of 499 audited fires
// blocked the subagents it meant to exempt.
// Placed HERE — after the would-block decision — and LOGGED (review 2026-09-15, 3 reviewers):
// a block row from a subagent that lost agent_id is byte-identical to a main-session row, so
// the only visible sign of a harness rename is the `exempt-subagent` rate falling to zero.
// Placed earlier, it would log every subagent Bash call instead of would-have-blocked reads.
if (hookLib.isSubagentCall()) {
  telemetry({
    path: target.abs,
    lines: counted.exact ? counted.lines : null,
    exact: counted.exact,
    action: 'exempt-subagent',
    agent_type: typeof payload.agent_type === 'string' ? payload.agent_type : null,
  });
  process.exit(0);
}

// Prompt-file exemption (four conditions, rationale at PROMPT_BASENAME above). Same placement
// rationale as the subagent exemption: AFTER the would-block decision, so an exempt-prompt row
// always means "this WOULD have blocked" and the exemption rate stays a measurement rather
// than a log of every prompt read.
//
// realpath, NOT resolve: `path.resolve` is lexical, so a symlink named `x_prompt.txt` pointing
// at a 900-line .rb took its NAME from the link and its SIZE from the target — the name test
// and the content test looking at two different files. That is rename laundering, a measured
// evasion class here (S69, 2026-08-27, 5 of them closed). Falls back to the lexical path if
// realpath throws, which only ever narrows the exemption.
let promptBase;
try {
  promptBase = path.basename(fs.realpathSync(target.abs));
} catch {
  promptBase = path.basename(target.abs);
}
// Ceiling uses the post-offset REMAINDER, matching the would-block rule at the `counted.lines
// - offset` line above. Testing whole-file lines here contradicted it: a 2000-line prompt read
// with offset:1500 (500 lines into context) blocked, while a 1000-line whole-file prompt — twice
// the context cost — passed. Conservative in the wrong direction is still the bug being fixed.
if (
  PROMPT_BASENAME.test(promptBase) &&
  PROMPT_EXT.test(promptBase) &&
  counted.exact &&
  counted.lines - offset <= limit * PROMPT_CEILING_MULTIPLE
) {
  telemetry({
    path: target.abs,
    // Derived, never the literal `true`: if the `counted.exact` conjunct above is ever relaxed,
    // a hardcoded true writes a capped count into the corpus as an exact one — the same
    // plausible-wrong-number the block row below was fixed to stop emitting.
    lines: counted.exact ? counted.lines : null,
    exact: counted.exact,
    action: 'exempt-prompt',
  });
  process.exit(0);
}

const warnOnly = hookLib.bypassed('CLAUDE_READ_SIZE_WARN_ONLY', command);
const size = counted.exact ? `${counted.lines} lines` : `more than ${limit} lines`;

// The escape must be REACHABLE from where the model stands, or the gate is a hard
// stop wearing the costume of a soft one (hook-input.js:88-100). A PreToolUse hook is
// a separate process: it sees an inline `VAR=1 cmd` prefix on a Bash command, but the
// Read tool has no command string, so `bypassed()` there is env-only — unsettable per
// call by an agent. So the Read message points at the Bash form, which IS honoured.
const escape = toolName === 'Bash'
  ? 'Override once: CLAUDE_READ_SIZE_SKIP=1 <the same command>.'
  : `Override once via Bash: CLAUDE_READ_SIZE_SKIP=1 cat ${shellQuote(target.abs)}`;

process.stderr.write(
  `READ-SIZE GATE: ${JSON.stringify(target.abs)} is ${size} (> ${limit}). Whole-file reads this size ` +
  `flood main context (S66b: 66K chars/session). Do one of: (a) delegate the read to an ` +
  `Explore subagent and take back the conclusion; (b) read a range with offset/limit; ` +
  `(c) grep for the lines you need. ${escape}\n`,
);

// Telemetry — after the message.
telemetry({
  path: target.abs,
  // A capped count is not a measurement: null, never a plausible wrong number (review 2026-09-08).
  lines: counted.exact ? counted.lines : null,
  exact: counted.exact,
  action: warnOnly ? 'warn' : 'block',
  // P3 Step 0 (2026-09-15): how the agent_id exemption was chosen. Drift signals on a BLOCK
  // row: a new/renamed key in payload_keys, or agent_type present without agent_id.
  // Top-level KEY NAMES only, no tool_input values.
  payload_keys: Object.keys(payload).sort(),
  agent_type: typeof payload.agent_type === 'string' ? payload.agent_type : null,
});

process.exit(warnOnly ? 0 : 2);

// Best-effort, never fatal: a log failure must never become a hook failure. Hoisted, so the
// subagent exemption above can log before exiting.
function telemetry(fields) {
  try {
    if (!process.env.HOME) return;
    const dir = path.join(process.env.HOME, '.claude', 'telemetry');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'read-size-gate.jsonl'), JSON.stringify({
      ts: new Date().toISOString(),
      tool: toolName,
      session: payload.session_id || process.env.CLAUDE_CODE_SESSION_ID || null,
      ...fields,
    }) + '\n');
  } catch { /* measurement is best-effort */ }
}
