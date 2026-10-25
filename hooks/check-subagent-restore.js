#!/usr/bin/env node
// PreToolUse hook: blocks SUBAGENTS from git commands that discard uncommitted work.
//
// Why (S69, feedback_commit_before_subagent_fanout.md): a subagent told "read-only" ran
// `git checkout -- …` and destroyed ~2h of the main session's uncommitted edits. "An
// instruction not to modify is not an enforcement mechanism." /careful's
// check-destructive.js only runs in careful mode and misses `checkout --`.
//
// Blocks (subagent only): checkout -- <path> / checkout . / checkout -f, restore (worktree),
// stash (push/save/drop/clear/bare), clean -f, reset --hard, switch -f/--discard-changes.
// Allows: branch work (checkout -b, checkout <branch>), restore --staged, stash list/show/
// pop/apply, soft/mixed reset, and EVERY main-session call (the owner's own session decides).
// Test: bash ~/.claude/hooks/check-subagent-restore.test.sh
//
// Always-on guard: an unloadable reader fails OPEN, loudly (same as check-cd-persistence).
let command, hookLib;
try {
  hookLib = require('./lib/hook-input.js');
  command = hookLib.readToolCommand();
} catch (err) {
  process.stderr.write(`subagent-restore guard DISABLED: ${err.message}\n`);
  process.exit(0);
}
if (!command || !hookLib.isSubagentCall()) process.exit(0);

// Quoted text is data, not a command — EXCEPT where the shell runs it: `…`, $(…), and the
// string handed to sh -c / bash -c / eval (security review 2026-10-12 found those bypasses).
// For those, scan the raw command too, with quote characters removed.
//
// Heredocs (hook-review 2026-10-15). stripQuotedRegions blanks from the FIRST `<<` to the
// END of the command — right for override detection (fail-closed there), fail-OPEN for a
// detector: `bash <<EOF⏎git checkout -- x`, `cat <<EOF | sh`, and any real command AFTER a
// prose heredoc all passed. Meanwhile 11 of 40 live fires (10-01..10-15) were report prose
// (`cat >> notes.md <<'EOF' … blocked \`git checkout -- Gemfile.lock\` …`), caught only by
// the backtick raw view. So: blank a heredoc BODY only when it is data, then neutralise the
// `<<` markers so stripQuotedRegions handles quotes alone. A body stays scannable when a
// shell runs it, or when an unquoted delimiter lets it substitute `$(…)`/backticks.
// blankHeredocBodies returns the command unchanged when it cannot parse the heredoc, so an
// unparseable shape is scanned in full (fail-closed).
const SHELL = '(?:ba|z|da|k)?sh|eval|source';
const bodyRuns = new RegExp(`(?:^|[\\s;&|(])(?:${SHELL})\\b[^\\n]*<<|<<[^\\n]*\\|\\s*(?:${SHELL})\\b`).test(command)
  || (/<<-?\s*[A-Za-z_\\]/.test(command) && /\$\(|`/.test(command));
const base = (bodyRuns ? command : hookLib.blankHeredocBodies(command)).replace(/<<-?/g, '   ');
const views = [hookLib.stripQuotedRegions(base)];
// An ESCAPED backtick (\`) is a literal, not command substitution.
if (/(?:^|[^\\])`|\$\(|\b(?:ba|z|da|k)?sh\s+-c\b|\beval\b/.test(base)) views.push(base.replace(/\\`/g, '  ').replace(/["'`]/g, ' '));
const segs = views.flatMap(v => v.split(/&&|\|\||[;&|\n(){}`]/)); // grouping chars end a segment too
const hits = [];
for (const seg of segs) {
  const m = /(?:^|[\s/])git((?:\s+-[Cc]\s+\S+|\s+--[a-z-]+(?:=\S+)?)*)\s+([a-z-]+)(.*)$/.exec(seg); // also /usr/bin/git, global --options
  if (!m) continue;
  const sub = m[2];
  const args = ` ${m[3].trim()} `;
  let bad = false;
  if (sub === 'checkout') bad = /\s--(\s|$)/.test(args) || /\s\.\s/.test(args) || /\s(-f|--force)\s/.test(args);
  else if (sub === 'restore') bad = !/\s(-S|--staged)\s/.test(args) || /\s(-W|--worktree)\s/.test(args);
  else if (sub === 'stash') bad = !/^\s*(list|show|pop|apply|branch)\s/.test(args);
  else if (sub === 'clean') bad = /\s-[a-zA-Z]*f/.test(args) || /\s--force\s/.test(args);
  else if (sub === 'reset') bad = /\s--hard\s/.test(args) || /\s--merge\s/.test(args);
  else if (sub === 'switch') bad = /\s(-f|--force|--discard-changes)\s/.test(args);
  if (bad && !hits.includes(`git ${sub}${args.trimEnd()}`)) hits.push(`git ${sub}${args.trimEnd()}`);
}
if (!hits.length) process.exit(0);

process.stderr.write([
  'BLOCKED: a helper agent may not discard uncommitted work.',
  `   Command: ${hits.join(' ; ')}`,
  '   The main session may have unsaved edits in this folder (S69: ~2h lost this way).',
  '   Report what you would discard and why; the main session decides.',
].join('\n') + '\n');
process.exit(2);
