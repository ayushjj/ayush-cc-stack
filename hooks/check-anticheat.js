#!/usr/bin/env node
// PreToolUse hook: when test-first workflow is active (plan.md or specs/*/implementation.md
// with Test Queue exists), checks git diff for deleted/weakened test assertions.
// Beck's #1 AI agent failure mode: agent deleting or disabling tests to make code pass.
//
// Behavior:
//   - No plan.md and no specs/*/implementation.md with Test Queue → silent no-op
//   - Test files with a removed assertion that has no added assertion of identical comparison
//     shape (allow-list, see below) → WARN on stderr (does NOT block).
//     An edited assert is not a deletion (fire audit 2026-09-15: 12/16 fires were edits).
//   - Block mode: set CLAUDE_ANTICHEAT_BLOCK=1 to exit 2 instead of warn
//   - Override (block mode only): a commit message carrying `ANTICHEAT-OK: <reason>`
//     downgrades the block to a warn+proceed. The guard's purpose is to stop SILENT
//     test deletion; an override forces a non-empty justification into the permanent,
//     greppable git record (`git log --grep=ANTICHEAT-OK`), so a reviewed rewrite can
//     proceed without globally disabling the flag. The warning still prints (audit trail).
//
// Only runs on: git commit commands

const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// Always-on guard: fail open (loudly) if the shared reader cannot load, rather than
// blocking every commit. The opt-in safety guards (/careful, /freeze) fail closed.
let command;
try {
  command = require('./lib/hook-input.js').readToolCommand();
} catch (err) {
  process.stderr.write(`anticheat guard DISABLED: ${err.message}\n`);
  process.exit(0);
}

// Only gate git commit commands
if (!/\bgit\s+commit\b/.test(command)) {
  process.exit(0);
}

// Check if test-first workflow is active
function isTestFirstActive() {
  // Check for plan.md in cwd
  if (fs.existsSync(path.join(process.cwd(), 'plan.md'))) {
    return true;
  }

  // Check for specs/*/implementation.md containing "Test Queue"
  const specsDir = path.join(process.cwd(), 'specs');
  if (fs.existsSync(specsDir)) {
    try {
      const features = fs.readdirSync(specsDir, { withFileTypes: true });
      for (const feat of features) {
        if (feat.isDirectory()) {
          const implPath = path.join(specsDir, feat.name, 'implementation.md');
          if (fs.existsSync(implPath)) {
            const content = fs.readFileSync(implPath, 'utf8');
            if (content.includes('Test Queue')) {
              return true;
            }
          }
        }
      }
    } catch {
      // If we can't read specs dir, don't block
    }
  }

  return false;
}

if (!isTestFirstActive()) {
  process.exit(0);
}

// Check staged diff for removed test assertions
function tryExec(cmd) {
  try {
    // maxBuffer: Node's 1 MB default threw on a larger staged diff, tryExec returned '', and the
    // gate exited 0 — one staged 1.5 MB fixture disabled it (security review, pre-existing).
    return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }).trim();
  } catch {
    return '';
  }
}

// --no-color/--no-ext-diff/--no-textconv/--text: repo config (color.ui=always, diff.external) or a
// staged `.gitattributes` `-diff` could otherwise blank the assertion lines (review round 2).
const DIFF = 'git -c core.quotepath=off diff --unified=0 --no-color --no-ext-diff --no-textconv --text';
let diff = tryExec(DIFF.replace(' diff ', ' diff --cached '));
// An `add` / `commit -a` earlier in this SAME cell stages files the index cannot show yet
// (S81 replay trial: 7/8 commits were `git add … && git commit …`, all dark). Read those as
// working-tree-vs-index diffs, limited to the add's pathspecs. New untracked files cannot
// weaken an existing assertion, so they are not needed here.
try {
  const pend = require('./lib/hook-input.js').pendingStage(command);
  if (pend.any) {
    const q = (p) => "'" + String(p).replace(/'/g, "'\\''") + "'";
    // `git diff` (no pathspec) covers the whole repo from any subdirectory.
    const ps = [...pend.paths, ...pend.trackedPaths];
    const spec = pend.whole || pend.trackedWhole ? '' : ' -- ' + ps.map(q).join(' ');
    diff = (diff + '\n' + tryExec(DIFF + spec)).trim();
  }
} catch { /* lib unavailable → index-only, the pre-existing behaviour */ }
if (!diff) {
  process.exit(0);
}

// Test files, and the assertion lines inside them
const testFilePatterns = /\.(test|spec)\.(ts|js|tsx|jsx|py|rb)$|test_.*\.py$|.*_test\.(go|rb)$|_spec\.rb$/;
const assertionPatterns = /\b(assert|expect|should|it\(|test\(|describe\(|\.toBe|\.toEqual|\.toMatch|\.toThrow|assertEqual|assertRaises|assert_equal)\b/;

// ── Removed-vs-added pairing (P3 hook tunes, 2026-09-15) ───────────────────────────────────────
// The old rule flagged every removed assertion line and ignored the `+` side, so an EDITED assert
// read as a deletion: the fire audit found 12 of 16 fires were edits and 0 true positives.
// A first rewrite paired lines by text similarity and then looked for a LIST of known weakenings;
// review (correctness + adversarial) constructed 12+ weakenings it let through — each one simply a
// weakening the list did not name. So this is an ALLOW-LIST, not a deny-list:
//   A removed assertion is excused only by an added assertion in the same file whose comparison
//   SHAPE is identical — same operators, keywords (not/is/in/True/None/to/not_to…), callee and
//   method names, brackets — with only variables, literals, messages and comments differing,
//   AND that shares at least one VARIABLE with it (callee/matcher names don't count — `toBe`,
//   `Equal`, Go's `t` are shared by every assert). The single change excused beyond that is
//   `<=`/`>=` → `==` with the rest of the assertion character-identical (a true strengthening;
//   strict `>`/`<` → `==` on the same value is a contradiction, e.g. `len(errs) > 0` → `== 0`).
// Everything else — deleted, inverted, loosened, reduced to truthiness, made tautological,
// restructured — is flagged. `ANTICHEAT-OK: <reason>` records an intentional one.
// KNOWN RESIDUE (accepted, stated): a same-shape change of a VALUE or ARGUMENT passes — `== 56` →
// `== 0`, `isinstance(x, int)` → `isinstance(x, object)`, `raise_error(Foo)` → `raise_error(StandardError)`
// — it has the same shape as the honest `== "1.1.0"` → `== "1.2.0"`; the diff cannot tell them apart.
// That includes loosening a tolerance (`abs=1e-6` → `abs=1e9`, `places=7` → `places=0`) and wrapping an
// untouched assert in a dead branch at the SAME indent inside the same hunk (indent only means
// something in Python).
// Honest edits still blocked (need ANTICHEAT-OK): re-indenting an assert into a wrapper block, an
// expected set gaining an element, multi-line assert openers. Replay 2026-09-15 (round-2 review):
// ~15% of [redacted] and ~23% of [redacted] test-touching commits would be flagged;
// per EDITED assert line, ~31% / ~39% of honest reshapes (`.strip()`, `&.`, `expect {`→`expect do`).
// Also unseen, as before: continuation lines of a multi-line assert, skip markers, deleted files'
// non-assert lines.

// File path from the `+++ b/` header (new side), falling back to `--- a/` for a deletion — the
// `diff --git a/X b/Y` line mis-splits paths containing " b/".
// A rename is a test file if EITHER side is (`git mv test_a.py checks_a.py` switches the file off
// for pytest AND used to hide its removals — review round 2). Pairing is scoped to one `@@` hunk:
// with unified=0 an honest in-place edit is always in the same hunk; a move to another test or a
// dead helper is not (review round 2).
const byFile = new Map();   // file -> { removed: [], added: [] }
let currentFile = '';
let oldFile = '';
let inHeader = false;
let hunk = 0;
for (const line of diff.split('\n')) {
  if (line.startsWith('diff --git ')) { currentFile = ''; oldFile = ''; inHeader = true; continue; }
  if (line.startsWith('@@')) { hunk++; inHeader = false; continue; }
  if (inHeader) {
    // Git ends a ---/+++ path containing a space with a TAB; keep it out of the path, or the
    // `$`-anchored testFilePatterns never matches and the file is silently skipped (review).
    const oldSide = line.match(/^--- (?:a\/)?(.*?)\t?$/);
    const newSide = line.match(/^\+\+\+ (?:b\/)?(.*?)\t?$/);
    if (oldSide && oldSide[1] !== '/dev/null') { currentFile = oldSide[1]; oldFile = oldSide[1]; }
    if (newSide && newSide[1] !== '/dev/null') currentFile = newSide[1];
    continue;
  }
  if (!testFilePatterns.test(currentFile) && !testFilePatterns.test(oldFile)) continue;
  const removed = line.startsWith('-');
  const added = line.startsWith('+');
  if (!(removed || added) || !assertionPatterns.test(line)) continue;
  if (!byFile.has(currentFile)) byFile.set(currentFile, { removed: [], added: [] });
  // Keep the indentation: an identical assert re-added DEEPER (under `if False:`, inside a dead
  // helper) is not a replacement (security review B3/B22).
  const body = line.slice(1);
  const indent = body.match(/^[ \t]*/)[0].replace(/\t/g, '        ').length;   // tabs = 8 columns
  byFile.get(currentFile)[removed ? 'removed' : 'added'].push({ text: body.trim(), indent, hunk });
}

// The assertion itself: string literals blanked, the trailing comment cut (comment syntax BY
// LANGUAGE — `//` is floor division in Python, review finding), and a Python `assert expr, message`
// reduced to `assert expr`.
const HASH_COMMENT = /\.(py|rb)$/;
function assertionCore(raw, file) {
  // Unambiguous alternation: a backslash can ONLY be eaten by `\\[\s\S]`. The earlier
  // `(?:\\.|(?!\1).)*` let either branch take it — 44 backslashes in an unclosed triple-quoted
  // string took 17.6 s through the hook (security review); this form is linear.
  // A string that INTERPOLATES code (`${x}`, "#{x}") is not a literal: `toBe(`${name}`)` compares
  // name to itself. It shapes as the keyword INTERP, never as S (review round 2). An EMPTY string is
  // not a literal either: `"" in msg` / `toContain("")` can never fail.
  let s = raw.trim().replace(/(["'`])(?:\\[\s\S]|(?!\1)[^\\])*\1/g, m => (/\$\{|#\{/.test(m) ? ' INTERP ' : m.length === 2 ? ' EMPTY ' : '""'));
  s = HASH_COMMENT.test(file) ? s.replace(/#.*$/, '') : s.replace(/(^|\s)\/\/.*$/, '');
  if (/^assert\b/.test(s)) {
    let depth = 0;
    for (let i = 0; i < s.length; i++) {
      if ('([{'.includes(s[i])) depth++;
      else if (')]}'.includes(s[i])) depth--;
      else if (s[i] === ',' && depth === 0) { s = s.slice(0, i); break; }
    }
  }
  return s.trim();
}

// Words that carry the MEANING of an assertion — kept verbatim in the shape.
const KEYWORDS = new Set(['assert', 'not', 'is', 'in', 'and', 'or', 'if', 'else', 'lambda',
  'True', 'False', 'None', 'true', 'false', 'null', 'undefined', 'nil',
  'expect', 'to', 'not_to', 'to_not', 'should', 'should_not', 'INTERP', 'EMPTY']);
// Receivers every assert in a file shares (Go's `t`, Python's `self`, JS `this`) — never evidence
// that two assertions test the same thing.
const RECEIVERS = new Set(['t', 'self', 'this', 'cls', 'require']);
const RSPEC_VERBS = new Set(['to', 'not_to', 'to_not', 'should', 'should_not']);
const TOKEN = /""|\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?|[A-Za-z_]\w*|\S/g;

// Shape: variables → I, numbers → N, strings → S; keywords, callee/method names (a word followed
// by `(`), RSpec matchers (the word after to/not_to), operators and brackets kept. Returns the
// shape string and the set of identifiers (for the shared-identifier requirement).
// Variables are NUMBERED by first appearance (I0, I1, …), so `got == expected` (I0==I1) and the
// tautology `expected == expected` (I0==I0) differ, while the harmless `want == got` still matches.
function shapeOf(core) {
  const toks = core.match(TOKEN) || [];
  const ids = new Set();
  const slot = new Map();
  const out = toks.map((t, i) => {
    if (t === '""') return 'S';
    if (/^\d/.test(t)) return 'N';
    if (!/^[A-Za-z_]/.test(t)) return t;
    if (KEYWORDS.has(t)) return t;
    if (toks[i + 1] === '(') return t;                                 // callee / method
    if (RSPEC_VERBS.has(toks[i - 1])) return t;                        // RSpec matcher
    if (!RECEIVERS.has(t)) ids.add(t);                                 // variables only
    if (!slot.has(t)) slot.set(t, slot.size);
    return `I${slot.get(t)}`;
  });
  return { shape: out.join(''), ids };
}

const squash = s => s.replace(/\s+/g, '');

const warnings = [];
for (const [file, { removed, added }] of byFile) {
  const addedCores = added.map(a => assertionCore(a.text, file));
  const addedShapes = addedCores.map(shapeOf);
  const free = added.map(() => true);
  for (const r of removed) {
    const core = assertionCore(r.text, file);
    const { shape, ids } = shapeOf(core);
    const strong = squash(core).replace(/<=|>=/g, '==');   // only if `<=`/`>=` present
    let pick = -1;
    for (let i = 0; i < added.length; i++) {
      if (!free[i] || added[i].hunk !== r.hunk || added[i].indent > r.indent) continue;
      const cand = addedShapes[i];
      const shapeOk = cand.shape === shape || (strong !== squash(core) && squash(addedCores[i]) === strong);
      if (shapeOk && [...ids].some(id => cand.ids.has(id))) { pick = i; break; }
    }
    if (pick === -1) {
      warnings.push(`  ${file}: -${r.text}   ← no replacement with the same comparison shape`);
      continue;
    }
    free[pick] = false;
  }
}

if (warnings.length === 0) {
  process.exit(0);
}

const msg = [
  '════════════════════════════════════════════════════════════════',
  '⚠  ANTI-CHEAT (Beck): Test assertions were REMOVED or WEAKENED',
  '   in this commit while test-first workflow is active.',
  '',
  '   Beck\'s #1 AI agent failure mode: "Any indication that the',
  '   genie was cheating, for example by disabling or deleting tests."',
  '',
  '   Removed or weakened assertions:',
  ...warnings,
  '',
  process.env.CLAUDE_ANTICHEAT_BLOCK === '1'
    ? '   BLOCKED. If the change is intentional, re-run the same commit with "ANTICHEAT-OK: <one-line reason>" in the message. If not, unstage and investigate. Do not retry unchanged.'
    : '   If intentional, proceed. If not, unstage and investigate.',
  '════════════════════════════════════════════════════════════════',
];

process.stderr.write(msg.join('\n') + '\n');

if (process.env.CLAUDE_ANTICHEAT_BLOCK === '1') {
  // Escape valve: an EXPLICIT, justified, permanently-logged override lets an intentional
  // test rewrite/removal proceed WITHOUT globally disabling block mode. The token must carry
  // a non-empty reason, so the justification lands in git history (audit:
  // `git log --grep=ANTICHEAT-OK`). This preserves the guard's real purpose (catching SILENT
  // deletions) while removing false-positive friction on reviewed rewrites.
  const override = command.match(/ANTICHEAT-OK:\s*(\S.*)/);
  if (override) {
    process.stderr.write(
      `\n   ⤷ Override honored (ANTICHEAT-OK): ${override[1].trim()}\n` +
        `     Removal proceeds ON THE RECORD — logged in the commit message.\n`
    );
    process.exit(0);
  }
  process.exit(2);
}

process.exit(0);
