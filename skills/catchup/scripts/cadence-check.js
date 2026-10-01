#!/usr/bin/env node
// Cadence nudge for /catchup Step 2. Prints one line per OVERDUE maintenance
// skill, plus model-config drift (CLAUDE.md rule vs settings); silent when all current.
//
// Design rule (S65): each skill keeps the date surface it ALREADY owns. This
// script reads three different surface types rather than introducing a central
// cadence file, because recording one date in two places is what cost 20 days
// of drift in S62 (MEMORY.md, "that date lives ONLY in skills/hook-review").
//
// Surfaces:
//   state-yaml     -> ~/.claude/<skill>-state.yaml   `last_run: "YYYY-MM-DD"` + interval
//   skill-md       -> skills/<skill>/SKILL.md        `Next review due: [~|**]YYYY-MM-DD`
//   governance-row -> ~/.claude/governance.md        table row, last date cell = next due
//
// A source that cannot be read ANNOUNCES itself rather than going quiet — a
// silent reader is indistinguishable from "nothing is due" (S64, check-eval-first
// failed open for weeks at 0 fires).
//
// Exit 0 always: this is advisory, never a gate.

const fs = require('fs');
const os = require('os');
const path = require('path');

const H = os.homedir();
const DAY = 86400000;
const today = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z');

const TARGETS = [
  { skill: 'automate-me',   type: 'state-yaml',     interval: 7,  why: 'mine recent sessions for repeated workflows worth a skill' },
  { skill: 'level-up',      type: 'state-yaml',     interval: 7,  why: 'fetch what Claude shipped since last run' },
  { skill: 'hook-review',   type: 'skill-md',       why: 'audit hooks for false-positive rate and fail-open defects' },
  { skill: 'skill-audit',   type: 'skill-md',       why: 'universality gate over skills/ and hooks/' },
  { skill: 'prune-memory',  type: 'governance-row', why: 'prune CLAUDE.md mistake table + principles' },
  { skill: 'publish-stack', type: 'governance-row', why: 'quarterly public stack snapshot' },
];

const readOr = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
const parseDay = (s) => { const d = new Date(s + 'T00:00:00Z'); return isNaN(d) ? null : d; };

// Returns {due: Date} | {error: string}
function resolveDue(t) {
  if (t.type === 'state-yaml') {
    const p = path.join(H, '.claude', `${t.skill}-state.yaml`);
    const raw = readOr(p);
    if (raw === null) return { error: `state file unreadable (${p})` };
    const m = raw.match(/^last_run:\s*["']?([0-9]{4}-[0-9]{2}-[0-9]{2}|null)["']?/m);
    if (!m) return { error: `no last_run: line in ${p}` };
    if (m[1] === 'null') return { due: new Date(0), never: true };
    const last = parseDay(m[1]);
    if (!last) return { error: `unparseable last_run in ${p}` };
    return { due: new Date(last.getTime() + t.interval * DAY) };
  }
  if (t.type === 'skill-md') {
    const p = path.join(H, '.claude', 'skills', t.skill, 'SKILL.md');
    const raw = readOr(p);
    if (raw === null) return { error: `SKILL.md unreadable (${p})` };
    const m = raw.match(/Next review due:\s*[~*\s]*([0-9]{4}-[0-9]{2}-[0-9]{2})/i);
    if (!m) return { error: `no "Next review due:" line in ${p}` };
    const d = parseDay(m[1]);
    return d ? { due: d } : { error: `unparseable due date in ${p}` };
  }
  if (t.type === 'governance-row') {
    const p = path.join(H, '.claude', 'governance.md');
    const raw = readOr(p);
    if (raw === null) return { error: `governance.md unreadable (${p})` };
    const row = raw.split('\n').find(l => l.includes('|') && l.includes(`/${t.skill}\``));
    if (!row) return { error: `no cadence row for /${t.skill} in governance.md` };
    const dates = row.match(/[0-9]{4}-[0-9]{2}-[0-9]{2}/g);
    if (!dates || !dates.length) return { error: `no date in /${t.skill} governance row` };
    const d = parseDay(dates[dates.length - 1]); // last date cell = Next due
    return d ? { due: d } : { error: `unparseable governance date for /${t.skill}` };
  }
  return { error: `unknown surface type ${t.type}` };
}

const lines = [];
for (const t of TARGETS) {
  const r = resolveDue(t);
  if (r.error) { lines.push(`⚠️  cadence: /${t.skill} — CANNOT CHECK: ${r.error}`); continue; }
  if (r.never) { lines.push(`💡 /${t.skill}: never run — ${t.why}`); continue; }
  const overdue = Math.floor((today - r.due) / DAY);
  if (overdue >= 0) lines.push(`💡 /${t.skill}: ${overdue}d overdue (due ${r.due.toISOString().slice(0,10)}) — ${t.why}`);
}
// Model-config drift (S76, 2026-09-23): commit 74d5aca silently moved `model` and
// dropped `advisorModel` while CLAUDE.md kept the old rule, unnoticed for 9 days.
// Compares the rule line `- **Model allocation** ... (`<alias>` ...) ... `advisorModel: <x>``
// against the EFFECTIVE settings (settings.local.json over settings.json). The main
// model must equal the backticked alias exactly (version + [1m] matter); the advisor
// is matched by family, which is all the rule states. Anything ambiguous → CANNOT CHECK.
function readJson(p) {
  const raw = readOr(p);
  if (raw === null) return { missing: true };
  try { const v = JSON.parse(raw); return v && typeof v === 'object' ? { v } : { error: `${path.basename(p)} is not an object` }; }
  catch { return { error: `${path.basename(p)} invalid JSON` }; }
}

// Returns {error: string} | {drift: string[]}
function resolveModelConfig() {
  const md = readOr(path.join(H, '.claude', 'CLAUDE.md'));
  if (md === null) return { error: 'CLAUDE.md unreadable' };
  const rules = md.split('\n').filter(l => l.startsWith('- **Model allocation**'));
  if (rules.length !== 1) return { error: rules.length ? `${rules.length} "- **Model allocation**" lines in CLAUDE.md` : 'no "- **Model allocation**" line in CLAUDE.md' };
  const alias = rules[0].match(/main session \*\*[^*]+\*\*\s*\(`([^`]+)`/);
  if (!alias) return { error: 'rule names no backticked main-model alias' };
  const adv = rules[0].match(/`advisorModel:\s*([A-Za-z0-9.\-\[\]]+)`/);
  if (!adv) return { error: 'no `advisorModel: X` in rule' };

  const base = readJson(path.join(H, '.claude', 'settings.json'));
  if (base.missing) return { error: 'settings.json unreadable' };
  if (base.error) return { error: base.error };
  const local = readJson(path.join(H, '.claude', 'settings.local.json'));
  if (local.error) return { error: local.error };
  const cfg = Object.assign({}, base.v, local.v || {});

  const drift = [];
  const want = alias[1].toLowerCase(), got = String(cfg.model || '').toLowerCase();
  if (got !== want) drift.push(`model is "${cfg.model || '(unset)'}" but CLAUDE.md says \`${alias[1]}\``);
  const wantAdv = adv[1].toLowerCase(), gotAdv = String(cfg.advisorModel || '').toLowerCase();
  const advOk = wantAdv === 'none' ? (gotAdv === '' || gotAdv === 'none') : gotAdv.includes(wantAdv); // `none` = rule says the advisor is OFF
  if (!advOk) drift.push(`advisorModel is "${cfg.advisorModel || '(unset)'}" but CLAUDE.md says ${adv[1]}`);
  const envModel = process.env.ANTHROPIC_MODEL || (cfg.env && cfg.env.ANTHROPIC_MODEL);
  if (envModel) drift.push(`ANTHROPIC_MODEL="${envModel}" overrides settings — the check cannot see the running model`);
  return { drift };
}

try {
  const r = resolveModelConfig();
  if (r.error) lines.push(`⚠️  model-config — CANNOT CHECK: ${r.error}`);
  else for (const d of r.drift) lines.push(`⚠️  model-config drift: ${d}`);
} catch (e) {
  lines.push(`⚠️  model-config — CANNOT CHECK: ${e.message}`); // never let this block take the cadence lines down
}

if (lines.length) process.stdout.write(lines.join('\n') + '\n');
process.exit(0);
