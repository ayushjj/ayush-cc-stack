// PreToolUse hook: warn-only size visibility for MEMORY.md, CLAUDE.md and
// learnings/ writes. Never blocks — always exits 0.
//
// Two layers:
//   (1) Whole-file soft-cap (original behavior, unchanged): warns if the write
//       would push MEMORY.md past 20 KB or CLAUDE.md past 50 KB.
//   (2) Authoring-time ENTRY-size budget (S47 addition): the "author within
//       budget from keystroke one, never write-then-trim at wrap" rule lived
//       only in prose, so oversized mistake-table rows / principle entries kept
//       getting written and then reactively pruned. This layer surfaces the
//       specific oversized entry at the moment of writing.
//
// P51 paired-semantics: the ENTRY caps and their measurement are a faithful
// port of ~/.claude/skills/wrapping-session/verify_claude_md.py (the wrap-time
// verifier). Write-time nudge and wrap-time gate MUST agree — if you change a
// cap or the measurement here, change it there too (and vice versa).
//   - Mistake row: first "|" cell (Pattern column) > 250 chars AND no archive
//     (a pointer does NOT exempt) → verify_claude_md.py MISTAKE_ROW_CAP_CHARS,
//     check_mistake_rows(), and _split_cells() — mirrored as splitCells() below.
//     Grep the names, not line numbers; line refs go stale silently.
//   - Principle: entry body > 600 chars WITH a substantial inline "Example:"
//     (>100 chars) AND no "→ Full case detail" pointer → verify_claude_md.py:64
//     PARAGRAPH_PRINCIPLE_CAP_CHARS + check_paragraph_principles(). Long
//     T1+T2-only principles are intentionally NOT flagged (governance.md:144
//     "Tier 2 — Rule body: No length cap"); only externalizable T3 bites.
//   - learnings/*.md body soft ceiling = 40 KB = 80% of the 50 KB CLAUDE.md cap
//     (the "~80% of cap" authoring aim). governance.md:156 says learnings are
//     "unbounded", so this is a split-me nudge, not a governance cap — the
//     warning text states its own source.
//
// Heuristics (write-time we may lack section headings that the verifier relies
// on when it reads the whole file):
//   - Mistake rows are identified by a Times cell matching /^\d+x$/ (every real
//     row has one; header/separator/other-table rows do not) — robust whether
//     or not the "## Mistake Patterns" heading is in the payload.
//   - Principle entries are numbered lines /^\d+\.\s/ whose body does NOT begin
//     with "**"; that excludes the Command-Discipline rules (0.–8., all shaped
//     "N. **Bold**:") which no principle imitates. Section-scoping is also used
//     when the "## Principles" heading is present (full-file Write).
//
// Honors CLAUDE_MEMORY_GATE_QUIET=1 for bulk archival work (silent).
// Wrapped in try/catch so any internal error still exits 0 (buggy hook must
// miss warnings, never block writes — same guarantee as check-freeze.js).

const MEMORY_SOFT_BYTES = 20 * 1024;
const CLAUDE_SOFT_BYTES = 50 * 1024;
const LEARNINGS_SOFT_BYTES = Math.round(0.8 * CLAUDE_SOFT_BYTES); // 40 KB (80% of CLAUDE.md cap)

// Entry caps — mirror verify_claude_md.py exactly (P51 paired-semantics).
const MISTAKE_ROW_CAP_CHARS = 250;
const PARAGRAPH_PRINCIPLE_CAP_CHARS = 600;
const EXTERNALIZED_POINTER_PATTERN = '→ Full case detail';
const ARCHIVE_POINTER_PATTERNS = [
  'learnings/',
  '→ `~/.claude/principles/',
  '→ Full case detail',
  'Sub-incident archive',
  'Sub-incidents:',
];

function hasArchivePointer(s) {
  return ARCHIVE_POINTER_PATTERNS.some((p) => s.includes(p));
}

// --- ENTRY-size heuristics (ported from verify_claude_md.py) --------------

// Split a GFM table row on UNESCAPED pipes; return its interior cells, or null if
// the line is not a table row. A literal '|' inside a cell must be written '\|'
// (GFM requires it even inside `code spans`); an unescaped one opens a new column,
// so a naive line.split('|') reads a truncated first cell and under-measures the
// row. Mirror of verify_claude_md.py::_split_cells — P51: change one, change both.
function splitCells(line) {
  const s = line.trim();
  if (!s.startsWith('|')) return null;
  const cells = [];
  let buf = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\' && i + 1 < s.length && s[i + 1] === '|') { buf += '|'; i += 1; continue; }
    if (ch === '|') { cells.push(buf.trim()); buf = ''; continue; }
    buf += ch;
  }
  cells.push(buf.trim());
  if (cells.length && cells[0] === '') cells.shift();
  if (cells.length && cells[cells.length - 1] === '') cells.pop();
  return cells;
}

// Oversized mistake-table rows in the given text. Returns [{len, snippet, ptr}].
function oversizedMistakeRows(text) {
  let body = text;
  const hm = text.match(/^## Mistake Patterns\b/m);
  if (hm) {
    const after = text.slice(hm.index + hm[0].length);
    const nxt = after.match(/^## /m);
    body = nxt ? after.slice(0, nxt.index) : after;
  }
  const out = [];
  for (const line of body.split('\n')) {
    if (!line.startsWith('| ')) continue;
    if (line.startsWith('| Pattern ') || line.startsWith('|---') || line.startsWith('| ---')) continue;
    const cells = splitCells(line);
    if (!cells || cells.length < 2) continue;
    // A real mistake row has a Times cell like "60x"; header/separator/other
    // tables do not. This is the write-time stand-in for the verifier's
    // section-scoping and never drops a row the verifier would flag.
    const isMistakeRow = cells.some((c) => /^\d+x$/.test(c));
    if (!isMistakeRow) continue;
    const patternCell = cells[0];
    // An archive pointer does NOT exempt a row from the cap (verifier parity,
    // 2026-07-09) — it only changes what the nudge tells you to do next.
    if (patternCell.length > MISTAKE_ROW_CAP_CHARS) {
      out.push({
        len: patternCell.length,
        snippet: patternCell.slice(0, 60).replace(/\n/g, ' '),
        ptr: hasArchivePointer(patternCell),
      });
    }
  }
  return out;
}

// Numbered principle entries in the given text. Command-Discipline rules
// ("N. **Bold**") are excluded. Returns [{num, body}].
function extractPrincipleEntries(text) {
  let body = text;
  const hm = text.match(/^## Principles\b/m);
  if (hm) {
    const after = text.slice(hm.index + hm[0].length);
    const nxt = after.match(/^## /m);
    body = nxt ? after.slice(0, nxt.index) : after;
  }
  const re = /^(\d+)\.\s/gm;
  const marks = [];
  let mm;
  while ((mm = re.exec(body)) !== null) {
    marks.push({ num: parseInt(mm[1], 10), start: mm.index, markerEnd: mm.index + mm[0].length });
  }
  const entries = [];
  for (let i = 0; i < marks.length; i++) {
    const start = marks[i].start;
    const end = i + 1 < marks.length ? marks[i + 1].start : body.length;
    // Discriminator: skip Command-Discipline rules (body starts with "**").
    // No real principle begins with "**", so applying this universally is safe.
    const afterMarker = body.slice(marks[i].markerEnd, end).replace(/^\s+/, '');
    if (afterMarker.startsWith('**')) continue;
    entries.push({ num: marks[i].num, body: body.slice(start, end).replace(/\s+$/, '') });
  }
  return entries;
}

// Oversized paragraph-form principles. Returns [{num, n}].
function oversizedPrinciples(text) {
  const out = [];
  for (const { num, body } of extractPrincipleEntries(text)) {
    const n = body.length;
    if (n <= PARAGRAPH_PRINCIPLE_CAP_CHARS) continue;
    if (body.includes(EXTERNALIZED_POINTER_PATTERN)) continue; // already externalized
    const idx = body.indexOf('Example:');
    if (idx === -1) continue; // T1+T2-only paragraph — no T3 to cleave (allowed)
    const post = body.slice(idx);
    if (post.includes('See learnings/') || post.includes('See `~/')) continue; // date-grounded fallback
    if (post.length - 'Example:'.length < 100) continue; // micro-example stays inline
    out.push({ num, n });
  }
  return out;
}

try {
  if (process.env.CLAUDE_MEMORY_GATE_QUIET === '1') {
    process.exit(0);
  }

  const fs = require('fs');
  const path = require('path');
  const os = require('os');

  // NOT migrated to lib/hook-input.js. `process.stdin.isTTY` flips fd 0 to
  // O_NONBLOCK and the read below silently fails open on a slow first byte. That is
  // harmless HERE only because every path in this file exits 0 (warn-only).
  // Do NOT copy this idiom into a hook that blocks, and if you give this file an
  // exit(2) path, migrate it to lib/hook-input.js first.
  let raw = '';
  try { if (!process.stdin.isTTY) raw = fs.readFileSync(0, 'utf8'); } catch (_) {}
  if (!raw.trim() && process.env.CLAUDE_TOOL_INPUT) raw = process.env.CLAUDE_TOOL_INPUT;
  let payload = {};
  try { payload = raw.trim() ? JSON.parse(raw) : {}; } catch (_) {}
  const input = payload.tool_input || payload;
  const warnings = [];   // emitted once at the end (see warnModel below)
  const filePath = input.file_path || '';
  if (!filePath) {
    process.exit(0);
  }

  const resolved = path.resolve(filePath);
  const baseName = path.basename(resolved);
  const claudeMdPath = path.resolve(path.join(os.homedir(), '.claude', 'CLAUDE.md'));
  const claudeDir = path.resolve(path.join(os.homedir(), '.claude'));

  const isMemoryMd = baseName === 'MEMORY.md';
  const isClaudeMd = resolved === claudeMdPath;
  // A learnings archive under ~/.claude (global learnings/ or per-project
  // memory/learnings/). Not CLAUDE.md, not principles/, not skills/.
  const isLearnings =
    resolved.startsWith(claudeDir + path.sep) &&
    resolved.includes(path.sep + 'learnings' + path.sep) &&
    baseName.endsWith('.md');

  if (!isMemoryMd && !isClaudeMd && !isLearnings) {
    process.exit(0);
  }

  // Tool name comes from the stdin payload (tool_name); legacy env fallback.
  const toolName = payload.tool_name || process.env.CLAUDE_TOOL_NAME || '';

  // --- Layer 1: whole-file soft cap (MEMORY.md / CLAUDE.md only) ----------
  if (isMemoryMd || isClaudeMd) {
    const currentSize = fs.existsSync(resolved) ? fs.statSync(resolved).size : 0;
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
      warnings.push(
        `[memory-size-gate] ${baseName} would become ${projKB}KB after this write ` +
        `(soft threshold ${softKB}KB). Consider /prune-memory when convenient. ` +
        `No block — write proceeding.\n`
      );
    }
  }

  // --- Layer 2a: CLAUDE.md entry-size budget (mistake rows + principles) ---
  if (isClaudeMd) {
    let scanText = '';
    if (toolName === 'Write') scanText = input.content || '';
    else if (toolName === 'Edit') scanText = input.new_string || '';
    else if (toolName === 'MultiEdit') scanText = (input.edits || []).map((e) => e.new_string || '').join('\n');

    if (scanText) {
      const rows = oversizedMistakeRows(scanText);
      if (rows.length) {
        const names = rows.slice(0, 2).map((r) => `"${r.snippet}…" (${r.len}c)`).join(', ');
        const more = rows.length > 2 ? ` (+${rows.length - 2} more)` : '';
        warnings.push(
          `[memory-size-gate] this CLAUDE.md write adds ${rows.length} oversized mistake-table ` +
          `row(s) (Pattern cell >${MISTAKE_ROW_CAP_CHARS} chars — an archive pointer does NOT ` +
          `exempt a row; ${rows.filter((r) => r.ptr).length} of these already carry one): ` +
          `${names}${more}. Author within budget now: T1 trigger + T2 fix inline, T3 narrative ` +
          `appended to "→ learnings/YYYY-MM-DD-{slug}-archive.md" BEFORE you trim. No block — ` +
          `write proceeding; the wrap-time gate (Step 8, --strict) will not be so forgiving.\n`
        );
      }

      const princ = oversizedPrinciples(scanText);
      if (princ.length) {
        const pn = princ.slice(0, 3).map((p) => `P${p.num}(${p.n}c)`).join(', ');
        const more = princ.length > 3 ? ` (+${princ.length - 3} more)` : '';
        warnings.push(
          `[memory-size-gate] this CLAUDE.md write adds ${princ.length} oversized principle ` +
          `entry(ies) (>${PARAGRAPH_PRINCIPLE_CAP_CHARS} chars with a substantial inline ` +
          `"Example:" and no "→ Full case detail" pointer — governance cap ` +
          `${PARAGRAPH_PRINCIPLE_CAP_CHARS}, verify_claude_md.py:64): ${pn}${more}. Externalize ` +
          `the T3 worked example to ~/.claude/principles/PNN-{slug}.md now (probation clause); ` +
          `keep T1+T2 inline. No block — write proceeding.\n`
        );
      }
    }
  }

  // --- Layer 2b: learnings/*.md body soft ceiling -------------------------
  if (isLearnings && toolName === 'Write') {
    const bodyBytes = Buffer.byteLength(input.content || '', 'utf-8');
    if (bodyBytes > LEARNINGS_SOFT_BYTES) {
      const kb = (bodyBytes / 1024).toFixed(1);
      const capKB = (LEARNINGS_SOFT_BYTES / 1024).toFixed(0);
      const claudeKB = (CLAUDE_SOFT_BYTES / 1024).toFixed(0);
      warnings.push(
        `[memory-size-gate] ${baseName} would be written at ${kb}KB. learnings/ files are ` +
        `"unbounded" per governance.md:156, but this ${capKB}KB soft ceiling = 80% of the ` +
        `${claudeKB}KB CLAUDE.md cap (the "~80% of cap" authoring aim). A single learnings file ` +
        `larger than the whole agent-facing CLAUDE.md is usually two topics — consider splitting ` +
        `by date/topic. No block — write proceeding.\n`
      );
    }
  }

  // ONE emission for all layers: stdout must hold a single JSON object, and
  // exit-0 stderr never reaches the model (S81 probe) — warnModel's channel does.
  if (warnings.length) {
    const text = warnings.join('');
    try { require('./lib/hook-input.js').warnModel(text); } catch { process.stderr.write(text); }
  }
  process.exit(0);
} catch (err) {
  try {
    process.stderr.write(`[memory-size-gate] internal error: ${err.message} — allowing write\n`);
  } catch (_) { /* stderr failed — still exit 0 */ }
  process.exit(0);
}
