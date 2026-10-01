#!/usr/bin/env node
// session-manifest.js — per-session file manifests for the SHARED ~/.claude repo.
//
// Why this exists (co-mingling, 8 fires as of 2026-07-04): the wrap mutex
// (git-sync-lock.js) serializes concurrent wraps, but Step 8's `git add -A`
// was spatially greedy — the wrap holding the lock swept OTHER live sessions'
// unstaged ~/.claude edits into ITS commit (mis-attribution; decision record
// `ship-mutex-accept-co-mingling` accepted this until the next fire; it fired).
// Fix: a PostToolUse hook records every file THIS session edits under ~/.claude
// into a per-session manifest; the wrap stages and commits exactly that list.
//
// Subcommands:
//   record          PostToolUse hook (matcher Edit|Write|MultiEdit|NotebookEdit).
//                   stdin JSON -> tool_input.file_path|notebook_path; if under
//                   the repo, append repo-relative path to the session manifest.
//                   ALWAYS touches the manifest mtime (even for non-repo paths):
//                   manifest freshness = "session alive" beacon for the orphan
//                   valve. FAIL-SILENT (exit 0) — never block an edit; the
//                   `stage` divergence WARN is the smoke alarm for a dead recorder.
//   stage           Called by wrap Step 8 (under the git-sync lock, replacing
//                   `git add -A`). One `git status --porcelain -z` snapshot;
//                   stages manifest∩dirty; prints an annotated report of
//                   leftovers (siblings' work — LEAVE by default); ownership-
//                   first orphan valve (see below); writes the commit pathspec
//                   file consumed by `git commit --pathspec-from-file`.
//                   FAILS LOUD (exit 1) — the skill's degradation path is
//                   explicit manual staging, never silence, never `add -A`.
//   claim <path>..  Wrap-time agent claims a leftover as its own (Bash-created
//                   files / rm deletions — the two capture gaps): stages it +
//                   appends to pathspec file + manifest. FAILS LOUD.
//   prune           After a successful commit: rewrite own manifest to only
//                   still-dirty entries (NOT delete — mid-wrap appends from
//                   background subagents must survive); drop the pathspec file.
//
// Orphan valve (ownership first, age second — file mtime is the WRONG signal:
// deletions have none, live long sessions would get mis-adopted, harness-touched
// files never age):
//   - leftover claimed by a FRESH sibling manifest (mtime < FRESH_MS): never
//     adopt — its owner is alive and will commit it in its own wrap.
//   - leftover claimed only by STALE manifests: owner is dead -> adopt NOW,
//     then GC those manifests.
//   - unclaimed leftover: age via the first-seen ledger (first-seen.json,
//     written here), adopt after ORPHAN_MS of continuous dirtiness.
//   Adopted paths are echoed for inclusion in the commit message.
//
// Env (defaults are production values; tests inject overrides):
//   CLAUDE_SESSION_MANIFEST_SKIP=1     -> no-op exit 0 (escape valve)
//   CLAUDE_MANIFEST_REPO=<path>        -> repo root   (default $HOME/.claude)
//   CLAUDE_SESSION_MANIFEST_DIR=<path> -> manifests   (default <repo>/.session-manifests)
//   CLAUDE_MANIFEST_FRESH_MS           -> live-owner threshold (default 48h)
//   CLAUDE_MANIFEST_ORPHAN_MS          -> unclaimed adoption age (default 7d)
//   CLAUDE_CODE_SESSION_ID             -> session identity (stdin session_id wins)

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const HOME = process.env.HOME || os.homedir() || '';
const REPO = process.env.CLAUDE_MANIFEST_REPO || path.join(HOME, '.claude');
const MANIFEST_DIR = process.env.CLAUDE_SESSION_MANIFEST_DIR || path.join(REPO, '.session-manifests');
const FRESH_MS = intEnv('CLAUDE_MANIFEST_FRESH_MS', 48 * 3600 * 1000);
const ORPHAN_MS = intEnv('CLAUDE_MANIFEST_ORPHAN_MS', 7 * 24 * 3600 * 1000);
const LEDGER = path.join(MANIFEST_DIR, 'first-seen.json');

const cmd = process.argv[2];

if (process.env.CLAUDE_SESSION_MANIFEST_SKIP === '1') process.exit(0);

if (cmd === 'record') {
  // Hook path: any throw must end in exit 0.
  try { record(); } catch { /* fail-silent */ }
  process.exit(0);
} else if (cmd === 'stage' || cmd === 'claim' || cmd === 'prune') {
  // Wrap path: fail LOUD so the skill's degradation path triggers.
  try {
    if (cmd === 'stage') stage();
    else if (cmd === 'claim') claim(process.argv.slice(3));
    else prune();
    process.exit(0);
  } catch (err) {
    process.stderr.write(`[session-manifest] ${cmd} FAILED: ${err.message}\n`);
    process.exit(1);
  }
} else {
  process.stderr.write('session-manifest.js: usage: record|stage|claim <path>..|prune\n');
  process.exit(cmd ? 1 : 0);
}

// ---------------------------------------------------------------------------

function intEnv(name, dflt) {
  const v = parseInt(process.env[name] || '', 10);
  return Number.isFinite(v) && v >= 0 ? v : dflt;
}

function sessionId(stdinPayload) {
  return (stdinPayload && stdinPayload.session_id) || process.env.CLAUDE_CODE_SESSION_ID || '';
}

function manifestPath(sid) { return path.join(MANIFEST_DIR, sid); }
function pathspecPath(sid) { return path.join(MANIFEST_DIR, `${sid}.commit-pathspec`); }
function shortId(id) { return id ? String(id).slice(0, 8) : '(none)'; }

function realpathSafe(p) {
  try { return fs.realpathSync(p); } catch { return p; }
}

function readLines(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').map(s => s.trim()).filter(Boolean);
  } catch { return []; }
}

function git(args, opts) {
  return execFileSync('git', ['-C', REPO, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
    ...opts,
  });
}

// --- record ----------------------------------------------------------------

function record() {
  // NOT migrated to lib/hook-input.js. `process.stdin.isTTY` flips fd 0 to
  // O_NONBLOCK and the read below silently fails open on a slow first byte. That is
  // harmless HERE only because this is an observer (never exits 2).
  // Do NOT copy this idiom into a hook that blocks, and if you give this file an
  // exit(2) path, migrate it to lib/hook-input.js first.
  let raw = '';
  try { if (!process.stdin.isTTY) raw = fs.readFileSync(0, 'utf8'); } catch {}
  if (!raw.trim() && process.env.CLAUDE_TOOL_INPUT) raw = process.env.CLAUDE_TOOL_INPUT; // legacy fallback
  let payload = {};
  try { payload = raw.trim() ? JSON.parse(raw) : {}; } catch { return; }

  const sid = sessionId(payload);
  if (!sid || /[\\/]/.test(sid)) return; // no identity (or unsafe as a filename) -> can't attribute

  const mf = manifestPath(sid);

  // Liveness beacon: touch the manifest on EVERY recorded tool call, even for
  // paths outside the repo — freshness must mean "session alive", not
  // "session recently edited ~/.claude" (protects long sessions from adoption).
  fs.mkdirSync(MANIFEST_DIR, { recursive: true });
  if (fs.existsSync(mf)) {
    const now = new Date();
    try { fs.utimesSync(mf, now, now); } catch {}
  }

  const ti = payload.tool_input || {};
  const filePath = ti.file_path || ti.notebook_path || '';
  if (!filePath) return;

  const repoReal = realpathSafe(REPO);
  // realpath the PARENT (it exists even when the file doesn't yet — e.g. symlinked
  // /var -> /private/var temp dirs) and rejoin the basename.
  const resolvedRaw = path.resolve(filePath);
  const resolved = path.join(realpathSafe(path.dirname(resolvedRaw)), path.basename(resolvedRaw));
  if (resolved !== repoReal && !resolved.startsWith(repoReal + path.sep)) return; // outside repo
  const rel = path.relative(repoReal, resolved);
  if (!rel || rel.startsWith('.git' + path.sep) || rel === '.git') return;
  const manifestDirReal = realpathSafe(MANIFEST_DIR);
  if (resolved.startsWith(manifestDirReal + path.sep)) return; // never self-track

  // O_APPEND single-line write; dedupe happens at read time (sort -u semantics).
  fs.appendFileSync(mf, rel + '\n');
}

// --- porcelain snapshot ----------------------------------------------------

// ONE `git status --porcelain -z -uall` snapshot -> Map(repoRelPath -> XY status).
// -z: NUL-separated, no C-quoting (exotic paths safe). -uall: individual files
// inside new untracked directories (default aggregates to `?? dir/`, which would
// never match a manifest's file entries). Rename/copy entries carry a second
// NUL field (origin path) — both sides are dirty state.
function dirtySnapshot() {
  const out = git(['status', '--porcelain', '-z', '-uall']);
  const dirty = new Map();
  // One path can appear TWICE (e.g. `git rm --cached` + file still on disk =>
  // `D ` staged deletion AND `?? ` untracked recreation). A blind overwrite
  // erases the deletion signal the resurrection guard depends on — merge so a
  // 'D' index state survives ('D ' + '??' => 'D?').
  const setDirty = (p, xy) => {
    const prev = dirty.get(p);
    if (prev && (prev[0] === 'D' || xy[0] === 'D')) {
      dirty.set(p, 'D' + (xy[1] !== ' ' ? xy[1] : prev[1]));
    } else {
      dirty.set(p, xy);
    }
  };
  const fields = out.split('\0').filter(f => f.length > 0);
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    if (f.length < 4 || f[2] !== ' ') continue; // defensive: not an XY entry
    const xy = f.slice(0, 2);
    setDirty(f.slice(3), xy);
    if (xy[0] === 'R' || xy[0] === 'C') {
      const orig = fields[++i]; // origin path travels as the next NUL field
      // Rename origin's deletion is STAGED (index-side), so key it 'D ' not ' D':
      // 'D ' makes claim/stage skip `git add` (which fatals — origin is in neither
      // worktree nor index) and puts the resurrection guard on the correct branch.
      // First-live-rename catch, S47 (git mv skills/<slug> skills/.archived-<slug>).
      if (orig) setDirty(orig, xy[0] === 'R' ? 'D ' : xy);
    }
  }
  // Never surface our own bookkeeping as stageable/leftover state (production
  // gitignores the dir; ad-hoc/test repos may not — filter structurally).
  const mdRel = path.relative(realpathSafe(REPO), realpathSafe(MANIFEST_DIR));
  if (mdRel && !mdRel.startsWith('..')) {
    for (const k of dirty.keys()) {
      if (k === mdRel || k === mdRel + '/' || k.startsWith(mdRel + '/')) dirty.delete(k);
    }
  }
  return dirty;
}

function gitAddChunked(paths) {
  for (let i = 0; i < paths.length; i += 200) {
    git(['add', '--', ...paths.slice(i, i + 200)]);
  }
}

// --- stage -----------------------------------------------------------------

function stage() {
  const sid = sessionId(null);
  if (!sid) throw new Error('no CLAUDE_CODE_SESSION_ID — cannot identify own manifest');
  fs.mkdirSync(MANIFEST_DIR, { recursive: true });

  const mine = [...new Set(readLines(manifestPath(sid)))].sort();
  const dirty = dirtySnapshot();

  const staged = mine.filter(p => dirty.has(p));
  const leftovers = [...dirty.keys()].filter(p => !staged.includes(p)).sort();

  // Sibling manifests -> path -> {freshest owner, isFresh}
  const now = Date.now();
  const siblings = []; // {sid, file, fresh, paths}
  for (const entry of safeReaddir(MANIFEST_DIR)) {
    if (entry === path.basename(LEDGER) || entry.endsWith('.commit-pathspec') || entry === sid) continue;
    const file = path.join(MANIFEST_DIR, entry);
    let st; try { st = fs.statSync(file); } catch { continue; }
    if (!st.isFile()) continue;
    siblings.push({ sid: entry, file, fresh: now - st.mtimeMs < FRESH_MS, paths: new Set(readLines(file)) });
  }

  // First-seen ledger for unclaimed leftovers.
  let ledger = {};
  try { ledger = JSON.parse(fs.readFileSync(LEDGER, 'utf8')) || {}; } catch {}

  const adopted = [];       // {path, why}
  const annotated = [];     // report lines for leftovers
  const staleToGC = new Set();

  for (const p of leftovers) {
    const xy = dirty.get(p);
    const freshOwners = siblings.filter(s => s.fresh && s.paths.has(p));
    const staleOwners = siblings.filter(s => !s.fresh && s.paths.has(p));
    if (freshOwners.length > 0) {
      annotated.push(`  ${xy} ${p} — claimed by live session ${freshOwners.map(s => shortId(s.sid)).join(', ')} (LEAVE)`);
    } else if (staleOwners.length > 0) {
      adopted.push({ path: p, why: `owner ${staleOwners.map(s => shortId(s.sid)).join(', ')} dead (manifest stale >${Math.round(FRESH_MS / 3600000)}h)` });
      annotated.push(`  ${xy} ${p} — ORPHAN-ADOPTED (${adopted[adopted.length - 1].why})`);
      staleOwners.forEach(s => staleToGC.add(s.file));
    } else if (ledger[p] && now - ledger[p] > ORPHAN_MS) {
      adopted.push({ path: p, why: `unclaimed + dirty for ${(now - ledger[p]) / 86400000 | 0}d (>${ORPHAN_MS / 86400000 | 0}d valve)` });
      annotated.push(`  ${xy} ${p} — ORPHAN-ADOPTED (${adopted[adopted.length - 1].why})`);
    } else {
      if (!ledger[p]) ledger[p] = now;
      const days = ((now - ledger[p]) / 86400000).toFixed(1);
      annotated.push(`  ${xy} ${p} — unclaimed; first seen ${days}d ago (adopts at ${ORPHAN_MS / 86400000 | 0}d) (LEAVE unless yours)`);
    }
  }

  // Ledger hygiene: drop entries no longer dirty or now claimed/adopted.
  const stillUnclaimed = new Set(leftovers.filter(p =>
    !siblings.some(s => s.paths.has(p)) && !adopted.some(a => a.path === p)));
  for (const k of Object.keys(ledger)) if (!stillUnclaimed.has(k)) delete ledger[k];
  fs.writeFileSync(LEDGER, JSON.stringify(ledger, null, 1));

  const toStage = [...staged, ...adopted.map(a => a.path)];
  // Index-side deletions (XY 'D…', e.g. after `git rm --cached`) have nothing for
  // `git add` to match — it would fatal. They're already staged; they only need
  // pathspec membership. Add only the rest.
  const needAdd = toStage.filter(p => (dirty.get(p) || ' ')[0] !== 'D');
  if (needAdd.length > 0) gitAddChunked(needAdd);
  // Pathspec commits record WORKING-TREE state: a staged deletion whose path has
  // been RECREATED on disk (e.g. the wrap mutex's own owner file, which exists
  // whenever the lock is held) would be committed as CONTENT — silently
  // resurrecting the file (bit the very first live wrap, commit 75517c7).
  // Exclude such paths; the deletion commits cleanly on a later stage once the
  // path is truly absent (self-healing). Same caveat applies to `claim` — but
  // claims are manual and reviewed; stage is the systematic path.
  const resurrected = toStage.filter(p =>
    (dirty.get(p) || ' ')[0] === 'D' && fs.existsSync(path.join(REPO, p)));
  const commitSet = toStage.filter(p => !resurrected.includes(p));
  fs.writeFileSync(pathspecPath(sid), commitSet.length ? commitSet.join('\n') + '\n' : '');
  for (const f of staleToGC) { try { fs.rmSync(f); } catch {} }

  // ---- report ----
  const W = process.stdout.write.bind(process.stdout);
  W(`[session-manifest] session ${shortId(sid)} | manifest: ${mine.length} paths | dirty: ${dirty.size} | staged: ${commitSet.length} (${adopted.length} adopted)\n`);
  if (resurrected.length) {
    // Partition by ignore status. A LOCK-OWNER-class path (not gitignored) self-heals:
    // its deletion commits once the path is truly absent. A GITIGNORED-but-kept path
    // (`git rm --cached`, file intentionally on disk forever) can NEVER commit its
    // untracking through this pathspec flow — git refuses to stage a gitignored path
    // (empirically confirmed S50), so the old "will commit once absent" WARN LIED for it.
    // The staged-deletion state is what lets check-ignore tell them apart: once `rm
    // --cached` runs, a gitignored path leaves the index and check-ignore reports rc 0.
    // rc 0 = ignored, 1 = not, 128 = fatal → fatal defaults to the self-heal message.
    const ignoredKept = resurrected.filter(p => {
      try { git(['check-ignore', '-q', '--', p]); return true; } catch { return false; }
    });
    const lockOwner = resurrected.filter(p => !ignoredKept.includes(p));
    if (lockOwner.length) {
      process.stderr.write(
        `[session-manifest] WARN: ${lockOwner.length} staged-deletion path(s) RECREATED on disk — ` +
        `excluded from this commit's pathspec (a pathspec commit records working-tree state and would resurrect them): ` +
        `${lockOwner.join(', ')}. The deletion will commit once the path is truly absent.\n`);
    }
    if (ignoredKept.length) {
      process.stderr.write(
        `[session-manifest] WARN: ${ignoredKept.length} gitignored-but-kept path(s) carry a staged untracking ` +
        `(a \`git rm --cached\` that already ran) which this pathspec commit will NEVER record — git refuses to ` +
        `stage a gitignored path (S50): ${ignoredKept.join(', ')}. The untracking is ALREADY staged in the index; ` +
        `do NOT re-run \`git rm --cached\` (it fatals — the path is already out of the index) and a path-scoped ` +
        `commit is a no-op for a gitignored path. To record it, commit the index directly with a plain whole-index ` +
        `commit, after confirming \`git -C ${REPO} status\` shows only changes you intend: ` +
        `git -C ${REPO} commit -m "untrack gitignored files".\n`);
    }
  }
  if (mine.length === 0 && dirty.size > 0) {
    process.stderr.write(
      `\n══ SESSION-MANIFEST WARN: manifest is EMPTY but the repo has ${dirty.size} dirty paths ══\n` +
      `   Either this session truly wrote nothing to ~/.claude, or the record hook is DEAD\n` +
      `   (precedent: six hooks sat silently dead on CLAUDE_TOOL_INPUT). If you edited\n` +
      `   ~/.claude files this session, claim them explicitly (\`claim <path>\`) and check\n` +
      `   the PostToolUse registration before trusting the next wrap.\n` +
      `══════════════════════════════════════════════════════════════════════\n`);
  }
  if (commitSet.length) W(`staged for THIS session's commit:\n${commitSet.map(p => `  ${dirty.get(p) || '??'} ${p}`).join('\n')}\n`);
  if (annotated.length) W(`leftovers — DEFAULT IS LEAVE; claim only with specific evidence it's yours (Bash-created file or your rm):\n${annotated.join('\n')}\n`);
  if (adopted.length) W(`ORPHAN-ADOPTED (name these in the commit message): ${adopted.map(a => a.path).join(', ')}\n`);
  W(`commit with: git -C ${REPO} commit --pathspec-from-file="${pathspecPath(sid)}" -m "..."\n`);
}

function safeReaddir(dir) {
  try { return fs.readdirSync(dir); } catch { return []; }
}

// --- claim -----------------------------------------------------------------

function claim(args) {
  const sid = sessionId(null);
  if (!sid) throw new Error('no CLAUDE_CODE_SESSION_ID');
  if (!args.length) throw new Error('claim: no paths given');
  const repoReal = realpathSafe(REPO);
  const rels = args.map(a => {
    const abs = path.isAbsolute(a) ? a : path.join(repoReal, a);
    const rel = path.relative(repoReal, path.resolve(abs));
    if (rel.startsWith('..')) throw new Error(`claim: ${a} is outside the repo`);
    return rel;
  });
  // Deletions already staged in the index (XY 'D…', e.g. after `git rm --cached`)
  // have nothing on disk NOR in the index for `git add` to match — it would fatal.
  // They only need manifest/pathspec membership; skip the add for exactly those.
  const dirty = dirtySnapshot();
  const toAdd = rels.filter(p => !(dirty.has(p) && dirty.get(p)[0] === 'D'));
  if (toAdd.length) gitAddChunked(toAdd);
  fs.mkdirSync(MANIFEST_DIR, { recursive: true });
  fs.appendFileSync(manifestPath(sid), rels.join('\n') + '\n');
  fs.appendFileSync(pathspecPath(sid), rels.join('\n') + '\n');
  process.stdout.write(`[session-manifest] claimed: ${rels.join(', ')}\n`);
}

// --- prune -----------------------------------------------------------------

function prune() {
  const sid = sessionId(null);
  if (!sid) throw new Error('no CLAUDE_CODE_SESSION_ID');
  const mf = manifestPath(sid);
  const mine = [...new Set(readLines(mf))];
  if (mine.length) {
    const dirty = dirtySnapshot();
    const keep = mine.filter(p => dirty.has(p)); // committed entries drop; mid-wrap appends survive
    if (keep.length) fs.writeFileSync(mf, keep.sort().join('\n') + '\n');
    else { try { fs.rmSync(mf); } catch {} }
  }
  try { fs.rmSync(pathspecPath(sid)); } catch {}
  process.stdout.write(`[session-manifest] pruned (kept ${Math.max(0, readLines(mf).length)} still-dirty entries)\n`);
}
