#!/usr/bin/env node
// UserPromptSubmit: when the owner questions a claim or recommendation, remind Claude to
// check before agreeing. Why: automate-me 2026-10-24 — 17 of 27 "you're right" replies
// (10-12..10-24, 4 projects) came with zero tool calls; owner called the flip-flopping out
// twice. The [redacted] memory (live-is-the-floor, 10-17) did not reach other projects.
'use strict';
const RE = /\b(are you sure|have you (really |actually )?(checked|confirmed|verified|tested)|why (are|did|do|would) you|why do (we|you) need|why should we|help me understand why|is(n'?t| not) (it|that|this)|should(n'?t| not) (we|it)|would(n'?t| not) (we|it))\b|,\s*right\s*\?/i;
let raw = '';
process.stdin.on('data', d => { raw += d; }).on('end', () => {
  try {
    const prompt = String(JSON.parse(raw).prompt || '').replace(/<pasted_content[\s\S]*?<\/pasted_content>/g, '');
    if (!RE.test(prompt) || process.env.CLAUDE_CHALLENGE_QUIET === '1') process.exit(0);
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit',
      additionalContext: 'The owner is questioning a claim or recommendation. A question is not a ruling. ' +
        'Before agreeing or withdrawing, re-check it (read the file, run the count, compare the text). ' +
        'Then answer in this order: what you still stand by and why; what the check changed, with the evidence; the decision. ' +
        'Open with "You\'re right" only when the check proved it. If it is his business preference, say so and follow it.' } }));
  } catch { /* never block a prompt */ }
  process.exit(0);
});
