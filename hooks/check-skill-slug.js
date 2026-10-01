#!/usr/bin/env node
// PreToolUse hook: when Skill tool is invoked with a name that fuzzy-matches
// an installed skill slug WITHOUT equaling one, block with a "did you mean"
// list. Catches P2 (3x): invoking with CLAUDE.md shorthand (`/wrap`) instead
// of slug (`wrapping-session`).
//
// The harness already errors with "Unknown skill:" — this hook only augments
// that rejection with the actual list of installed slugs so Claude
// self-corrects in one turn instead of guessing. Because the harness is the
// real judge, this hook BLOCKS ONLY on positive shorthand evidence (a fuzzy
// suggestion exists). Unrecognized names with NO resemblance to anything
// installed pass through (S256): harness BUILT-IN skills (verify, code-review,
// fewer-permission-prompts, loop, …) live inside the CLI, not on disk, so they
// are invisible to this enumeration — blocking them was a false positive, and
// enumerating them here would be a P58 static set drifting every CLI release.
//
// Skip:      CLAUDE_SKILL_SLUG_SKIP=1
// Warn-only: CLAUDE_SKILL_SLUG_WARN_ONLY=1

if (process.env.CLAUDE_SKILL_SLUG_SKIP === '1') {
  process.exit(0);
}

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const tty = require('node:tty');

// Tool input arrives as JSON on stdin (hook contract, verified 2026-07-04);
// legacy CLAUDE_TOOL_INPUT env retained only as fallback — the env-only read
// left this gate silently dead until S46.
let raw = '';
// tty.isatty(0), not process.stdin.isTTY — the latter flips fd 0 O_NONBLOCK
// and readFileSync(0) EAGAINs on slow pipes (the S167 classify-diff bug).
try { if (!tty.isatty(0)) raw = fs.readFileSync(0, 'utf8'); } catch {}
if (!raw.trim() && process.env.CLAUDE_TOOL_INPUT) raw = process.env.CLAUDE_TOOL_INPUT;
let input = {};
try { input = raw.trim() ? JSON.parse(raw) : {}; } catch {}
const requested = ((input.tool_input && input.tool_input.skill) || input.skill || '').trim();

if (!requested) {
  process.exit(0);
}

// Strip a leading slash if present (CLAUDE.md shorthand often writes `/wrap`)
const requestedClean = requested.replace(/^\//, '');

function listSkills(dir) {
  if (!fs.existsSync(dir)) return [];
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name)
      .filter(name => !name.startsWith('.archived-')) // retired skills: block with did-you-mean, not resolve
      .filter(name => fs.existsSync(path.join(dir, name, 'SKILL.md')));
  } catch {
    return [];
  }
}

const userSkillsDir = path.join(os.homedir(), '.claude', 'skills');
const userSkills = listSkills(userSkillsDir);

// Plugin skills live anywhere under ~/.claude/plugins. The exact depth varies:
//   plugins/cache/<source>/<plugin>/<version>/skills/<slug>/SKILL.md
//   plugins/marketplaces/<mkt>/plugins/<plugin>/skills/<slug>/SKILL.md
// Walk recursively, recognise any `.../skills/<slug>/SKILL.md` shape.
function walkPluginSkills() {
  const pluginsRoot = path.join(os.homedir(), '.claude', 'plugins');
  if (!fs.existsSync(pluginsRoot)) return [];
  const found = new Set();
  const stack = [pluginsRoot];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const full = path.join(dir, e.name);
      if (e.name === 'skills') {
        // Children of `skills/` are slugs (if they contain a SKILL.md)
        let slugs;
        try { slugs = fs.readdirSync(full, { withFileTypes: true }); }
        catch { continue; }
        for (const s of slugs) {
          if (s.isDirectory() && fs.existsSync(path.join(full, s.name, 'SKILL.md'))) {
            found.add(s.name);
          }
        }
        // Don't descend further from `skills/` — slugs are leaves
      } else {
        stack.push(full);
      }
    }
  }
  return [...found];
}

const pluginSkills = walkPluginSkills();
const allSkills = [...new Set([...userSkills, ...pluginSkills])];

// If requested name contains a `:`, it's plugin-namespaced (e.g.
// compound-engineering:ce-commit). Validate only the part after `:` — the
// hook's goal is catching shorthand-not-slug, not enforcing plugin namespace.
const requestedSlug = requestedClean.includes(':')
  ? requestedClean.split(':').pop()
  : requestedClean;

if (allSkills.includes(requestedSlug)) {
  process.exit(0);
}

// ≤2-edit approximation with length delta ≤2 (two-pointer; not true Levenshtein).
function nearEdit(a, b) {
  if (Math.abs(a.length - b.length) > 2) return false;
  let diffs = 0;
  for (let i = 0, j = 0; i < a.length && j < b.length; ) {
    if (a[i] === b[j]) { i++; j++; continue; }
    diffs++;
    if (diffs > 2) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else { i++; j++; }
  }
  return diffs <= 2;
}

// Blockable evidence = shorthand or typo, DIRECTION-AWARE (S256, 2nd pass):
//  - requested is a FRAGMENT of an installed slug (`wrap` ⊂ `wrapping-session`) — P2 shorthand
//  - requested is within ~2 edits of an installed slug (`catchp` → `catchup`) — typo
//  - requested EXTENDS an installed slug (`code-review` ⊃ `review`) — NOT blockable:
//    that's the shape of a harness built-in, which lives in the CLI and is invisible
//    here. The first fail-open pass freed only zero-resemblance names and still
//    hard-blocked `code-review`; the harness errors on its own for real unknowns.
//    Matched against the post-namespace slug, not the full plugin-prefixed string.
const suggestions = allSkills.filter(s => {
  const inst = s.toLowerCase(), req = requestedSlug.toLowerCase();
  if (inst === req) return false;
  // PREFIX, not substring: P2 shorthand is abbreviation-shaped (`wrap` →
  // `wrapping-session`). A substring rule re-blocked built-in `code-review`
  // via installed `ce-code-review` (caught by the canary's extension case).
  if (inst.startsWith(req)) return true;
  if (req.includes(inst)) return false;
  return nearEdit(inst, req);
}).slice(0, 5);

// No shorthand/typo evidence → fail OPEN; the harness is the real judge.
if (suggestions.length === 0) {
  process.exit(0);
}

const msg = [
  '════════════════════════════════════════════════════════════════',
  `⚠  SKILL-SLUG (P2): Skill "${requested}" not found.`,
  '',
  '   CLAUDE.md often uses shorthand (e.g. `/wrap`) but the Skill tool',
  '   needs the actual installed slug (e.g. `wrapping-session`).',
  '',
  '   Did you mean:',
  ...suggestions.map(s => `     - ${s}`),
  '',
  '   Skip this hook: CLAUDE_SKILL_SLUG_SKIP=1',
  '   Warn-only:     CLAUDE_SKILL_SLUG_WARN_ONLY=1',
  '════════════════════════════════════════════════════════════════',
];

process.stderr.write(msg.join('\n') + '\n');

if (process.env.CLAUDE_SKILL_SLUG_WARN_ONLY === '1') {
  process.exit(0);
}

process.exit(2);
