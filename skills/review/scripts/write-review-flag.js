#!/usr/bin/env node
'use strict';
// Writes the /review gate flag. Called by review/SKILL.md Step 8 — replaces the
// old bash `shasum` recipe so writer and reader (check-review-gate.js) share the
// SAME chunking/hashing code via diff-chunks.js (P51 paired contract; row in
// governance.md "Skill-coupling contracts").
//
// Flag JSON: {repo, verdict, ts, fileHashes} at a PER-REPO path
// ($TMPDIR/.claude-review-done-<sha256(repo)[0:12]>). fileHashes maps each
// `diff --git` header line of `git diff HEAD` to the sha256 of its chunk —
// the gate later blocks only on chunks that are new/changed AND classify as
// code (delta-aware, S256). Write this AFTER applying review findings, so the
// flag covers the post-apply diff and applying findings never invalidates the
// review that produced them.
//
// Usage: node write-review-flag.js --verdict PASS|REVISE [--repo <path>]
const fs = require('fs');
const { execFileSync } = require('child_process');
const { fileHashes, flagPath, gitDiff } = require('./diff-chunks.js');

const argv = process.argv;
const get = f => { const i = argv.indexOf(f); return i !== -1 ? argv[i + 1] : undefined; };

const verdict = get('--verdict');
if (verdict !== 'PASS' && verdict !== 'REVISE') {
  process.stderr.write('usage: write-review-flag.js --verdict PASS|REVISE [--repo <path>]\n');
  process.exit(1);
}

let repo;
try {
  repo = execFileSync('git', ['-C', get('--repo') || process.cwd(), 'rev-parse', '--show-toplevel'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  repo = fs.realpathSync(repo);
} catch {
  process.stderr.write('write-review-flag: not a git repo\n');
  process.exit(1);
}

// Shared gitDiff (one ruler with the gate — pinned flags, error semantics).
// Fresh repo (no HEAD) → empty diff on both sides — consistent. A REAL git
// error must not silently produce an empty-coverage flag: abort instead.
const { diff, errored } = gitDiff(repo);
if (errored) {
  process.stderr.write('write-review-flag: `git diff` failed — no flag written (fail toward review)\n');
  process.exit(1);
}

const hashes = fileHashes(diff);
const out = flagPath(repo);
fs.writeFileSync(out, JSON.stringify({
  repo, verdict, ts: new Date().toISOString(), fileHashes: hashes,
}) + '\n');
process.stdout.write('review flag: ' + verdict + ' for ' + repo +
  ' (' + Object.keys(hashes).length + ' reviewed file chunks)\n');
