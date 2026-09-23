"""Fixtures for the example's tests: the engine's fake `codex`, a throwaway TeamCity and a goal folder.

The fake `codex` fixture is the engine suite's (`tests/conftest.py`), loaded by path under its own
module name so that neither pytest's conftest handling nor `sys.modules` sees two modules called
`conftest`. Re-binding the fixture function in this module registers it for this directory.
"""
import importlib.util
import json
import shutil
import sys
import threading
import types
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

EXAMPLE = Path(__file__).resolve().parent.parent
REPO = EXAMPLE.parent.parent
sys.path.insert(0, str(EXAMPLE))  # so `import teamcity` finds the example's helper

import teamcity  # noqa: E402  the sys.path entry above is what makes this import work


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


fake_codex = _load("janus_engine_conftest", REPO / "tests" / "conftest.py").fake_codex


@pytest.fixture(autouse=True)
def without_teamcity(monkeypatch):
    """No test inherits a real TeamCity from the developer's environment. Autouse fixtures are set
    up before the fixtures a test names, so `teamcity_server` still wins where a test asks for it."""
    monkeypatch.delenv("JANUS_TEAMCITY_URL", raising=False)
    monkeypatch.delenv("JANUS_TEAMCITY_TOKEN", raising=False)
    teamcity.reload_env()  # the module read the environment at import; forget what it found


@pytest.fixture
def teamcity_server(monkeypatch):
    """A TeamCity on 127.0.0.1 that answers queued JSON bodies and records the requests it got.
    `serve(bodies)` queues answers in order; a request past the queue gets 404."""
    queue = []
    seen = []

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            seen.append({"path": self.path, "auth": self.headers.get("Authorization")})
            body = queue.pop(0) if queue else None
            if body is None:
                self.send_response(404)
                self.end_headers()
                return
            data = json.dumps(body).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, *args):
            pass  # keep the pytest output pristine

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    monkeypatch.setenv("JANUS_TEAMCITY_URL", "http://127.0.0.1:%d" % server.server_address[1])
    monkeypatch.setenv("JANUS_TEAMCITY_TOKEN", "t0ken")
    teamcity.reload_env()  # `teamcity` reads the environment once, so tell it to read it again
    yield types.SimpleNamespace(serve=queue.extend, requests=lambda: list(seen))
    server.shutdown()
    server.server_close()


@pytest.fixture
def goal_folder(tmp_path):
    """A copy of the example as a goal folder, with one empty repository sub-folder `app`."""
    folder = tmp_path / "angular-16-upgrade"
    folder.mkdir()
    for name in ("flow.py", "teamcity.py", "JANUS.md"):
        shutil.copy(EXAMPLE / name, folder / name)
    shutil.copytree(EXAMPLE / "prompts", folder / "prompts")
    (folder / "app").mkdir()
    return folder
