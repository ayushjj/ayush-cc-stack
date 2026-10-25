#!/usr/bin/env node
// SessionStart hook: warn when a THIRD-PARTY plugin gains or changes a way to execute code.
// Why (2026-10-04): autoUpdate was turned on for compound-engineering so the owner stays
// current; the security review's residual risk was "new upstream code runs before anyone
// reads it". Text-only changes stay silent; only execution surface reaches a person.
//
// Surface = a content hash per item, compared on EVERY run (the version string is not
// trusted — an in-place change with the same version still warns):
//   - any hooks.json / .mcp.json / .lsp.json / monitors.json in the plugin
//   - component keys in .claude-plugin/plugin.json and in the plugin's marketplace.json entry
//   - every file under bin/
//   - frontmatter keys allowed-tools / tools / disallowedTools / hooks / mcpServers in any .md
// Official-marketplace plugins are not watched (Anthropic-curated). The very first run
// records a baseline silently; after that a NEW third-party plugin with surface warns.
// Plugin-supplied text is never echoed — only sanitized paths — so a plugin cannot talk to
// the model through this warning. Irregular files (FIFOs, devices) are skipped so a crafted
// symlink cannot hang the hook. Any read failure prints CANNOT CHECK, never silence.
// Canary: hooks/tests/plugin-surface-watch-canary.sh (t10–t20 = the 2026-10-04 review bypasses).
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const HOME = os.homedir();
const INSTALLED = process.env.PLUGIN_SURFACE_INSTALLED || path.join(HOME, '.claude/plugins/installed_plugins.json');
const MARKETPLACES = process.env.PLUGIN_SURFACE_MARKETPLACES || path.join(HOME, '.claude/plugins/known_marketplaces.json');
const STATE = process.env.PLUGIN_SURFACE_STATE || path.join(HOME, '.claude/state/plugin-surface.json');
const OFFICIAL = new Set(['claude-plugins-official']);
const SKIP_ANYWHERE = new Set(['node_modules', '.git']);
const SKIP_AT_ROOT = new Set(['tests', 'test', 'fixtures']);
const SURFACE_FILES = new Set(['hooks.json', '.mcp.json', '.lsp.json', 'monitors.json']);
const COMPONENT_KEYS = ['hooks', 'mcpServers', 'lspServers', 'monitors', 'experimental', 'commands', 'agents', 'skills', 'outputStyles'];
const FRONTMATTER_KEYS = /^["']?(allowed-tools|tools|disallowedTools|hooks|mcpServers)["']?\s*:/;
const HEAD_BYTES = 64 * 1024;       // frontmatter lives at the top of a .md
const MAX_HASH_BYTES = 5 * 1024 * 1024;
const MAX_LISTED = 20;

const hash = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
const clean = (s) => String(s).replace(/[^A-Za-z0-9_.\/@ :|-]/g, '?').slice(0, 120);

// Regular files only (symlinks followed to a regular target); FIFOs/devices return null.
function readRegular(file, maxBytes) {
  const st = fs.statSync(file);
  if (!st.isFile()) return null;
  if (st.size <= maxBytes) return fs.readFileSync(file, 'utf8');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(maxBytes);
    const n = fs.readSync(fd, buf, 0, maxBytes, 0);
    return buf.subarray(0, n).toString('utf8') + `\0size:${st.size}`;
  } finally {
    fs.closeSync(fd);
  }
}

function frontmatterBlocks(raw) {
  const text = raw.replace(/^\uFEFF/, '');
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return [];
  const lines = m[1].split(/\r?\n/);
  const blocks = [];
  if (lines.some((l) => /^\s*\{/.test(l))) blocks.push(['unparsed', m[1]]);   // flow style: watch it whole
  for (let i = 0; i < lines.length; i++) {
    const key = lines[i].match(FRONTMATTER_KEYS);
    if (!key) continue;
    let block = lines[i];
    while (i + 1 < lines.length && /^(\s|-)/.test(lines[i + 1])) block += '\n' + lines[++i];
    blocks.push([key[1], block]);
  }
  return blocks;
}

// Symlinked folders are followed (a plugin can point bin/ or hooks/ elsewhere); `visited`
// holds real paths so link loops end. `force` walks a declared component path even when its
// folder name is normally skipped (root tests/).
function walk(dir, root, sig, visited, force) {
  const real = fs.realpathSync(dir);
  if (visited.has(real)) return;
  visited.add(real);
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    const rel = path.relative(root, full);
    let isDir = ent.isDirectory();
    if (ent.isSymbolicLink()) {
      let target;
      try { target = fs.realpathSync(full); } catch { sig[`${rel} link`] = 'dangling'; continue; }
      const realRoot = fs.realpathSync(root);
      sig[`${rel} link`] = hash(target.startsWith(realRoot + path.sep) ? path.relative(realRoot, target) : target);
      isDir = fs.statSync(full).isDirectory();
    }
    if (isDir) {
      if (SKIP_ANYWHERE.has(ent.name)) continue;
      if (!force && !ent.isSymbolicLink() && dir === root && SKIP_AT_ROOT.has(ent.name)) continue;
      walk(full, root, sig, visited, force);
      continue;
    }
    const inBin = rel.split(path.sep)[0] === 'bin';
    if (inBin || SURFACE_FILES.has(ent.name)) {
      const body = readRegular(full, MAX_HASH_BYTES);
      if (body !== null) sig[rel] = hash(body);
    } else if (ent.name.endsWith('.md')) {
      const head = readRegular(full, HEAD_BYTES);
      if (head === null) continue;
      for (const [key, block] of frontmatterBlocks(head)) sig[`${rel} frontmatter:${key}`] = hash(block);
    }
  }
}

// Hash each component value; for plugin.json (root given), also follow string paths to the
// files or folders they name, so a hooks file at a custom path is watched by content.
function componentKeys(obj, label, sig, root) {
  for (const k of COMPONENT_KEYS) {
    if (!obj || obj[k] === undefined) continue;
    sig[`${label}:${k}`] = hash(JSON.stringify(obj[k]));
    if (!root) continue;
    const paths = [].concat(obj[k]).filter((v) => typeof v === 'string');
    for (const p of paths) {
      const full = path.resolve(root, p);
      if (!fs.existsSync(full)) continue;
      if (fs.statSync(full).isDirectory()) {
        walk(full, root, sig, new Set(), true);
      } else {
        const body = readRegular(full, MAX_HASH_BYTES);
        if (body !== null) sig[path.relative(root, full)] = hash(body);
      }
    }
  }
}

function surfaceOf(entry, pluginName, marketplace, marketplaces) {
  const root = entry.installPath;
  if (typeof root !== 'string' || !fs.statSync(root).isDirectory()) throw new Error(`install path unusable: ${root}`);
  const sig = {};
  walk(root, root, sig, new Set(), false);
  const manifest = path.join(root, '.claude-plugin/plugin.json');
  if (fs.existsSync(manifest)) componentKeys(JSON.parse(fs.readFileSync(manifest, 'utf8')), 'plugin.json', sig, root);
  const mk = marketplaces[marketplace];
  if (!mk || typeof mk.installLocation !== 'string') throw new Error(`marketplace ${marketplace} not in record`);
  const catalog = JSON.parse(fs.readFileSync(path.join(mk.installLocation, '.claude-plugin/marketplace.json'), 'utf8'));
  const listed = (catalog.plugins || []).find((p) => p && p.name === pluginName);
  componentKeys(listed, 'marketplace entry', sig, null);
  return sig;
}

function describe(title, items) {
  const shown = items.slice(0, MAX_LISTED).map((i) => `  + ${clean(i)}`);
  if (items.length > MAX_LISTED) shown.push(`  + and ${items.length - MAX_LISTED} more`);
  return `${title}\n${shown.join('\n')}`;
}

function main() {
  const installed = JSON.parse(fs.readFileSync(INSTALLED, 'utf8'));
  if (!installed || typeof installed.plugins !== 'object') throw new Error('install record has no plugins map');

  let state;
  let firstRun = false;
  try {
    state = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw new Error(`state file unreadable, left as is (${err.message})`);
    state = { plugins: {} };
    firstRun = true;
  }
  if (!state || typeof state.plugins !== 'object') throw new Error('state file has no plugins map, left as is');

  let marketplaces = null;
  const out = [];
  const next = {};
  for (const [id, entries] of Object.entries(installed.plugins)) {
    const at = id.lastIndexOf('@');
    const pluginName = id.slice(0, at);
    const marketplace = id.slice(at + 1);
    if (OFFICIAL.has(marketplace)) continue;
    if (!Array.isArray(entries)) throw new Error(`install record for ${clean(id)} is not a list`);
    if (marketplaces === null) marketplaces = JSON.parse(fs.readFileSync(MARKETPLACES, 'utf8'));
    for (const e of entries) {
      const key = `${id}|${e.scope || ''}|${e.projectPath || ''}`;
      let sig;
      try {
        sig = surfaceOf(e, pluginName, marketplace, marketplaces);
      } catch (err) {
        out.push(`plugin-surface-watch: CANNOT CHECK ${clean(id)} — ${clean(err.message)}`);
        if (state.plugins[key]) next[key] = state.plugins[key];
        continue;
      }
      const prev = state.plugins[key];
      if (prev && prev.sig) {
        const changed = Object.keys(sig).filter((k) => prev.sig[k] !== sig[k]);
        if (changed.length) {
          out.push(describe(`PLUGIN CHANGED CODE THAT CAN RUN: ${clean(id)} ${clean(prev.version)} -> ${clean(e.version)}`, changed));
        }
      } else if (!firstRun && Object.keys(sig).length) {
        out.push(describe(`NEW THIRD-PARTY PLUGIN WITH CODE THAT CAN RUN: ${clean(id)}`, Object.keys(sig)));
      }
      next[key] = { version: e.version, sig };
    }
  }
  if (out.some((l) => l.startsWith('PLUGIN') || l.startsWith('NEW'))) {
    out.push('  Tell the owner in plain words before using this plugin. Inspect the files listed above.');
  }
  fs.mkdirSync(path.dirname(STATE), { recursive: true });
  fs.writeFileSync(STATE, JSON.stringify({ plugins: next }, null, 2));
  if (out.length) console.log(out.join('\n'));
}

try {
  main();
} catch (err) {
  console.log(`plugin-surface-watch: CANNOT CHECK — ${clean(err.message)}`);
}
