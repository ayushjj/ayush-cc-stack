#!/usr/bin/env node
// Stop: after 6+ helper reports with no check-in, make Claude add one before stopping.
// Why: 8 of 12 owner-asked check-ins (10-12..10-24) came after 6-31 helper reports with none.
'use strict';
const fs = require('fs');
let raw = '';
process.stdin.on('data', d => { raw += d; }).on('end', () => {
  try {
    const inp = JSON.parse(raw);
    if (inp.stop_hook_active) process.exit(0);           // block at most once per stop
    const lines = fs.readFileSync(inp.transcript_path, 'utf8').split('\n');
    let reports = 0;
    for (const line of lines) {
      let e; try { e = JSON.parse(line); } catch { continue; }
      if (e.isSidechain) continue;
      const c = e.message && e.message.content;
      const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter(x => x && x.type === 'text').map(x => x.text).join(' ') : '';
      if (e.type === 'user' && /Subagent hand-back|<agent-message/.test(text)) reports++;
      if (e.type === 'assistant' && /\*\*Done\*\*/.test(text) && /Where we are/i.test(text)) reports = 0;
    }
    if (reports < 6) process.exit(0);
    process.stdout.write(JSON.stringify({ decision: 'block', reason:
      `${reports} helper reports since your last check-in. Add one now (plain-coach § Check-ins): ` +
      'Done as before → after from the user\'s side; Left and who it waits on; Where we are as x of N and what happens next.' }));
  } catch { /* fail open */ }
  process.exit(0);
});
