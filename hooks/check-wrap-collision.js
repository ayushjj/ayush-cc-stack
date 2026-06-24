#!/usr/bin/env node
// check-wrap-collision.js — PreToolUse/Bash, WARN-ONLY telemetry.
//
// Purpose: prove the git-sync mutex (git-sync-lock.js, wired into /wrap Step 8)
// is actually holding. It fires ONLY when the mutex has a HOLE — i.e. this
// session is about to write the shared ~/.claude git index while ANOTHER live
// session holds the lock. In a correctly-serialized world this never fires.
//
// Why warn-only and never block: blocking is the mutex's job. A stateless
// PreToolUse hook cannot do winner/loser arbitration (it would stall BOTH
// contending sessions until the TTL). So this is a smoke alarm, not a valve.
//
// Why NOT "count >=2 live wrap markers": once the mutex serializes, two
// concurrent wraps legitimately BOTH hold markers (B waits while A commits),
// so a marker-count signal would false-positive on every correctly-serialized
// pair. The correct signal is "lock held by a DIFFERENT live session while I
// write" — that only happens on a real bypass.
//
// Detection:
//   1. command is a `git add` or `git commit` targeting the ~/.claude repo
//      (cwd under $HOME/.claude, OR `git -C <~/.claude>` / `--git-dir` there).
//   2. the git-sync lock is held by a LIVE owner whose session_id != mine.
//   => WARN on stderr (exit 0). Otherwise silent pass.
//
// Identity: CLAUDE_CODE_SESSION_ID (same var the lock records as owner). If this
// hook can't read its own session id, it FAILS SILENT (no warn) to avoid false
// positives — telemetry degrades gracefully rather than crying wolf.
//
// Env:  CLAUDE_WRAP_COLLISION_SKIP=1  -> no-op exit 0
// Fail-safe: any error -> exit 0 (a telemetry hook must never block a tool call).

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

try {
  if (process.env.CLAUDE_WRAP_COLLISION_SKIP === '1') process.exit(0);

  const input = JSON.parse(process.env.CLAUDE_TOOL_INPUT || '{}');
  const command = (input.command || '').trim();
  if (!command) process.exit(0);

  // (1) Is this a git add / git commit?
  if (!/\bgit\b[\s\S]*\b(add|commit)\b/.test(command)) process.exit(0);

  const HOME = process.env.HOME || os.homedir() || '';
  const claudeDir = path.join(HOME, '.claude');

  // (1b) Does it target the ~/.claude repo? Either cwd is under ~/.claude and the
  // command has no overriding `-C`, OR the command explicitly points there.
  const cwd = (input.cwd || process.cwd() || '').trim();
  const dashC = command.match(/git\s+-C\s+(\S+)/);
  let targetsClaude;
  if (dashC) {
    targetsClaude = resolveHome(dashC[1], HOME).startsWith(claudeDir);
  } else {
    targetsClaude = cwd === claudeDir || cwd.startsWith(claudeDir + path.sep);
  }
  if (!targetsClaude) process.exit(0);

  // (2) Is the lock held by a DIFFERENT live session?
  const LOCK_DIR = process.env.CLAUDE_GIT_SYNC_LOCK_DIR
    || path.join(claudeDir, '.git-sync.lock');
  const TTL_MS = intEnv('CLAUDE_GIT_SYNC_LOCK_TTL_MS', 600_000);

  const owner = readOwner(path.join(LOCK_DIR, 'owner'));
  if (!owner || owner.malformed || !owner.sessionId) process.exit(0); // no clear holder

  const mySession = process.env.CLAUDE_CODE_SESSION_ID || '';
  if (!mySession) process.exit(0);              // can't self-identify -> fail silent
  if (owner.sessionId === mySession) process.exit(0); // it's MY lock -> normal

  // A different session owns the lock. Only warn if it's genuinely LIVE
  // (don't cry wolf over a stale lock the acquirer would reclaim anyway).
  if (!holderLive(LOCK_DIR, owner, TTL_MS)) process.exit(0);

  process.stderr.write(
    `\n══ WRAP-COLLISION WARNING (mutex hole) ══\n` +
    `   You are about to write the SHARED ~/.claude index, but session ` +
    `${shortId(owner.sessionId)} (pid ${owner.pid}) holds the git-sync lock.\n` +
    `   The wrap mutex should have serialized this — its absence means the lock ` +
    `was bypassed or timed out (fail-open). Expect possible commit scatter.\n` +
    `   Safe move: wait for the other wrap to finish, or stage explicitly ` +
    `(never \`git add -A\`) and verify your commit afterward.\n` +
    `   Lock: ${LOCK_DIR}   Silence: CLAUDE_WRAP_COLLISION_SKIP=1\n` +
    `══════════════════════════════════════════\n`
  );
  process.exit(0); // WARN-ONLY — never block
} catch {
  process.exit(0); // fail-safe
}

// ---------------------------------------------------------------------------

function intEnv(name, dflt) {
  const v = parseInt(process.env[name] || '', 10);
  return Number.isFinite(v) && v >= 0 ? v : dflt;
}

function resolveHome(p, HOME) {
  if (p === '~') return HOME;
  if (p.startsWith('~/')) return path.join(HOME, p.slice(2));
  if (p.startsWith('$HOME')) return path.join(HOME, p.slice('$HOME'.length));
  return p;
}

function readOwner(ownerFile) {
  try {
    const raw = fs.readFileSync(ownerFile, 'utf8');
    const parts = raw.split('\t');
    if (parts.length < 3) return { sessionId: (parts[0] || '').trim(), pid: '', lstart: '', malformed: true };
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

function holderLive(LOCK_DIR, owner, TTL_MS) {
  let mtimeMs = 0;
  try { mtimeMs = fs.statSync(LOCK_DIR).mtimeMs; } catch { return false; }
  if (Date.now() - mtimeMs >= TTL_MS) return false;
  const p = String(owner.pid).trim();
  if (!/^\d+$/.test(p)) return false;
  let cur = '';
  try {
    cur = execFileSync('ps', ['-p', p, '-o', 'lstart='], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch { return false; }
  return cur !== '' && cur === owner.lstart;
}

function shortId(id) { return id ? String(id).slice(0, 8) : '(none)'; }
