#!/usr/bin/env node
// Cadence nudge for /catchup Step 2. Prints one line per OVERDUE maintenance
// skill, plus model-config drift (CLAUDE.md rule vs settings), plus due adoption
// re-checks (adoption-log.yaml); silent when all current.
// Line prefixes: 💡 overdue/never run · 🎓 daily lesson not taken today (`daily: true`, interval 1:
// last_run yesterday or earlier → due; 'today' is the UTC date) · 🔁 adoption re-check · ⚠️ CANNOT CHECK.
//
// Design rule (S65): each skill keeps the date surface it ALREADY owns. This
// script reads three different surface types rather than introducing a central
// cadence file, because recording one date in two places is what cost 20 days
// of drift in S62 (MEMORY.md, "that date lives ONLY in skills/hook-review").
//
// Surfaces:
//   state-yaml     -> ~/.claude/<skill>-state.yaml (or t.file, path parts under ~)   `last_run: "YYYY-MM-DD"` + interval
//   also: harvest-status.json and the weekly check records (sections near the end)
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
  // Weekly check: /catchup starts it in the background in the first session on or after its due day (plan Draft 6).
  // The state file lives in ~/dev/weekly-run with the run records.
  { skill: 'level-up',      type: 'state-yaml',     interval: 7,  file: ['dev', 'weekly-run', 'level-up-state.yaml'], claimDir: ['dev', 'weekly-run', 'runs'], why: 'weekly check due — /catchup Step 5c starts it in the background' },
  { skill: 'brief',         type: 'state-yaml',     interval: 1,  daily: true, why: "today's 10-15 min lesson from your bookmarks" }, // owner, 2026-10-04
  { skill: 'hook-review',   type: 'skill-md',       why: 'audit hooks for false-positive rate and fail-open defects' },
  { skill: 'skill-audit',   type: 'skill-md',       why: 'universality gate over skills/ and hooks/' },
  { skill: 'prune-memory',  type: 'governance-row', why: 'prune CLAUDE.md mistake table + principles' },
  { skill: 'publish-stack', type: 'governance-row', why: 'quarterly public stack snapshot' },
];

const readOr = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
const parseDay = (s) => { const d = new Date(s + 'T00:00:00Z'); return isNaN(d) ? null : d; };
const strictDay = (s) => { const d = parseDay(s); return d && d.toISOString().slice(0, 10) === s ? d : null; }; // rejects 2020-02-31
// A weekly record is finished when its first line is `started:` and its last non-blank line is `finished: HH:MM`.
function recordFinished(dir, d) {
  const raw = readOr(path.join(dir, `${d}.md`));
  const ls = raw === null ? [] : raw.split('\n').filter(l => l.trim());
  return ls.length > 0 && /^started:/.test(ls[0]) && /^finished: [0-9]{2}:[0-9]{2}\s*$/.test(ls[ls.length - 1]);
}
const stuckNotes = [];

// Returns {due: Date} | {error: string}
function resolveDue(t) {
  if (t.type === 'state-yaml') {
    const p = t.file ? path.join(H, ...t.file) : path.join(H, '.claude', `${t.skill}-state.yaml`);
    const raw = readOr(p);
    if (raw === null) return { error: `state file unreadable (${p})` };
    const all = [...raw.replace(/^\uFEFF/, '').matchAll(/^last_run:[ \t]*(.*)$/gm)];
    if (all.length > 1) return { error: `${all.length} last_run: lines in ${p} (keep one)` };
    const m = all.length && all[0][1].replace(/\s+#.*$/, '').trim().match(/^["']?([0-9]{4}-[0-9]{2}-[0-9]{2}|null|~|)["']?$/);
    if (!all.length) return { error: `no last_run: line in ${p}` };
    if (!m) return { error: `unparseable last_run in ${p}` };
    if (m[1] === 'null' || m[1] === '~' || m[1] === '') return { due: new Date(0), never: true };
    const last = strictDay(m[1]);
    if (!last) return { error: `unparseable last_run in ${p}` };
    if (last - today > DAY) return { error: `last_run ${m[1]} is in the future in ${p}` }; // a forged date would silence this forever
    // A finished run that could not move last_run (a source failed) counts as an attempt: retry a week after it,
    // not every day (review round 4, correctness MUST 2). The window is kept because last_run stays put.
    if (t.claimDir) {
      const dir = path.join(H, ...t.claimDir);
      let names = []; try { names = fs.readdirSync(dir); } catch { /* records section reports unreadable runs/ */ }
      const todayS = today.toISOString().slice(0, 10);
      const tried = names.map(f => f.match(/^([0-9]{4}-[0-9]{2}-[0-9]{2})\.md$/)).filter(Boolean).map(x => x[1])
        .filter(d => d > m[1] && d <= todayS && recordFinished(dir, d)).sort();
      if (tried.length) {
        const latest = tried[tried.length - 1];
        stuckNotes.push(`⚠️  weekly check finished ${latest} but last_run is still ${m[1]} — a source failed (see that record); it retries the same window a week after that run`);
        return { due: new Date(strictDay(latest).getTime() + t.interval * DAY) };
      }
    }
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
  // A lesson claims the day when it STARTS (brief SKILL.md Step 1), so sessions opened together see it as taken (2026-10-12).
  if (t.daily && fs.existsSync(path.join(H, '.claude', `${t.skill}-claims`, today.toISOString().slice(0, 10)))) continue;
  // The weekly check claims its day when /catchup launches it (Step 5c), so a second session that morning stays quiet.
  if (t.claimDir && fs.existsSync(path.join(H, ...t.claimDir, `${today.toISOString().slice(0, 10)}.started`))) continue;
  if (overdue >= 0 && t.daily) { lines.push(`🎓 /${t.skill}: ${t.why} — not taken yet today`); continue; }
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

// Adoption re-checks (2026-10-04, plans/steady-whistling-walrus.md Step 6): adoption-log.yaml
// is the ONLY owner of re-check dates. One line per entry with status: open and recheck <= today.
// Fails LOUD: any entry this reader cannot fully parse is a CANNOT CHECK line, never a skip, and
// one bad entry never hides the due entries after it (review 2026-10-04: 4 fail-open shapes).
const ADOPTION_STATUSES = new Set(['open', 'kept', 'reverted', 'declined']);
const scalar = (v) => v.replace(/\s+#.*$/, '').trim().replace(/^(["'])(.*)\1$/, '$2');

// Returns {errors: string[], due: string[]}
function resolveAdoptions() {
  const p = path.join(H, '.claude', 'adoption-log.yaml');
  const raw = readOr(p);
  if (raw === null) return { errors: [`unreadable (${p})`], due: [] };
  const lines = raw.replace(/\r/g, '').split('\n');
  const start = lines.findIndex(l => /^entries:/.test(l));
  if (start < 0) return { errors: ['no "entries:" line'], due: [] };
  if (/^entries:\s*\[\s*\]\s*$/.test(lines[start])) return { errors: [], due: [] };
  // Group items: a block starts at a "- " line; its fields are the keys at the item's own indent.
  const blocks = [];
  for (const l of lines.slice(start + 1)) {
    const item = l.match(/^(\s*)-\s+(.*)$/);
    if (item && (!blocks.length || item[1].length <= blocks[0].dash)) { blocks.push({ dash: item[1].length, keyIndent: item[1].length + 2, lines: [' '.repeat(item[1].length + 2) + item[2]] }); continue; }
    if (blocks.length) blocks[blocks.length - 1].lines.push(l);
  }
  const errors = [], due = [];
  blocks.forEach((b, i) => {
    if (/^\s*\{/.test(b.lines[0])) { errors.push(`entry ${i + 1} uses {inline} style — write one key per line`); return; }
    const f = {};
    for (const l of b.lines) {
      const m = l.match(/^(\s*)([A-Za-z_]+):\s*(.*)$/);
      if (m && m[1].length === b.keyIndent && !(m[2] in f)) f[m[2]] = scalar(m[3]);
    }
    const id = f.id || `entry ${i + 1}`;
    const status = (f.status || '').toLowerCase();
    if (!ADOPTION_STATUSES.has(status)) { errors.push(`${id} has status "${f.status || ''}" (expected open|kept|reverted|declined)`); return; }
    if (status !== 'open') return;
    const d = f.recheck && strictDay(f.recheck);
    if (!d) { errors.push(`${id} is open but has no valid recheck date`); return; }
    if (d <= today) due.push(`${id} (re-check ${f.recheck})`);
  });
  return { errors, due };
}

try {
  const r = resolveAdoptions();
  for (const e of r.errors) lines.push(`⚠️  adoption-log — CANNOT CHECK: ${e}`);
  for (const d of r.due) lines.push(`🔁 adoption re-check due: ${d} — keep, revert or extend (adoption-log.yaml)`);
} catch (e) {
  lines.push(`⚠️  adoption-log — CANNOT CHECK: ${e.message}`);
}

// Bookmark collection health (2026-10-24): a daily Mac timer runs harvest.py, which writes this file.
// Silent only when the last run is <= 3 days old and ok. Missing/unparseable = CANNOT CHECK.
function resolveHarvest() {
  const p = process.env.HARVEST_STATUS || path.join(H, 'dev', '[redacted]', 'data', 'harvest-status.json');
  const raw = readOr(p);
  if (raw === null) return { error: `unreadable (${p})` };
  let s; try { s = JSON.parse(raw); } catch { return { error: `not JSON (${p})` }; }
  if (!s || typeof s !== 'object') return { error: `missing last_run/ok in ${p}` };
  const last = typeof s.last_run === 'string' && strictDay(s.last_run.slice(0, 10));
  if (!last || typeof s.ok !== 'boolean') return { error: `missing last_run/ok in ${p}` };
  const age = Math.round((today - last) / DAY);
  if (age < -1) return { error: `last_run ${s.last_run.slice(0, 10)} is in the future in ${p}` };
  // Fixed strings only: never echo this file's free text into a session.
  const reason = ['auth', 'monthly-cap'].includes(s.reason) ? s.reason : 'other';
  if (!s.ok) return { warn: `last run ${s.last_run.slice(0, 10)} failed: ${reason}${reason === 'auth' ? ' — run `python3 ~/dev/[redacted]/harvest.py` once to log in to X' : ''}` };
  if (age > 3) return { warn: `no successful collection for ${age} days (last ${s.last_run.slice(0, 10)}) — is the daily timer loaded?` };
  return {};
}

try {
  const r = resolveHarvest();
  if (r.error) lines.push(`⚠️  bookmarks — CANNOT CHECK: ${r.error}`);
  if (r.warn) lines.push(`📥 bookmarks: ${r.warn}`);
} catch (e) {
  lines.push(`⚠️  bookmarks — CANNOT CHECK: ${e.message}`);
}

// Weekly check records (plan Draft 7). A record is finished when its last non-blank line is `finished: HH:MM`.
// - finished but not yet delivered (no Library copy) → the owner's session should run Weekly delivery;
// - 2+ launches (claim folders) since last_run with no finished record → it keeps dying; say so, don't relaunch blind.
function resolveWeeklyRecords() {
  const runs = path.join(H, 'dev', 'weekly-run', 'runs');
  let names; try { names = fs.readdirSync(runs); } catch { return { error: `unreadable (${runs})` }; }
  const finished = (d) => recordFinished(runs, d);
  const todayS = today.toISOString().slice(0, 10);
  const lib = path.join(H, 'Documents', 'Claude Library', 'global');
  const ready = names.map(f => f.match(/^([0-9]{4}-[0-9]{2}-[0-9]{2})\.md$/)).filter(Boolean).map(m => m[1])
    .filter(d => finished(d) && !fs.existsSync(path.join(lib, `${d} – Weekly check record (untrusted).md`))).sort();
  const state = readOr(path.join(H, 'dev', 'weekly-run', 'level-up-state.yaml')) || '';
  const lm = state.match(/^last_run:[ \t]*["']?([0-9]{4}-[0-9]{2}-[0-9]{2})/m);
  const since = lm ? lm[1] : '0000-00-00';
  const dead = names.map(f => f.match(/^([0-9]{4}-[0-9]{2}-[0-9]{2})\.started$/)).filter(Boolean).map(m => m[1])
    .filter(d => d > since && d < todayS && !finished(d)).sort(); // today's claim is a run in progress, not a death
  const started = ready.filter(d => fs.existsSync(path.join(runs, `${d}.delivering`)));
  return { ready: ready.filter(d => !started.includes(d)), started, dead, since };
}

try {
  const r = resolveWeeklyRecords();
  if (r.error) lines.push(`⚠️  weekly check records — CANNOT CHECK: ${r.error}`);
  else {
    lines.push(...stuckNotes);
    for (const d of r.started) lines.push(`⚠️  weekly check: delivery of ${d} started but not finished — resume level-up "Weekly delivery" from its ledger (runs/${d}-delivered.jsonl), never from the top`);
    if (r.ready.length) lines.push(`📬 weekly check results ready: ${r.ready.join(', ')} — run level-up "Weekly delivery" (cards for your yes, routes to apply)`);
    if (r.dead.length >= 2) lines.push(`⚠️  weekly check started ${r.dead.length} times since ${r.since}, none finished (${r.dead.join(', ')}) — read the latest record before launching again`);
  }
} catch (e) {
  lines.push(`⚠️  weekly check records — CANNOT CHECK: ${e.message}`);
}

if (lines.length) process.stdout.write(lines.join('\n') + '\n');
process.exit(0);
