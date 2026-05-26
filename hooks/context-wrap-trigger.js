#!/usr/bin/env node
// UserPromptSubmit hook: surface context-consumption thresholds and force the
// wrap-trigger to be a runtime gate rather than an attention-based nudge.
//
// Why this exists (context-overflow incident, 2026-05-04): the "trigger /wrapping-session
// at 40% consumed" rule lived only as CLAUDE.md text, so it depended on Claude
// noticing the threshold and proactively suggesting wrap. P57 directly warns
// this fails silently. In the original incident the suggestion never fired; the wrap was
// initiated cold from a much higher consumption point and ran past the
// context budget — at which point /compact was blocked by the wrap-marker
// hook (correctly!) but the user couldn't escape because the agent itself
// was already context-exhausted and could not process commands.
//
// Root-cause fix: read the *actual* prompt-side token count from the latest
// assistant turn in the transcript JSONL (same number Claude Code's status
// bar reads), and inject a system-reminder when consumption crosses
// thresholds. This converts the attention-based gate into a deterministic
// runtime gate — same architectural pattern as the wrap-marker hook itself.
//
// Thresholds (calibrated to the empirical wrap budget of 8-17%):
//   35% consumed  →  soft nudge (suggest wrap proactively)
//   45% consumed  →  hard reminder (mandatory wrap before further work)
//   60% consumed  →  emergency (wrap may not fit; recommend tight wrap)
//
// Hook behavior:
//   - Skips if no transcript yet (first turn of session).
//   - Skips if wrap-marker present (don't nudge during an in-flight wrap).
//   - Skips if CLAUDE_CONTEXT_GATE_QUIET=1 (escape valve for explicit override).
//   - Reads usage from `message.usage.{input_tokens, cache_read_input_tokens,
//     cache_creation_input_tokens}` of the most recent assistant message.
//   - Sums to total prompt-side context (matches the status-bar metric).
//   - Compares against 1M context window (Opus 4.7 [1m]); the 1M floor is
//     a conservative default since smaller-window models would trigger sooner
//     in absolute-token terms (which is correct: smaller window = wrap sooner).
//   - Returns JSON {additionalContext: "..."} on stdout; never sets `decision`
//     (a hard block on UserPromptSubmit could trap the user the same way the
//     wrap-marker hook deadlocked the prior incident — fail SOFT, trust the agent to
//     act on the system-reminder).
//   - Fails closed (any internal error → exit 0, no injection, no block).
//     Same guarantee as memory-size-gate.js + check-freeze.js.

const fs = require('node:fs');
const path = require('node:path');

const CONTEXT_WINDOW_TOKENS = 1_000_000;  // Opus 4.7 [1m] default

const SOFT_THRESHOLD = 0.35;
const HARD_THRESHOLD = 0.45;
const EMERGENCY_THRESHOLD = 0.60;

function failSilent() {
  process.exit(0);
}

try {
  if (process.env.CLAUDE_CONTEXT_GATE_QUIET === '1') {
    failSilent();
  }

  // Read JSON payload from stdin (UserPromptSubmit convention)
  let raw = '';
  try {
    raw = fs.readFileSync(0, 'utf8');
  } catch {
    failSilent();
  }
  if (!raw.trim()) failSilent();

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    failSilent();
  }

  const transcriptPath = payload.transcript_path;
  const cwd = payload.cwd || process.cwd();

  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    failSilent();  // first turn — nothing to read yet
  }

  // If a wrap is in progress, don't nudge — wrap-marker hook handles it.
  const wrapSlug = cwd.replace(/\//g, '-');
  const wrapMarker = path.join(
    process.env.HOME || '',
    '.claude',
    `.wrap-in-progress${wrapSlug}`
  );
  if (fs.existsSync(wrapMarker)) {
    failSilent();
  }

  // Walk transcript backwards to find the LATEST assistant message with usage.
  // Tail-read pattern: read the file, split, scan from the end. For very large
  // transcripts this is still cheap (the JSONL is line-oriented and fits in
  // memory on any developer machine).
  let consumed = 0;
  let foundUsage = false;
  try {
    const text = fs.readFileSync(transcriptPath, 'utf8');
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      const usage = (msg.message && msg.message.usage) || msg.usage;
      if (!usage) continue;
      const input = Number(usage.input_tokens) || 0;
      const cacheRead = Number(usage.cache_read_input_tokens) || 0;
      const cacheCreate = Number(usage.cache_creation_input_tokens) || 0;
      consumed = input + cacheRead + cacheCreate;
      if (consumed > 0) {
        foundUsage = true;
        break;
      }
    }
  } catch {
    failSilent();  // can't read transcript → silent
  }

  if (!foundUsage) failSilent();

  const ratio = consumed / CONTEXT_WINDOW_TOKENS;
  const consumedPct = (ratio * 100).toFixed(1);
  const remainingPct = ((1 - ratio) * 100).toFixed(1);
  const consumedK = Math.round(consumed / 1000);

  if (ratio < SOFT_THRESHOLD) {
    failSilent();  // healthy — no injection
  }

  let band, body;
  if (ratio >= EMERGENCY_THRESHOLD) {
    band = 'EMERGENCY';
    body =
      `EMERGENCY: context consumption is past the safe-wrap threshold. The full ` +
      `wrap-skill (8-17% budget) may NOT fit in the remaining ${remainingPct}%. ` +
      `If a wrap has not started yet: invoke /wrapping-session immediately and ` +
      `compress aggressively — write only the singleton-required updates ` +
      `(MEMORY.md Current State, session-registry entry, one commit) and skip ` +
      `the full implementation.md/decisions.md/learnings narrative. The risk: ` +
      `if context exhausts mid-wrap, the wrap-marker hook will (correctly) ` +
      `block /compact, but you will be unable to issue any further commands. ` +
      `The original context-overflow incident is the precedent.`;
  } else if (ratio >= HARD_THRESHOLD) {
    band = 'HARD';
    body =
      `Context consumption has crossed the HARD wrap-trigger threshold ` +
      `(${HARD_THRESHOLD * 100}% consumed). Per CLAUDE.md, /wrapping-session ` +
      `must run before any new feature work — wrap costs 8-17% empirically, ` +
      `which now leaves a buffer of only ${remainingPct}%. MANDATORY: respond ` +
      `to the user's prompt by either (a) finishing any tightly-scoped in-flight ` +
      `task that is <5 minutes from completion, then immediately invoking ` +
      `/wrapping-session; OR (b) invoking /wrapping-session now if no such ` +
      `task is in flight. Do NOT start new investigation, refactoring, or ` +
      `multi-step implementation past this point.`;
  } else {
    band = 'SOFT';
    body =
      `Context consumption has crossed the soft wrap-trigger threshold ` +
      `(${SOFT_THRESHOLD * 100}% consumed). Wrap costs 8-17% empirically, so ` +
      `starting the wrap now keeps a healthy buffer (${remainingPct}% remaining ` +
      `before this prompt). Per CLAUDE.md "Proactive Suggestions" table, ` +
      `surface a one-line nudge to the user: "Should I /wrapping-session to ` +
      `preserve progress?" — unless the user has explicitly directed otherwise ` +
      `in this prompt, or you are mid-task with <5 minutes to completion.`;
  }

  const reminder =
    `══ CONTEXT WRAP-TRIGGER (${band}) ══\n` +
    `Consumed: ${consumedPct}% (~${consumedK}K / ${CONTEXT_WINDOW_TOKENS / 1000}K tokens). ` +
    `Remaining: ${remainingPct}%.\n\n` +
    body +
    `\n\n` +
    `Override: set CLAUDE_CONTEXT_GATE_QUIET=1 to suppress these nudges for this session.\n` +
    `Hook: ~/.claude/hooks/context-wrap-trigger.js (root-cause fix for context-overflow incident; see ` +
    `wrapping-session SKILL.md "Wrap-trigger gate").`;

  // Emit JSON for Claude Code to inject as additionalContext.
  // We deliberately do NOT set `decision: "block"` — that would trap the
  // user the same way the original wrap-marker deadlock did.
  const out = JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: reminder,
    },
  });
  process.stdout.write(out);
  process.exit(0);
} catch (err) {
  // Last-resort safety: any error → exit 0, no injection. Hook bugs must
  // never block prompts. Mirrors memory-size-gate.js + check-freeze.js.
  process.exit(0);
}
