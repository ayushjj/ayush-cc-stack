#!/usr/bin/env python3
"""Grade a bookmark-checklist run against an answer key written BEFORE the run.

Usage: python3 -I grade-checklist.py [--subset] <answer-key.json> <run-output.jsonl> [more.jsonl ...]
  --subset: the run also holds items not in the key (a weekly run graded on its 3 controls); ignore them.

answer-key.json: [{"id", "rating": HIGH|MEDIUM|LOW|SKIP, "reject_terms": [...] (optional)}]
  rating = the owner-reviewed verdict on the bookmark (e.g. 2026-10-23 walk-through).
  reject_terms = words of an idea the owner rejected; a setup card containing them is a failure.
run output: one JSON object per id with "survived_fast" (bool), "routes" (list), "card" (str|null).

Bars (plan specs/weekly-run/plan.md §6): every HIGH survives the fast pass; at least 14/17 SKIP
(scaled to the key) are dropped; no rejected idea comes back as a setup card; overall survival <= 50%.
Exit 0 = all bars met, 1 = a bar failed, 2 = bad input or internal error. Callers read stdout:
`RESULT: PASS` / `RESULT: FAIL` (checklist drift) / `BAD INPUT` (rows malformed — not drift) /
`INTERNAL ERROR` (a grader bug — not drift).
"""
import json
import re
import sys


RATINGS = {"HIGH", "MEDIUM", "LOW", "SKIP"}


def load(args: list[str]) -> tuple[dict[str, dict], dict[str, dict]]:
    """Read the key and the run rows. Any malformed input raises ValueError (→ exit 2, never a failed bar)."""
    with open(args[0]) as fh:
        raw_key = json.load(fh)
    if not isinstance(raw_key, list) or not raw_key:
        raise ValueError("answer key must be a non-empty JSON list")
    key: dict[str, dict] = {}
    for k in raw_key:
        if not (isinstance(k, dict) and isinstance(k.get("id"), str)):
            raise ValueError(f"key entry without a string id: {str(k)[:80]}")
        if k.get("rating") not in RATINGS:
            raise ValueError(f"{k['id']}: rating must be one of {sorted(RATINGS)}")
        terms = k.get("reject_terms", [])
        if not (isinstance(terms, list) and all(isinstance(t, str) and t.strip() for t in terms)):
            raise ValueError(f"{k['id']}: reject_terms must be a list of non-empty strings")
        if k["id"] in key:
            raise ValueError(f"{k['id']}: duplicate key id")
        key[k["id"]] = k
    rows: dict[str, dict] = {}
    for path in args[1:]:
        with open(path) as fh:
            for line in fh:
                if line.strip():
                    row = json.loads(line)
                    if not isinstance(row, dict) or not isinstance(row.get("id"), str):
                        raise ValueError(f"row is not an object with an id: {line[:80]}")
                    if row["id"] in rows:
                        raise ValueError(f"{row['id']}: appears twice")
                    rows[row["id"]] = row
    return key, rows


def is_card(row: dict) -> bool:
    # route labels vary ("setup-card", "setup card — owner", ...): match the normalised prefix
    return any(str(r).lower().replace(" ", "-").startswith("setup-card") for r in (row.get("routes") or []))


def valid_row(row: dict) -> bool:
    # a row routed to a setup card must carry the card's text, or its reject check could never fire
    card_ok = (isinstance(row.get("card"), str) and bool(row["card"].strip())) if is_card(row) \
        else (row.get("card") is None or isinstance(row["card"], str))
    return isinstance(row.get("survived_fast"), bool) and isinstance(row.get("routes"), list) and card_ok


def main() -> int:
    subset = "--subset" in sys.argv[1:]
    args = [a for a in sys.argv[1:] if a != "--subset"]
    if len(args) < 2:
        print("BAD INPUT: usage: grade-checklist.py [--subset] <answer-key.json> <run-output.jsonl> [more.jsonl ...]")
        return 2
    try:
        key, out = load(args)
    except (OSError, ValueError, KeyError, TypeError) as e:  # bad input is exit 2, never mistaken for a failed bar
        print(f"BAD INPUT: {e}")
        return 2
    if subset:  # only keyed rows are graded: a row with bad FIELDS for another bookmark is ignored, but an
                # unparseable file, a duplicate id or a row with no id still stops grading (BAD INPUT, not drift)
        out = {i: out[i] for i in out if i in key}
    missing, extra = sorted(set(key) - set(out)), sorted(set(out) - set(key))
    bad = sorted(i for i in out if not valid_row(out[i]))
    if missing or extra or bad:
        print(f"BAD INPUT: missing {len(missing)} {missing[:5]}, extra {len(extra)} {extra[:5]}, malformed {bad[:5]}")
        return 2

    by = {}
    for i, k in key.items():
        by.setdefault(k["rating"], []).append(out[i])

    def survived(rows):
        return sum(1 for r in rows if r.get("survived_fast"))

    fails = []
    print("rating  n  survived-fast  setup-cards")
    for rating in ("HIGH", "MEDIUM", "LOW", "SKIP"):
        rows = by.get(rating, [])
        cards = sum(1 for r in rows if is_card(r))
        print(f"{rating:6} {len(rows):3}  {survived(rows):13}  {cards:11}")

    high = by.get("HIGH", [])
    missed = [r["id"] for r in high if not r.get("survived_fast")]
    if missed:
        fails.append(f"HIGH dropped at fast pass: {missed}")
    skip = by.get("SKIP", [])
    need = -(-14 * len(skip) // 17) if skip else 0  # 14 of 17, scaled, rounded up
    dropped = len(skip) - survived(skip)
    if dropped < need:
        fails.append(f"SKIP dropped {dropped}/{len(skip)}, need >= {need}")
    total = len(out)
    rate = sum(1 for r in out.values() if r.get("survived_fast")) / total
    if rate > 0.5 and not subset:  # the survival bar needs a real week's mix, not the 3 planted controls
        fails.append(f"survival {rate:.0%} > 50% (filter too soft)")
    for i, k in key.items():
        card = (out[i].get("card") or "").lower()
        # leading guard only (so "hooks" doesn't match "webhooks"), no trailing one (plurals, -ing, "C++", ".env" still
        # match); any run of whitespace in the term matches any run in the card (cards are model-written and wrap)
        hit = [t for t in k.get("reject_terms", [])
               if re.search(r"(?<!\w)" + r"\s+".join(map(re.escape, t.lower().split())), card)]
        if hit and is_card(out[i]):
            fails.append(f"{i}: rejected idea came back as a setup card ({hit})")

    print(f"overall survival {rate:.0%} ({total} items)")
    for f in fails:
        print("FAIL:", f)
    print("RESULT:", "PASS" if not fails else f"FAIL ({len(fails)})")
    return 1 if fails else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:  # a bug here must never read as "a bar failed" (exit 1)
        print(f"INTERNAL ERROR: {e!r}")
        sys.exit(2)
