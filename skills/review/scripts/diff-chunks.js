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

// THE diff surface — writer, gate, and /review must hash/classify identical
// bytes, so the command lives here, once. Pins (S256 review, 5 reviewers):
// --no-ext-diff + prefix configs, else external diff drivers / diff.noprefix
// emit headerless output that chunks() cannot split (fail-open hole).
// errored=true means git failed WITH a HEAD present (ENOBUFS >64MB, index.lock,
// corrupt repo) — callers MUST fail toward review; only a fresh repo (no HEAD)
// legitimately returns an empty diff.
function gitDiff(repo) {
  const args = ['-C', repo, '-c', 'diff.noprefix=false', '-c', 'diff.mnemonicPrefix=false',
    'diff', '--no-ext-diff', 'HEAD'];
  try {
    return { errored: false, diff: execFileSync('git', args,
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: MAX_DIFF_BUFFER }) };
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

module.exports = { chunks, fileHashes, fileHashesFrom, flagPath, gitDiff, MAX_DIFF_BUFFER };
