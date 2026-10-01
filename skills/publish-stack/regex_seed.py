#!/usr/bin/env python3
"""Emit a literal string that the given ERE alternative actually matches.

Why this exists: the denylist gate's self-test must seed a token that its own pattern will
catch. Deriving the seed by stripping regex metacharacters is wrong -- `/Users/[a-zA-Z]+/`
strips to `~/`, which the pattern does NOT match, so the self-test reported the
scanner broken on a perfectly good gate. Sampling the regex instead of mangling it is the
only version that is correct for every class.

Exit 1 (and print nothing) if no seed can be constructed -- the caller must treat that as a
broken gate, never as a pass.
"""
import sys, re

def expand(pat):
    """Sample one matching string. Units are kept separately so a {n,m} quantifier can
    repeat the PREVIOUS unit -- emitting one character for {2,4} produces a string the
    pattern rejects, which would report a working scanner as broken."""
    units, i, n = [], 0, len(pat)
    while i < n:
        c = pat[i]
        if c == '\\' and i + 1 < n:
            nxt = pat[i+1]
            if nxt in 'bBAZz<>':                      # zero-width assertions emit nothing
                units.append('')
            else:
                units.append({'d': '1', 'w': 'a', 's': ' ', 'S': 'a', 'W': '-', 'D': 'a'}.get(nxt, nxt))
            i += 2
        elif c == '[':
            j = pat.index(']', i + 2) if ']' in pat[i+2:] else -1
            if j == -1:
                return None
            body = pat[i+1:j]
            if body.startswith('^'):
                units.append('z')
            else:
                m = re.match(r'(.)-(.)', body)
                units.append(m.group(1) if m else (body[0] if body else 'a'))
            i = j + 1
        elif c == '(':
            j, depth = i + 1, 1                       # take the first alternative of the group
            while j < n and depth:
                depth += (pat[j] == '(') - (pat[j] == ')')
                j += 1
            inner = pat[i+1:j-1].split('|')[0]
            if inner.startswith('?:'):
                inner = inner[2:]
            sub = expand(inner)
            if sub is None:
                return None
            units.append(sub); i = j
        elif c in '+*?':
            i += 1                                    # one repetition is already emitted
        elif c == '{':
            j = pat.index('}', i) if '}' in pat[i:] else -1
            if j == -1:
                return None
            lo = pat[i+1:j].split(',')[0]
            if units and lo.isdigit() and int(lo) > 1:
                units[-1] = units[-1] * int(lo)       # repeat the PREVIOUS unit to satisfy {n,}
            i = j + 1
        elif c == '.':
            units.append('x'); i += 1
        elif c in '^$':
            i += 1
        else:
            units.append(c); i += 1
    return ''.join(units)

def top_alternatives(pat):
    """Split on TOP-LEVEL | only. A naive pat.split('|') tears `(foo|bar)-x` into two
    malformed halves and reports an unsamplable pattern, which would abort a working gate."""
    parts, depth, cur, i = [], 0, [], 0
    while i < len(pat):
        c = pat[i]
        if c == '\\' and i + 1 < len(pat):
            cur.append(pat[i:i+2]); i += 2; continue
        if c == '[':
            j = pat.index(']', i + 2) if ']' in pat[i+2:] else len(pat) - 1
            cur.append(pat[i:j+1]); i = j + 1; continue
        if c == '(':
            depth += 1
        elif c == ')':
            depth -= 1
        if c == '|' and depth == 0:
            parts.append(''.join(cur)); cur = []
        else:
            cur.append(c)
        i += 1
    parts.append(''.join(cur))
    return parts

def main():
    pat = sys.argv[1] if len(sys.argv) > 1 else ''
    if not pat:
        return 1
    for alt in top_alternatives(pat):                # first alternative that round-trips wins
        seed = expand(alt)
        if seed and re.search(pat, seed, re.IGNORECASE):
            print(seed)
            return 0
    return 1

sys.exit(main())
