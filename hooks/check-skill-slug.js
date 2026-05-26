#!/usr/bin/env node
// PreToolUse hook: when Skill tool is invoked with a name that doesn't match
// any installed skill slug, block with a "did you mean" list. Catches P2 (3x):
// invoking with CLAUDE.md shorthand (`/wrap`) instead of slug (`wrapping-session`).
//
// The harness already errors with "Unknown skill:" — this hook augments the
// rejection with the actual list of installed slugs so Claude self-corrects
// in one turn instead of guessing.
//
// Skip:      CLAUDE_SKILL_SLUG_SKIP=1
// Warn-only: CLAUDE_SKILL_SLUG_WARN_ONLY=1

if (process.env.CLAUDE_SKILL_SLUG_SKIP === '1') {
  process.exit(0);
}

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const input = JSON.parse(process.env.CLAUDE_TOOL_INPUT || '{}');
const requested = (input.skill || '').trim();

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

// Compute fuzzy suggestions: substring matches + Levenshtein-1-like edits.
function similar(a, b) {
  a = a.toLowerCase();
  b = b.toLowerCase();
  if (a === b) return true;
  if (a.includes(b) || b.includes(a)) return true;
  // Quick Levenshtein-1 approximation: same length ±1, ≤1 char diff
  if (Math.abs(a.length - b.length) > 2) return false;
  let diffs = 0;
  const maxLen = Math.max(a.length, b.length);
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

const suggestions = allSkills
  .filter(s => similar(s, requestedClean))
  .slice(0, 5);

const msg = [
  '════════════════════════════════════════════════════════════════',
  `⚠  SKILL-SLUG (P2): Skill "${requested}" not found.`,
  '',
  '   CLAUDE.md often uses shorthand (e.g. `/wrap`) but the Skill tool',
  '   needs the actual installed slug (e.g. `wrapping-session`).',
  '',
];

if (suggestions.length > 0) {
  msg.push('   Did you mean:');
  for (const s of suggestions) msg.push(`     - ${s}`);
  msg.push('');
}

msg.push(
  `   Installed user skills (${userSkills.length}):`,
  '     ' + (userSkills.slice(0, 12).join(', ') || '(none)'),
  ...(userSkills.length > 12 ? [`     ... and ${userSkills.length - 12} more`] : []),
);

if (pluginSkills.length > 0) {
  msg.push(
    '',
    `   Plugin skills (${pluginSkills.length}, namespaced as plugin:slug):`,
    '     ' + pluginSkills.slice(0, 6).join(', '),
    ...(pluginSkills.length > 6 ? [`     ... and ${pluginSkills.length - 6} more`] : []),
  );
}

msg.push(
  '',
  '   Skip this hook: CLAUDE_SKILL_SLUG_SKIP=1',
  '   Warn-only:     CLAUDE_SKILL_SLUG_WARN_ONLY=1',
  '════════════════════════════════════════════════════════════════',
);

process.stderr.write(msg.join('\n') + '\n');

if (process.env.CLAUDE_SKILL_SLUG_WARN_ONLY === '1') {
  process.exit(0);
}

process.exit(2);
