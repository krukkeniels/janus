#!/usr/bin/env python3
"""Janus UI: a live view of one goal folder in the browser (design 2026-09-24 section 4).
``python janus_ui.py [--port N]`` from the goal folder serves http://127.0.0.1:8765 on loopback only. It reads
``journal.yaml`` and ``JANUS.md`` on every poll and never writes, never runs the flow, never commits."""
from __future__ import annotations

import argparse
import datetime as dt
import errno
import json
import sys
from collections import Counter
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import yaml

from janus import find_section, to_mermaid

JOURNAL_FILE = "journal.yaml"
GOAL_FILE = "JANUS.md"
SUMMARY_WIDTH = 160
CODEX_KINDS = ("codex", "ai_gate")
TOKEN_KEYS = ("input", "cached", "output", "total")


# --- state -----------------------------------------------------------------

def read_journal(root: Path) -> Tuple[Dict[str, Any], Optional[str], Optional[str]]:
    """(journal, updated, error): the mapping, its mtime as ISO seconds, one error line. A missing file gives
    ({}, None, None); a corrupt one ({}, None, "journal.yaml ...") so the rest reads as for a missing journal."""
    path = root / JOURNAL_FILE
    if not path.exists():
        return {}, None, None
    try:
        loaded = yaml.safe_load(path.read_text(encoding="utf-8"))
    except yaml.YAMLError as exc:
        return {}, None, f"{JOURNAL_FILE} is not valid YAML: {' '.join(str(exc).split())}"
    if not isinstance(loaded, dict):
        return {}, None, f"{JOURNAL_FILE} is not a mapping"
    return loaded, dt.datetime.fromtimestamp(path.stat().st_mtime).isoformat(timespec="seconds"), None


def parse_time(value: Any) -> Optional[dt.datetime]:
    """An engine timestamp (ISO seconds, a string or already a datetime when YAML resolved it), else None."""
    if isinstance(value, dt.datetime):
        return value
    try:
        return dt.datetime.fromisoformat(value) if isinstance(value, str) else None
    except ValueError:
        return None


def seconds(entry: Dict[str, Any], now: dt.datetime) -> Optional[int]:
    """Whole seconds from ``started`` to ``finished``, or to ``now`` while running or open; None when unparsable."""
    started = parse_time(entry.get("started"))
    finished = now if entry.get("status") in ("running", "open") else parse_time(entry.get("finished"))
    return None if started is None or finished is None else int((finished - started).total_seconds())


def summary(entry: Dict[str, Any]) -> str:
    """One line of at most 160 characters: the result's summary or text, the answer, the error or the question."""
    status, result = entry.get("status"), entry.get("result")
    if status == "done":
        text = next((result[k] for k in ("summary", "text") if isinstance(result, dict)
                     and isinstance(result.get(k), str)), "")
    else:
        field = {"answered": "answer", "failed": "error", "open": "question"}.get(status)
        text = entry.get(field) if field else ""
    line = str(text).splitlines()[0] if text else ""
    return line if len(line) <= SUMMARY_WIDTH else line[:SUMMARY_WIDTH - 3] + "..."


def step_item(key: str, entry: Dict[str, Any], now: dt.datetime) -> Dict[str, Any]:
    usage = entry.get("usage")
    return {"key": key, "kind": entry.get("kind"), "status": entry.get("status"), "attempt": entry.get("attempt"),
            "session": entry.get("session"), "usage": usage if isinstance(usage, dict) else None,
            "started": entry.get("started"), "finished": entry.get("finished"), "seconds": seconds(entry, now),
            "summary": summary(entry), "detail": yaml.safe_dump(entry, sort_keys=False, allow_unicode=True)}


def section_lines(lines: List[str], heading: str) -> List[str]:
    span = find_section(lines, heading)
    return [] if span is None else lines[span[0] + 1:span[1]]


def build_tree(steps: List[Dict[str, Any]], path: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Keys split on '/': a journal key's node carries its status and seconds, a group rolls its children up
    (running if any is running or open, else failed if any failed, else done) and sums their seconds; a top-level
    node named after a finished path visit gets that visit's label as ``next``."""
    roots: List[Dict[str, Any]] = []
    nodes: Dict[str, Dict[str, Any]] = {}
    for item in steps:
        siblings, prefix = roots, ""
        for part in item["key"].split("/"):
            prefix = f"{prefix}/{part}" if prefix else part
            if prefix not in nodes:
                nodes[prefix] = {"name": part, "key": prefix, "status": None, "seconds": None, "next": None,
                                 "children": []}
                siblings.append(nodes[prefix])
            siblings = nodes[prefix]["children"]
        nodes[item["key"]].update(status=item["status"], seconds=item["seconds"])

    def roll(node: Dict[str, Any]) -> None:
        for child in node["children"]:
            roll(child)
        if node["status"] is None and node["children"]:
            statuses = [c["status"] for c in node["children"]]
            node["status"] = ("running" if any(s in ("running", "open") for s in statuses)
                              else "failed" if "failed" in statuses else "done")
            timed = [c["seconds"] for c in node["children"] if c["seconds"] is not None]
            node["seconds"] = sum(timed) if timed else None

    labels = {f"{e['node']}#{e['visit']}": e.get("next") for e in path if e.get("finished")}
    for root in roots:
        roll(root)
        root["next"] = labels.get(root["key"])
    return roots


def gate_of(steps: List[Dict[str, Any]], raw: Dict[str, Any], lines: List[str]) -> Optional[Dict[str, Any]]:
    """The first open entry with its verbatim ``## Gate: <key>`` section of JANUS.md (heading included)."""
    for s in steps:
        if s["status"] == "open":
            span = find_section(lines, f"## Gate: {s['key']}")
            return {"key": s["key"], "kind": s["kind"], "question": raw[s["key"]].get("question"),
                    "section": "\n".join(lines[span[0]:span[1]]) if span else ""}
    return None


def mermaid_of(graph: Any, path: List[Dict[str, Any]], current: Optional[Dict[str, Any]]) -> Optional[str]:
    """The map with every finished visit's node ``visited``, the unfinished last visit's node after ``current``'s
    status (``running`` without a current step), and ``(n)`` counts on the edges the finished visits took."""
    if not isinstance(graph, dict) or not isinstance(graph.get("nodes"), list):
        return None
    finished = [e for e in path if e.get("finished")]
    classes = {e["node"]: "visited" for e in finished}
    if path and not path[-1].get("finished"):
        status = current["status"] if current else "running"
        classes[path[-1]["node"]] = status if status in ("running", "open", "failed") else "running"
    return to_mermaid(graph, classes, dict(Counter((e["node"], e.get("next", "")) for e in finished)))


def build_state(root: Path, now: Any = None) -> Dict[str, Any]:
    """The page's state from journal.yaml and JANUS.md (design 4.2); ``now`` (ISO string or datetime) for tests."""
    root, clock = Path(root), parse_time(now) or dt.datetime.now()
    journal, updated, error = read_journal(root)
    raw = journal.get("steps") if isinstance(journal.get("steps"), dict) else {}
    steps = [step_item(str(k), e, clock) for k, e in raw.items() if isinstance(e, dict)]
    raw_path = journal.get("path")
    path = ([e for e in raw_path if isinstance(e, dict) and "node" in e and "visit" in e]
            if isinstance(raw_path, list) else [])
    live = [s for s in steps if s["status"] in ("running", "open")]
    failed = [s for s in steps if s["status"] == "failed"]
    current = live[0] if live else failed[-1] if failed else None
    goal_path = root / GOAL_FILE
    lines = goal_path.read_text(encoding="utf-8").splitlines() if goal_path.exists() else []
    used = [s["usage"] for s in steps if s["usage"]]
    tokens = {k: sum(u.get(k, 0) for u in used) for k in TOKEN_KEYS}
    tokens["sessions"] = len(used)
    totals = {"steps": len(steps), **{st: sum(1 for s in steps if s["status"] == st)
                                      for st in ("done", "failed", "running", "open", "answered")},
              "codex_seconds": sum(s["seconds"] or 0 for s in steps if s["kind"] in CODEX_KINDS), "tokens": tokens}
    return {"folder": root.resolve().name, "flow": journal.get("flow", "flow.py"), "started": journal.get("started"),
            "updated": updated, "error": error, "goal": "\n".join(section_lines(lines, "# Goal")).strip(),
            "steps": steps, "tree": build_tree(steps, path), "current": current["key"] if current else None,
            "gate": gate_of(steps, raw, lines), "path": path,
            "mermaid": mermaid_of(journal.get("graph"), path, current),
            "progress": section_lines(lines, "## Progress"), "decisions": section_lines(lines, "## Decisions"),
            "totals": totals}


# --- server ----------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    root = Path(".")  # make_server sets it on a subclass

    def do_GET(self) -> None:
        route = self.path.split("?")[0]
        if route == "/":
            self.reply(200, "text/html; charset=utf-8", PAGE.encode("utf-8"))
        elif route == "/state.json":
            try:
                body = json.dumps(build_state(self.root), default=str).encode("utf-8")
            except Exception as exc:  # the page keeps its last state and reddens the dot with this text
                self.reply(500, "text/plain; charset=utf-8", f"{type(exc).__name__}: {exc}".encode("utf-8"))
                return
            self.reply(200, "application/json", body)
        else:
            self.reply(404, "text/plain; charset=utf-8", b"not found\n")

    def reply(self, code: int, content_type: str, body: bytes) -> None:
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002 - the base class names it so
        pass


def make_server(root: Path, port: int) -> ThreadingHTTPServer:
    """A loopback server for ``root``; port 0 picks a free one (``server.server_address[1]`` tells which)."""
    handler = type("JanusHandler", (Handler,), {"root": Path(root)})
    return ThreadingHTTPServer(("127.0.0.1", port), handler)


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(prog="janus_ui.py", description="Janus UI: a live view of this goal folder")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args(argv)
    try:
        server = make_server(Path.cwd(), args.port)
    except OSError as exc:
        if exc.errno != errno.EADDRINUSE:
            raise
        print(f"janus_ui: port {args.port} is in use; try --port {args.port + 1}", file=sys.stderr)
        return 1
    print(f"janus_ui: {Path.cwd().resolve().name} at http://127.0.0.1:{args.port} (Ctrl-C stops)", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


# --- page ------------------------------------------------------------------

PAGE = r"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Janus</title>
<style>
  :root { --bg: #14161a; --panel: #1c1f25; --line: #2c313a; --fg: #d6d9de; --dim: #8a919c;
          --done: #66bb6a; --running: #42a5f5; --open: #ffb74d; --failed: #ef5350; }
  body { margin: 0; padding: 16px 24px; background: var(--bg); color: var(--fg); min-width: 1000px;
         font: 14px/1.45 system-ui, sans-serif; }
  code, pre, .mono { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 13px; }
  pre { background: var(--panel); border: 1px solid var(--line); padding: 10px; margin: 0; white-space: pre-wrap;
        overflow-wrap: anywhere; max-height: 60vh; overflow: auto; }
  h1 { font-size: 18px; margin: 0 0 4px; } h2 { font-size: 14px; color: var(--dim); margin: 18px 0 6px; }
  #head { display: flex; gap: 12px; align-items: baseline; flex-wrap: wrap; }
  #dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; background: var(--dim); }
  #dot.ok { background: var(--done); } #dot.bad { background: var(--failed); }
  .meta { color: var(--dim); } #error { color: var(--failed); }
  #gate { border: 1px solid var(--open); background: #2a2113; padding: 10px 12px; margin-top: 14px; }
  #gate b { color: var(--open); }
  #map { margin-top: 8px; } #map svg { max-width: 100%; height: auto; }
  #cols { display: grid; grid-template-columns: minmax(360px, 1fr) 2fr; gap: 20px; margin-top: 4px; }
  .row { display: flex; gap: 8px; padding: 2px 6px; cursor: pointer; border-radius: 3px; white-space: nowrap; }
  .row:hover { background: var(--panel); } .row.current { outline: 1px solid var(--running); }
  .row.selected { background: var(--line); }
  .row .name { flex: 1; } .row .meta { font-size: 12px; }
  .done, .answered { color: var(--done); } .running { color: var(--running); }
  .open { color: var(--open); } .failed { color: var(--failed); }
  .arrow { width: 12px; display: inline-block; color: var(--dim); }
  #detail dl { display: grid; grid-template-columns: max-content 1fr; gap: 2px 12px; margin: 0 0 8px; }
  #detail dt { color: var(--dim); } #detail dd { margin: 0; }
  #panels { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
</style>
</head>
<body>
<div id="head"><h1 id="folder">Janus</h1><span id="dot" title="waiting for the first poll"></span>
  <span id="totals" class="meta"></span><span id="error"></span></div>
<div id="meta" class="meta"></div>
<div id="gate" hidden></div>
<div id="mapwrap" hidden><h2>Map</h2><div id="map"></div></div>
<div id="cols">
  <div><h2>Steps</h2><div id="tree" class="mono"></div></div>
  <div><h2>Detail</h2><div id="detail"></div></div>
</div>
<div id="panels">
  <div><h2>Progress</h2><pre id="progress"></pre></div>
  <div><h2>Decisions</h2><pre id="decisions"></pre></div>
</div>
<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>
<script>
"use strict";
const collapsed = new Set();   // the user's toggles survive polls
let selected = null, lastMermaid = null, renders = 0, loaded = false;
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls;
                                 if (text !== undefined) e.textContent = text; return e; };
const pad = (n) => String(n).padStart(2, "0");
const dur = (s) => s == null ? "" : s < 60 ? s + "s" : s < 3600 ? Math.floor(s / 60) + "m" + pad(s % 60) + "s"
                   : Math.floor(s / 3600) + "h" + pad(Math.floor(s % 3600 / 60)) + "m";
const tok = (n) => n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1000 ? Math.round(n / 1000) + "k" : String(n);

function ancestors(key) {  // "a/b/c" -> ["a", "a/b"]
  const parts = key.split("/"), out = [];
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join("/"));
  return out;
}

function renderHeader(st) {
  $("folder").textContent = st.folder;
  const t = st.totals, bits = [t.steps + " steps", t.done + " done"];
  for (const k of ["failed", "running", "open", "answered"]) if (t[k]) bits.push(t[k] + " " + k);
  if (t.codex_seconds) bits.push("codex " + dur(t.codex_seconds));
  if (t.tokens.sessions) bits.push(tok(t.tokens.total) + " tokens in " + t.tokens.sessions + " sessions");
  $("totals").textContent = bits.join(", ");
  $("error").textContent = st.error || "";
  $("meta").textContent = st.flow + (st.started ? ", started " + st.started : "")
                          + (st.updated ? ", updated " + st.updated : "") + (st.goal ? " — " + st.goal : "");
}

function renderGate(g) {
  const box = $("gate");
  box.hidden = !g; box.replaceChildren();
  if (!g) return;
  box.append(el("div", "", ""), el("div", "", g.question || ""), el("pre", "", g.section || ""),
             el("div", "meta", "Answer it in JANUS.md, then run `python janus.py run` again."));
  box.firstChild.append(el("b", "", "Gate " + g.key), el("span", "meta", "  (" + g.kind + ")"));
}

async function renderMap(text) {
  $("mapwrap").hidden = !text;
  if (!text || text === lastMermaid) return;   // re-rendered only when the text changes: no flicker
  lastMermaid = text;
  const map = $("map");
  if (!window.mermaid) { map.replaceChildren(el("pre", "", text)); return; }
  try {
    const { svg } = await mermaid.render("janusmap" + (++renders), text);
    map.innerHTML = svg;
  } catch (e) { map.replaceChildren(el("pre", "", text + "\n\n" + e)); }
}

function renderTree(st) {
  const tree = $("tree"), byKey = {};
  for (const s of st.steps) byKey[s.key] = s;
  tree.replaceChildren();
  if (!st.steps.length) { tree.append(el("div", "meta", "nothing has run yet")); return; }
  if (selected && !byKey[selected]) selected = null;
  const walk = (nodes, depth) => {
    for (const n of nodes) {
      const step = byKey[n.key], group = n.children.length > 0, shut = collapsed.has(n.key);
      const row = el("div", "row " + (n.status || "") + (n.key === st.current ? " current" : "")
                            + (n.key === (selected || st.current) ? " selected" : ""));
      row.style.paddingLeft = (6 + depth * 18) + "px";
      row.append(el("span", "arrow", group ? (shut ? "▸" : "▾") : ""));
      row.append(el("span", "name", n.name + (step && step.attempt > 1 ? " #" + step.attempt : "")));
      if (step && step.usage && step.usage.total != null)
        row.append(el("span", "meta", tok(step.usage.total) + " tok"));
      if (n.seconds != null) row.append(el("span", "meta", dur(n.seconds)));
      if (n.next != null) row.append(el("span", "meta", "→ " + n.next));
      row.onclick = () => {
        if (group) collapsed.has(n.key) ? collapsed.delete(n.key) : collapsed.add(n.key);
        if (step) selected = n.key;
        render(st);
      };
      tree.append(row);
      if (group && !shut) walk(n.children, depth + 1);
    }
  };
  walk(st.tree, 0);
}

function renderDetail(st) {
  const box = $("detail"), key = selected || st.current;
  const step = st.steps.find((s) => s.key === key);
  box.replaceChildren();
  if (!step) { box.append(el("div", "meta", key ? key : "select a step")); return; }
  const dl = el("dl");
  for (const [k, v] of [["key", step.key], ["kind", step.kind], ["status", step.status], ["attempt", step.attempt],
                        ["started", step.started], ["finished", step.finished], ["seconds", dur(step.seconds)]]) {
    dl.append(el("dt", "", k), el("dd", k === "status" ? step.status : "mono", v == null ? "" : String(v)));
  }
  box.append(dl, el("pre", "", step.detail));
}

function render(st) {
  if (!loaded) {   // on load every group is collapsed except the ancestors of current
    loaded = true;
    const keep = new Set(st.current ? ancestors(st.current) : []);
    const mark = (nodes) => { for (const n of nodes) { if (n.children.length && !keep.has(n.key)) collapsed.add(n.key);
                                                       mark(n.children); } };
    mark(st.tree);
  }
  renderHeader(st); renderGate(st.gate); renderMap(st.mermaid); renderTree(st); renderDetail(st);
  $("progress").textContent = st.progress.join("\n"); $("decisions").textContent = st.decisions.join("\n");
}

async function poll() {
  try {
    const r = await fetch("/state.json", { cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status + ": " + (await r.text()).trim());
    render(await r.json());
    $("dot").className = "ok"; $("dot").title = "live";
  } catch (e) { $("dot").className = "bad"; $("dot").title = String(e); }
}

if (window.mermaid) mermaid.initialize({ startOnLoad: false, theme: "dark", securityLevel: "strict",
  themeVariables: { primaryColor: "#3a3f47", primaryBorderColor: "#8a919c", primaryTextColor: "#e6e9ee",
                    lineColor: "#8a919c", edgeLabelBackground: "#14161a", fontFamily: "system-ui, sans-serif" } });
poll(); setInterval(poll, 2000);
</script>
</body>
</html>
"""

if __name__ == "__main__":
    sys.exit(main())
