#!/usr/bin/env node
// PreToolUse hook: enforces the weekly check's limits. Attached only in the weekly-check
// agent's own file (agents/weekly-check.md) with --enforce, so every call it sees is that
// agent's. Without --enforce it acts only when stdin agent_type is `weekly-check`.
//
// Why: the background weekly check reads strangers' pages unwatched. Its limit — "read,
// judge, write only inside ~/dev/weekly-run" — was instruction-only, and it runs inside
// the owner's auto-mode session whose allow rules include git commit/push (plan
// specs/weekly-run/plan.md, review round 4, security M5). A hook deny (exit 2) applies
// before allow rules, so this holds even in auto mode.
//
// Design (review round 5, 2026-10-24): an ALLOW-list. Only commands named below may run;
// anything else is blocked. Four review rounds showed a list of banned commands always
// misses one. A command the check really needs and cannot run is a one-line addition here.
//
// Scope, stated honestly: the agent may still READ anything and send it out in a web
// request (an accepted limit). The other half of the safety is the read/act split: nothing
// the agent writes is acted on until the owner's foreground delivery step.
//
// Fails CLOSED under --enforce (unreadable input = deny). No skip variable.

const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = os.homedir();
const W = path.join(HOME, 'dev', 'weekly-run');
const WEEKLY_AGENT = 'weekly-check';
// The answer key for the checklist's control bookmarks: reading it would make the controls meaningless.
const NO_READ = [path.join(HOME, '.claude', 'level-up', 'controls-key.json')];

function deny(reason) {
  process.stderr.write(`weekly-check sandbox: BLOCKED — ${reason}. The weekly check may only read, and write inside ~/dev/weekly-run.\n`);
  process.exit(2);
}

function expand(p) {
  let s = String(p);
  if (s === '~' || s.startsWith('~/')) s = HOME + s.slice(1);
  s = s.replace(/^\$HOME(?=\/|$)/, HOME).replace(/^\$\{HOME\}(?=\/|$)/, HOME);
  return s;
}

// Follow symlinks in the part of the path that exists, so a link inside W pointing
// outside cannot make an outside write look inside.
function realish(abs) {
  let head = abs;
  const tail = [];
  while (head !== path.dirname(head)) {
    try {
      return path.join(fs.realpathSync(head), ...tail.reverse());
    } catch {
      tail.push(path.basename(head));
      head = path.dirname(head);
    }
  }
  return abs;
}
const REAL_W = realish(W);

// Characters the shell would expand or re-join: a word holding one cannot be judged as text.
const UNSAFE_WORD = /[$`"'\\*?{}[\]~]/;

function insideW(p, cwd) {
  const e = expand(p);
  if (UNSAFE_WORD.test(e)) return false;
  const abs = realish(path.resolve(cwd || '/', e));
  // W's own git folder and attributes hold settings that git commands run (core.pager, fsmonitor, filters).
  if (/(^|\/)\.git(\/|$)|(^|\/)\.git(attributes|modules)$/.test(abs)) return false;
  return abs === REAL_W || abs.startsWith(REAL_W + path.sep);
}

// ---- Bash ---------------------------------------------------------------------------------

// Commands that only read or print. Built from what the 2026-10-24 run and its test sessions used.
const READERS = new Set(['cat', 'head', 'tail', 'grep', 'egrep', 'fgrep', 'ls', 'wc', 'sort', 'uniq', 'cut',
  'tr', 'echo', 'printf', 'date', 'jq', 'diff', 'cmp', 'comm', 'paste', 'column', 'nl', 'basename', 'dirname',
  'realpath', 'stat', 'file', 'test', '[', 'true', 'false', ':', 'sleep', 'shasum', 'md5', 'seq', 'pwd',
  'fold', 'rev', 'expr', 'done', 'fi', 'read', 'base64', ']', 'which', 'type']);
// Commands that write to their path arguments: every path must be inside W.
const PATH_WRITERS = new Set(['mkdir', 'touch', 'rm', 'rmdir', 'mv', 'cp', 'tee']);
// Shell words that start a command without being one.
const KEYWORDS = new Set(['then', 'do', 'else', 'elif', 'if', 'while', 'until', '!', '{', '}', 'time']);
// Variables that may prefix a command (they change nothing about what runs).
const SAFE_ENV = new Set(['TZ', 'LC_ALL', 'LANG', 'NO_COLOR', 'TOOL_SCOUT_LOG', 'TOOL_SCOUT_FAKE_LATEST']);
const HOUSEKEEPING = path.join(HOME, '.local', 'bin', 'weekly-housekeeping');
const SKILLS_DIR = path.join(HOME, '.claude', 'skills') + path.sep;

function isTrustedScript(p) {
  const e = expand(p);
  if (UNSAFE_WORD.test(e)) return false;
  const abs = realish(path.resolve(e));
  return abs.startsWith(SKILLS_DIR) && /\.(js|py)$/.test(abs);
}

// Here-doc bodies are data, not commands; the opening line (with any redirect) stays.
function stripHeredocs(cmd) {
  return cmd.replace(/(<<-?[ \t]*(['"]?)(\w+)\2[^\n]*)\n[\s\S]*?\n[ \t]*\3[ \t]*(?=\n|$)/g, '$1');
}

const REDIRECT = /(?:[0-9]|&)?>>?[|&]?[ \t]*("[^"]*"|'[^']*'|[^\s;&|()<>]+)/g;

// Redirects are found in the masked text (a `>` inside quotes is not one); targets are read
// from the original text at the same position.
function checkRedirectsMasked(part, mpart, cwd) {
  REDIRECT.lastIndex = 0;
  let m;
  while ((m = REDIRECT.exec(mpart)) !== null) {
    const tStart = m.index + m[0].length - m[1].length;
    const target = part.slice(tStart, m.index + m[0].length);
    if (/^[0-9-]$/.test(target) && /&[ \t]*[0-9-]$/.test(m[0])) continue;   // >&2, 2>&1, >&-
    if (target === '/dev/null' || target === '/dev/stderr' || target === '/dev/stdout') continue;
    if (!insideW(target, cwd)) deny(`writing to ${target}`);
  }
  // A `>` left without a plain target (e.g. `> $(…)`, whose name only exists once it runs) cannot be checked.
  if (/>/.test(mpart.replace(REDIRECT, ''))) deny('redirect with no plain target (cannot be checked)');
}

// Blank out quoted text (keeping its length and the quote marks) so operators, brackets and
// `>` inside quotes are not read as shell structure. Single quotes hide everything; inside
// double quotes the shell still runs $(…) and `…`, so those are refused outright.
function maskQuotes(cmd) {
  let out = '';
  let q = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (q === null) {
      if (c === '\\') { out += '__'; i++; continue; }
      if (c === "'" || c === '"') q = c;
      out += c;
    } else if (c === q) {
      q = null;
      out += c;
    } else {
      if (q === '"' && (c === '`' || (c === '$' && cmd[i + 1] === '(' && cmd[i + 2] !== '('))) deny('command substitution inside quotes (cannot be checked)');
      if (q === '"' && c === '\\') { out += '__'; i++; continue; }
      out += c === '\n' ? '\n' : '_';
    }
  }
  if (q !== null) deny('unbalanced quote (cannot be checked)');
  return out;
}

// The words of one simple command, with redirects removed, taken from the original text.
function wordsOf(part, mpart) {
  const blank = mpart.replace(REDIRECT, (s) => ' '.repeat(s.length)).replace(/<[ \t]*[^\s<>]+/g, (s) => ' '.repeat(s.length));
  const words = [];
  const re = /\S+/g;
  let m;
  while ((m = re.exec(blank)) !== null) words.push(part.slice(m.index, m.index + m[0].length));
  return words;
}

function checkBash(rawCmd, startCwd) {
  const raw = stripHeredocs(rawCmd);
  const masked = maskQuotes(raw);
  if (/<<</.test(masked)) deny('here-string (cannot be checked)');
  if (/>\(/.test(masked)) deny('process substitution that writes (cannot be checked)');
  let cwd = startCwd;
  // One simple command at a time. Splitting on operators, brackets and substitutions means a
  // command hidden in $(…), `…`, ( … ) or after & is still checked as a command of its own.
  // Split positions come from the masked text; the words themselves from the original.
  const sep = /&&|\|\||(?<![<>])&(?![>&])|[;|\n()`<]|\$\(/g;
  let from = 0;
  const parts = [];
  let m;
  while ((m = sep.exec(masked)) !== null) {
    if (m[0] === '<' && masked[m.index + 1] !== '(') continue;   // input redirect, not a split
    parts.push([raw.slice(from, m.index), masked.slice(from, m.index)]);
    from = m.index + m[0].length;
  }
  parts.push([raw.slice(from), masked.slice(from)]);
  for (const [part, mpart] of parts) {
    checkRedirectsMasked(part, mpart, cwd);
    const words = wordsOf(part, mpart);
    while (words.length && KEYWORDS.has(words[0])) words.shift();
    if (words[0] === 'export') words.shift();
    while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) {
      const name = words[0].split('=')[0];
      if (words.length > 1 && !SAFE_ENV.has(name)) deny(`setting ${name} before a command`);
      if (/^(PATH|IFS|ENV|BASH_ENV|PS4|PROMPT_COMMAND|CDPATH|PAGER|EDITOR|VISUAL|LESSOPEN|.*_PAGER|GIT_.*|LD_.*|DYLD_.*|NODE_OPTIONS|PYTHON.*)$/.test(name)) deny(`setting ${name}`);
      words.shift();
    }
    if (!words.length) continue;
    const first = words[0];
    const args = words.slice(1);
    if (first === 'for' || first === 'case' || first === 'esac') {
      if (first !== 'for') deny('case statement (cannot be checked)');
      continue;   // `for x in a b c`: the words are values; the loop body is checked as its own part
    }
    // The read-only housekeeping report, run directly or as `bash <it>` (both seen in real runs).
    const target = /^(bash|sh)$/.test(first) && args.length === 1 ? args[0] : first;
    if (!UNSAFE_WORD.test(expand(target)) && path.resolve(cwd, expand(target)) === HOUSEKEEPING) continue;
    if (UNSAFE_WORD.test(first) && first !== '[') deny(`command name ${first} (cannot be checked)`);
    if (first.includes('/')) deny(`running ${first} (only named commands may run)`);
    checkCommand(first, args, cwd, (next) => { cwd = next; });
  }
}

function checkCommand(name, args, cwd, setCwd) {
  if (name === 'cd') {
    if (args.length !== 1 || UNSAFE_WORD.test(expand(args[0]))) deny('cd that cannot be followed');
    setCwd(path.resolve(cwd, expand(args[0])));
    return;
  }
  if (READERS.has(name)) {
    if (name === 'sort' && args.some((a) => /^--output/.test(a) || /^-[a-zA-Z]*o/.test(a))) deny('sort writing a file');
    // readers that can also write: uniq's second file is its output; base64/md5 -o and file -C write files
    if (name === 'uniq') {
      // operands: a lone '-', everything after '--', and any word that is not an option (option values
      // like `-f 2` count too, which only over-blocks). A second operand is uniq's output file.
      const dd = args.indexOf('--');
      const ops = args.filter((a, j) => (dd !== -1 && j > dd) || a === '-' || (!a.startsWith('-') && a !== '--'));
      if (ops.length > 1) deny('uniq writing a file');
    }
    if (['base64', 'md5', 'file', 'shasum'].includes(name) && args.some((a) => /^(-[a-zA-Z]*[oC]|--output)/.test(a))) deny(`${name} writing a file`);
    return;
  }
  if (PATH_WRITERS.has(name)) {
    for (const w of args) {
      if (w === '--') continue;
      if (w.startsWith('-')) {
        if (name === 'cp' && /^-[a-zA-Z]*[sl]|^--(symbolic|link)/.test(w)) deny('cp making links');
        continue;
      }
      if (!insideW(w, cwd)) deny(`${name} on ${w}`);
    }
    return;
  }
  if (name === 'git') return checkGit(args, cwd);
  if (name === 'sed') {
    if (args.some((a) => /^-[a-zA-Z]*f|^--file/.test(a))) deny('script-file sed');
    if (args.some((a) => /^-[a-zA-Z]*i|^--in-place/.test(a))) {
      // in-place edit: the script and BSD's '' suffix are quoted; every unquoted word is a file to edit
      const files = args.filter((a) => !a.startsWith('-') && !/^['"]/.test(a));
      if (!files.length || files.some((f) => !insideW(f, cwd))) deny('in-place sed outside ~/dev/weekly-run');
    }
    if (args.some((a) => /(^|[;{}\n]\s*)[wWe](\s|$)|\/[gpIi0-9]*[wWe](\s|$)/.test(a.replace(/^['"]|['"]$/g, '')))) deny('sed that writes or runs');
    return;
  }
  if (name === 'find') {
    if (args.some((w) => /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/.test(w))) deny('find that runs or deletes');
    return;
  }
  if (name === 'gh') {
    if (args[0] !== 'api') deny('GitHub command other than reading the API');
    for (let i = 1; i < args.length; i++) {
      const a = args[i];
      const explicitGet = args.some((b, j) => (/^(-X|--method)$/.test(b) && args[j + 1] === 'GET') || /^(-XGET|--method=GET)$/.test(b));
      if (/^(--input|--hostname)(=|$)/.test(a)) deny('GitHub API upload or other host');
      if ((/^(-f|-F|--field|--raw-field)(=|$)/.test(a) || /^-[a-zA-Z]*[fF]$/.test(a)) && !explicitGet) deny('GitHub API fields without -X GET (would POST)');
      if (/^(-X|--method)$/.test(a) && args[i + 1] !== 'GET') deny('GitHub API write');
      if (/^(-X(?!GET$).|--method=(?!GET$))/.test(a)) deny('GitHub API write');
    }
    return;
  }
  if (name === 'curl') {
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (/^(-X|--request)$/.test(a) && args[i + 1] !== 'GET') deny('web request other than GET');
      if (/^-X(?!GET$)./.test(a)) deny('web request other than GET');
      if (/^--(data|form|upload-file|output|remote-name|config|dump-header|cookie-jar|trace|stderr|libcurl|create-dirs|output-dir|remote-header-name|json)/.test(a)
        || (/^-[a-zA-Z]+$/.test(a) && /[dFToOKDcJ]/.test(a))) {
        deny('web request that sends data or saves a file');
      }
    }
    return;
  }
  if (name === 'node' || /^python3?(\.\d+)?$/.test(name)) {
    // Only our own scripts in ~/.claude/skills (the agent cannot write there) may run.
    const rest = args.filter((w) => w !== '-I');
    if (!rest.length || rest[0].startsWith('-') || !isTrustedScript(rest[0])) deny(`${name} without one of our own scripts (cannot be checked)`);
    return;
  }
  deny(`command ${name} is not on the weekly check's list`);
}

// git: only read-only subcommands, and only the -C global option. Every other global option
// (-c, --config-env, --exec-path, --git-dir, -p …) can make a read run a program.
const GIT_READS = new Set(['log', 'show', 'status', 'diff', 'rev-parse', 'rev-list', 'ls-files', 'ls-tree',
  'cat-file', 'for-each-ref', 'merge-base', 'describe', 'blame', 'shortlog', 'symbolic-ref', 'branch', 'remote']);
function checkGit(args, cwd) {
  let i = 0;
  let dir = cwd;
  while (i < args.length && args[i].startsWith('-')) {
    if (args[i] !== '-C' || UNSAFE_WORD.test(expand(args[i + 1] || '$'))) deny(`git option ${args[i]}`);
    dir = path.resolve(dir, expand(args[i + 1]));
    i += 2;
  }
  // A repo the agent built inside W (its own HEAD, config, objects) could make a read run a
  // program through its config. Inside W, git may only run at W's root, whose .git it cannot write.
  const real = realish(dir);
  if (real.startsWith(REAL_W + path.sep)) deny('git inside a folder the weekly check can write');
  const sub = args[i];
  if (sub === undefined) return;
  if (!GIT_READS.has(sub)) deny(`git ${sub} (only reading git commands are allowed)`);
  const flags = args.slice(i + 1);
  if (sub === 'branch' && flags.some((f) => !['--show-current', '-a', '-r', '-v', '-vv', '--list', '--all'].includes(f))) deny('git branch with options that may change it');
  if (sub === 'remote' && flags.some((f) => !['-v', 'get-url', 'show', 'origin'].includes(f))) deny('git remote change');
  if (flags.some((a) => /^--(output|ext-diff|textconv|open-files-in-pager|paginate)(=|$)|^-[a-zA-Z]*[oOp]$/.test(a) && !/^--(no-|oneline|pretty|patch-with)/.test(a))) {
    deny('git option that writes a file or runs a program');
  }
}

// ---- entry --------------------------------------------------------------------------------

const enforce = process.argv.includes('--enforce');

function main(raw) {
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    if (enforce) deny('unreadable hook input');
    process.stderr.write('weekly-check sandbox: unreadable hook input, not checked\n');
    process.exit(0);
  }
  if (!input || (!enforce && input.agent_type !== WEEKLY_AGENT)) process.exit(0);

  const tool = input.tool_name;
  const ti = input.tool_input || {};
  const cwd = typeof input.cwd === 'string' ? input.cwd : '/';

  if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(tool)) {
    const p = ti.file_path || ti.notebook_path;
    if (typeof p !== 'string' || !insideW(p, cwd)) deny(`${tool} on ${p}`);
    process.exit(0);
  }
  if (tool === 'Bash') {
    if (typeof ti.command !== 'string') deny('Bash with no command');
    checkBash(ti.command, cwd);
    process.exit(0);
  }
  if (tool === 'Skill') {
    if (ti.skill !== 'level-up') deny(`skill ${ti.skill}`);
    process.exit(0);
  }
  if (tool === 'Read') {
    const p = typeof ti.file_path === 'string' ? realish(path.resolve(cwd, expand(ti.file_path))) : '';
    if (NO_READ.some((n) => p === realish(n))) deny('reading the controls answer key');
    process.exit(0);
  }
  // SubagentHandback is how the agent delivers its final report; TodoWrite is its own task list.
  if (['Glob', 'Grep', 'WebFetch', 'WebSearch', 'ToolSearch', 'LS', 'SubagentHandback', 'TodoWrite'].includes(tool)) process.exit(0);
  if (/^mcp__plugin_exa_exa__(web_search_exa|web_fetch_exa)$/.test(tool)) process.exit(0);
  // Everything else (Agent, SendMessage, cron, Gmail, Artifact, other MCP tools…) is outward or unchecked.
  deny(`tool ${tool}`);
}

let buf = '';
process.stdin.on('data', (c) => { buf += c; });
process.stdin.on('end', () => {
  try {
    main(buf);
  } catch (err) {
    if (enforce || /"agent_type"\s*:\s*"weekly-check"/.test(buf)) deny(`guard error: ${err.message}`);
    process.stderr.write(`weekly-check sandbox error (not a weekly call): ${err.message}\n`);
    process.exit(0);
  }
});
