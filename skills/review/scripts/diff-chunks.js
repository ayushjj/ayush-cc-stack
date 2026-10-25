'use strict';
// Shared per-file diff chunking + hashing for the /review delta contract (S256).
// P51 PAIRED CONTRACT: write-review-flag.js (writer) and check-review-gate.js
// (reader) BOTH derive per-file hashes through THIS module — one ruler, no drift.
// Contract row: governance.md "Skill-coupling contracts".
//
// Chunk key = the raw `diff --git a/... b/...` header line. No path parsing:
// the key is unique per file within one `git diff HEAD`, and anything that
// changes the header (rename, quoting, mode) changes the key, which fails
// toward "new, unreviewed" — i.e. toward review (P72 asymmetry).
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const MAX_DIFF_BUFFER = 64 * 1024 * 1024;

// The default branch's ref (S81 review round). Order: review.base (when accepted,
// see configuredBase), then origin/HEAD only when it RESOLVES (a dangling symref to a
// pruned branch used to skip every fallback and diff the whole repo), then
// origin/main, origin/master, then any other remote's HEAD.
// null = no default branch known (no remote, or none fetched).
function defaultRef(repo, tip) {
  return configuredBase(repo, tip || 'HEAD') || plainDefaultRef(repo);
}

function plainDefaultRef(repo) {
  const git = gitIn(repo);
  const resolves = r => { try { git(['rev-parse', '-q', '--verify', r + '^{commit}']); return true; } catch { return false; } };
  const cands = [];
  try { cands.push(git(['symbolic-ref', '-q', 'refs/remotes/origin/HEAD'])); } catch {}
  cands.push('refs/remotes/origin/main', 'refs/remotes/origin/master');
  try {
    for (const r of git(['for-each-ref', '--format=%(symref)', 'refs/remotes/*/HEAD']).split('\n')) {
      if (r) cands.push(r);
    }
  } catch {}
  return cands.find(resolves) || null;
}

// `git config review.base <ref>` names the branch PRs here merge into when it is not
// the default branch ([redacted], 2026-10-07: PRs target a release branch
// while origin/HEAD is master, so the gate counted that branch's whole divergence as
// unreviewed). The repo's .git/config is shared by every worktree.
// FAIL CLOSED: the base decides what the gate sees, so a base on `tip`'s own line
// shrinks the surface to the unpushed commits, or to nothing. Accepted only as
// refs/remotes/<a configured remote>/<name>, <name> not HEAD, not the checked-out
// branch, and no local branch <name> containing `tip` (the tip's own remote copy,
// whichever worktree pushes it). The upstream is NOT rejected: `checkout -b feat
// origin/<base>` tracks the base by default, and that is the case this exists for.
// Anything else returns null and the default order applies (a WIDER surface).
function configuredBase(repo, tip) {
  const git = gitIn(repo);
  try {
    const want = git(['config', '--get', 'review.base']);
    if (!want || want.startsWith('-') || want.includes('\n')) return null;
    const full = git(['rev-parse', '--symbolic-full-name', want]);
    const remote = git(['remote']).split('\n').filter(Boolean)
      .filter(r => full.startsWith(`refs/remotes/${r}/`))
      .sort((x, y) => y.length - x.length)[0];       // longest: a remote may contain '/'
    if (!remote) return null;
    const name = full.slice(`refs/remotes/${remote}/`.length).toLowerCase();  // case-insensitive FS
    if (!name || name === 'head') return null;
    let cur = null;
    try { cur = git(['symbolic-ref', '-q', '--short', 'HEAD']).toLowerCase(); } catch {}
    if (name === cur) return null;
    const own = git(['for-each-ref', '--contains', tip, '--format=%(refname:lstrip=2)', 'refs/heads/'])
      .split('\n').map(b => b.toLowerCase());
    if (own.includes(name)) return null;
    git(['rev-parse', '-q', '--verify', full + '^{commit}']);
    return full;
  } catch { return null; }
}

function gitIn(repo) {
  return a => execFileSync('git', ['-C', repo, ...a],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

// Where `tip` (default HEAD) left the default branch: what a push of `tip` sends
// starts here. null = no default branch, or no merge-base (unrelated history /
// shallow clone) — callers decide: the writer and --delta fall back to HEAD (the
// pre-S81 uncommitted-only surface), the gate blocks with a named reason. Never the
// empty tree: a whole-repo diff overflows the buffer on a large repo, and its id
// differs in sha256 repos.
// A configured base that already contains `tip` (merge-base == tip, an empty
// surface) is dropped for the default order — a WIDER surface.
function branchBase(repo, tip) {
  const git = gitIn(repo);
  const at = tip || 'HEAD';
  const mergeBase = ref => { try { return git(['merge-base', at, ref]) || null; } catch { return null; } };
  const cfg = configuredBase(repo, at);
  if (cfg) {
    const b = mergeBase(cfg);
    let t = null;
    try { t = git(['rev-parse', at + '^{commit}']); } catch {}
    if (b && b !== t) return b;
  }
  const plain = plainDefaultRef(repo);
  return plain ? mergeBase(plain) : null;
}

// Untracked, non-ignored files rendered as new-file diffs — same `diff --git a/p b/p`
// header a staged new file gets. The gate adds these only for a cell that runs
// `git add` before its commit+push (that add will sweep them into the push).
// Over 500 files → errored (fail toward review), not a 500-process stall.
function untrackedDiff(repo) {
  const files = execFileSync('git', ['-C', repo, 'ls-files', '--others', '--exclude-standard', '-z'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: MAX_DIFF_BUFFER })
    .split('\0').filter(Boolean);
  if (files.length > 500) throw new Error('too many untracked files');
  let out = '';
  for (const f of files) {
    try {
      out += execFileSync('git', ['-C', repo, '-c', 'diff.noprefix=false', '-c', 'diff.mnemonicPrefix=false',
        'diff', '--no-ext-diff', '--no-index', '--', '/dev/null', f],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: MAX_DIFF_BUFFER });
    } catch (e) {
      if (e.status === 1 && typeof e.stdout === 'string') out += e.stdout; // 1 = "differs"
      else throw e;
    }
  }
  return out;
}

// THE diff surface — writer, gate, and /review must hash/classify identical
// bytes, so the command lives here, once. Pins (S256 review, 5 reviewers):
// --no-ext-diff + prefix configs, else external diff drivers / diff.noprefix
// emit headerless output that chunks() cannot split (fail-open hole).
// errored=true means git failed WITH a HEAD present (ENOBUFS >64MB, index.lock,
// corrupt repo) — callers MUST fail toward review; only a fresh repo (no HEAD)
// legitimately returns an empty diff.
//
// Surfaces (S81):
//   default            branchBase → working tree. /review --delta and the flag
//                      writer. No base → `git diff HEAD` (pre-S81 surface).
//   {to: <commit>}     branchBase(to) → to. What a push of that ref sends (gate).
//                      No base → {noBase: true}; the gate blocks on it.
//   {requireBase: true} default surface, but no base → {noBase: true} (gate,
//                      commit+push cells: the commit is still in the worktree).
//   {untracked: true}  also append untracked files (gate, add+commit+push cells).
// With a clean tree, default and {to: 'HEAD'} are byte-identical, so a review of
// uncommitted work still covers it once committed; work left uncommitted at push
// time is not part of the push.
function gitDiff(repo, opts) {
  const to = opts && opts.to;
  let base = null;
  try { base = branchBase(repo, to || 'HEAD'); } catch {}
  if (!base && (to || (opts && opts.requireBase))) return { errored: false, noBase: true, diff: '' };
  const args = ['-C', repo, '-c', 'diff.noprefix=false', '-c', 'diff.mnemonicPrefix=false',
    'diff', '--no-ext-diff', base || 'HEAD', ...(to ? [to] : [])];
  try {
    let diff = execFileSync('git', args,
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: MAX_DIFF_BUFFER });
    if (opts && opts.untracked) diff += untrackedDiff(repo);
    return { errored: false, diff };
  } catch {
    try {
      execFileSync('git', ['-C', repo, 'rev-parse', '--verify', 'HEAD'],
        { stdio: ['ignore', 'ignore', 'ignore'] });
      return { errored: true, diff: '' };      // HEAD exists → real git error
    } catch { return { errored: false, diff: '' }; }  // no HEAD → fresh repo
  }
}

// Split a unified diff into per-file chunks [{key, text}]. Text includes the
// header line. Trailing newlines are normalized to exactly one so a chunk
// hashes identically whether or not it is the LAST file in the diff (the
// split's trailing empty element otherwise lands only on the final chunk,
// making the same unchanged file read as "changed" once a later-sorted file
// joins the diff — caught by the canary's docs-only-addition case).
function chunks(diffText) {
  const out = [];
  let cur = null;
  for (const line of diffText.split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) {
      cur = { key: line, lines: [] };
      out.push(cur);
    }
    if (cur) cur.lines.push(line);
  }
  return out.map(c => ({ key: c.key, text: c.lines.join('\n').replace(/\n+$/, '') + '\n' }));
}

// { "<header line>": sha256(chunk text) } — from an already-chunked array so
// callers holding the chunks never re-parse the whole diff (it can be 64MB).
function fileHashesFrom(chunkArr) {
  const map = {};
  for (const c of chunkArr) {
    map[c.key] = crypto.createHash('sha256').update(c.text).digest('hex');
  }
  return map;
}
function fileHashes(diffText) { return fileHashesFrom(chunks(diffText)); }

// Per-repo flag path: $TMPDIR/.claude-review-done-<sha256(realpath)[0:12]>.
// Per-repo (S256) so a /review in another repo/session never clobbers this
// repo's flag — the S255 wrap was blocked by exactly that cross-repo clobber.
// Caller passes the repo's REALPATH (fs.realpathSync) so macOS /var vs
// /private/var symlinks hash identically on both sides.
function flagPath(repoRealpath) {
  const h = crypto.createHash('sha256').update(repoRealpath).digest('hex').slice(0, 12);
  return path.join(os.tmpdir(), '.claude-review-done-' + h);
}

module.exports = { branchBase, defaultRef, plainDefaultRef, chunks, fileHashes, fileHashesFrom, flagPath, gitDiff, MAX_DIFF_BUFFER };
