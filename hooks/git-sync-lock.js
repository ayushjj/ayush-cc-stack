#!/usr/bin/env node
// git-sync-lock.js — a cross-session mutex for the SHARED ~/.claude git repo.
//
// Why this exists (concurrent-wrap collision, 6x as of 2026-05-31): two Claude
// sessions running /wrap at the same time both reach Step 8
// (wrapping-session/SKILL.md), which does `git add -A; commit; push` in the ONE
// shared ~/.claude repo. One shared git index + two writers => session B's
// `git add -A` sweeps session A's unstaged files into B's commit, scattering
// A's work across commits. The per-project wrap markers
// (~/.claude/.wrap-in-progress<cwd-slug>) are keyed by cwd, so they never
// guarded the shared repo. This lock serializes Step 8 across sessions.
//
// Design:
//   - Lock = a DIRECTORY (mkdir is POSIX-atomic; exactly one creator wins).
//   - owner file inside it carries: `session_id \t pid \t lstart`.
//       * IDENTITY  (whose lock is it / is it mine?)  -> session_id
//         (CLAUDE_CODE_SESSION_ID — stable per session, not a recyclable PID).
//       * LIVENESS  (did the owner crash? reclaim it)  -> pid + lstart, checked
//         with `ps -p <pid> -o lstart=` (the exact technique precompact-guard.js
//         uses; lstart defeats PID recycling).
//   - The caller (the wrap skill) passes its long-lived $PPID + lstart, because
//     the node process here runs inside an EPHEMERAL bash subshell — recording
//     that shell's pid would make the lock look instantly-stale (no exclusion).
//
// Subcommands:
//   acquire [pid] [lstart...]  -> mkdir-spin until acquired or timeout.
//                                 FAIL-OPEN: on timeout, warn + exit 0 (a lock
//                                 must NEVER hang a wrap — degrade to today's
//                                 behavior, never worse). The warn-hook
//                                 (check-wrap-collision.js) catches the hole.
//   release                    -> remove the lock (only if we own it).
//   status                     -> print JSON {held, owner, live} (tests/debug).
//
// Env overrides (defaults are production values; tests inject small numbers):
//   CLAUDE_GIT_SYNC_LOCK_SKIP=1        -> no-op exit 0 (escape valve)
//   CLAUDE_GIT_SYNC_LOCK_DIR=<path>    -> lock dir (default $HOME/.claude/.git-sync.lock)
//   CLAUDE_GIT_SYNC_LOCK_TIMEOUT_MS    -> acquire timeout (default 60000)
//   CLAUDE_GIT_SYNC_LOCK_POLL_MS       -> poll interval (default 1000)
//   CLAUDE_GIT_SYNC_LOCK_TTL_MS        -> stale-by-mtime TTL (default 600000 = 10min)
//
// Fail-safe: any unexpected error -> exit 0, never block the caller. Same
// guarantee as precompact-guard.js / memory-size-gate.js.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

function exit(code) { process.exit(code); }

try {
  if (process.env.CLAUDE_GIT_SYNC_LOCK_SKIP === '1') exit(0);

  const HOME = process.env.HOME || os.homedir() || '';
  const LOCK_DIR = process.env.CLAUDE_GIT_SYNC_LOCK_DIR
    || path.join(HOME, '.claude', '.git-sync.lock');
  const OWNER_FILE = path.join(LOCK_DIR, 'owner');
  const TIMEOUT_MS = intEnv('CLAUDE_GIT_SYNC_LOCK_TIMEOUT_MS', 60_000);
  const POLL_MS = intEnv('CLAUDE_GIT_SYNC_LOCK_POLL_MS', 1_000);
  const TTL_MS = intEnv('CLAUDE_GIT_SYNC_LOCK_TTL_MS', 600_000);

  const sessionId = process.env.CLAUDE_CODE_SESSION_ID || '';
  const cmd = process.argv[2];

  if (cmd === 'acquire') {
    // pid/lstart: prefer explicit args (skill passes its $PPID + lstart);
    // fall back to this process's parent (best-effort, e.g. ad-hoc invocation).
    const pid = process.argv[3] ? String(process.argv[3]).trim() : String(process.ppid);
    const lstart = process.argv.slice(4).join(' ').trim() || psLstart(pid) || '';
    acquire({ LOCK_DIR, OWNER_FILE, TIMEOUT_MS, POLL_MS, TTL_MS, sessionId, pid, lstart });
  } else if (cmd === 'release') {
    release({ LOCK_DIR, OWNER_FILE, sessionId });
  } else if (cmd === 'status') {
    status({ LOCK_DIR, OWNER_FILE, TTL_MS });
  } else {
    process.stderr.write('git-sync-lock.js: usage: acquire|release|status\n');
    exit(0); // unknown subcommand must not block the caller
  }
} catch (err) {
  // Last-resort: never block a wrap on a lock bug.
  try { process.stderr.write(`[git-sync-lock] non-fatal error: ${err.message}\n`); } catch {}
  exit(0);
}

// ---------------------------------------------------------------------------

function intEnv(name, dflt) {
  const v = parseInt(process.env[name] || '', 10);
  return Number.isFinite(v) && v >= 0 ? v : dflt;
}

// Returns the `ps -p <pid> -o lstart=` string (trimmed), or '' if pid is dead
// or invalid. Uses execFileSync (no shell) + a digits-only guard so a corrupted
// owner file can never inject a command via the pid field.
function psLstart(pid) {
  const p = String(pid).trim();
  if (!/^\d+$/.test(p)) return ''; // non-numeric => invalid => treat as dead/reclaimable
  try {
    return execFileSync('ps', ['-p', p, '-o', 'lstart='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return ''; // ps exit 1 => pid not found => dead
  }
}

// Read the owner file -> {sessionId, pid, lstart} or null if absent/malformed.
function readOwner(OWNER_FILE) {
  try {
    const raw = fs.readFileSync(OWNER_FILE, 'utf8');
    const parts = raw.split('\t');
    if (parts.length < 3) return { sessionId: parts[0] || '', pid: '', lstart: '', malformed: true };
    return {
      sessionId: parts[0].trim(),
      pid: parts[1].trim(),
      lstart: parts.slice(2).join('\t').trim(),
      malformed: false,
    };
  } catch {
    return null;
  }
}

// Is the current lock holder still genuinely alive (not crashed, not stale)?
//   live    = owner pid alive AND lstart matches AND lock mtime within TTL
//   !live   = reclaimable (dead / recycled / malformed / aged out)
function isHolderLive({ LOCK_DIR, OWNER_FILE, TTL_MS }) {
  let mtimeMs = 0;
  try { mtimeMs = fs.statSync(LOCK_DIR).mtimeMs; } catch { return false; } // gone
  if (Date.now() - mtimeMs >= TTL_MS) return false;                        // aged out

  const owner = readOwner(OWNER_FILE);
  if (!owner) return true;        // lockdir exists but owner not yet written: treat as live (acquirer mid-write) to avoid a reclaim race
  if (owner.malformed) return false;
  if (!owner.pid) return false;

  const cur = psLstart(owner.pid);
  return cur !== '' && cur === owner.lstart;
}

// Atomically reclaim a stale lock: rename it away (only one racer can win the
// rename), then delete. If the rename fails (someone else reclaimed, or a fresh
// lock replaced it), do nothing and let the caller re-loop. This prevents the
// classic "rm + mkdir" race where a slow reclaimer deletes a fresh winner's lock.
function reclaimStale(LOCK_DIR, pid) {
  const tmp = `${LOCK_DIR}.stale.${pid}.${process.pid}`;
  try {
    fs.renameSync(LOCK_DIR, tmp);
  } catch {
    return false; // lost the reclaim race — caller re-loops
  }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  return true;
}

function writeOwner(OWNER_FILE, sessionId, pid, lstart) {
  fs.writeFileSync(OWNER_FILE, `${sessionId}\t${pid}\t${lstart}\n`);
}

function acquire(ctx) {
  const { LOCK_DIR, OWNER_FILE, TIMEOUT_MS, POLL_MS, TTL_MS, sessionId, pid, lstart } = ctx;
  const deadline = Date.now() + TIMEOUT_MS;

  for (;;) {
    try {
      fs.mkdirSync(LOCK_DIR); // atomic create; throws EEXIST if held
      writeOwner(OWNER_FILE, sessionId, pid, lstart);
      process.stdout.write(`[git-sync-lock] acquired (session ${shortId(sessionId)}, pid ${pid})\n`);
      exit(0);
    } catch (e) {
      if (e.code !== 'EEXIST') throw e; // unexpected — outer catch fails open

      // Held. If the holder is dead/stale, reclaim and retry immediately.
      if (!isHolderLive({ LOCK_DIR, OWNER_FILE, TTL_MS })) {
        reclaimStale(LOCK_DIR, pid);
        continue; // re-attempt mkdir right away
      }

      // Genuinely held by a live owner — wait, unless we're out of time.
      if (Date.now() >= deadline) {
        const owner = readOwner(OWNER_FILE) || {};
        process.stderr.write(
          `\n══ GIT-SYNC-LOCK: acquire timed out after ${Math.round(TIMEOUT_MS / 1000)}s ══\n` +
          `   Held by session ${shortId(owner.sessionId)} (pid ${owner.pid}).\n` +
          `   FAIL-OPEN: proceeding WITHOUT the lock so the wrap never hangs.\n` +
          `   The shared ~/.claude index may collide; check-wrap-collision.js will warn if so.\n` +
          `   Lock: ${LOCK_DIR}\n` +
          `══════════════════════════════════════════════════════════════════\n`
        );
        exit(0); // fail-open: NEVER hang a wrap
      }
      sleepMs(POLL_MS);
    }
  }
}

function release(ctx) {
  const { LOCK_DIR, OWNER_FILE, sessionId } = ctx;
  const owner = readOwner(OWNER_FILE);
  // Only release a lock we own (defensive: never delete another session's lock).
  // If owner is unreadable/absent, treat as ours to clean up (idempotent end-of-wrap).
  if (owner && !owner.malformed && owner.sessionId && sessionId && owner.sessionId !== sessionId) {
    process.stderr.write(
      `[git-sync-lock] release skipped: lock owned by session ${shortId(owner.sessionId)}, ` +
      `not mine (${shortId(sessionId)}). Leaving it intact.\n`
    );
    exit(0);
  }
  try { fs.rmSync(LOCK_DIR, { recursive: true, force: true }); } catch {}
  process.stdout.write(`[git-sync-lock] released\n`);
  exit(0);
}

function status(ctx) {
  const { LOCK_DIR, OWNER_FILE, TTL_MS } = ctx;
  let held = false;
  try { held = fs.statSync(LOCK_DIR).isDirectory(); } catch {}
  const owner = held ? (readOwner(OWNER_FILE) || {}) : {};
  const live = held ? isHolderLive({ LOCK_DIR, OWNER_FILE, TTL_MS }) : false;
  process.stdout.write(JSON.stringify({
    held,
    live,
    owner_session: owner.sessionId || null,
    owner_pid: owner.pid || null,
  }) + '\n');
  exit(0);
}

function shortId(id) { return id ? String(id).slice(0, 8) : '(none)'; }

// Synchronous sleep (this is a short-lived CLI; blocking is fine and keeps the
// retry loop simple). Uses a blocking syscall via Atomics.wait on a throwaway buffer.
function sleepMs(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
  catch { /* SharedArrayBuffer unavailable — busy-spin fallback */ const end = Date.now() + ms; while (Date.now() < end) {} }
}
