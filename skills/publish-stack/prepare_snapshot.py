#!/usr/bin/env python3
"""prepare_snapshot.py — deterministic prepare half of /publish-stack (B1-B2).

Copies the manifest-listed subset of a private ~/.claude OS into a public-repo
working copy, renumbers principles P50..->P01.. (rewriting CLAUDE.md path refs),
and normalizes absolute /Users/<name>/ paths to ~/. It NEVER commits, pushes, or
runs the leak sweep (that is the human's job per decisions.md D7), and it is
CONSERVATIVE: it copies + flags stale target items but never auto-deletes
(avoids the public-only README/LICENSE footgun).

Universal by construction (P68): no hardcoded paths or business tokens — the
target path comes from argv, the allowlist from publish_manifest.txt.

It then SANITIZES at copy time: every match of the private denylist
(.skill-audit-patterns — the same classes denylist_gate.sh sweeps) is replaced
with [redacted] in exactly the files this run wrote — never anything else in the
target (hand-kept, often gitignored files there exist nowhere else; S78 lost four).
The written set is then re-scanned with grep -E (the gate's engine, not Python's),
binaries included; any surviving match fails the run. It refuses to run at all if
the manifest would publish the patterns file itself.

Usage:
  prepare_snapshot.py --source ~/.claude --target /path/to/public/repo \
      [--manifest <path>] [--patterns <path>] [--quiet]
Exit codes: 0 ok, 1 sanitizer left a match / broke a file, 2 bad args / refused /
unusable patterns.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import TypeAlias

Manifest: TypeAlias = "dict[str, list[str]]"
Patterns: TypeAlias = "dict[str, tuple[str, re.Pattern[str]]]"  # key -> (raw ERE, redactor)

USERS_PATH_RE = re.compile(r"/Users/[A-Za-z0-9._-]+/")
# The same username in Claude's dash-encoded project slugs (~/.claude/projects/-Users-<name>-...).
USERS_SLUG_RE = re.compile(r"(?<![A-Za-z0-9])-Users-[A-Za-z0-9._]+")
PRINCIPLE_RE = re.compile(r"^P(\d+)-(.+)\.md$")
# Public-only curated artifacts the sync must never create/overwrite/delete.
PROTECTED = {"README.md", "LICENSE", "MEMORY.md.template", "settings.json.minimal"}
PROTECTED_DIRS = {"learnings"}
# Build/OS detritus never published: .pyc files embed absolute source paths (S78 review).
COPY_IGNORE = shutil.ignore_patterns("__pycache__", "*.pyc", ".DS_Store")

REDACTED = "[redacted]"
PATTERNS_BASENAME = ".skill-audit-patterns"
# Classes mirror denylist_gate.sh sweep(): D2_PUB is scoped (CLAUDE.md keeps its
# provenance counts/dates, F-checklist:28); every other class covers the whole set.
SANITIZE_CLASSES = ["D1", "D2_PUB", "D3", "D4", "D5"]
SCOPED_EXEMPT = {"D2_PUB": {"CLAUDE.md"}}


class Refused(Exception):
    """A precondition failed; nothing safe can be produced (exit 2)."""


def log(msg: str, quiet: bool = False) -> None:
    if not quiet:
        print(msg)


def load_patterns(path: Path) -> Patterns:
    """Source the shell-format patterns file with bash (exactly as the gate does).
    Error text never echoes bash's stderr — it can contain pattern values."""
    script = 'source "$1"; for k in ' + " ".join(SANITIZE_CLASSES) + \
        '; do v="${!k-}"; [ "$k" = D2_PUB ] && v="${D2_PUB-${D2-}}"; printf "%s\\0" "$v"; done'
    try:
        res = subprocess.run(["bash", "-c", script, "_", str(path)], capture_output=True,
                             stdin=subprocess.DEVNULL, timeout=30)
    except (OSError, subprocess.TimeoutExpired) as e:
        raise Refused(f"could not run bash to read patterns ({type(e).__name__})")
    if res.returncode != 0:
        raise Refused(f"bash could not source {path} (rc={res.returncode})")
    values = res.stdout.decode("utf-8", "replace").rstrip("\0").split("\0")
    if len(values) != len(SANITIZE_CLASSES):
        raise Refused(f"expected {len(SANITIZE_CLASSES)} pattern classes, got {len(values)}")
    out: Patterns = {}
    for key, val in zip(SANITIZE_CLASSES, values):
        if not val:
            raise Refused(f"pattern {key} is empty — refusing a sanitize that skips a class")
        try:
            # grep -i matches per line: MULTILINE keeps ^/$ per line. The [\w-]* wings absorb
            # the rest of a token, because Python alternation is leftmost-FIRST and grep's is
            # leftmost-LONGEST — 'a|ab' on 'ab' would otherwise leave a 'b' tail behind.
            rx = re.compile(r"[\w-]*(?:" + val + r")[\w-]*", re.IGNORECASE | re.MULTILINE)
        except re.error as e:
            raise Refused(f"pattern {key} does not compile in Python ({e.msg})")
        if rx.fullmatch(""):
            raise Refused(f"pattern {key} matches the empty string")
        out[key] = (val, rx)
    return out


def parse_manifest(path: Path) -> Manifest:
    out: Manifest = {"file": [], "dir": [], "skill": []}
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.split("#", 1)[0].strip()
        if not line:
            continue
        kind, _, val = line.partition(":")
        val = val.strip()
        if kind in out and val:
            if Path(val).is_absolute() or ".." in Path(val).parts or val in (".", ""):
                raise Refused(f"manifest entry escapes the source/target root: {raw!r}")
            out[kind].append(val)
        else:
            print(f"  WARN: unparseable manifest line: {raw!r}", file=sys.stderr)
    return out


def manifest_roots(source: Path, manifest: Manifest) -> list[Path]:
    roots = [source / r for r in manifest["file"] + manifest["dir"]]
    return roots + [source / "skills" / n for n in manifest["skill"]]


def publishes_patterns(source: Path, manifest: Manifest, secret: Path) -> list[str]:
    """Every source file the run would copy that IS the denylist (by resolved path, or by
    name — a copy under another path is still the denylist). Follows symlinks like copytree."""
    secret = secret.resolve()
    hits: list[str] = []
    for root in manifest_roots(source, manifest):
        if root.is_file():
            candidates = [root]
        elif root.is_dir():
            candidates = [Path(d) / f for d, _, fs in os.walk(root, followlinks=True) for f in fs]
        else:
            continue
        for c in candidates:
            if c.name == PATTERNS_BASENAME or c.resolve() == secret:
                hits.append(str(c))
    return hits


def normalize_paths(files: list[Path], quiet: bool) -> None:
    """Replace /Users/<name>/ -> ~/ in the files this run wrote (never elsewhere)."""
    changed = 0
    for p in files:
        txt = read_text(p)
        if txt is None:
            continue
        new = USERS_SLUG_RE.sub("-Users-<you>", USERS_PATH_RE.sub("~/", txt))
        if new != txt:
            p.write_text(new, encoding="utf-8")
            changed += 1
    log(f"  path-normalize: rewrote /Users/<name>/ -> ~/ in {changed} file(s)", quiet)


def renumber_principles(source: Path, target: Path, written: list[Path]) -> list[tuple[str, str]]:
    """Copy source principles renumbered to contiguous P01.., return [(old,new)] map."""
    src_dir = source / "principles"
    dst_dir = target / "principles"
    dst_dir.mkdir(parents=True, exist_ok=True)
    files = []
    for f in src_dir.iterdir():
        m = PRINCIPLE_RE.match(f.name)
        if m:
            files.append((int(m.group(1)), m.group(2), f))
    files.sort(key=lambda t: t[0])
    mapping: list[tuple[str, str]] = []
    for i, (_, slug, srcf) in enumerate(files, start=1):
        old_base = srcf.stem            # e.g. P02-right-context-token-shape
        new_base = f"P{i:02d}-{slug}"    # e.g. P01-right-context-token-shape
        dst = dst_dir / f"{new_base}.md"
        safe_copy(srcf, dst, target, written)
        # The title shows both numbers ("# P17 (private P68) — ..."): CLAUDE.md and skills cite
        # principles by bare private number, so a reader grepping "P68" must still land here.
        txt = read_text(dst)
        if txt is not None:
            dst.write_text(re.sub(r"\A# P(\d+)\b", lambda m: f"# P{i:02d} (private P{m.group(1)})", txt),
                           encoding="utf-8")
        if old_base != new_base:
            mapping.append((old_base, new_base))
    return mapping


def rewrite_principle_refs(mapping: list[tuple[str, str]], written: list[Path]) -> None:
    """Rewrite private principle basenames (P68-slug) to public ones (P17-slug) in every
    file this run wrote — not only CLAUDE.md (S78: governance.md and skills kept P68 refs).
    Two passes through placeholders, because old and new numbers overlap (P10 -> P17 while
    another P36 -> P01)."""
    if not mapping:
        return
    for p in written:
        txt = read_text(p)
        if txt is None:
            continue
        new = txt
        for i, (old_base, _) in enumerate(mapping):
            new = re.sub(rf"\b{re.escape(old_base)}\b", f"\0PRINCIPLE{i}\0", new)
        for i, (_, new_base) in enumerate(mapping):
            new = new.replace(f"\0PRINCIPLE{i}\0", new_base)
        if new != txt:
            p.write_text(new, encoding="utf-8")


def flag_unmapped_claude_md_refs(target: Path, mapping: list[tuple[str, str]], written: list[Path],
                                 quiet: bool) -> None:
    """Flag principles/PNN refs in target CLAUDE.md that no public file backs (don't guess)."""
    cm = target / "CLAUDE.md"
    if cm not in written:
        return
    txt = read_text(cm) or ""
    mapped_new = {f"principles/{n}" for _, n in mapping}
    unmapped = sorted(set(re.findall(r"principles/P\d+-[A-Za-z0-9-]+", txt)) - mapped_new)
    if unmapped:
        log("  FLAG: CLAUDE.md principle refs with no source mapping (verify by hand):", quiet)
        for r in unmapped:
            log(f"    - {r}", quiet)


# settings.json keys that carry per-project context rather than reusable configuration.
# `autoMode.environment` describes whatever project the live config was last tuned for —
# deploy hosts, private repo slugs, absolute paths — so it re-leaks on EVERY refresh unless
# it is stripped at copy time. Publishing the rest of settings.json is still useful.
SETTINGS_STRIP_KEYS = [("autoMode", "environment")]


def check_inside(dst: Path, target: Path) -> None:
    """Never write through a symlink or outside the target (a write through a link
    rewrites a file this run does not own)."""
    if dst.is_symlink() or not dst.parent.resolve().is_relative_to(target):
        raise Refused(f"refusing to write through a symlink / outside target: {dst}")


def safe_copy(src: Path, dst: Path, target: Path, written: list[Path]) -> None:
    check_inside(dst, target)
    shutil.copy2(src, dst)
    written.append(dst)


def copy_file(source: Path, target: Path, rel: str, written: list[Path], quiet: bool) -> None:
    src = source / rel
    if not src.exists():
        print(f"  MISSING (manifest item absent from source): {rel}", file=sys.stderr)
        return
    dst = target / rel
    dst.parent.mkdir(parents=True, exist_ok=True)

    if rel == "settings.json":
        check_inside(dst, target)
        data = json.loads(src.read_text())
        stripped = []
        for parent, child in SETTINGS_STRIP_KEYS:
            if isinstance(data.get(parent), dict) and child in data[parent]:
                n = len(data[parent][child])
                del data[parent][child]
                stripped.append(f"{parent}.{child} ({n} entries)")
        dst.write_text(json.dumps(data, indent=2) + "\n")
        written.append(dst)
        if stripped:
            log(f"  settings.json: stripped project-specific {', '.join(stripped)}", quiet)
        return

    safe_copy(src, dst, target, written)


def copy_tree(source: Path, target: Path, rel: str, written: list[Path]) -> None:
    src = source / rel
    if not src.is_dir():
        print(f"  MISSING (manifest dir absent from source): {rel}", file=sys.stderr)
        return
    dst_root = target / rel
    check_inside(dst_root, target)

    def record(s: str, d: str) -> str:
        safe_copy(Path(s), Path(d), target, written)
        return d

    shutil.copytree(src, dst_root, dirs_exist_ok=True, ignore=COPY_IGNORE, copy_function=record)


def read_text(p: Path) -> str | None:
    try:
        return p.read_text(encoding="utf-8")
    except (UnicodeDecodeError, OSError):
        return None


def sanitize(files: list[Path], target: Path, patterns: Patterns, quiet: bool) -> list[str]:
    """Replace denylist matches with [redacted]. Logs counts only — never the tokens.
    Returns files it could not read as UTF-8 (left for the grep re-scan to judge)."""
    total, undecodable = 0, []
    for p in files:
        rel = str(p.relative_to(target))
        txt = read_text(p)
        if txt is None:
            undecodable.append(rel)
            continue
        new, counts = txt, []
        for key, (_, rx) in patterns.items():
            if rel in SCOPED_EXEMPT.get(key, set()):
                continue
            new, n = rx.subn(REDACTED, new)
            if n:
                counts.append(f"{key}x{n}")
                total += n
        if new != txt:
            p.write_text(new, encoding="utf-8")
            log(f"  sanitize: {rel}: {', '.join(counts)}", quiet)
    log(f"  sanitize: {total} denylist match(es) replaced with {REDACTED}", quiet)
    if undecodable:
        log(f"  sanitize: {len(undecodable)} non-UTF-8 file(s) not rewritten (grep re-scan judges them)", quiet)
    return undecodable


def residual_matches(files: list[Path], target: Path, patterns: Patterns) -> list[str]:
    """Independent re-scan with grep -iE — the gate's engine, which also reads binaries.
    A grep error is a failure, never a pass."""
    left: list[str] = []
    for key, (raw, _) in patterns.items():
        exempt = SCOPED_EXEMPT.get(key, set())
        scope = [str(p) for p in files if str(p.relative_to(target)) not in exempt]
        if not scope:
            continue
        # LC_ALL=C: under a UTF-8 locale macOS grep silently skips any line holding an
        # invalid byte, so a token beside one stray byte read as clean (measured S78).
        res = subprocess.run(["grep", "-liE", "--", raw, *scope], capture_output=True,
                             stdin=subprocess.DEVNULL, env={**os.environ, "LC_ALL": "C"})
        if res.returncode >= 2:
            left.append(f"(grep error rc={res.returncode} while scanning {key} — scan incomplete)")
            continue
        for line in res.stdout.decode("utf-8", "replace").splitlines():
            left.append(f"{Path(line).relative_to(target)} ({key})")
    return left


def flag_stale(source: Path, target: Path, manifest: Manifest, quiet: bool) -> None:
    """Report target items not backed by source/manifest. NEVER deletes."""
    stale: list[str] = []
    tgt_skills = target / "skills"
    allow_skills = set(manifest["skill"])
    if tgt_skills.is_dir():
        for d in tgt_skills.iterdir():
            if d.is_dir() and d.name not in allow_skills:
                stale.append(f"skills/{d.name}/  (in public repo, not in manifest)")
    # stale principles: target principle whose slug isn't in source
    src_slugs = set()
    for f in (source / "principles").iterdir():
        m = PRINCIPLE_RE.match(f.name)
        if m:
            src_slugs.add(m.group(2))
    tgt_pr = target / "principles"
    if tgt_pr.is_dir():
        for f in tgt_pr.iterdir():
            m = PRINCIPLE_RE.match(f.name)
            if m and m.group(2) not in src_slugs:
                stale.append(f"principles/{f.name}  (no matching source principle)")
    if stale:
        log("\n  STALE (present in public repo, not produced by this run — review, do NOT auto-delete):", quiet)
        for s in stale:
            log(f"    - {s}", quiet)
    else:
        log("\n  stale check: none", quiet)


def run(args: argparse.Namespace) -> int:
    source = Path(args.source).expanduser().resolve()
    target = Path(args.target).expanduser().resolve()
    manifest_path = Path(args.manifest).expanduser()
    q = args.quiet

    if not source.is_dir() or not target.is_dir() or not manifest_path.is_file():
        raise Refused(f"source/target must be dirs and manifest must exist "
                      f"(source={source} target={target} manifest={manifest_path})")

    manifest = parse_manifest(manifest_path)

    # Refuse before copying anything: the denylist itself must never be published, and a
    # sanitize without patterns is a false all-clear.
    patterns_path = Path(args.patterns).expanduser()
    leaking = publishes_patterns(source, manifest, patterns_path)
    if leaking:
        raise Refused(f"manifest would publish the private denylist via {', '.join(leaking)}")
    if not patterns_path.is_file():
        raise Refused(f"missing patterns file {patterns_path} — cannot sanitize")
    patterns = load_patterns(patterns_path)

    log(f"prepare_snapshot: {source} -> {target}", q)
    log(f"  manifest: {len(manifest['file'])} files, {len(manifest['dir'])} dirs, "
        f"{len(manifest['skill'])} skills", q)

    # B1 — copy the allowlisted set (skipping protected public-only artifacts), recording
    # every file written: that list, and only that list, is what later steps may rewrite.
    written: list[Path] = []
    for rel in manifest["file"]:
        if Path(rel).name in PROTECTED:
            continue
        copy_file(source, target, rel, written, q)
    for rel in manifest["dir"]:
        if rel == "principles" or Path(rel).parts[0] in PROTECTED_DIRS:
            continue  # principles: renumber pass below; protected: public-only
        copy_tree(source, target, rel, written)
    for name in manifest["skill"]:
        copy_tree(source, target, f"skills/{name}", written)

    # B2 — deterministic transforms: renumber principles + rewrite refs + paths + sanitize.
    mapping: list[tuple[str, str]] = []
    if "principles" in manifest["dir"]:
        mapping = renumber_principles(source, target, written)
    rewrite_principle_refs(mapping, written)
    flag_unmapped_claude_md_refs(target, mapping, written, q)
    normalize_paths(written, q)
    sanitize(written, target, patterns, q)

    problems = residual_matches(written, target, patterns)
    settings = target / "settings.json"
    if settings in written:
        try:
            json.loads(settings.read_text(encoding="utf-8"))
        except ValueError:
            problems.append("settings.json (no longer valid JSON after sanitize)")
    if problems:
        print("FAIL: denylist matches survived sanitize (fix by hand, do NOT publish):", file=sys.stderr)
        for item in problems:
            print(f"    - {item}", file=sys.stderr)
        return 1

    # Report the principle mapping for human review.
    if mapping:
        log("\n  principle renumber map (old -> new):", q)
        for old, new in mapping:
            log(f"    {old}  ->  {new}", q)

    flag_stale(source, target, manifest, q)
    log("\nprepare_snapshot: DONE (no commit, no push — run F-prepublish-checklist next).", q)
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", default=str(Path.home() / ".claude"))
    ap.add_argument("--target", required=True)
    ap.add_argument("--manifest", default=str(Path(__file__).with_name("publish_manifest.txt")))
    ap.add_argument("--patterns", default=os.environ.get(
        "SKILL_AUDIT_PATTERNS", str(Path.home() / ".claude" / PATTERNS_BASENAME)))
    ap.add_argument("--quiet", action="store_true")
    try:
        return run(ap.parse_args())
    except Refused as e:
        print(f"REFUSED: {e}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
