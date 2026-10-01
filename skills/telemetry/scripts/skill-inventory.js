#!/usr/bin/env node
// Skill firing-mechanism inventory (S65, 2026-08-22).
//
// Answers: for each skill, HOW does it get invoked, and does that mechanism exist?
// Built after a hand-rolled pass found 4 skills with no mechanism at all and one
// (`level-up`) whose SKILL.md documented a /catchup nudge that was never built.
//
// THREE USAGE CHANNELS — they measure different things and disagree usefully:
//   wrap      self-reported `skills_used` in telemetry/skill-log.jsonl. Full history,
//             but undercounts: depends on /wrap remembering to log.
//   tool      `Skill` tool calls in session transcripts. MODEL-INITIATED only.
//   slash     <command-name>/x</command-name> in transcripts. USER-TYPED only.
//   Transcripts are capped by the 30d-retention floor (see MEMORY.md Constraints),
//   so `wrap` is the long history and tool/slash are the recent, precise split.
//
// FOUR MECHANISM SIGNALS (a skill with none is orphaned — reachable only by memory):
//   CLAUDE  named in ~/.claude/CLAUDE.md (a Gates row or rule)
//   MEM     named in the project MEMORY.md (a standing instruction — this is a REAL
//           mechanism: /plain has 86 lifetime uses from a memory file alone)
//   HOOK    referenced by settings.json or a hook script
//   GOV     has a cadence row in governance.md
//
// KNOWN LIMITS, stated rather than hidden:
//   - `careful` runs as a hook SCRIPT, so all three usage channels read 0 while it is
//     active. Low usage never proves a skill is dead; it only raises the question.
//   - Safety/situational skills (harden, freeze, executing-batch-operations,
//     autonomous-batch, learn-book) are rare BY DESIGN. Judging them by count is the
//     S64 error: a count is not a health signal.
//   - Mechanism signals are textual references, not proof of wiring. A skill named
//     only in a hook COMMENT scores HOOK>0 while being unwired (this is why `freeze`
//     read as hook-backed on the first pass and was not).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const H = os.homedir();
const C = path.join(H, '.claude');
const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
// A swallowed error here returns '' and every usage channel reads 0 — which renders as
// "never used" and is indistinguishable from a correct zero. That is the S64 fail-open shape
// (check-eval-first sat at 0 fires for weeks). Record the failure and surface it in the report.
const SH_ERRORS = [];
const sh = (cmd, label) => {
  try { return execFileSync('bash', ['-c', cmd], { encoding: 'utf8', maxBuffer: 1 << 28 }); }
  catch (e) { SH_ERRORS.push(`${label || cmd.slice(0, 40)}: ${e.message.split('\n')[0]}`); return ''; }
};

const skills = fs.readdirSync(path.join(C, 'skills')).filter(s =>
  fs.existsSync(path.join(C, 'skills', s, 'SKILL.md'))).sort();

// ---- Channel 1: self-reported wrap logs (full history) ----
const wrap = {}; let wrapN = 0, dMin = '9999', dMax = '0';
for (const g of [path.join(C, 'telemetry/skill-log.jsonl'), ...sh(`ls ${H}/dev/*/telemetry/skill-log.jsonl 2>/dev/null`, 'wrap-logs glob').trim().split('\n')]) {
  if (!g) continue;
  const raw = read(g); if (!raw) continue;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let d; try { d = JSON.parse(line); } catch { continue; }
    wrapN++;
    if (d.date) { if (d.date < dMin) dMin = d.date; if (d.date > dMax) dMax = d.date; }
    for (const s of (d.skills_used || [])) {
      const k = String(s).trim().replace(/^\//, '').split(/[\s:(]/)[0];
      wrap[k] = (wrap[k] || 0) + 1;
    }
  }
}

// ---- Channels 2+3: transcripts ----
const count = (out) => { const m = {}; for (const l of out.trim().split('\n')) { if (!l) continue; const [n, k] = [l.trim().split(/\s+/)[0], l.trim().split(/\s+/)[1]]; if (k) m[k] = +n; } return m; };
const P = path.join(C, 'projects');
const tool = count(sh(`cd ${P} 2>/dev/null && find . -name '*.jsonl' -print0 | xargs -0 grep -h -o '"name":"Skill","input":{"skill":"[a-z-]*"' 2>/dev/null | sed 's/.*"skill":"//;s/"//' | sort | uniq -c`, 'transcript scan'));
const slash = count(sh(`cd ${P} 2>/dev/null && find . -name '*.jsonl' -print0 | xargs -0 grep -h -o '<command-name>/[a-z-]*</command-name>' 2>/dev/null | sed 's|<command-name>/||;s|</command-name>||' | sort | uniq -c`, 'transcript scan'));
const nTx = sh(`cd ${P} 2>/dev/null && find . -name '*.jsonl' | wc -l`, 'transcript count').trim();

// ---- Mechanism signals ----
const claudeMd = read(path.join(C, 'CLAUDE.md')) || '';
const memMd = read(path.join(C, `projects/-Users-${path.basename(H)}/memory/MEMORY.md`)) || '';
const govMd = read(path.join(C, 'governance.md')) || '';
const hookBlob = [path.join(C, 'settings.json'),
  ...sh(`ls ${C}/hooks/*.js ${C}/hooks/*.sh 2>/dev/null`, 'hooks glob').trim().split('\n').filter(Boolean)]
  .map(f => read(f) || '').join('\n');

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hits = (txt, sk) => (txt.match(new RegExp('(?:/|`)' + esc(sk) + '(?:`|\\b)', 'g')) || []).length;

// settings.json `skillOverrides` is AUTHORITATIVE and was missed on the first build (S65).
// "off" = disabled; "user-invocable-only" = the model cannot reach it. Both make zero
// model-initiated usage the CORRECT outcome, not a defect. Without this the inventory
// reported four deliberately-disabled skills as orphaned.
let OVR = {};
let OVR_ERROR = null;
{
  const raw = read(path.join(C, 'settings.json'));
  if (raw === null) OVR_ERROR = 'settings.json unreadable';
  else { try { OVR = JSON.parse(raw).skillOverrides || {}; }
         catch (e) { OVR_ERROR = `settings.json unparseable (${e.message.split('\n')[0]})`; } }
}

const rows = skills.map(sk => ({
  sk,
  wrap: wrap[sk] || 0, tool: tool[sk] || 0, slash: slash[sk] || 0,
  CLAUDE: hits(claudeMd, sk), MEM: hits(memMd, sk),
  HOOK: (hookBlob.match(new RegExp('skills/' + esc(sk) + '/|/' + esc(sk) + '\\b', 'g')) || []).length,
  GOV: hits(govMd, sk),
}));
rows.forEach(r => { r.use = r.wrap + r.tool + r.slash; r.ovr = OVR[r.sk] || ''; });

const w = Math.max(...rows.map(r => r.sk.length));
console.log(`SKILL FIRING INVENTORY — ${skills.length} skills`);
console.log(`  wrap logs : ${wrapN} entries, ${dMin} -> ${dMax}   (self-reported, undercounts)`);
console.log(`  transcripts: ${nTx} files (retention-capped)\n`);
console.log(`${'skill'.padEnd(w)}  wrap tool slash | CLAUDE MEM HOOK GOV | verdict`);
console.log('-'.repeat(w + 52));
for (const r of rows.sort((a, b) => b.use - a.use || a.sk.localeCompare(b.sk))) {
  // MEM alone is a WEAK signal: a MEMORY.md status note that merely NAMES a skill
  // scores identically to a standing instruction that actually drives it. This bit
  // the first run — an inventory bullet listing the orphans made those orphans read
  // as mechanism-backed (both sides derived from the same text, P72). Strong signals
  // only decide the verdict; MEM is printed and left for a human to judge.
  const strong = r.CLAUDE + r.HOOK + r.GOV;
  // An override settles the verdict before any signal is consulted.
  const v = r.ovr === 'off' ? 'DISABLED in settings.skillOverrides — zero use is correct'
    : r.ovr === 'user-invocable-only' ? 'USER-ONLY in settings.skillOverrides — model cannot reach it; zero model use is correct'
    : strong === 0 && r.use === 0 ? (r.MEM ? 'ORPHANED? — MEM-only, verify it is a standing instruction' : 'ORPHANED — no mechanism, no use')
    : strong === 0 ? 'no strong mechanism (manual only)'
    : r.use === 0 ? 'has mechanism, never used — VERIFY IT FIRES'
    : '';
  console.log(`${r.sk.padEnd(w)}  ${String(r.wrap).padStart(4)} ${String(r.tool).padStart(4)} ${String(r.slash).padStart(5)} | ${String(r.CLAUDE).padStart(6)} ${String(r.MEM).padStart(3)} ${String(r.HOOK).padStart(4)} ${String(r.GOV).padStart(3)} | ${v}`);
}
console.log(`\nRare BY DESIGN — do NOT judge these by count (S64: a count is not a health signal):`);
console.log(`  harden · freeze · executing-batch-operations · autonomous-batch · learn-book`);
console.log(`A mechanism signal is a textual reference, not proof of wiring — confirm before acting.`);
// Loud degradation: a reader must never mistake a broken reader for a clean result.
if (OVR_ERROR) {
  console.log(`\n\u26a0\ufe0f  OVERRIDES UNAVAILABLE: ${OVR_ERROR}.`);
  console.log(`   Every verdict above is UNSAFE — deliberately disabled skills will read as ORPHANED.`);
}
if (SH_ERRORS.length) {
  console.log(`\n\u26a0\ufe0f  ${SH_ERRORS.length} DATA SOURCE(S) FAILED — usage counts are undercounts, not zeros:`);
  for (const e of SH_ERRORS) console.log(`   - ${e}`);
}
if (!wrapN) console.log(`\n\u26a0\ufe0f  ZERO wrap-log entries parsed — the 'wrap' column is meaningless, not zero.`);
