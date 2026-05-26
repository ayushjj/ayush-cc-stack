#!/usr/bin/env node
// PreToolUse hook: when test-first workflow is active (plan.md or specs/*/implementation.md
// with Test Queue exists), checks git diff for deleted/weakened test assertions.
// Beck's #1 AI agent failure mode: agent deleting or disabling tests to make code pass.
//
// Behavior:
//   - No plan.md and no specs/*/implementation.md with Test Queue → silent no-op
//   - Test files with removed assertion lines → WARN on stderr (does NOT block)
//   - Block mode: set CLAUDE_ANTICHEAT_BLOCK=1 to exit 2 instead of warn
//
// Only runs on: git commit commands

const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const input = JSON.parse(process.env.CLAUDE_TOOL_INPUT || '{}');
const command = input.command || '';

// Only gate git commit commands
if (!/\bgit\s+commit\b/.test(command)) {
  process.exit(0);
}

// Check if test-first workflow is active
function isTestFirstActive() {
  // Check for plan.md in cwd
  if (fs.existsSync(path.join(process.cwd(), 'plan.md'))) {
    return true;
  }

  // Check for specs/*/implementation.md containing "Test Queue"
  const specsDir = path.join(process.cwd(), 'specs');
  if (fs.existsSync(specsDir)) {
    try {
      const features = fs.readdirSync(specsDir, { withFileTypes: true });
      for (const feat of features) {
        if (feat.isDirectory()) {
          const implPath = path.join(specsDir, feat.name, 'implementation.md');
          if (fs.existsSync(implPath)) {
            const content = fs.readFileSync(implPath, 'utf8');
            if (content.includes('Test Queue')) {
              return true;
            }
          }
        }
      }
    } catch {
      // If we can't read specs dir, don't block
    }
  }

  return false;
}

if (!isTestFirstActive()) {
  process.exit(0);
}

// Check staged diff for removed test assertions
function tryExec(cmd) {
  try {
    return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

const diff = tryExec('git diff --cached --unified=0');
if (!diff) {
  process.exit(0);
}

// Look for removed lines in test files that contain assertion patterns
const testFilePatterns = /\.(test|spec)\.(ts|js|tsx|jsx|py|rb)$|test_.*\.py$|.*_test\.(go|rb)$/;
const assertionPatterns = /\b(assert|expect|should|it\(|test\(|describe\(|\.toBe|\.toEqual|\.toMatch|\.toThrow|assertEqual|assertRaises|assert_equal)\b/;

const lines = diff.split('\n');
let currentFile = '';
const warnings = [];

for (const line of lines) {
  const fileMatch = line.match(/^diff --git a\/(.*?) b\//);
  if (fileMatch) {
    currentFile = fileMatch[1];
    continue;
  }

  // Only check test files
  if (!testFilePatterns.test(currentFile)) continue;

  // Look for removed lines (start with -) that contain assertions
  if (line.startsWith('-') && !line.startsWith('---') && assertionPatterns.test(line)) {
    warnings.push(`  ${currentFile}: ${line.trim()}`);
  }
}

if (warnings.length === 0) {
  process.exit(0);
}

const msg = [
  '════════════════════════════════════════════════════════════════',
  '⚠  ANTI-CHEAT (Beck): Test assertions were REMOVED or WEAKENED',
  '   in this commit while test-first workflow is active.',
  '',
  '   Beck\'s #1 AI agent failure mode: "Any indication that the',
  '   genie was cheating, for example by disabling or deleting tests."',
  '',
  '   Removed assertion lines:',
  ...warnings,
  '',
  '   If intentional, proceed. If not, unstage and investigate.',
  '════════════════════════════════════════════════════════════════',
];

process.stderr.write(msg.join('\n') + '\n');

if (process.env.CLAUDE_ANTICHEAT_BLOCK === '1') {
  process.exit(2);
}

process.exit(0);
