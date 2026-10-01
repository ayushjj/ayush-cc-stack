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
//   - Reads usage AND model id from the most recent assistant message with usage:
//     `message.usage.{input_tokens, cache_read_input_tokens, cache_creation_input_tokens}`
//     plus `message.model`.
//   - Sums usage to total prompt-side context (matches the status-bar metric). On an
//     advisor turn the top-level usage is the SUM of every `message` iteration (~2x the
//     real context), so the numerator comes from the LAST `type:"message"` entry of
//     `usage.iterations` when present (promptTokens; 2026-09-15 fire audit: 3 of 391
//     reminders in the wrong band, e.g. EMERGENCY 72.0% when the real figure was 36.1%).
//   - DENOMINATOR: CLAUDE_CONTEXT_WINDOW_TOKENS when set, else DEFAULT_WINDOW (1M since
//     S254 — the former 200K fail-safe floor was retired; a genuine 200K model must set
//     the env override). windowForModel()'s [1m]-marker / CONFIRMED_1M_IDS branches and
//     the session-wide wide-window scan below are kept for the day DEFAULT_WINDOW is
//     lowered again; at a 1M default they return the same value as the fallback.
//   - Returns JSON {additionalContext: "..."} on stdout; never sets `decision`
//     (a hard block on UserPromptSubmit could trap the user the same way the
//     wrap-marker hook deadlocked the prior incident — fail SOFT, trust the agent to
//     act on the system-reminder).
//   - Fails closed (any internal error → exit 0, no injection, no block).
//     Same guarantee as memory-size-gate.js + check-freeze.js.

const fs = require('node:fs');
const path = require('node:path');

const ONE_M = 1_000_000;
const DEFAULT_WINDOW = ONE_M;     // USER DECISION 2026-09-02 (S254): every model in use is a 1M SKU, so the default is
                                  // 1M. The former 200K fail-safe floor produced two false EMERGENCY nags on version
                                  // bumps (opus-5 S165, fable-5-1 S254) and zero true positives. A genuine 200K model
                                  // must be handled via CLAUDE_CONTEXT_WINDOW_TOKENS=200000, not by the floor.
// A model earns the 1M denominator ONLY via a POSITIVE 1M-SKU identification:
//   (a) the id carries the explicit "[1m]" marker (definitive when present), OR
//   (b) it EXACTLY equals a bare id CONFIRMED to run at 1M for this setup.
// NOT a version substring (the prior /opus-4-8/ form) — that leaked two silent-overflow
// paths (S48 adversarial review): (1) a substring matches 200K sibling SKUs like
// "opus-4-8-haiku" / "fable-5-mini" / "fable-50", handing them 1M so they never nag →
// silent overflow; and (2) transcripts record "[1m]" INCONSISTENTLY (some strip it), so a
// version substring cannot tell a 1M SKU from a 200K SKU of the same version. Exact-match +
// [1m]-marker is the only positive discriminator (P58: substring discriminators leak both
// ways). A bare id joins the confirmed set ONLY on evidence, NEVER on assumption — an
// unverified 1M entry on a heavily-used model is the worst case (a dead valve on the primary).
// fable-5 was initially removed (window unconfirmed); re-added 2026-07-05 on user
// confirmation of its 1M window (the required positive-evidence bar, not an assumption).
const CONFIRMED_1M_IDS = new Set([
  'claude-opus-4-8',   // env-confirmed 1M SKU for this setup (records with OR without the [1m] suffix)
  'claude-fable-5',    // user-confirmed 1M window (2026-07-05)
  'claude-fable-5-1',  // user-confirmed 1M window (2026-09-02, S254): hook nagged EMERGENCY at 63% while the
                       // status line showed 88% remaining — same 200K-floor miss as opus-5 below; exact-match
                       // means each new version id must be added explicitly.
  'claude-opus-5',     // system-prompt-confirmed 1M SKU (`claude-opus-5[1m]`), added 2026-07-25 (S165)
                       // after the hook reported 49.5% consumed while the status line showed 92%
                       // remaining: same ~99K numerator, 200K vs 1M denominator. The [1m] regex in
                       // windowForModel did NOT fire, so this transcript records the id WITHOUT its
                       // suffix — the inconsistency noted above. Same case as claude-opus-4-8 above.
]);

// Denominator for the consumption ratio, from the model that produced the latest turn.
// Precedence: explicit env override > positively-identified 1M SKU > DEFAULT_WINDOW (1M).
function windowForModel(model) {
  const envOverride = Number(process.env.CLAUDE_CONTEXT_WINDOW_TOKENS);
  if (envOverride > 0) return envOverride;
  // Type guard, not just falsiness: this is now called on EVERY usage-bearing
  // transcript line (not once, post-loop), so a single malformed record with a
  // truthy non-string `model` anywhere in a long session would throw at
  // `.replace` below, land in the scan's catch, and silence the hook for the
  // REST of that session — fail-closed in the severe direction (S223 review CORR-3).
  if (typeof model !== 'string' || !model) return DEFAULT_WINDOW;
  if (/\[1m\]$/.test(model)) return ONE_M;                              // explicit 1M SKU marker → definitive
  if (CONFIRMED_1M_IDS.has(model.replace(/\[1m\]$/, ''))) return ONE_M; // exact confirmed id (suffix optional)
  return DEFAULT_WINDOW;                                                // unknown/fallback/unconfirmed → default (1M)
}

const SOFT_THRESHOLD = 0.35;
const HARD_THRESHOLD = 0.45;
const EMERGENCY_THRESHOLD = 0.60;

// Prompt-side tokens of one usage record. An advisor turn carries
// `iterations: [message, advisor_message, message]` and its top-level counts are the
// sum of both `message` iterations (verified on a real record: 234,866 top-level =
// 116,615 + 118,251). The context the NEXT turn starts from is the last `message`
// iteration alone. No iterations (ordinary turn) → the top-level counts, as before.
function promptTokens(usage) {
  const its = Array.isArray(usage.iterations)
    ? usage.iterations.filter(it => it && it.type === 'message')
    : [];
  const sum = u => (Number(u.input_tokens) || 0) +
    (Number(u.cache_read_input_tokens) || 0) +
    (Number(u.cache_creation_input_tokens) || 0);
  // A last `message` iteration with no token counts (e.g. an aborted final call) falls
  // back to the top-level total: over-counting nags early, which is the safe side;
  // returning 0 would skip the record and read an older, smaller turn (review 2026-09-15).
  const last = its.length ? sum(its[its.length - 1]) : 0;
  return last > 0 ? last : sum(usage);
}

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

  // Walk transcript backwards to find the LATEST assistant message with usage
  // (for the NUMERATOR — current context size is a property of the latest turn,
  // not a max-across-session value). Tail-read pattern: read the file, split,
  // scan from the end. For very large transcripts this is still cheap (the
  // JSONL is line-oriented and fits in memory on any developer machine).
  //
  // The DENOMINATOR is a different question: this transcript file is one
  // session, but a session can switch models mid-flight (a fallback turn,
  // an explicit /model swap). Deriving the window from ONLY the latest
  // usage-bearing message's model (S47 §2's fix) is right for "no window is
  // ever assumed bigger than what THIS message's model confirms" but wrong
  // when the session's real model is a confirmed-1M SKU and the LATEST turn
  // merely fell back to an unconfirmed one — that single turn then silently
  // downgrades the whole session's reported ratio (S223: 88 claude-sonnet-5
  // turns + 19 claude-opus-5 turns in one session; the hook read the newest
  // usage record, which happened to be a sonnet-5 turn, and reported 77.6%
  // consumed on a 200K floor when the session's real window — opus-5, 1M —
  // put it at 15.5%). Fix: scan the WHOLE session transcript (not just the
  // latest record) for any usage-bearing message whose model is a positively
  // confirmed 1M SKU; if one exists anywhere in this session, the session's
  // window is 1M — sticky for the session, never re-derived down by a later
  // fallback turn. (Written when DEFAULT_WINDOW was a 200K floor; at today's 1M
  // default this scan cannot change the denominator — see the header.)
  let consumed = 0;
  let foundUsage = false;
  let modelId = '';
  let sawConfirmed1M = false;
  let maxObservedNumerator = 0;
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
      // Subagent turns must never speak for the MAIN conversation's window: a 1M
      // subagent inside a 200K session would pin the denominator and silence the
      // valve. Today this client writes subagent turns to their own transcript
      // (verified: 0 sidechain records across 60 transcripts), so this guard is
      // insurance against a future client inlining them — cheap, and the failure
      // it prevents is the severe one (S223 review, residual risk 4).
      if (msg.isSidechain) continue;
      const lineModel = (msg.message && msg.message.model) || msg.model || '';
      // One number feeds BOTH the numerator and maxObservedNumerator, so neither
      // can read the doubled advisor-turn total.
      const lineConsumed = promptTokens(usage);
      // Both window signals require a record we actually trust (lineConsumed > 0).
      // The numerator path always refused zero-sum records; before S223 the model
      // check did not, so one ERRORED/aborted 1M request in an otherwise-200K
      // session could upgrade the denominator 5x and suppress every nag after it.
      // One record, one trust verdict (S223 review CORR-2).
      if (lineConsumed > 0) {
        if (windowForModel(lineModel) === ONE_M) sawConfirmed1M = true;
        // SELF-VERIFYING window evidence, independent of any allowlist: the API
        // ACCEPTED a request of this size, so the window is at least this big.
        // This is observation rather than assertion — it needs no id in
        // CONFIRMED_1M_IDS and keeps working for models that do not exist yet,
        // which is exactly what the allowlist cannot do. It is also the discriminator
        // that would have prevented S223 on its own. Evidence the allowlist is not
        // enough: a real session here ran 446,004 prompt tokens on `claude-opus-4-7`
        // and the API accepted every one, while this file then called that model a
        // 200K fallback. Widens the window only; never narrows it.
        if (lineConsumed > maxObservedNumerator) maxObservedNumerator = lineConsumed;
      }
      if (!foundUsage && lineConsumed > 0) {
        consumed = lineConsumed;
        modelId = lineModel;  // denominator fallback (S47 §2) when no wide-window evidence exists
        foundUsage = true;
      }
      // Keep scanning to the top even after foundUsage — the window signals must
      // reflect the WHOLE session, not just what's newer than the latest usage line.
    }
  } catch {
    failSilent();  // can't read transcript → silent
  }

  if (!foundUsage) failSilent();

  // Denominator: session-max, from EITHER a positively-identified 1M SKU or an
  // observed numerator the API already accepted above DEFAULT_WINDOW. Sticky by design
  // (a later fallback turn cannot narrow it), because the numerator is shared
  // conversation state — the tokens do not disappear when the model changes.
  const modelWindow = windowForModel(modelId);
  const wideWindowEvidence = sawConfirmed1M || maxObservedNumerator > DEFAULT_WINDOW;
  const CONTEXT_WINDOW_TOKENS = wideWindowEvidence ? Math.max(ONE_M, modelWindow) : modelWindow;
  const ratio = consumed / CONTEXT_WINDOW_TOKENS;
  const consumedPct = (ratio * 100).toFixed(1);
  const remainingPct = ((1 - ratio) * 100).toFixed(1);
  const consumedK = Math.round(consumed / 1000);

  // The S223 "downgrade net" (forced SOFT when the wide window rested only on
  // stickiness) was RETIRED 2026-09-15 (S327): unreachable in every config. Without the
  // env override windowForModel always returns 1M, so modelWindow === the window; with
  // it, windowForModel returns the override for every model, so sawConfirmed1M is set
  // only when the override IS 1M. If DEFAULT_WINDOW is ever lowered below 1M, re-derive
  // a net for the mixed-model case (a sticky 1M window over a smaller current model).
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
