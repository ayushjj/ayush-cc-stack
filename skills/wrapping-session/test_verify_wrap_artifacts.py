#!/usr/bin/env python3
"""Both-directions tests for verify_wrap_artifacts.py.

A compression governor whose failure mode is "allow everything" must be proven to
BLOCK the bad case and PERMIT the good one. Every assertion here comes in that pair
where the check under test has one (some are FAIL-only-when-over-cap with no
separate "block" motion needed, e.g. the freshness lag check).

Coverage: check_label, check_memory, check_implementation, check_coverage_freshness
are covered directly (function-level, message assertions) AND end-to-end via the
CLI (subprocess, exit-code assertions for --strict vs default/warn).

Run: python3 test_verify_wrap_artifacts.py
"""
import importlib.util
import subprocess
import sys
import tempfile
from pathlib import Path

TARGET_DIR = Path(__file__).resolve().parent
TARGET = TARGET_DIR / "verify_wrap_artifacts.py"

spec = importlib.util.spec_from_file_location("vwa", TARGET)
v = importlib.util.module_from_spec(spec)
spec.loader.exec_module(v)

results = []


def check(name, cond):
    results.append((name, bool(cond)))


def fails(issues):
    return [i for i in issues if i.startswith("FAIL:")]


def infos(issues):
    return [i for i in issues if i.startswith("INFO:")]


def registry_text(project: str, label: str) -> str:
    # Mirrors session-registry.yaml's nesting: 2-space project key, 4-space
    # "- label:" list item (find_first_label's regexes, verbatim).
    return f"  {project}:\n    - label: {label}\n      next: some next-field text\n"


def memory_text(block_lines: list[str]) -> str:
    body = "\n".join(block_lines)
    return f"# MEMORY\n\n## Current State\n{body}\n\n## Next Section\nunrelated\n"


def impl_text(block_lines: list[str], marker: int | None = None, session_line: str = "Session 5") -> str:
    head = f"<!-- coverage-synced: S{marker} -->\n" if marker is not None else ""
    body = "\n".join(block_lines)
    return (
        f"{head}## Session Outcome Record (Latest)\n"
        f"{session_line}\n"
        f"{body}\n\n"
        f"### Prior Sessions\nold stuff\n"
    )


def run_cli(args):
    return subprocess.run(
        [sys.executable, str(TARGET)] + args, capture_output=True, text=True
    )


tmp = Path(tempfile.mkdtemp())

# ── check_label: over cap FAILs, under cap doesn't ──────────────────────────
reg_long = tmp / "registry_long.yaml"
reg_long.write_text(registry_text("projlong", "x" * (v.LABEL_CAP_CHARS + 10)))
issues = v.check_label(reg_long, "projlong")
check("label over cap FAILs", fails(issues))

reg_ok = tmp / "registry_ok.yaml"
reg_ok.write_text(registry_text("projok", "a clean short label → learnings/x.md"))
issues = v.check_label(reg_ok, "projok")
check("label under cap: no FAIL", not fails(issues))

# ── check_label: missing 'learnings/' pointer is INFO only, never FAIL ──────
reg_noptr = tmp / "registry_noptr.yaml"
reg_noptr.write_text(registry_text("projnoptr", "a short label with no pointer at all"))
issues = v.check_label(reg_noptr, "projnoptr")
check("label missing 'learnings/' pointer: no FAIL", not fails(issues))
check("label missing 'learnings/' pointer: INFO present",
      any("learnings/" in i for i in infos(issues)))

# ── check_memory: line cap ───────────────────────────────────────────────────
mem_lines = tmp / "memory_lines.md"
mem_lines.write_text(memory_text([f"- item {i}" for i in range(v.MEMORY_CAP_LINES + 5)]))
issues = v.check_memory(mem_lines)
check("MEMORY.md over line cap FAILs (non-blank lines)",
      any("non-blank lines" in i for i in fails(issues)))

# ── check_memory: char cap catches a giant single line the line cap misses ──
mem_chars = tmp / "memory_chars.md"
giant = "- " + ("z" * (v.MEMORY_CAP_CHARS + 100))
mem_chars.write_text(memory_text([giant, "- short a", "- short b"]))
issues = v.check_memory(mem_chars)
check("MEMORY.md giant single line: char-cap FAILs", any(" chars " in i for i in fails(issues)))
check("MEMORY.md giant single line: line-cap does NOT fire (only 3 lines)",
      not any("non-blank lines" in i for i in fails(issues)))

# ── check_memory: under both caps -> clean ───────────────────────────────────
mem_clean = tmp / "memory_clean.md"
mem_clean.write_text(memory_text(["- short a", "- short b", "- short c"]))
issues = v.check_memory(mem_clean)
check("MEMORY.md under both caps: clean (no FAIL)", not fails(issues))

# ── check_memory: missing file / missing header -> INFO skip, never FAIL ────
issues = v.check_memory(tmp / "does_not_exist.md")
check("missing MEMORY.md: INFO skip, no FAIL", not fails(issues) and infos(issues))

mem_noheader = tmp / "memory_noheader.md"
mem_noheader.write_text("# MEMORY\n\nNo Current State header here.\n")
issues = v.check_memory(mem_noheader)
check("MEMORY.md missing '## Current State' header: INFO skip, no FAIL",
      not fails(issues) and infos(issues))

# ── check_implementation: line cap ───────────────────────────────────────────
impl_lines = tmp / "impl_lines.md"
impl_lines.write_text(impl_text([f"- did {i}" for i in range(v.IMPL_CAP_LINES + 5)]))
issues = v.check_implementation(impl_lines)
check("implementation.md over line cap FAILs (non-blank lines)",
      any("non-blank lines" in i for i in fails(issues)))

# ── check_implementation: char cap ───────────────────────────────────────────
impl_chars = tmp / "impl_chars.md"
giant_impl = "- " + ("q" * (v.IMPL_CAP_CHARS + 100))
impl_chars.write_text(impl_text([giant_impl, "- x", "- y"]))
issues = v.check_implementation(impl_chars)
check("implementation.md giant single line: char-cap FAILs", any(" chars " in i for i in fails(issues)))
check("implementation.md giant single line: line-cap does NOT fire",
      not any("non-blank lines" in i for i in fails(issues)))

# ── check_implementation: under both caps -> clean ───────────────────────────
impl_clean = tmp / "impl_clean.md"
impl_clean.write_text(impl_text(["- did a", "- did b"]))
issues = v.check_implementation(impl_clean)
check("implementation.md under both caps: clean (no FAIL)", not fails(issues))

# ── check_implementation: missing file / missing header -> INFO skip ────────
issues = v.check_implementation(tmp / "impl_missing.md")
check("missing implementation.md: INFO skip, no FAIL", not fails(issues) and infos(issues))

impl_noheader = tmp / "impl_noheader.md"
impl_noheader.write_text("# Plan\n\nNo outcome-record header here.\n")
issues = v.check_implementation(impl_noheader)
check("implementation.md missing outcome-record header: INFO skip, no FAIL",
      not fails(issues) and infos(issues))

# ── check_coverage_freshness: marker lags the latest outcome record ─────────
cov_lag = tmp / "impl_cov_lag.md"
cov_lag.write_text(impl_text(["- notes"], marker=10, session_line="Session 12 wrap notes"))
issues = v.check_coverage_freshness(cov_lag)
check("coverage-synced lag: FAILs", fails(issues))
check("coverage-synced lag: names the lag (2)", any("lag 2" in i for i in fails(issues)))

# ── check_coverage_freshness: marker absent -> INFO skip, never FAIL ────────
cov_nomarker = tmp / "impl_cov_nomarker.md"
cov_nomarker.write_text(impl_text(["- notes"], marker=None, session_line="Session 12 wrap notes"))
issues = v.check_coverage_freshness(cov_nomarker)
check("coverage-synced absent: no FAIL", not fails(issues))
check("coverage-synced absent: INFO present", infos(issues))

# ── check_coverage_freshness: synced == current -> clean (empty) ────────────
cov_synced = tmp / "impl_cov_synced.md"
cov_synced.write_text(impl_text(["- notes"], marker=12, session_line="Session 12 wrap notes"))
issues = v.check_coverage_freshness(cov_synced)
check("coverage-synced == current: clean (empty issues list)", issues == [])

# ── CLI exit codes: label over cap ───────────────────────────────────────────
missing_mem = tmp / "no_memory_here.md"  # never created -> check_memory INFO-skips
warn = run_cli(["--registry", str(reg_long), "--project", "projlong", "--memory", str(missing_mem)])
strict = run_cli(["--strict", "--registry", str(reg_long), "--project", "projlong", "--memory", str(missing_mem)])
check("label over cap: warn mode exits 0", warn.returncode == 0)
check("label over cap: strict mode exits 1", strict.returncode == 1)

# ── CLI exit codes: label under cap -> strict exits 0 ────────────────────────
strict_ok = run_cli(["--strict", "--registry", str(reg_ok), "--project", "projok", "--memory", str(missing_mem)])
check("label under cap: strict mode exits 0", strict_ok.returncode == 0)

# ── CLI: strict exits 0 on a fully clean fixture set (permits the good case) ─
clean_dir = Path(tempfile.mkdtemp())
reg_full_clean = clean_dir / "registry.yaml"
reg_full_clean.write_text(registry_text("cleanproj", "short clean label → learnings/ok.md"))
mem_full_clean = clean_dir / "MEMORY.md"
mem_full_clean.write_text(memory_text(["- short a", "- short b", "- short c"]))
impl_full_clean = clean_dir / "implementation.md"
impl_full_clean.write_text(impl_text(["- did x", "- did y"], marker=5, session_line="Session 5 wrap notes"))

r = run_cli([
    "--strict",
    "--registry", str(reg_full_clean), "--project", "cleanproj",
    "--memory", str(mem_full_clean), "--implementation", str(impl_full_clean),
])
check("fully clean fixture: strict mode exits 0 (permits good case)", r.returncode == 0)
check("fully clean fixture: OK message names all three targets",
      "registry-label" in r.stdout and "memory" in r.stdout and "implementation.md" in r.stdout)

# ── check_registry_parses (S331) ───────────────────────────────────────────
# BOTH DIRECTIONS, and the multi-line case is the one that matters: the regex this
# check replaced flagged a legal multi-line single-quoted scalar as broken and
# produced two false positives that were reported to the owner and acted on.

_VALID_REGISTRY = """projects:
  demo:
    path: /tmp/demo
    sessions:
    - label: 'S2 - a clean entry'
      date: '2026-08-22'
      status: done
      next: 'do the next thing'
      duration_min: 10
      files_changed: 1
"""

# An unescaped apostrophe inside a single-quoted scalar — the exact S331 fault.
_BROKEN_REGISTRY = """projects:
  demo:
    path: /tmp/demo
    sessions:
    - label: 'S2 - a clean entry'
      date: '2026-08-22'
      status: done
      next: 'mind the buyer's apostrophe'
      duration_min: 10
      files_changed: 1
"""

# UNQUOTED `date:` — YAML resolves this to a Date object, which Ruby's psych refuses
# unless `permitted_classes` names it. Real entries in the live registry carry this
# shape. Without this fixture, dropping `permitted_classes: [Date, Time]` from the
# probe SURVIVES the whole suite (measured) while making the guard FAIL on every real
# registry — a false positive that would block every wrap for a bogus reason. This is
# the over-restrictive direction that a "does it block bad input?" suite is blind to.
_UNQUOTED_DATE_REGISTRY = """projects:
  demo:
    path: /tmp/demo
    sessions:
    - label: 'S2 - a clean entry'
      date: 2026-08-22
      status: done
      next: 'do the next thing'
      duration_min: 10
      files_changed: 1
"""

# A LEGAL multi-line single-quoted scalar. The naive one-line regex called this broken.
_MULTILINE_REGISTRY = """projects:
  demo:
    path: /tmp/demo
    sessions:
    - label: 'S2 - a clean entry'
      date: '2026-08-22'
      status: done
      next: 'first line of a long next field

        second paragraph, still inside the same scalar

        third paragraph and then it closes'
      duration_min: 10
      files_changed: 1
"""

with tempfile.TemporaryDirectory() as _td:
    _d = Path(_td)
    reg_valid = _d / "valid.yaml";      reg_valid.write_text(_VALID_REGISTRY)
    reg_broken = _d / "broken.yaml";    reg_broken.write_text(_BROKEN_REGISTRY)
    reg_multi = _d / "multi.yaml";      reg_multi.write_text(_MULTILINE_REGISTRY)
    reg_datefmt = _d / "unquoted_date.yaml"; reg_datefmt.write_text(_UNQUOTED_DATE_REGISTRY)
    reg_missing = _d / "nope.yaml"

    _valid_msgs = v.check_registry_parses(reg_valid)
    _broken_msgs = v.check_registry_parses(reg_broken)
    _multi_msgs = v.check_registry_parses(reg_multi)
    _missing_msgs = v.check_registry_parses(reg_missing)

    # If no parser is reachable the check reports CANNOT CHECK; that is a valid
    # environment outcome, but it must NOT be mistaken for a pass, so assert it loudly.
    _no_parser = any("CANNOT CHECK" in m for m in _valid_msgs)
    check("registry-yaml: a parser is reachable (else this suite proves nothing)",
          not _no_parser)

    check("registry-yaml: PERMITS a valid registry (no messages)",
          _valid_msgs == [])
    check("registry-yaml: BLOCKS an unescaped apostrophe (FAIL)",
          any(m.startswith("FAIL:") for m in _broken_msgs))
    check("registry-yaml: the FAIL names the apostrophe remedy",
          any("apostrophe" in m for m in _broken_msgs))
    check("registry-yaml: PERMITS a legal multi-line scalar (the false-positive the "
          "regex produced)", _multi_msgs == [])
    check("registry-yaml: PERMITS an unquoted date (guards the over-restrictive "
          "direction — see the fixture comment)",
          v.check_registry_parses(reg_datefmt) == [])
    # THE FAIL-OPEN PATH. It only runs when no parser is reachable, which never happens
    # on a machine that HAS ruby — so without simulating the absence, turning this branch
    # into a silent `return []` SURVIVES the whole suite (measured). `cadence-check.js`
    # states the rule this pins: silence must mean "nothing wrong", never "the reader broke".
    _real_run = v.subprocess.run
    try:
        v.subprocess.run = lambda *a, **k: (_ for _ in ()).throw(FileNotFoundError("ruby"))
        _noparser = v.check_registry_parses(reg_valid)
    finally:
        v.subprocess.run = _real_run
    check("registry-yaml: no parser reachable reports CANNOT CHECK, not silence",
          _noparser and any("CANNOT CHECK" in m for m in _noparser))
    check("registry-yaml: the CANNOT CHECK line says it is not a pass",
          any("Not a pass" in m for m in _noparser))

    check("registry-yaml: a missing registry is INFO, never FAIL",
          _missing_msgs and not any(m.startswith("FAIL:") for m in _missing_msgs))

    # End-to-end: --strict must actually exit 1 on the broken file, 0 on the valid one.
    _r_bad = subprocess.run(
        [sys.executable, str(TARGET), "--strict", "--registry", str(reg_broken),
         "--project", "demo", "--memory", str(_d / "absent-MEMORY.md")],
        capture_output=True, text=True)
    check("registry-yaml: --strict exits 1 on a broken registry", _r_bad.returncode == 1)

    _r_ok = subprocess.run(
        [sys.executable, str(TARGET), "--registry", str(reg_valid),
         "--project", "demo", "--memory", str(_d / "absent-MEMORY.md")],
        capture_output=True, text=True)
    check("registry-yaml: clean registry, --strict exits 0",
          _r_ok.returncode == 0 and "registry-yaml" in _r_ok.stdout)

    # ── THE OLD-RUBY CASE (S331 MUST-FIX-1) ────────────────────────────────
    # This box has TWO rubies and PATH picks one: rbenv 3.4.7, and /usr/bin/ruby 2.6.10
    # whose psych predates the `permitted_classes:` KEYWORD on load_file. The first draft
    # of this check used that keyword form, so under the system ruby it exited non-zero
    # on a PERFECTLY VALID registry and reported it as invalid — blocking every wrap on
    # every project and blaming an apostrophe that did not exist. Nothing in the suite
    # saw it, because the suite ran with rbenv's ruby on PATH.
    _sys_ruby = Path("/usr/bin/ruby")
    if _sys_ruby.exists():
        _r_old = subprocess.run(
            [sys.executable, str(TARGET), "--strict", "--registry", str(reg_valid),
             "--project", "demo", "--memory", str(_d / "absent-MEMORY.md")],
            capture_output=True, text=True, env={"PATH": "/usr/bin:/bin"})
        check("registry-yaml: a valid registry PASSES under the system ruby too "
              "(no permitted_classes keyword)", _r_old.returncode == 0)

        _r_old_bad = subprocess.run(
            [sys.executable, str(TARGET), "--strict", "--registry", str(reg_broken),
             "--project", "demo", "--memory", str(_d / "absent-MEMORY.md")],
            capture_output=True, text=True, env={"PATH": "/usr/bin:/bin"})
        check("registry-yaml: a broken registry still BLOCKS under the system ruby",
              _r_old_bad.returncode == 1)
    else:
        check("registry-yaml: system-ruby cases skipped (/usr/bin/ruby absent)", True)

    # ── THE LIVE FILE ──────────────────────────────────────────────────────
    # Every fixture above is small and hand-written. The real registry is ~14k lines with
    # entry shapes no fixture reproduces, and it is the only file this check ever runs
    # against in production. It also doubles as the timeout's positive control (0.19s).
    _live = Path.home() / ".claude" / "session-registry.yaml"
    if _live.exists():
        check("registry-yaml: the LIVE session-registry parses",
              v.check_registry_parses(_live) == [])
    else:
        check("registry-yaml: live-registry case skipped (file absent)", True)

    # ── A PARSER FAULT MUST NOT BE BLAMED ON THE FILE ──────────────────────
    # Non-zero exit with no Psych marker = the parser is broken, not the registry.
    # Without this, any future ruby-invocation change reintroduces MUST-FIX-1 silently.
    class _FakeProc:
        returncode = 1
        stdout = ""
        stderr = "-e:1:in `<main>': unknown keyword: permitted_classes (ArgumentError)"

    _real_run2 = v.subprocess.run
    try:
        v.subprocess.run = lambda *a, **k: _FakeProc()
        _parser_fault = v.check_registry_parses(reg_valid)
    finally:
        v.subprocess.run = _real_run2
    check("registry-yaml: a parser fault degrades to CANNOT CHECK, never FAIL",
          _parser_fault and not any(m.startswith("FAIL:") for m in _parser_fault)
          and any("CANNOT CHECK" in m for m in _parser_fault))

    # A ruby that exits 0 WITHOUT parsing (a wrapper script, a stubbed binary) must not
    # be read as a pass — that is what the PARSE_OK sentinel on stdout is for. Without
    # this, deleting the sentinel check survives the whole suite.
    class _SilentZero:
        returncode = 0
        stdout = ""
        stderr = ""

    _real_run3 = v.subprocess.run
    try:
        v.subprocess.run = lambda *a, **k: _SilentZero()
        _silent = v.check_registry_parses(reg_valid)
    finally:
        v.subprocess.run = _real_run3
    check("registry-yaml: exit 0 without PARSE_OK is NOT a pass",
          _silent != [])

    # The apostrophe remedy must appear only for a SYNTAX fault. An anchor is a real
    # file-level fault (psych rejects it without aliases:true) but has nothing to do with
    # quoting, and the hint is the operator's primary debugging artifact when the wrap is
    # blocked. Without this, ungating the hint survives the suite.
    reg_anchor = _d / "anchor.yaml"
    reg_anchor.write_text("""defaults: &d
  status: done
projects:
  demo:
    path: /tmp/demo
    sessions:
    - label: 'S2 - anchored'
      <<: *d
""")
    _anchor_msgs = v.check_registry_parses(reg_anchor)
    check("registry-yaml: an anchor is a FAIL (psych rejects it)",
          any(m.startswith("FAIL:") for m in _anchor_msgs))
    check("registry-yaml: a non-syntax FAIL does NOT blame an apostrophe",
          _anchor_msgs and not any("apostrophe" in m for m in _anchor_msgs))

    # ── --strict EXIT CODES for the non-FAIL states (S331 CONSIDER-6) ──────
    # The gate's correctness rests on the literal `FAIL:` prefix at the filter. Reword
    # CANNOT CHECK to lead with FAIL and every wrap on a parser-less machine blocks.
    _r_missing = subprocess.run(
        [sys.executable, str(TARGET), "--strict", "--registry", str(reg_missing),
         "--project", "demo", "--memory", str(_d / "absent-MEMORY.md")],
        capture_output=True, text=True)
    check("registry-yaml: --strict exits 0 when the registry is missing",
          _r_missing.returncode == 0)

# ── report ─────────────────────────────────────────────────────────────────
passed = sum(1 for _, ok in results if ok)
for name, ok in results:
    print(f"  {'PASS' if ok else 'FAIL'}  {name}")
print(f"\n{passed}/{len(results)} passed")
sys.exit(0 if passed == len(results) else 1)
