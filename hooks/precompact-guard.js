#!/usr/bin/env node
// PreCompact guard — make context compaction visible, and optionally block when
// uncommitted work is detected. Aligns with CLAUDE.md: "Context compaction is
// silent and irreversible; inline capture is the only defense." (2026-04-12)
//
// Release-note contract (v2.1.105, 2026-04-13): PreCompact hooks can block
// compaction by exiting with code 2 or returning {"decision":"block"}.
//
// Env knobs:
//   CLAUDE_FORCE_COMPACT=1       → allow silently, no warning printed
//   CLAUDE_PRECOMPACT_BLOCK=1    → BLOCK compaction (exit 2) when git is dirty
//
// Default: warn loudly on stderr, do NOT block. Rationale: false-positive
// blocking would be worse than silent compaction — the stated goal is to make
// compaction *visible* so the user can react (run /wrap, commit, etc.).

const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

if (process.env.CLAUDE_FORCE_COMPACT === '1') {
  process.exit(0);
}

// --- Wrap-in-progress marker check ---------------------------------------
// /wrap creates a per-project marker file when it starts; deletes when done.
// Marker carries an ownership token: `{pid}\t{lstart}`. The PID identifies
// the Claude process that started the wrap; lstart is the process start time
// (from `ps -o lstart=`) and defeats PID recycling.
//
// Decision matrix (fix for repeating-orphan-marker class):
//   - mtime ≥ TTL                                  → stale, clean & allow
//   - mtime < TTL + owner alive (PID + start match)→ genuine wrap, BLOCK
//   - mtime < TTL + owner dead OR PID recycled     → orphan, clean & allow
//   - mtime < TTL + marker malformed (legacy 0-byte
//     from earlier /wrap versions)                 → preserve old TTL behavior, BLOCK
//
// Backwards-compatible: legacy `touch`-style markers (0-byte, no PID/lstart)
// hit the malformed branch and behave exactly like the previous hook — so an
// in-flight wrap that spans the upgrade is unaffected.
//
// Marker path: ~/.claude/.wrap-in-progress<project-slug>
// Slug = absolute cwd with `/` replaced by `-` (matches the projects-dir
// convention used elsewhere in this harness).
const WRAP_MARKER_TTL_MS = 10 * 60 * 1000;  // 10 minutes
const wrapSlug = process.cwd().replace(/\//g, '-');
const wrapMarker = path.join(process.env.HOME || '', '.claude', `.wrap-in-progress${wrapSlug}`);

try {
  const st = fs.statSync(wrapMarker);
  const ageMs = Date.now() - st.mtimeMs;

  let blockReason = null;
  let cleanReason = null;

  if (ageMs >= WRAP_MARKER_TTL_MS) {
    cleanReason = `stale by mtime (age: ${Math.round(ageMs / 1000)}s > ttl 600s)`;
  } else {
    // Within TTL — verify ownership token
    let stillOwned = null;  // null sentinel = marker malformed/unreadable
    let ownerPid = null;
    try {
      const content = fs.readFileSync(wrapMarker, 'utf8');
      const tabIdx = content.indexOf('\t');
      if (tabIdx > 0) {
        ownerPid = parseInt(content.slice(0, tabIdx), 10);
        const recordedStart = content.slice(tabIdx + 1).trimEnd();
        if (ownerPid > 0 && recordedStart) {
          let currentStart = '';
          try {
            currentStart = execSync(`ps -p ${ownerPid} -o lstart= 2>/dev/null`, { encoding: 'utf8' }).trimEnd();
          } catch { /* ps exit 1 = pid not found = process dead */ }
          stillOwned = currentStart !== '' && currentStart === recordedStart;
        }
      }
    } catch (readErr) {
      process.stderr.write(`[precompact-guard] marker read failed (falling back to TTL block): ${readErr.message}\n`);
    }

    if (stillOwned === false) {
      cleanReason = `owner pid ${ownerPid} dead or recycled (start-time mismatch)`;
    } else if (stillOwned === true) {
      blockReason = `wrap in progress (owner pid: ${ownerPid}, age: ${Math.round(ageMs / 1000)}s)`;
    } else {
      // stillOwned === null → malformed marker; preserve legacy TTL behavior
      blockReason = `marker present but malformed (legacy or corrupt); TTL fallback (age: ${Math.round(ageMs / 1000)}s)`;
    }
  }

  if (blockReason !== null) {
    process.stderr.write(
      `\n══ COMPACTION BLOCKED ══\n` +
      `   ${blockReason}\n` +
      `   marker: ${wrapMarker}\n` +
      `   The wrap will delete the marker when done; compaction will proceed on the next trigger.\n` +
      `   Escape valves:\n` +
      `     • Force compact this once: CLAUDE_FORCE_COMPACT=1\n` +
      `     • Clear orphan from another terminal: rm "${wrapMarker}"\n` +
      `═════════════════════════\n`
    );
    process.exit(2);
  }

  // cleanReason set — orphan or stale; clean and continue
  fs.unlinkSync(wrapMarker);
  process.stderr.write(`[precompact-guard] Cleared wrap marker (${cleanReason}): ${wrapMarker}\n`);
} catch (e) {
  if (e.code !== 'ENOENT') {
    process.stderr.write(`[precompact-guard] marker stat failed (continuing): ${e.message}\n`);
  }
  // ENOENT = marker absent = no wrap in progress = continue with normal flow
}
// -------------------------------------------------------------------------

function tryExec(cmd) {
  try {
    return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

const cwd = process.cwd();
const isGitRepo = tryExec('git rev-parse --is-inside-work-tree') === 'true';
const dirtyRaw = isGitRepo ? tryExec('git status --porcelain') : null;
const dirtyCount = dirtyRaw ? dirtyRaw.split('\n').filter(Boolean).length : 0;

const lines = [
  '════════════════════════════════════════════════════════════════',
  '⚠  COMPACTION IMMINENT — context is about to be summarized.',
  '   Per CLAUDE.md: compaction is silent and irreversible; inline',
  '   capture is the only defense.',
  '',
];

if (dirtyCount > 0) {
  lines.push(`   git status: ${dirtyCount} uncommitted file(s) in ${cwd}`);
  lines.push(`   Consider: /wrap  (or commit, or write to learnings/)`);
} else if (isGitRepo) {
  lines.push(`   git status: clean`);
} else {
  lines.push(`   (cwd is not a git repo — manually verify findings are saved)`);
}

lines.push('');
lines.push('   Override this warning:  CLAUDE_FORCE_COMPACT=1');
lines.push('   Block-on-dirty mode:    CLAUDE_PRECOMPACT_BLOCK=1');
lines.push('════════════════════════════════════════════════════════════════');

process.stderr.write(lines.join('\n') + '\n');

if (process.env.CLAUDE_PRECOMPACT_BLOCK === '1' && dirtyCount > 0) {
  process.exit(2);
}

process.exit(0);
