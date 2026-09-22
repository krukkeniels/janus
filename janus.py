#!/usr/bin/env python3
"""Janus 4.0: a small durable flow engine for Codex. One file, standard library plus PyYAML.
A flow imports the primitives with ``from janus import ...``; see janus-4.0-spec.md sections 4 to 9."""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import runpy
import shutil
import subprocess
import sys
import tempfile
import traceback
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

import yaml

# --- constants, errors and engine state ------------------------------------

GOAL_FILE = "JANUS.md"
JOURNAL_FILE = "journal.yaml"
FLOW_FILE = "flow.py"
PREAMBLE_FILE = "prompts/_preamble.md"


class JanusError(Exception):
    """Engine and flow errors that stop the run."""


class Exhausted(Exception):
    """Raised by ralph after max_iter iterations without success; .last is the final result."""
    def __init__(self, last: Any) -> None:
        super().__init__("ralph exhausted")
        self.last = last


# Engine state for one run; begin() resets all of it.
ROOT = Path(".")
JOURNAL: Dict[str, Any] = {"flow": FLOW_FILE, "started": None, "steps": {}}
CONTEXT: Dict[str, Any] = {}
COUNTERS: Dict[str, int] = {}
LIVE: set = set()
CURRENT: Optional[str] = None
REPLAYING = False  # True while the last step came from the journal; log() then skips Progress


def now() -> str:
    return dt.datetime.now().isoformat(timespec="seconds")


def write_atomic(path: Path, text: str) -> None:
    """Write through a temporary file in the same directory, then rename over the target."""
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=path.name + ".", suffix=".tmp")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(text)
    os.replace(tmp, str(path))


def begin(root: Path) -> None:
    """Reset the engine for one run rooted at ``root`` and load its journal, or start a fresh one."""
    global ROOT, JOURNAL, CONTEXT, COUNTERS, LIVE, CURRENT, REPLAYING
    ROOT = Path(root)
    path, fresh = ROOT / JOURNAL_FILE, {"flow": FLOW_FILE, "started": now(), "steps": {}}
    JOURNAL = yaml.safe_load(path.read_text(encoding="utf-8")) if path.exists() else fresh
    JOURNAL.setdefault("steps", {})
    CONTEXT, COUNTERS, LIVE, CURRENT = {}, {}, set(), None
    REPLAYING = bool(JOURNAL["steps"])


def save_journal(key: str, status: str) -> None:
    """Write journal.yaml atomically at every status change of ``key``."""
    write_atomic(ROOT / JOURNAL_FILE, yaml.safe_dump(JOURNAL, sort_keys=False, allow_unicode=True))


# --- JANUS.md --------------------------------------------------------------

def read_goal_file() -> List[str]:
    path = ROOT / GOAL_FILE
    return path.read_text(encoding="utf-8").splitlines() if path.exists() else []


def write_goal_file(lines: List[str]) -> None:
    write_atomic(ROOT / GOAL_FILE, "\n".join(lines).rstrip("\n") + "\n")


def find_section(lines: List[str], heading: str) -> Optional[Tuple[int, int]]:
    """Line range [start, end) of the section with exactly this heading line; ### and deeper belong to it."""
    for i, line in enumerate(lines):
        if line.rstrip() == heading:
            j = i + 1
            while j < len(lines) and not re.match(r"#{1,2} ", lines[j]):
                j += 1
            return i, j
    return None


def remove_section(heading: str) -> None:
    lines = read_goal_file()
    span = find_section(lines, heading)
    if span is not None:
        del lines[span[0]:span[1]]
        write_goal_file(lines)


def append_to_section(heading: str, new_lines: List[str]) -> None:
    """Append lines at the end of a section, creating the section at the end of the file if needed."""
    lines = read_goal_file()
    span = find_section(lines, heading)
    if span is None:
        lines += ([""] if lines and lines[-1].strip() else []) + [heading]
        span = (len(lines) - 1, len(lines))
    end = span[1]
    while end > span[0] + 1 and not lines[end - 1].strip():  # keep the blank line before the next heading
        end -= 1
    lines[end:end] = new_lines
    write_goal_file(lines)


def goal() -> str:
    lines = read_goal_file()
    span = find_section(lines, "# Goal")
    if span is None:
        raise JanusError(f"{GOAL_FILE} has no '# Goal' section")
    return "\n".join(lines[span[0] + 1:span[1]]).strip()


def log(text: str) -> None:
    print(text)
    lines = text.splitlines() or [""]
    if not REPLAYING:  # a replayed run repeats the print, not the Progress line
        append_to_section("## Progress", [f"- {now()} {lines[0]}"] + [f"  {line}" for line in lines[1:]])
