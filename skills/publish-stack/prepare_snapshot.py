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

Usage:
  prepare_snapshot.py --source ~/.claude --target /path/to/public/repo \
      [--manifest <path>]  [--quiet]
Exit codes: 0 ok, 2 bad args / missing source-manifest item that aborts.
"""
from __future__ import annotations

import argparse
import os
import re
import shutil
import sys
from pathlib import Path

USERS_PATH_RE = re.compile(r"/Users/[A-Za-z0-9._-]+/")
PRINCIPLE_RE = re.compile(r"^P(\d+)-(.+)\.md$")
# Public-only curated artifacts the sync must never create/overwrite/delete.
PROTECTED = {"README.md", "LICENSE", "MEMORY.md.template", "settings.json.minimal"}
PROTECTED_DIRS = {"learnings"}


def log(msg: str, quiet: bool = False) -> None:
    if not quiet:
        print(msg)


def parse_manifest(path: Path) -> dict[str, list[str]]:
    out: dict[str, list[str]] = {"file": [], "dir": [], "skill": []}
    for raw in path.read_text().splitlines():
        line = raw.split("#", 1)[0].strip()
        if not line:
            continue
        kind, _, val = line.partition(":")
        if kind in out and val:
            out[kind].append(val.strip())
        else:
            print(f"  WARN: unparseable manifest line: {raw!r}", file=sys.stderr)
    return out


def normalize_paths_in_text_files(root: Path, quiet: bool) -> int:
    """Replace /Users/<name>/ -> ~/ in .md files under root. Returns count changed."""
    changed = 0
    for p in root.rglob("*.md"):
        try:
            txt = p.read_text()
        except (UnicodeDecodeError, OSError):
            continue
        new = USERS_PATH_RE.sub("~/", txt)
        if new != txt:
            p.write_text(new)
            changed += 1
    log(f"  path-normalize: rewrote /Users/<name>/ -> ~/ in {changed} .md file(s)", quiet)
    return changed


def renumber_principles(source: Path, target: Path, quiet: bool) -> list[tuple[str, str]]:
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
        old_base = srcf.stem            # e.g. P50-right-context-token-shape
        new_base = f"P{i:02d}-{slug}"    # e.g. P01-right-context-token-shape
        shutil.copy2(srcf, dst_dir / f"{new_base}.md")
        if old_base != new_base:
            mapping.append((old_base, new_base))
    return mapping


def rewrite_claude_md_refs(target: Path, mapping: list[tuple[str, str]], quiet: bool) -> None:
    """Rewrite principles/<old> -> principles/<new> path refs in target CLAUDE.md."""
    cm = target / "CLAUDE.md"
    if not cm.exists():
        return
    txt = cm.read_text()
    for old_base, new_base in mapping:
        txt = txt.replace(f"principles/{old_base}", f"principles/{new_base}")
    # Flag any leftover principles/PNN ref that has no mapping (don't guess).
    leftovers = sorted(set(re.findall(r"principles/P\d+-[A-Za-z0-9-]+", txt)))
    mapped_new = {f"principles/{n}" for _, n in mapping}
    unmapped = [r for r in leftovers if r not in mapped_new and not any(
        r == f"principles/{n}" for _, n in mapping)]
    cm.write_text(txt)
    if unmapped:
        log("  FLAG: CLAUDE.md principle refs with no source mapping (verify by hand):", quiet)
        for r in unmapped:
            log(f"    - {r}", quiet)


def copy_file(source: Path, target: Path, rel: str, quiet: bool) -> bool:
    src = source / rel
    if not src.exists():
        print(f"  MISSING (manifest item absent from source): {rel}", file=sys.stderr)
        return False
    dst = target / rel
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dst)
    return True


def copy_tree(source: Path, target: Path, rel: str, quiet: bool) -> bool:
    src = source / rel
    if not src.is_dir():
        print(f"  MISSING (manifest dir absent from source): {rel}", file=sys.stderr)
        return False
    shutil.copytree(src, target / rel, dirs_exist_ok=True)
    return True


def flag_stale(source: Path, target: Path, manifest: dict[str, list[str]], quiet: bool) -> None:
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


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", default=str(Path.home() / ".claude"))
    ap.add_argument("--target", required=True)
    ap.add_argument("--manifest", default=str(Path(__file__).with_name("publish_manifest.txt")))
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()

    source = Path(args.source).expanduser().resolve()
    target = Path(args.target).expanduser().resolve()
    manifest_path = Path(args.manifest).expanduser()
    q = args.quiet

    if not source.is_dir() or not target.is_dir() or not manifest_path.is_file():
        print(f"ERROR: source/target must be dirs and manifest must exist "
              f"(source={source} target={target} manifest={manifest_path})", file=sys.stderr)
        return 2

    manifest = parse_manifest(manifest_path)
    log(f"prepare_snapshot: {source} -> {target}", q)
    log(f"  manifest: {len(manifest['file'])} files, {len(manifest['dir'])} dirs, "
        f"{len(manifest['skill'])} skills", q)

    # B1 — copy the allowlisted set (skipping protected public-only artifacts).
    for rel in manifest["file"]:
        if Path(rel).name in PROTECTED:
            continue
        copy_file(source, target, rel, q)
    for rel in manifest["dir"]:
        if rel == "principles":
            continue  # handled by renumber pass below
        copy_tree(source, target, rel, q)
    for name in manifest["skill"]:
        copy_tree(source, target, f"skills/{name}", q)

    # B2 — deterministic transforms: renumber principles + rewrite refs + paths.
    mapping = renumber_principles(source, target, q)
    rewrite_claude_md_refs(target, mapping, q)
    normalize_paths_in_text_files(target, q)

    # Report the principle mapping for human review.
    if mapping:
        log("\n  principle renumber map (old -> new):", q)
        for old, new in mapping:
            log(f"    {old}  ->  {new}", q)

    flag_stale(source, target, manifest, q)
    log("\nprepare_snapshot: DONE (no commit, no push — run F-prepublish-checklist next).", q)
    return 0


if __name__ == "__main__":
    sys.exit(main())
