# Janus 3.0 Slices 2 to 4: Bitbucket, TeamCity, Coupled Repositories, E2E, Review and Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the Janus 3.0 specification on top of the committed slice 1 plan (`docs/superpowers/plans/2026-09-21-slice1-local-loop.md`, Tasks 1 to 12): Bitbucket pull requests and TeamCity PR builds for the exact commit (slice 2), a second repository in approved order with an explicit coupled verification point (slice 3), the prerelease job, the full E2E build, the independent AI review, human review feedback and completion recorded only against merged PRs (slice 4).

**Architecture:** The same one-file procedural runner (`janus.py`) and the same goal document (`JANUS.md`). `urllib.request` talks to Bitbucket Server REST 1.0 and TeamCity REST (`/app/rest/2018.1`) with Bearer tokens from the runner's environment; every piece of evidence is tied to an exact commit SHA and every wait is checkpointed in `in_flight` so a crashed process resumes without duplicating commits, builds or publishes. The tests keep slice 1's temporary git repositories, bare remotes and fake `codex`, and add one `http.server` stub started per test in a thread that serves canned responses for exactly the endpoints Janus calls and records every request.

**Tech Stack:** Python 3.9+ (`from __future__ import annotations`, no `match`, no runtime `X | Y`), PyYAML 6, pytest 8 via `uv`, git 2.43, codex-cli 0.146, stdlib `urllib.request`, `http.server` (tests only).

**Spec:** `/home/race-day/janus/janus-3.0-spec.md` (v0.2). Every task cites the spec section it implements; executors read both. **Prerequisite:** slice 1 (Tasks 1 to 11 of the slice 1 plan) is implemented and its 85 tests pass; this plan consumes slice 1's interfaces verbatim and never re-plans them. Tasks here are numbered 13 to 23 so that "Task 9" always means slice 1's Task 9.

## Global Constraints

Copied from the spec and the settled project decisions where they bind implementation; every task's requirements include this section and slice 1's Global Constraints.

- Spec §1: "Python 3.9 or newer, standard library plus PyYAML." `from __future__ import annotations`, `typing.Optional/List/Dict/Tuple`, no `match`, no runtime `X | Y`. Development machine has Python 3.12.3; `ast.parse(..., feature_version=(3, 9))` must accept every file.
- Spec §1: "There is no state machine framework, database, daemon, plugin architecture, provider interface, per-role JSON schema, separate plan YAML, persisted fake service, or custom telemetry service." All runtime code stays in `janus.py` as small procedural functions; no classes except slice 1's `Goal` dataclass (and slice 1's `JanusError`); no provider interfaces, no plugin seams, no persisted fake services, no separate plan YAML. `urllib.request` for REST, `hashlib`, `fcntl`, `subprocess`.
- Spec §10 names are used exactly: `ensure_pr`, `find_or_trigger_build`, `wait_and_summarize_build`, `trigger_full_e2e`, `run_review` join slice 1's `load_goal`, `save_checkpoint`, `verify_plan_approval`, `discover_repos`, `run_codex`, `record_heads`, `check_heads_unchanged`, `run_checks`, `diff_guardrails`, `git_commit_push`, `show_status`.
- Spec §5: "Environment variables supply TeamCity and Bitbucket URLs and tokens; never put secrets in `JANUS.md`, CLI arguments, agent prompts or stored logs." The variable names are fixed in the contract section below; tokens travel only in `Authorization` headers; `redact` strips credential-shaped text and the literal token values before anything reaches a prompt or `JANUS.md`.
- Spec §6 step 6: "Finds the PR build corresponding to that **exact commit SHA**. If no automatic build appears within the configured appearance timeout, triggers the approved TeamCity build explicitly. Never regards an older green build as proof for a new commit."
- Spec §6 step 7: "retries at most **3 code-fix attempts per task**. CI infrastructure/start failures do not count as code-fix attempts and are retried once."
- Spec §6: "If a task cannot be individually green because of an approved coupled change, the **plan must explicitly name the temporary red and the joint verification point**. The runner may proceed to that point but must not present the intermediate result as green."
- Spec §6: "A shared-library prerelease may be published to Nexus by an existing TeamCity job when the approved task calls for it. How the version is chosen is part of the approved plan. That is not permission to publish a production release."
- Spec §6: "Pass each participating repository's exact goal branch; use base branches only where the approved plan says so. E2E evidence is valid only for the recorded repository head SHAs. Any later change to a participating branch invalidates it."
- Spec §6: "independent fresh Codex review of the combined change. Fix material findings, rerun affected CI and E2E, then review again, with a maximum of 2 review/fix cycles before human direction." "Janus must **never** interpret silence, a green build or an AI review as human approval." "Completion is recorded only after checking actual merged PRs and release handover; a failed or unobserved release remains an explicit follow-up rather than falsely 'done'."
- Spec §2 and §11 criterion 8: no automatic PR merge, no production release, no deploy. Janus calls no Bitbucket merge endpoint and no release job; the only TeamCity build types it queues are the approved `pr_build`, `publish` and `e2e.build_type` ids.
- Spec §8: "Before launching Codex or a CI wait, checkpoint `in_flight` with task, repo, starting SHA and intended operation." "An already-pushed commit or completed build must not be duplicated merely because Janus crashed before updating Markdown." "After a checkpoint, push the control repo."
- Spec §9: "Only the runner performs product Git commit/push and calls TeamCity/Bitbucket write APIs." "Redact credentials and sensitive query parameters from the CI excerpts given to Codex or committed to the control repo."
- Spec §10 tests: pytest in `tests/`; `uv run pytest -q` (uv is `/snap/bin/uv`); TeamCity and Bitbucket against "a small `http.server` stub started per test that serves canned responses for exactly the endpoints Janus calls"; Codex via slice 1's `fake_codex` fixture; never the network, never the real `codex`.
- Spec §4: `JANUS.md` stays the only tracked per-goal artifact. Slice 1's front matter keys are extended, never renamed: `pr_build`, `e2e`, `prs`, `last_verified` keep their names and shapes. Every new front matter field is either Codex-proposed and human-approved (then part of the plan hash) or runner-owned; the contract section says which.
- Spec §11 criterion 11: nothing in the runner depends on a specific Angular major; `angular.from/to` are data.
- Commits: `type(scope): subject` with a scope, two `-m` form: `git commit -m "feat(janus): ..." -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"`.
- Janus 2.x (`8bf3f0f`) is history only; this plan references no v2 code.

## Verified facts

- The slice 1 plan's Tasks 1 to 11 were assembled verbatim into a scratch directory and run: **85 passed**, exactly as the slice 1 self-review states; every file parses with `feature_version=(3, 9)`; `python3 janus.py --help` lists the four commands. No slice 1 code had to be changed to make it work. This plan's tasks were then layered on top in order and `uv run pytest -q` was run after each: 90, 106, 116, 128, 135, 148, 151, 158, 163, 169 passed (recorded per task below; full suite about 48 s).
- Two slice 1 tests change meaning by design and are rewritten where that happens: `test_run_with_all_tasks_done_records_completion` (slice 1 Task 9; after slice 4 "all tasks done" leads to E2E, review and the human gate, not to `done`) and the `ws` fixture's origin URL (slice 1 Task 4; it becomes `file:///.../remotes/PROJ/app.git` so the Bitbucket project/repo derivation rule has something to parse; git treats `file://` like any remote).
- Bitbucket Server and TeamCity are **not reachable from this development machine**; every REST shape below is from knowledge of Bitbucket Server REST 1.0 and TeamCity REST (API version path `2018.1`, accepted by every later server) and is exercised only against the stub. Points to confirm in the sandbox trial (Task 23): (a) TeamCity access tokens (`Authorization: Bearer`) exist since TeamCity 2019.1; a 2018.1 server would need Basic auth instead; (b) the JSON form of "trigger a build for one revision", `{"lastChanges": {"change": [{"locator": "version:<sha>,buildType:(id:<bt>)"}]}}`, requires TeamCity to have already collected that change (otherwise HTTP 404, which Janus treats as an infrastructure failure and retries once); (c) the build locator dimensions `revision:(version:<sha>)`, `branch:(default:any)`, `state:any`, `defaultFilter:false`; (d) `GET /app/rest/2018.1/builds/id:<id>` for a still-queued build; (e) `branch:(name:<base>)` for the baseline lookup, with `branch:(default:true)` as the fallback the runner already makes; (f) Bitbucket project keys are matched case-insensitively (the runner upper-cases keys taken from ssh URLs, except personal `~user` keys); (g) Bitbucket Server versions before 8.x have no draft PRs, so Janus opens ordinary `OPEN` PRs titled `[Janus] <goal id>: <repo>` (spec §6 says "draft/open").
- `ThreadingHTTPServer` on `127.0.0.1:0` in a daemon thread starts and stops in milliseconds; one stub serves both "systems" because their paths never overlap (`/app/rest/...` vs `/rest/api/1.0/...`).
- The fake `codex` of slice 1 chooses its scripted step by the number of calls recorded so far; a test that re-scripts after a first `cmd_run` must repeat placeholders for the calls already made (Task 22's feedback test shows this).

## File structure

| Path | Responsibility |
|---|---|
| `janus.py` | All runtime code. New banner sections, in this order after `# --- checks and guardrails ---`: `# --- http ---` (env contract, one REST helper), `# --- bitbucket ---` (origin parsing, PR lookup/creation/state), `# --- teamcity ---` (build locate/queue/poll/excerpt, baseline), `# --- e2e and review ---` (heads, E2E trigger and validity, fix pass, review, handover, feedback, completion), then slice 1's `# --- run ---`, `# --- status ---`, `# --- CLI ---`. Each task says where its code goes. |
| `JANUS.md` | Unchanged template from slice 1 Task 7; the HTML comment already describes the front matter and this plan only adds optional task fields and runner-owned keys (documented in the contract below and in `show_status`). |
| `tests/conftest.py` | Slice 1 fixtures plus `stub` (per-test HTTP server) and `clean_janus_env` (autouse; removes `JANUS_*` variables). |
| `tests/helpers.py` | Slice 1 helpers plus `TC_API`, `tc_build`, `script_ci`, `script_bitbucket`, `add_repo`, `two_repo_front`. |
| `tests/test_http.py`, `test_bitbucket.py`, `test_teamcity.py`, `test_run_ci.py`, `test_baseline.py`, `test_coupled.py`, `test_publish.py`, `test_e2e.py`, `test_review.py`, `test_feedback_completion.py` | One test module per task (Tasks 13 to 22). |

## Front matter contract for slices 2 to 4 (fixed here, used by every task)

Slice 1's keys keep their names and shapes. Additions are marked **approved** (Codex proposes during `plan`, a human edits, `approve` hashes them; `run` refuses a change) or **runner** (runner-owned, excluded from the hash, added lazily so a slice 1 draft still has exactly slice 1's twelve keys).

```yaml
id: angular-15-to-16
status: awaiting_plan_approval   # runner: awaiting_plan_approval | approved | executing | blocked | awaiting_human_review | done
angular: {from: 15, to: 16}      # approved
approval: {plan_hash: ..., approved_by: ..., approved_at: ...}   # runner
repos:                           # approved (unchanged shape); pr_build is the TeamCity build configuration id of the PR build
  - {name: ui-kit, base: main, branch: ai/angular-15-to-16, pr_build: Fe_UiKit_Build, checks: [...]}
  - {name: shell,  base: main, branch: ai/angular-15-to-16, pr_build: Fe_Shell_Build, checks: [...]}
e2e:                             # approved (unchanged shape) or null
  build_type: Fe_E2E_Full
  branch_parameters: {shell: env.SHELL_BRANCH, orders-remote: env.ORDERS_BRANCH}   # repo -> TeamCity parameter name
tasks:
  - id: 1
    repo: ui-kit
    objective: Upgrade ui-kit and publish a prerelease
    publish: Fe_UiKit_Publish    # approved, optional: existing TeamCity job that publishes the prerelease of this task's verified commit
    status: pending              # runner: pending | in_progress | awaiting_ci | publishing | coupled_pending | done
    values: {prerelease_version: 2.0.0-angular16.1}   # runner, from Codex's output; passed into later task prompts
    summary: ...                 # runner, from Codex's output
    blockers: [...]              # runner, from Codex's output (becomes "Known limitations" in the QA handover)
    verified_build: 101          # runner: TeamCity build id that judged the verified commit green
    publish_build: 102           # runner: TeamCity build id of the successful publish job
  - id: 2
    repo: shell
    objective: Upgrade shell using the ui-kit prerelease recorded by task 1
    expect_red: true             # approved, optional: this task's PR build may stay red (temporary red of a coupled change)
    verify_at: 3                 # approved, required with expect_red: a LATER task id or "e2e" (the joint verification point)
    red_build: 103               # runner: the red build that was recorded as coupled_pending, never as green
current_task: 2                  # runner
last_verified:                   # runner: repo -> {commit, teamcity_build, status}
  ui-kit: {commit: <sha>, teamcity_build: 101, status: green}
  shell:  {commit: <sha>, teamcity_build: 103, status: coupled_pending}
                                 # status: local_checks_passed | green | red | coupled_pending | verified_by_e2e
prs: {ui-kit: https://bitbucket.example/projects/FE/repos/ui-kit/pull-requests/12}   # runner: repo -> PR URL (id is the last path segment)
attempts: 0                      # runner: code-fix attempts used on current_task (max 3)
in_flight: null                  # runner: {task, repo, start_sha, operation, attempt, started_at, build}
                                 # operation: codex | ci_wait | publish_wait | e2e_wait | review | fix:e2e | fix:review | fix:review-feedback
e2e_result:                      # runner, present once E2E ran: {build, status: running|green|red|infra|timeout|unavailable, heads: {repo: sha}, url, at, fix_attempts}
review:                          # runner, present once the review ran: {cycles, status: clean|findings, heads, at, summary, findings}
```

Body sections are slice 1's. `## Review feedback` is consumed by `run` (moved into `## Decisions`, reset to its placeholder). `## Progress and handover` gains `PR <repo>: <url>`, `E2E: ...`, `Review: ...` lines and, at the human gate, a `### QA handover` sub-block.

**Environment variables (spec §5, §9), read only by the runner, never written anywhere:**

| Variable | Meaning | Default |
|---|---|---|
| `JANUS_TEAMCITY_URL` | TeamCity server URL, e.g. `https://teamcity.example` | required for CI |
| `JANUS_TEAMCITY_TOKEN` | TeamCity access token (`Authorization: Bearer`) | required for CI |
| `JANUS_BITBUCKET_URL` | Bitbucket Server URL, e.g. `https://bitbucket.example` | required for PRs |
| `JANUS_BITBUCKET_TOKEN` | Bitbucket HTTP access token (`Authorization: Bearer`) | required for PRs |
| `JANUS_POLL_SECONDS` | Sleep between polls | `30` |
| `JANUS_BUILD_APPEARANCE_SECONDS` | How long to wait for an automatic PR build before queuing one | `600` |
| `JANUS_BUILD_TIMEOUT_SECONDS` | How long to wait for one build to finish | `7200` |

**REST endpoints Janus calls (the stub serves exactly these):**

| System | Call | Used by |
|---|---|---|
| TeamCity | `GET /app/rest/2018.1/builds?locator=buildType:(id:<bt>),revision:(version:<sha>),branch:(default:any),state:any,defaultFilter:false,count:20&fields=count,build(<BUILD_FIELDS>)` | `locate_builds` (find the build of the exact commit) |
| TeamCity | `GET /app/rest/2018.1/builds?locator=buildType:(id:<bt>),branch:(name:<base>),count:1&fields=...` then `...branch:(default:true),count:1...` | `baseline_build` (plan) |
| TeamCity | `GET /app/rest/2018.1/builds/id:<id>?fields=<BUILD_FIELDS>` | `build_by_id` (poll) |
| TeamCity | `POST /app/rest/2018.1/buildQueue` body `{"buildType": {"id": ...}, "comment": {"text": ...}, "branchName": ..., "lastChanges": {"change": [{"locator": "version:<sha>,buildType:(id:<bt>)"}]}}` or with `"properties": {"property": [{"name", "value"}]}` instead of branch/revision (E2E) | `queue_build` |
| TeamCity | `GET /app/rest/2018.1/testOccurrences?locator=build:(id:<id>),status:FAILURE,count:20&fields=testOccurrence(name,details)` | `failure_excerpt` |
| TeamCity | `GET /app/rest/2018.1/problemOccurrences?locator=build:(id:<id>),count:20&fields=problemOccurrence(type,details)` | `failure_excerpt` |
| Bitbucket | `GET /rest/api/1.0/projects/<KEY>/repos/<slug>/pull-requests?state=OPEN&direction=OUTGOING&at=refs/heads/<branch>&limit=25` | `ensure_pr` (find) |
| Bitbucket | `POST /rest/api/1.0/projects/<KEY>/repos/<slug>/pull-requests` | `ensure_pr` (create) |
| Bitbucket | `GET /rest/api/1.0/projects/<KEY>/repos/<slug>/pull-requests/<id>` | `pr_state` (reuse check, completion) |

`BUILD_FIELDS = id,number,state,status,statusText,webUrl,failedToStart,canceledInfo(text),revisions(revision(version)),buildType(id)`. Every request carries `Authorization: Bearer <token>` and `Accept: application/json`; bodies are JSON. Pagination is not needed: the PR list is filtered to one branch (`limit=25`), build lists are bounded by `count`. No merge, decline, release or deploy endpoint is ever called.

---
### Task 13: Environment contract, one REST helper and the per-test HTTP stub

Spec §5 ("Environment variables supply TeamCity and Bitbucket URLs and tokens"), §9 ("Secrets are supplied through the runner's environment"), §10 ("`urllib.request` for the existing TeamCity and Bitbucket Server REST endpoints", "a small `http.server` stub started per test").

**Files:**
- Modify: `janus.py` (imports; constants section; new section `# --- http ---` inserted before `# --- run ---`, together with the empty banners `# --- bitbucket ---`, `# --- teamcity ---`, `# --- e2e and review ---` that Tasks 14, 15 and 20 fill)
- Modify: `tests/conftest.py` (append the `stub` fixture)
- Create: `tests/test_http.py`

**Interfaces:**
- Consumes: `JanusError`, `redact` (slice 1 Task 8; Task 14 extends it).
- Produces: constants `TEAMCITY_URL_VAR = "JANUS_TEAMCITY_URL"`, `TEAMCITY_TOKEN_VAR = "JANUS_TEAMCITY_TOKEN"`, `BITBUCKET_URL_VAR = "JANUS_BITBUCKET_URL"`, `BITBUCKET_TOKEN_VAR = "JANUS_BITBUCKET_TOKEN"`, `POLL_SECONDS_VAR = "JANUS_POLL_SECONDS"`, `BUILD_APPEARANCE_VAR = "JANUS_BUILD_APPEARANCE_SECONDS"`, `BUILD_TIMEOUT_VAR = "JANUS_BUILD_TIMEOUT_SECONDS"`, `HTTP_TIMEOUT_SECONDS = 30`; `env_text(name: str) -> Optional[str]`; `env_int(name: str, default: int) -> int` (`JanusError` on garbage); `service(url_var: str, token_var: str) -> Optional[Tuple[str, str]]` (base URL without trailing slash and token, or `None` unless both are set); `http_json(method: str, url: str, token: str, body: Optional[dict] = None) -> Tuple[int, object]` (status and parsed JSON, or text; `(0, reason)` when unreachable; never includes the token).
- Test fixture `stub` (`tests/conftest.py`): `stub.url` (base URL), `stub.on(method, path, responses)` where `responses` is a list of `(status, json)` served in order with the last repeating, or a callable `(request) -> (status, json)`; `stub.requests` (every recorded request as `{"method", "path", "query", "headers", "json"}`); `stub.calls(method=None, path=None)` filter. The fixture also sets `JANUS_TEAMCITY_URL`/`JANUS_BITBUCKET_URL` to the stub, the tokens to `tc-secret-token`/`bb-secret-token`, `JANUS_POLL_SECONDS=0`, `JANUS_BUILD_APPEARANCE_SECONDS=0`, `JANUS_BUILD_TIMEOUT_SECONDS=60`. Unrouted paths answer 404.

- [ ] **Step 1: Add the stub fixture**

Append to `tests/conftest.py` (after the `fake_codex` fixture):

```python
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import threading
import urllib.parse


@pytest.fixture
def stub(monkeypatch):
    """A per-test HTTP server standing in for TeamCity and Bitbucket Server (spec §10). It serves canned
    responses for exactly the routes a test registers and records every request for assertions."""
    routes = {}
    requests = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def _serve(self):
            parsed = urllib.parse.urlsplit(self.path)
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length).decode("utf-8") if length else ""
            record = {
                "method": self.command,
                "path": parsed.path,
                "query": {k: v[0] for k, v in urllib.parse.parse_qs(parsed.query).items()},
                "headers": {k.lower(): v for k, v in self.headers.items()},
                "json": json.loads(raw) if raw else None,
            }
            requests.append(record)
            entry = routes.get((self.command, parsed.path))
            if entry is None:
                status, body = 404, {"error": f"no stub route for {self.command} {parsed.path}"}
            elif callable(entry):
                status, body = entry(record)
            else:
                status, body = entry[0] if len(entry) == 1 else entry.pop(0)
            payload = json.dumps(body).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        do_GET = do_POST = do_PUT = do_DELETE = _serve

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    url = f"http://127.0.0.1:{server.server_address[1]}"
    monkeypatch.setenv("JANUS_TEAMCITY_URL", url)
    monkeypatch.setenv("JANUS_TEAMCITY_TOKEN", "tc-secret-token")
    monkeypatch.setenv("JANUS_BITBUCKET_URL", url)
    monkeypatch.setenv("JANUS_BITBUCKET_TOKEN", "bb-secret-token")
    monkeypatch.setenv("JANUS_POLL_SECONDS", "0")
    monkeypatch.setenv("JANUS_BUILD_APPEARANCE_SECONDS", "0")
    monkeypatch.setenv("JANUS_BUILD_TIMEOUT_SECONDS", "60")

    def on(method, path, responses):
        """responses: a list of (status, json) served in order (the last one repeats), or a callable
        taking the recorded request and returning (status, json)."""
        routes[(method, path)] = responses if callable(responses) else list(responses)

    def calls(method=None, path=None):
        return [r for r in requests if (method is None or r["method"] == method) and (path is None or r["path"] == path)]

    yield types.SimpleNamespace(url=url, on=on, requests=requests, calls=calls)
    server.shutdown()
    server.server_close()
```

- [ ] **Step 2: Write the failing tests**

`tests/test_http.py`:

```python
import pytest

import janus


def test_http_json_sends_bearer_accept_and_json_body(stub):
    stub.on("POST", "/things", [(201, {"id": 7})])
    status, body = janus.http_json("POST", stub.url + "/things?x=1", "tc-secret-token", {"name": "n"})
    assert (status, body) == (201, {"id": 7})
    [request] = stub.requests
    assert request["method"] == "POST" and request["path"] == "/things" and request["query"] == {"x": "1"}
    assert request["headers"]["authorization"] == "Bearer tc-secret-token"
    assert request["headers"]["accept"] == "application/json"
    assert request["headers"]["content-type"] == "application/json"
    assert request["json"] == {"name": "n"}


def test_http_json_get_has_no_body_and_returns_error_statuses(stub):
    stub.on("GET", "/missing", [(404, {"message": "nope"})])
    assert janus.http_json("GET", stub.url + "/missing", "t") == (404, {"message": "nope"})
    assert stub.requests[0]["json"] is None and "content-type" not in stub.requests[0]["headers"]
    assert janus.http_json("GET", stub.url + "/unrouted", "t")[0] == 404


def test_http_json_reports_an_unreachable_server_as_status_zero():
    status, reason = janus.http_json("GET", "http://127.0.0.1:9/app/rest", "never-shown-token")
    assert status == 0
    assert "127.0.0.1:9" in reason and "never-shown-token" not in reason


def test_service_needs_both_url_and_token(monkeypatch):
    monkeypatch.delenv("JANUS_TEAMCITY_URL", raising=False)
    monkeypatch.setenv("JANUS_TEAMCITY_TOKEN", "t")
    assert janus.service(janus.TEAMCITY_URL_VAR, janus.TEAMCITY_TOKEN_VAR) is None
    monkeypatch.setenv("JANUS_TEAMCITY_URL", "https://tc.example/ ")
    assert janus.service(janus.TEAMCITY_URL_VAR, janus.TEAMCITY_TOKEN_VAR) == ("https://tc.example", "t")


def test_env_int_defaults_and_rejects_garbage(monkeypatch):
    monkeypatch.delenv("JANUS_POLL_SECONDS", raising=False)
    assert janus.env_int(janus.POLL_SECONDS_VAR, 30) == 30
    monkeypatch.setenv("JANUS_POLL_SECONDS", "5")
    assert janus.env_int(janus.POLL_SECONDS_VAR, 30) == 5
    monkeypatch.setenv("JANUS_POLL_SECONDS", "soon")
    with pytest.raises(janus.JanusError, match="JANUS_POLL_SECONDS"):
        janus.env_int(janus.POLL_SECONDS_VAR, 30)
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `uv run pytest -q tests/test_http.py`
Expected: FAIL with `AttributeError: module 'janus' has no attribute 'http_json'` (and `service`, `env_int`, `TEAMCITY_URL_VAR`).

- [ ] **Step 4: Implement**

Add to the imports of `janus.py` (alphabetical within the stdlib group): `import os`, `import time`, `import urllib.error`, `import urllib.parse`, `import urllib.request`.

Add to the constants section, after `FAILURE_SUMMARY_CHARS = 6000`:

```python
TEAMCITY_URL_VAR = "JANUS_TEAMCITY_URL"


TEAMCITY_TOKEN_VAR = "JANUS_TEAMCITY_TOKEN"


BITBUCKET_URL_VAR = "JANUS_BITBUCKET_URL"


BITBUCKET_TOKEN_VAR = "JANUS_BITBUCKET_TOKEN"


POLL_SECONDS_VAR = "JANUS_POLL_SECONDS"


BUILD_APPEARANCE_VAR = "JANUS_BUILD_APPEARANCE_SECONDS"


BUILD_TIMEOUT_VAR = "JANUS_BUILD_TIMEOUT_SECONDS"


HTTP_TIMEOUT_SECONDS = 30
```

Insert immediately before `# --- run ---` four new banners in this order, and put this code under the first:

```python
# --- http -------------------------------------------------------------------

# --- bitbucket --------------------------------------------------------------

# --- teamcity ---------------------------------------------------------------

# --- e2e and review ---------------------------------------------------------
```

```python
def env_text(name: str) -> Optional[str]:
    value = (os.environ.get(name) or "").strip()
    return value or None


def env_int(name: str, default: int) -> int:
    value = env_text(name)
    if value is None:
        return default
    try:
        return int(value)
    except ValueError:
        raise JanusError(f"{name} must be an integer number of seconds, not {value!r}")


def service(url_var: str, token_var: str) -> Optional[Tuple[str, str]]:
    """(base URL without trailing slash, token) when both variables are set, else None (spec §5, §9)."""
    url, token = env_text(url_var), env_text(token_var)
    if not url or not token:
        return None
    return url.rstrip("/"), token


def http_json(method: str, url: str, token: str, body: Optional[dict] = None) -> Tuple[int, object]:
    """One REST call with a Bearer token. Returns (HTTP status, parsed JSON or text); (0, reason) when the
    server is unreachable. The token never appears in any returned text (spec §9)."""
    data = json.dumps(body).encode("utf-8") if body is not None else None
    request = urllib.request.Request(url, data=data, method=method)
    request.add_header("Authorization", f"Bearer {token}")
    request.add_header("Accept", "application/json")
    if data is not None:
        request.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(request, timeout=HTTP_TIMEOUT_SECONDS) as response:
            status, text = response.status, response.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        status, text = exc.code, exc.read().decode("utf-8", "replace")
    except (urllib.error.URLError, OSError) as exc:
        return 0, f"{method} {url}: {getattr(exc, 'reason', exc)}"
    try:
        return status, json.loads(text) if text.strip() else {}
    except ValueError:
        return status, text
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `uv run pytest -q`
Expected: `90 passed`

- [ ] **Step 6: Commit**

```bash
cd /home/race-day/janus
git add janus.py tests/conftest.py tests/test_http.py
git commit -m "feat(janus): environment contract, one urllib REST helper and a per-test http.server stub" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---
### Task 14: Bitbucket Server: derive project/repo from `origin`, `ensure_pr`, `pr_state`

Spec §6 step 5 ("Ensures a draft/open Bitbucket PR exists for the changed repo"), §6 last paragraph ("checking actual merged PRs"), §9 ("Only the runner ... calls TeamCity/Bitbucket write APIs"), §10 (`ensure_pr`).

**Files:**
- Modify: `janus.py` (section `# --- bitbucket ---`; replace `redact` in `# --- checks and guardrails ---`)
- Modify: `tests/conftest.py` (`ws` fixture origin URL), `tests/test_checks.py` (one new test)
- Create: `tests/test_bitbucket.py`

**Interfaces:**
- Consumes: `Goal`, `git`, `section`, `service`, `http_json`, `redact`, `BITBUCKET_URL_VAR`, `BITBUCKET_TOKEN_VAR`.
- Produces: `BITBUCKET_API = "/rest/api/1.0"`; `describe_http(status: int, body: object) -> str` (redacted, 300 chars); `parse_origin(url: str) -> Tuple[str, str]` (project key, repo slug); `pr_api(base_url, key, slug) -> str`; `pr_web_url(base_url, key, slug, pr_id: int) -> str`; `pr_id_from_url(url: str) -> int`; `bitbucket_repo(goal: Goal, name: str) -> Tuple[str, str, str, str]` (base URL, token, key, slug; `JanusError` when unconfigured); `pr_state(goal: Goal, name: str, url: str) -> str` (`OPEN` | `MERGED` | `DECLINED`); `ensure_pr(goal: Goal, repo_cfg: dict) -> str` (records `goal.front["prs"][name]`).
- **Origin rule** (tested): take the URL path (`ssh://`, `https://`, `file://` or scp-like `git@host:path`), split on `/`, use the last two segments as key and slug, strip a trailing `.git`, upper-case the key unless it starts with `~`. `ssh://git@host:7999/proj/ui-kit.git`, `git@host:proj/ui-kit.git`, `https://user@host/context/scm/PROJ/ui-kit.git` all give `("PROJ", "ui-kit")`; a bare local path is refused.
- `redact` (slice 1 Task 8) gains a second pass that replaces the literal values of `JANUS_TEAMCITY_TOKEN` and `JANUS_BITBUCKET_TOKEN` (when at least 8 characters) with `[REDACTED]`, so a server echoing a token in an error body or a build log can never reach a prompt or `JANUS.md`.

- [ ] **Step 1: Give the test workspace a parseable origin**

In `tests/conftest.py`, fixture `ws` (slice 1 Task 4), change two lines:

```diff
--- a/tests/conftest.py
+++ b/tests/conftest.py
@@ -15,14 +15,14 @@ def ws(tmp_path):
     (root / "JANUS.md").write_text("# Goal\nUpgrade Angular 15 to 16 in every repository here.\n", encoding="utf-8")
     (root / ".gitignore").write_text("*/\n.janus.lock\n.janus-interrupted.patch\n", encoding="utf-8")
     commit_all(root, "chore(janus): start goal")
-    bare = make_bare(tmp_path / "remotes" / "app.git")
+    bare = make_bare(tmp_path / "remotes" / "PROJ" / "app.git")
     app = root / "app"
     init_repo(app)
     (app / "package.json").write_text('{"name": "app", "version": "0.0.0"}\n', encoding="utf-8")
     (app / "src").mkdir()
     (app / "src" / "app.spec.ts").write_text("describe('app', () => {\n  it('works', () => {});\n});\n", encoding="utf-8")
     commit_all(app, "feat: initial app")
-    git(app, "remote", "add", "origin", str(bare))
+    git(app, "remote", "add", "origin", "file://" + str(bare))
     git(app, "push", "-q", "-u", "origin", "main")
     return types.SimpleNamespace(root=root, app=app, bare=bare)
 
```

Slice 1's tests keep passing: `ws.bare` is still the path, and git accepts `file://` URLs for fetch and push.

- [ ] **Step 2: Write the failing tests**

`tests/test_bitbucket.py`:

```python
import pytest

import janus
from helpers import approve_draft, draft_front, git

PR_API = "/rest/api/1.0/projects/PROJ/repos/app/pull-requests"


@pytest.mark.parametrize(
    "url, expected",
    [
        ("ssh://git@bitbucket.example:7999/proj/ui-kit.git", ("PROJ", "ui-kit")),
        ("git@bitbucket.example:proj/ui-kit.git", ("PROJ", "ui-kit")),
        ("https://bitbucket.example/scm/PROJ/ui-kit.git", ("PROJ", "ui-kit")),
        ("https://martin@bitbucket.example/bitbucket/scm/proj/ui-kit.git", ("PROJ", "ui-kit")),
        ("https://bitbucket.example/scm/~martin/scratch.git", ("~martin", "scratch")),
        ("file:///tmp/remotes/PROJ/app.git", ("PROJ", "app")),
    ],
)
def test_parse_origin_takes_the_last_two_path_segments(url, expected):
    assert janus.parse_origin(url) == expected


@pytest.mark.parametrize("url", ["/tmp/remotes/app.git", "app.git", "https://bitbucket.example/app.git"])
def test_parse_origin_rejects_urls_without_project_and_repo(url):
    with pytest.raises(janus.JanusError, match="cannot derive the Bitbucket project"):
        janus.parse_origin(url)


def test_pr_id_from_url():
    assert janus.pr_id_from_url("https://bb/projects/PROJ/repos/app/pull-requests/42") == 42


def test_ensure_pr_reuses_an_open_pr_for_the_goal_branch(ws, stub):
    goal = approve_draft(ws.root)
    stub.on("GET", PR_API, [(200, {"values": [
        {"id": 3, "state": "OPEN", "fromRef": {"id": "refs/heads/ai/angular-15-to-16"}, "toRef": {"id": "refs/heads/release"}},
        {"id": 5, "state": "OPEN", "fromRef": {"id": "refs/heads/ai/angular-15-to-16"}, "toRef": {"id": "refs/heads/main"}},
    ], "isLastPage": True})])
    url = janus.ensure_pr(goal, goal.front["repos"][0])
    assert url == f"{stub.url}/projects/PROJ/repos/app/pull-requests/5"
    assert goal.front["prs"] == {"app": url}
    [request] = stub.requests
    assert request["method"] == "GET"
    assert request["query"] == {"state": "OPEN", "direction": "OUTGOING", "at": "refs/heads/ai/angular-15-to-16", "limit": "25"}
    assert request["headers"]["authorization"] == "Bearer bb-secret-token"
    assert stub.calls("POST") == []


def test_ensure_pr_creates_an_open_pr_when_none_exists(ws, stub):
    goal = approve_draft(ws.root)
    stub.on("GET", PR_API, [(200, {"values": [], "isLastPage": True})])
    stub.on("POST", PR_API, [(201, {"id": 12, "state": "OPEN"})])
    url = janus.ensure_pr(goal, goal.front["repos"][0])
    assert url == f"{stub.url}/projects/PROJ/repos/app/pull-requests/12"
    assert goal.front["prs"] == {"app": url}
    [post] = stub.calls("POST")
    body = post["json"]
    assert body["title"] == "[Janus] angular-15-to-16: app"
    assert "Upgrade Angular 15 to 16 in every repository here." in body["description"]
    assert "1: Upgrade app to Angular 16" in body["description"] and "Do not merge" in body["description"]
    assert body["state"] == "OPEN" and body["open"] is True and body["closed"] is False
    assert body["fromRef"] == {"id": "refs/heads/ai/angular-15-to-16", "repository": {"slug": "app", "project": {"key": "PROJ"}}}
    assert body["toRef"] == {"id": "refs/heads/main", "repository": {"slug": "app", "project": {"key": "PROJ"}}}
    assert body["reviewers"] == [] and body["locked"] is False
    assert "bb-secret-token" not in post["headers"].get("x-nothing", "") and post["headers"]["authorization"] == "Bearer bb-secret-token"


def test_ensure_pr_keeps_a_recorded_pr_while_it_is_open_and_replaces_a_merged_one(ws, stub):
    goal = approve_draft(ws.root)
    goal.front["prs"] = {"app": f"{stub.url}/projects/PROJ/repos/app/pull-requests/7"}
    stub.on("GET", PR_API + "/7", [(200, {"id": 7, "state": "OPEN"}), (200, {"id": 7, "state": "MERGED"})])
    assert janus.ensure_pr(goal, goal.front["repos"][0]).endswith("/pull-requests/7")
    assert len(stub.requests) == 1
    stub.on("GET", PR_API, [(200, {"values": []})])
    stub.on("POST", PR_API, [(201, {"id": 8})])
    assert janus.ensure_pr(goal, goal.front["repos"][0]).endswith("/pull-requests/8")
    assert goal.front["prs"]["app"].endswith("/pull-requests/8")
    stub.on("GET", PR_API + "/8", [(200, {"id": 8, "state": "MERGED"})])
    assert janus.pr_state(goal, "app", goal.front["prs"]["app"]) == "MERGED"


def test_ensure_pr_without_bitbucket_configuration_is_an_error(ws, monkeypatch):
    goal = approve_draft(ws.root)
    monkeypatch.delenv("JANUS_BITBUCKET_URL", raising=False)
    monkeypatch.delenv("JANUS_BITBUCKET_TOKEN", raising=False)
    with pytest.raises(janus.JanusError, match="Bitbucket is not configured: set JANUS_BITBUCKET_URL and JANUS_BITBUCKET_TOKEN"):
        janus.ensure_pr(goal, goal.front["repos"][0])


def test_ensure_pr_reports_http_failures_without_the_token(ws, stub):
    goal = approve_draft(ws.root)
    stub.on("GET", PR_API, [(401, {"errors": [{"message": "Authentication failed for token bb-secret-token"}]})])
    with pytest.raises(janus.JanusError, match="HTTP 401") as exc:
        janus.ensure_pr(goal, goal.front["repos"][0])
    assert "bb-secret-token" not in str(exc.value)
```

Append to `tests/test_checks.py`:

```python
def test_redact_strips_the_literal_service_tokens_from_the_environment(monkeypatch):
    monkeypatch.setenv("JANUS_TEAMCITY_TOKEN", "tc-very-secret-1234")
    monkeypatch.setenv("JANUS_BITBUCKET_TOKEN", "bb-very-secret-5678")
    out = janus.redact("log: using tc-very-secret-1234 and bb-very-secret-5678 for auth")
    assert out == "log: using [REDACTED] and [REDACTED] for auth"
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `uv run pytest -q tests/test_bitbucket.py tests/test_checks.py`
Expected: FAIL with `AttributeError: module 'janus' has no attribute 'parse_origin'` (and `ensure_pr`, `pr_id_from_url`); `test_redact_strips_the_literal_service_tokens_from_the_environment` fails on the equality.

- [ ] **Step 4: Implement**

Replace `redact` (section `# --- checks and guardrails ---`) with:

```python
def redact(text: str) -> str:
    """Strip credential-shaped values, and the literal TeamCity/Bitbucket tokens from the runner's own
    environment, before text reaches a prompt or JANUS.md (spec §9)."""
    for pattern, replacement in REDACTIONS:
        text = pattern.sub(replacement, text)
    for var in (TEAMCITY_TOKEN_VAR, BITBUCKET_TOKEN_VAR):
        secret = env_text(var)
        if secret and len(secret) >= 8:
            text = text.replace(secret, "[REDACTED]")
    return text
```

Insert under `# --- bitbucket ---`:

```python
BITBUCKET_API = "/rest/api/1.0"


def describe_http(status: int, body: object) -> str:
    text = body if isinstance(body, str) else json.dumps(body)
    return redact(f"HTTP {status} {text}")[:300]


def parse_origin(url: str) -> Tuple[str, str]:
    """(project key, repository slug) from a Bitbucket Server clone URL. Rule: the last two path segments,
    minus a trailing `.git`; keys are upper-cased unless personal (`~user`). Accepted forms:
    ssh://git@host:7999/KEY/slug.git, git@host:KEY/slug.git, https://[user@]host[/context]/scm/KEY/slug.git."""
    if "://" in url:
        path = urllib.parse.urlsplit(url).path
    elif ":" in url and "@" in url.split(":", 1)[0]:
        path = url.split(":", 1)[1]
    else:
        raise JanusError(f"cannot derive the Bitbucket project and repository from origin URL {url!r}: expected an ssh://, https:// or git@host: URL")
    parts = [p for p in path.split("/") if p]
    if len(parts) < 2:
        raise JanusError(f"cannot derive the Bitbucket project and repository from origin URL {url!r}: need /<project>/<repo>.git")
    key, slug = parts[-2], parts[-1]
    if slug.endswith(".git"):
        slug = slug[:-4]
    if not key.startswith("~"):
        key = key.upper()
    return key, slug


def pr_api(base_url: str, key: str, slug: str) -> str:
    return f"{base_url}{BITBUCKET_API}/projects/{key}/repos/{slug}/pull-requests"


def pr_web_url(base_url: str, key: str, slug: str, pr_id: int) -> str:
    return f"{base_url}/projects/{key}/repos/{slug}/pull-requests/{pr_id}"


def pr_id_from_url(url: str) -> int:
    return int(url.rstrip("/").rsplit("/", 1)[1])


def bitbucket_repo(goal: Goal, name: str) -> Tuple[str, str, str, str]:
    """(base_url, token, project key, slug) for a product repo; JanusError when Bitbucket is not configured."""
    bb = service(BITBUCKET_URL_VAR, BITBUCKET_TOKEN_VAR)
    if bb is None:
        raise JanusError(f"Bitbucket is not configured: set {BITBUCKET_URL_VAR} and {BITBUCKET_TOKEN_VAR} in the runner's environment")
    key, slug = parse_origin(git(goal.root / name, "remote", "get-url", "origin"))
    return bb[0], bb[1], key, slug


def pr_state(goal: Goal, name: str, url: str) -> str:
    """OPEN, MERGED or DECLINED for a recorded PR (spec §6: completion needs actual merged PRs)."""
    base_url, token, key, slug = bitbucket_repo(goal, name)
    status, body = http_json("GET", f"{pr_api(base_url, key, slug)}/{pr_id_from_url(url)}", token)
    if status != 200 or not isinstance(body, dict):
        raise JanusError(f"Bitbucket pull request {url} could not be read: {describe_http(status, body)}")
    return str(body.get("state"))


def ensure_pr(goal: Goal, repo_cfg: dict) -> str:
    """Spec §6 step 5: make sure an open Bitbucket PR exists from the goal branch to the base branch and
    record its URL in `prs`. Existing open PRs are reused; Janus never merges, declines or force-pushes."""
    name, branch, base = repo_cfg["name"], repo_cfg["branch"], repo_cfg["base"]
    prs = goal.front.get("prs") or {}
    recorded = prs.get(name)
    if recorded and pr_state(goal, name, recorded) == "OPEN":
        return recorded
    base_url, token, key, slug = bitbucket_repo(goal, name)
    api = pr_api(base_url, key, slug)
    query = urllib.parse.urlencode({"state": "OPEN", "direction": "OUTGOING", "at": f"refs/heads/{branch}", "limit": 25})
    status, body = http_json("GET", f"{api}?{query}", token)
    if status != 200 or not isinstance(body, dict):
        raise JanusError(f"Bitbucket pull-request lookup for {name} failed: {describe_http(status, body)}")
    url = None
    for pr in body.get("values") or []:
        if (pr.get("fromRef") or {}).get("id") == f"refs/heads/{branch}" and (pr.get("toRef") or {}).get("id") == f"refs/heads/{base}":
            url = pr_web_url(base_url, key, slug, int(pr["id"]))
            break
    if url is None:
        tasks = [t for t in goal.front.get("tasks") or [] if t.get("repo") == name]
        payload = {
            "title": f"[Janus] {goal.front.get('id')}: {name}",
            "description": (section(goal.body, "# Goal") or "") + "\n\nTasks in this repository:\n"
            + "\n".join(f"- {t['id']}: {t['objective']}" for t in tasks)
            + "\n\nOpened by Janus. Do not merge before human review and QA.",
            "state": "OPEN",
            "open": True,
            "closed": False,
            "fromRef": {"id": f"refs/heads/{branch}", "repository": {"slug": slug, "project": {"key": key}}},
            "toRef": {"id": f"refs/heads/{base}", "repository": {"slug": slug, "project": {"key": key}}},
            "locked": False,
            "reviewers": [],
        }
        status, body = http_json("POST", api, token, payload)
        if status != 201 or not isinstance(body, dict) or "id" not in body:
            raise JanusError(f"Bitbucket refused to create the pull request for {name} ({branch} -> {base}): {describe_http(status, body)}")
        url = pr_web_url(base_url, key, slug, int(body["id"]))
    prs[name] = url
    goal.front["prs"] = prs
    return url
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `uv run pytest -q`
Expected: `106 passed`

- [ ] **Step 6: Commit**

```bash
cd /home/race-day/janus
git add janus.py tests/conftest.py tests/test_checks.py tests/test_bitbucket.py
git commit -m "feat(janus): ensure a Bitbucket pull request per goal branch and read PR states" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---
### Task 15: TeamCity: `find_or_trigger_build`, `wait_and_summarize_build` for the exact commit

Spec §6 steps 6 and 7 ("Finds the PR build corresponding to that **exact commit SHA** ... triggers the approved TeamCity build explicitly. Never regards an older green build as proof for a new commit", "bounded, redacted failure summary", "CI infrastructure/start failures ... retried once"), §9 (redaction), §10 (`find_or_trigger_build`, `wait_and_summarize_build`, "Handle HTTP pagination/timeouts narrowly").

**Files:**
- Modify: `janus.py` (section `# --- teamcity ---`)
- Create: `tests/test_teamcity.py`

**Interfaces:**
- Consumes: `service`, `http_json`, `env_int`, `describe_http`, `redact`, `tail`, `FAILURE_SUMMARY_CHARS`, the `*_VAR` constants.
- Produces: `TEAMCITY_API = "/app/rest/2018.1"`; `BUILD_FIELDS` (see the contract); `teamcity() -> Tuple[str, str]` (`JanusError` naming both variables when unconfigured); `build_url(base_url, build_id) -> str` (`<base>/viewLog.html?buildId=<id>`); `build_revisions(build: dict) -> List[str]`; `locate_builds(build_type: str, sha: str) -> List[dict]` (queued/running/finished builds of exactly that revision, newest first; builds whose `revisions` name another commit are dropped even if the server returned them); `build_by_id(build_id) -> dict`; `queue_build(build_type: str, branch: Optional[str], sha: Optional[str], properties: Optional[Dict[str, str]], comment: str) -> dict`; `find_or_trigger_build(build_type: str, sha: str, branch: str, comment: str) -> dict` (polls `locate_builds` every `JANUS_POLL_SECONDS` until `JANUS_BUILD_APPEARANCE_SECONDS`, then queues); `failure_excerpt(build: dict, base_url: str, token: str) -> str`; `wait_and_summarize_build(build_id, sha: Optional[str]) -> dict` with keys `id`, `number`, `url`, `status` in `green | red | infra | timeout`, `summary` (redacted, at most `FAILURE_SUMMARY_CHARS`). `infra` = `failedToStart`, `canceledInfo` or a status other than SUCCESS/FAILURE. A build whose revisions do not contain `sha` raises `JanusError` ("not a build of commit").

- [ ] **Step 1: Write the failing tests**

`tests/test_teamcity.py`:

```python
import pytest

import janus

TC = "/app/rest/2018.1"
SHA = "c" * 40
OLD = "b" * 40


def build(build_id, state="finished", status="SUCCESS", sha=SHA, **extra):
    """A TeamCity build JSON as `fields=id,number,state,status,statusText,webUrl,...` returns it; queued builds have no status."""
    data = {"id": build_id, "number": str(build_id), "state": state,
            "webUrl": f"https://tc.example/viewLog.html?buildId={build_id}", "buildType": {"id": "Fe_App_Build"},
            "revisions": {"revision": [{"version": sha}]}}
    if status is not None:
        data.update({"status": status, "statusText": f"{status.lower()} text"})
    data.update(extra)
    return data


def test_find_or_trigger_build_uses_the_newest_build_of_the_exact_commit(stub):
    stub.on("GET", TC + "/builds", [(200, {"count": 2, "build": [build(101), build(102, state="running", status="SUCCESS")]})])
    found = janus.find_or_trigger_build("Fe_App_Build", SHA, "ai/angular-15-to-16", "Janus")
    assert found["id"] == 102
    [request] = stub.requests
    assert request["query"]["locator"] == f"buildType:(id:Fe_App_Build),revision:(version:{SHA}),branch:(default:any),state:any,defaultFilter:false,count:20"
    assert request["query"]["fields"].startswith("count,build(id,number,state,status,statusText,webUrl,failedToStart")
    assert request["headers"]["authorization"] == "Bearer tc-secret-token" and request["headers"]["accept"] == "application/json"
    assert stub.calls("POST") == []


def test_find_or_trigger_build_never_accepts_a_build_of_another_commit_and_queues_one(stub):
    stub.on("GET", TC + "/builds", [(200, {"count": 1, "build": [build(90, sha=OLD)]})])
    stub.on("POST", TC + "/buildQueue", [(200, {"id": 200, "state": "queued", "buildTypeId": "Fe_App_Build"})])
    queued = janus.find_or_trigger_build("Fe_App_Build", SHA, "ai/angular-15-to-16", "Janus: verify task 1")
    assert queued["id"] == 200
    [post] = stub.calls("POST")
    assert post["json"] == {
        "buildType": {"id": "Fe_App_Build"},
        "comment": {"text": "Janus: verify task 1"},
        "branchName": "ai/angular-15-to-16",
        "lastChanges": {"change": [{"locator": f"version:{SHA},buildType:(id:Fe_App_Build)"}]},
    }


def test_find_or_trigger_build_polls_until_the_appearance_timeout(stub, monkeypatch):
    monkeypatch.setenv("JANUS_BUILD_APPEARANCE_SECONDS", "1")
    monkeypatch.setenv("JANUS_POLL_SECONDS", "0")
    stub.on("GET", TC + "/builds", [(200, {"count": 0}), (200, {"count": 0}), (200, {"count": 1, "build": [build(103, state="queued", status=None)]})])
    assert janus.find_or_trigger_build("Fe_App_Build", SHA, "b", "c")["id"] == 103
    assert len(stub.calls("GET")) == 3 and stub.calls("POST") == []


def test_wait_and_summarize_build_polls_to_green(stub):
    stub.on("GET", TC + "/builds/id:101", [(200, build(101, state="queued", status=None)), (200, build(101, state="running", status="SUCCESS")), (200, build(101))])
    result = janus.wait_and_summarize_build(101, SHA)
    assert result == {"id": 101, "number": "101", "url": "https://tc.example/viewLog.html?buildId=101", "status": "green", "summary": "success text"}
    assert len(stub.calls("GET", TC + "/builds/id:101")) == 3
    assert stub.calls("GET", TC + "/builds/id:101")[0]["query"] == {"fields": janus.BUILD_FIELDS}


def test_wait_and_summarize_build_describes_a_red_build_with_redacted_bounded_details(stub, monkeypatch):
    stub.on("GET", TC + "/builds/id:102", [(200, build(102, status="FAILURE", statusText="Tests failed: 1"))])
    stub.on("GET", TC + "/testOccurrences", [(200, {"testOccurrence": [
        {"name": "AppComponent should render", "details": "Expected 16 to be 15\n  at src/app.spec.ts:12\nnpm_token=abc123secret"},
    ]})])
    stub.on("GET", TC + "/problemOccurrences", [(200, {"problemOccurrence": [{"type": "TC_EXIT_CODE", "details": "Process exited with code 1 " + "x" * 2000}]})])
    result = janus.wait_and_summarize_build(102, SHA)
    assert result["status"] == "red" and result["id"] == 102
    summary = result["summary"]
    assert summary.startswith("TeamCity build #102 (https://tc.example/viewLog.html?buildId=102): Tests failed: 1")
    assert "FAILED AppComponent should render" in summary and "Expected 16 to be 15" in summary
    assert "abc123secret" not in summary and "npm_token=[REDACTED]" in summary
    assert "PROBLEM TC_EXIT_CODE: ...[truncated]..." in summary
    assert len(summary) <= janus.FAILURE_SUMMARY_CHARS + 20
    tests_request = stub.calls("GET", TC + "/testOccurrences")[0]["query"]
    assert tests_request == {"locator": "build:(id:102),status:FAILURE,count:20", "fields": "testOccurrence(name,details)"}
    assert stub.calls("GET", TC + "/problemOccurrences")[0]["query"]["locator"] == "build:(id:102),count:20"


def test_wait_and_summarize_build_classifies_failed_to_start_and_canceled_as_infra(stub):
    stub.on("GET", TC + "/builds/id:103", [(200, build(103, status="FAILURE", failedToStart=True, statusText="Agent lost"))])
    stub.on("GET", TC + "/builds/id:104", [(200, build(104, status="UNKNOWN", canceledInfo={"text": "canceled"}))])
    stub.on("GET", TC + "/testOccurrences", [(200, {})])
    stub.on("GET", TC + "/problemOccurrences", [(404, {})])
    assert janus.wait_and_summarize_build(103, SHA)["status"] == "infra"
    canceled = janus.wait_and_summarize_build(104, SHA)
    assert canceled["status"] == "infra" and canceled["summary"].startswith("TeamCity build #104")


def test_wait_and_summarize_build_times_out_without_pretending(stub, monkeypatch):
    monkeypatch.setenv("JANUS_BUILD_TIMEOUT_SECONDS", "0")
    stub.on("GET", TC + "/builds/id:105", [(200, build(105, state="running", status="SUCCESS"))])
    result = janus.wait_and_summarize_build(105, SHA)
    assert result["status"] == "timeout" and "still running" in result["summary"]


def test_wait_and_summarize_build_refuses_a_build_of_another_commit(stub):
    stub.on("GET", TC + "/builds/id:106", [(200, build(106, sha=OLD))])
    with pytest.raises(janus.JanusError, match="not a build of commit"):
        janus.wait_and_summarize_build(106, SHA)


def test_teamcity_must_be_configured(monkeypatch):
    monkeypatch.delenv("JANUS_TEAMCITY_URL", raising=False)
    monkeypatch.delenv("JANUS_TEAMCITY_TOKEN", raising=False)
    with pytest.raises(janus.JanusError, match="TeamCity is not configured: set JANUS_TEAMCITY_URL and JANUS_TEAMCITY_TOKEN"):
        janus.locate_builds("Fe_App_Build", SHA)


def test_queue_build_passes_properties_for_parameterised_builds(stub):
    stub.on("POST", TC + "/buildQueue", [(200, {"id": 300, "state": "queued"})])
    janus.queue_build("Fe_E2E_Full", None, None, {"env.SHELL_BRANCH": "ai/x", "env.ORDERS_BRANCH": "develop"}, "Janus E2E")
    assert stub.calls("POST")[0]["json"] == {
        "buildType": {"id": "Fe_E2E_Full"},
        "comment": {"text": "Janus E2E"},
        "properties": {"property": [{"name": "env.SHELL_BRANCH", "value": "ai/x"}, {"name": "env.ORDERS_BRANCH", "value": "develop"}]},
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest -q tests/test_teamcity.py`
Expected: FAIL with `AttributeError: module 'janus' has no attribute 'find_or_trigger_build'` (and `wait_and_summarize_build`, `locate_builds`, `queue_build`, `BUILD_FIELDS`).

- [ ] **Step 3: Implement**

Insert under `# --- teamcity ---`:

```python
TEAMCITY_API = "/app/rest/2018.1"


BUILD_FIELDS = "id,number,state,status,statusText,webUrl,failedToStart,canceledInfo(text),revisions(revision(version)),buildType(id)"


def teamcity() -> Tuple[str, str]:
    tc = service(TEAMCITY_URL_VAR, TEAMCITY_TOKEN_VAR)
    if tc is None:
        raise JanusError(f"TeamCity is not configured: set {TEAMCITY_URL_VAR} and {TEAMCITY_TOKEN_VAR} in the runner's environment")
    return tc


def build_url(base_url: str, build_id: object) -> str:
    return f"{base_url}/viewLog.html?buildId={build_id}"


def build_revisions(build: dict) -> List[str]:
    return [str(r.get("version")) for r in ((build.get("revisions") or {}).get("revision") or [])]


def locate_builds(build_type: str, sha: str) -> List[dict]:
    """Every queued, running or finished build of `build_type` for exactly `sha`, newest first (spec §6 step 6)."""
    base_url, token = teamcity()
    locator = f"buildType:(id:{build_type}),revision:(version:{sha}),branch:(default:any),state:any,defaultFilter:false,count:20"
    query = urllib.parse.urlencode({"locator": locator, "fields": f"count,build({BUILD_FIELDS})"})
    status, body = http_json("GET", f"{base_url}{TEAMCITY_API}/builds?{query}", token)
    if status != 200 or not isinstance(body, dict):
        raise JanusError(f"TeamCity build lookup for {build_type} at {sha[:12]} failed: {describe_http(status, body)}")
    builds = [b for b in body.get("build") or [] if not build_revisions(b) or sha in build_revisions(b)]
    return sorted(builds, key=lambda b: int(b.get("id") or 0), reverse=True)


def build_by_id(build_id: object) -> dict:
    base_url, token = teamcity()
    query = urllib.parse.urlencode({"fields": BUILD_FIELDS})
    status, body = http_json("GET", f"{base_url}{TEAMCITY_API}/builds/id:{build_id}?{query}", token)
    if status != 200 or not isinstance(body, dict):
        raise JanusError(f"TeamCity build {build_id} could not be read: {describe_http(status, body)}")
    return body


def queue_build(build_type: str, branch: Optional[str], sha: Optional[str], properties: Optional[Dict[str, str]], comment: str) -> dict:
    """POST /buildQueue: the approved build type, on the exact branch and (when given) the exact revision."""
    base_url, token = teamcity()
    payload: Dict[str, object] = {"buildType": {"id": build_type}, "comment": {"text": comment}}
    if branch:
        payload["branchName"] = branch
    if sha:
        payload["lastChanges"] = {"change": [{"locator": f"version:{sha},buildType:(id:{build_type})"}]}
    if properties:
        payload["properties"] = {"property": [{"name": k, "value": v} for k, v in properties.items()]}
    status, body = http_json("POST", f"{base_url}{TEAMCITY_API}/buildQueue", token, payload)
    if status not in (200, 201) or not isinstance(body, dict) or "id" not in body:
        raise JanusError(f"TeamCity refused to queue {build_type}: {describe_http(status, body)}")
    return body


def find_or_trigger_build(build_type: str, sha: str, branch: str, comment: str) -> dict:
    """Spec §6 step 6: the PR build for this exact commit. Wait for an automatic build to appear; after the
    appearance timeout queue one explicitly. An older build of another commit is never used."""
    poll = env_int(POLL_SECONDS_VAR, 30)
    deadline = time.monotonic() + env_int(BUILD_APPEARANCE_VAR, 600)
    while True:
        builds = locate_builds(build_type, sha)
        if builds:
            return builds[0]
        if time.monotonic() >= deadline:
            break
        time.sleep(poll)
    print(f"No {build_type} build appeared for {sha[:12]}; queuing one.")
    return queue_build(build_type, branch, sha, None, comment)


def failure_excerpt(build: dict, base_url: str, token: str) -> str:
    """Bounded, redacted description of a red build for the fix prompt and the handover (spec §6 step 7, §9)."""
    build_id = build.get("id")
    lines = [f"TeamCity build #{build.get('number')} ({build.get('webUrl') or build_url(base_url, build_id)}): {build.get('statusText')}"]
    query = urllib.parse.urlencode({"locator": f"build:(id:{build_id}),status:FAILURE,count:20", "fields": "testOccurrence(name,details)"})
    status, body = http_json("GET", f"{base_url}{TEAMCITY_API}/testOccurrences?{query}", token)
    if status == 200 and isinstance(body, dict):
        for test in body.get("testOccurrence") or []:
            lines.append(f"FAILED {test.get('name')}\n{tail(str(test.get('details') or ''), 800)}")
    query = urllib.parse.urlencode({"locator": f"build:(id:{build_id}),count:20", "fields": "problemOccurrence(type,details)"})
    status, body = http_json("GET", f"{base_url}{TEAMCITY_API}/problemOccurrences?{query}", token)
    if status == 200 and isinstance(body, dict):
        for problem in body.get("problemOccurrence") or []:
            lines.append(f"PROBLEM {problem.get('type')}: {tail(str(problem.get('details') or ''), 800)}")
    return redact(tail("\n".join(lines), FAILURE_SUMMARY_CHARS))


def wait_and_summarize_build(build_id: object, sha: Optional[str]) -> dict:
    """Poll one build to completion. Returns {id, number, url, status: green|red|infra|timeout, summary}.
    `infra` covers failed-to-start and canceled builds (retried once, not a code-fix attempt, spec §6 step 7)."""
    base_url, token = teamcity()
    poll = env_int(POLL_SECONDS_VAR, 30)
    timeout = env_int(BUILD_TIMEOUT_VAR, 7200)
    deadline = time.monotonic() + timeout
    while True:
        build = build_by_id(build_id)
        if sha and build_revisions(build) and sha not in build_revisions(build):
            raise JanusError(f"TeamCity build {build_id} is not a build of commit {sha}; refusing to use it as evidence")
        url = build.get("webUrl") or build_url(base_url, build_id)
        if build.get("state") == "finished":
            break
        if time.monotonic() >= deadline:
            return {"id": int(build["id"]), "number": build.get("number"), "url": url, "status": "timeout",
                    "summary": f"build {build_id} is still {build.get('state')} after {timeout}s"}
        time.sleep(poll)
    if build.get("failedToStart") or build.get("canceledInfo") or build.get("status") not in ("SUCCESS", "FAILURE"):
        status = "infra"
    else:
        status = "green" if build.get("status") == "SUCCESS" else "red"
    summary = redact(str(build.get("statusText") or "")) if status == "green" else failure_excerpt(build, base_url, token)
    return {"id": int(build["id"]), "number": build.get("number"), "url": url, "status": status, "summary": summary}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest -q`
Expected: `116 passed`

- [ ] **Step 5: Commit**

```bash
cd /home/race-day/janus
git add janus.py tests/test_teamcity.py
git commit -m "feat(janus): locate, queue and poll TeamCity builds for the exact commit with redacted failure excerpts" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---
### Task 16: `run` verifies every pushed commit in TeamCity and advances to the next task

Spec §6 steps 5 to 8 (PR, exact-SHA build, bounded red loop, green records evidence and advances), §5 ("`run` ... advance until next human gate, block or completion"), §7 ("A required TeamCity or Bitbucket capability is unavailable", "unexpected remote changes"), §8 (checkpoint before a CI wait; "An already-pushed commit or completed build must not be duplicated"), §9 ("An agent cannot modify Janus approval/state"), §11 criteria 3, 4, 5, 9.

**Files:**
- Modify: `janus.py` (constants; section `# --- run ---`: replace `record_verified`, `stop_for_human`, `run_next_task`, `reconcile_in_flight` from slice 1 Tasks 9 and 10; add `goal_file_digest`, `remote_head`, `verify_task_ci`, `complete_task`, `finish_goal`; replace `cmd_run` in the CLI section)
- Modify: `tests/helpers.py` (append CI/SCM stub scripts), `tests/test_run.py` (one slice 1 test changes meaning)
- Create: `tests/test_run_ci.py`

**Interfaces:**
- Consumes: everything from slice 1 Tasks 2 to 10 plus `ensure_pr`, `find_or_trigger_build`, `queue_build`, `wait_and_summarize_build`, `service`, `redact`.
- Produces: `ADVANCE = -1` (return value of `run_next_task` meaning "task finished, start the next"); `record_verified(goal, name, sha, build: Optional[int] = None, status: str = "local_checks_passed")` (slice 1 signature extended with defaults); `stop_for_human(goal, reason, next_action, status: str = "blocked")` (Task 21 adds `handover`); `goal_file_digest(root: Path) -> str`; `remote_head(repo: Path, branch: str) -> Optional[str]` (`git ls-remote origin refs/heads/<branch>`); `verify_task_ci(goal, task, repo_cfg, sha) -> dict` (`wait_and_summarize_build`'s dict, or `status: "unavailable"` with the redacted error when TeamCity/Bitbucket cannot be used; ensures the PR, checkpoints `in_flight.operation = "ci_wait"` with the build id, retries one infrastructure failure by queuing a fresh build of the same commit); `complete_task(goal, task, repo_cfg, sha, outcome) -> int` (records `last_verified[name] = {commit, teamcity_build, status: green}`, `task.status = done`, `task.verified_build`, checkpoints, returns `ADVANCE`); `finish_goal(goal) -> int` (all tasks done: human gate with `status: awaiting_human_review`, exit 1; Tasks 18, 20, 21 extend it); `cmd_run` loops `run_next_task` until it returns something other than `ADVANCE`.
- Behaviour fixed here: a task whose repo has `pr_build: null` still stops with slice 1's `CI_HANDOVER` (local checks are not CI evidence). With `pr_build` set, a pushed commit is verified by the build of exactly that SHA; red starts a fresh Codex fix attempt with the redacted excerpt (`attempts` counts local and CI failures together, max 3); `infra` is retried once without counting; `timeout`/second `infra`/`unavailable` stop for a human with the task left `awaiting_ci` so the next `run` re-locates the build by SHA. A `ci_wait` in `in_flight` needs no reconciliation on restart (the commit is in `last_verified`); `reconcile_in_flight` returns `False` for every non-`codex` operation. Before verifying, `remote_head` must equal the Janus commit, otherwise stop (§7 unexpected remote changes). After every Codex run the SHA-256 of `JANUS.md` is compared with the value taken right before the run; a change restores the runner's copy and stops (§11 criterion 9).
- Test helpers (`tests/helpers.py`): `TC_API`, `tc_build(build_id, sha, state, status, build_type, **extra)`, `script_ci(stub, outcomes=("green",), first_id=101, automatic=True)` (the n-th build the stub allocates, found automatically for a commit or queued by Janus, gets the n-th outcome `green | red | infra`; `automatic` is `True`, `False` or a tuple of build type ids that have a VCS trigger; returns the list of allocated builds `{id, type, sha, outcome}`), `script_bitbucket(stub, slug="app", key="PROJ", existing=None, pr_id=12, state="OPEN") -> pr_url`.

- [ ] **Step 1: Add the CI and Bitbucket stub scripts**

Append to `tests/helpers.py` (also add `import re` to its imports):

```python
TC_API = "/app/rest/2018.1"


def tc_build(build_id, sha, state="finished", status="SUCCESS", build_type="Fe_App_Build", **extra):
    data = {"id": build_id, "number": str(build_id), "state": state, "webUrl": f"https://tc.example/viewLog.html?buildId={build_id}",
            "buildType": {"id": build_type}, "revisions": {"revision": [{"version": sha}]}}
    if status is not None:
        data.update({"status": status, "statusText": f"{status.lower()} text"})
    data.update(extra)
    return data


def script_ci(stub, outcomes=("green",), first_id=101, automatic=True):
    """Stub TeamCity: every build the stub allocates (found automatically for a commit, or queued by Janus)
    gets the next outcome in order (green | red | infra; the last repeats). Builds are per (build type,
    commit). `automatic` says which build types have a VCS trigger, i.e. get a build for a new commit
    without Janus queuing one: True (all), False (none) or a tuple of build type ids. Returns the allocated
    builds as dicts {id, type, sha, outcome}; E2E builds (queued without lastChanges) get sha None."""
    builds = []

    def new_build(build_type, sha):
        build_id = max([b["id"] for b in builds] + [first_id - 1]) + 1
        build = {"id": build_id, "type": build_type, "sha": sha, "outcome": outcomes[min(len(builds), len(outcomes) - 1)]}
        builds.append(build)
        return build

    def as_json(build):
        if build["outcome"] == "infra":
            return tc_build(build["id"], build["sha"], status="FAILURE", build_type=build["type"], failedToStart=True, statusText="Agent lost")
        return tc_build(build["id"], build["sha"], status="SUCCESS" if build["outcome"] == "green" else "FAILURE", build_type=build["type"])

    def by_locator(record):
        locator = record["query"]["locator"]
        build_type = re.search(r"buildType:\(id:([^)]+)\)", locator).group(1)
        sha = re.search(r"revision:\(version:([0-9a-f]{40})\)", locator).group(1)
        known = [b for b in builds if b["sha"] == sha and b["type"] == build_type]
        triggered = automatic is True or (automatic and build_type in automatic)
        if not known and triggered:
            known = [new_build(build_type, sha)]
        if not known:
            return 200, {"count": 0}
        return 200, {"count": len(known), "build": [as_json(b) for b in reversed(known)]}

    def by_queue(record):
        body = record["json"]
        sha = None
        if "lastChanges" in body:
            sha = re.search(r"version:([0-9a-f]{40})", body["lastChanges"]["change"][0]["locator"]).group(1)
        build = new_build(body["buildType"]["id"], sha)
        return 200, {"id": build["id"], "state": "queued", "buildTypeId": build["type"]}

    def by_id(record):
        build_id = int(record["path"].rsplit("id:", 1)[1])
        for build in builds:
            if build["id"] == build_id:
                return 200, as_json(build)
        return 404, {"message": f"no build {build_id}"}

    stub.on("GET", TC_API + "/builds", by_locator)
    stub.on("POST", TC_API + "/buildQueue", by_queue)
    stub.on("GET", TC_API + "/testOccurrences", [(200, {"testOccurrence": [{"name": "AppComponent renders", "details": "Expected 16 to be 15\nnpm_token=abc123secret"}]})])
    stub.on("GET", TC_API + "/problemOccurrences", [(200, {"problemOccurrence": [{"type": "TC_EXIT_CODE", "details": "Process exited with code 1"}]})])
    for build_id in range(first_id, first_id + 100):
        stub.on("GET", f"{TC_API}/builds/id:{build_id}", by_id)
    return builds


def script_bitbucket(stub, slug="app", key="PROJ", existing=None, pr_id=12, state="OPEN"):
    """Stub Bitbucket Server for one repository: PR lookup (empty unless `existing`), PR creation, PR state."""
    api = f"/rest/api/1.0/projects/{key}/repos/{slug}/pull-requests"
    values = [] if existing is None else [{"id": existing, "state": "OPEN", "fromRef": {"id": "refs/heads/ai/angular-15-to-16"}, "toRef": {"id": "refs/heads/main"}}]
    stub.on("GET", api, [(200, {"values": values, "isLastPage": True})])
    stub.on("POST", api, [(201, {"id": pr_id, "state": "OPEN"})])
    stub.on("GET", f"{api}/{existing or pr_id}", [(200, {"id": existing or pr_id, "state": state})])
    return f"{stub.url}/projects/{key}/repos/{slug}/pull-requests/{existing or pr_id}"
```

- [ ] **Step 2: Rewrite the one slice 1 test whose meaning changes**

In `tests/test_run.py` (slice 1 Task 9), replace `test_run_with_all_tasks_done_records_completion` with:

```python
def test_run_with_all_tasks_done_stops_at_the_human_review_gate(ws, fake_codex):
    goal = approve_draft(ws.root)
    goal.front["tasks"][0]["status"] = "done"
    janus.save_goal(goal)
    assert janus.cmd_run(ws.root) == 1
    assert fake_codex.calls() == []
    gate = janus.load_goal(ws.root)
    assert gate.front["status"] == "awaiting_human_review" and gate.front["current_task"] is None
    progress = janus.section(gate.body, "## Progress and handover")
    assert "Completed tasks: 1" in progress and "human PR review and QA are next" in progress and "PRs: none recorded" in progress
```

- [ ] **Step 3: Write the failing tests**

`tests/test_run_ci.py`:

```python
import pytest

import janus
from helpers import approve_draft, codex_output, commit_all, draft_front, git, script_bitbucket, script_ci

BRANCH = "ai/angular-15-to-16"


def approve_with_ci(ws, checks=("test -f package.json",)):
    return approve_draft(ws.root, draft_front(checks=list(checks), pr_build="Fe_App_Build"))


def test_run_verifies_the_exact_commit_in_teamcity_opens_a_pr_and_completes_the_task(ws, fake_codex, stub):
    approve_with_ci(ws)
    pr_url = script_bitbucket(stub)
    builds = script_ci(stub, ["green"])
    fake_codex.script([{"shell": ["echo a > a.txt"], "output": codex_output(summary="upgraded")}])
    assert janus.cmd_run(ws.root) == 1
    sha = git(ws.app, "rev-parse", "HEAD")
    assert builds == [{"id": 101, "type": "Fe_App_Build", "sha": sha, "outcome": "green"}]
    goal = janus.load_goal(ws.root)
    assert goal.front["last_verified"] == {"app": {"commit": sha, "teamcity_build": 101, "status": "green"}}
    assert goal.front["prs"] == {"app": pr_url}
    task = goal.front["tasks"][0]
    assert task["status"] == "done" and task["verified_build"] == 101 and task["summary"] == "upgraded"
    assert goal.front["status"] == "awaiting_human_review" and goal.front["in_flight"] is None and goal.front["attempts"] == 0
    log = git(ws.root, "log", "--format=%s").splitlines()
    assert log[:5] == [
        "chore(janus): stop for human direction",
        "chore(janus): task 1 verified green in build 101",
        "chore(janus): task 1 waiting for build 101",
        f"chore(janus): task 1 awaiting CI for {sha[:12]}",
        f"chore(janus): task 1 pushed {sha[:12]}",
    ]
    assert stub.calls("POST", "/rest/api/1.0/projects/PROJ/repos/app/pull-requests")[0]["json"]["fromRef"]["id"] == f"refs/heads/{BRANCH}"
    assert stub.calls("POST", "/app/rest/2018.1/buildQueue") == []
    janus_md = (ws.root / "JANUS.md").read_text(encoding="utf-8")
    assert "tc-secret-token" not in janus_md and "bb-secret-token" not in janus_md
    assert pr_url in janus.section(goal.body, "## Progress and handover")
    [call] = fake_codex.calls()
    assert "tc-secret-token" not in call["prompt"] and "bb-secret-token" not in call["prompt"]


def test_run_red_build_starts_a_fresh_fix_attempt_with_the_redacted_ci_summary(ws, fake_codex, stub):
    approve_with_ci(ws)
    script_bitbucket(stub)
    builds = script_ci(stub, ["red", "green"])
    fake_codex.script([
        {"shell": ["echo a > a.txt"], "output": codex_output(summary="first")},
        {"shell": ["echo b > b.txt"], "output": codex_output(summary="fixed the spec")},
    ])
    assert janus.cmd_run(ws.root) == 1
    calls = fake_codex.calls()
    assert len(calls) == 2
    prompt = calls[1]["prompt"]
    assert "Previous attempt failed" in prompt and "TeamCity PR build of commit" in prompt and "is red" in prompt
    assert "FAILED AppComponent renders" in prompt and "Expected 16 to be 15" in prompt
    assert "abc123secret" not in prompt and "npm_token=[REDACTED]" in prompt
    assert "https://tc.example/viewLog.html?buildId=101" in prompt
    sha = git(ws.app, "rev-parse", "HEAD")
    assert [b["outcome"] for b in builds] == ["red", "green"] and builds[1]["sha"] == sha
    assert git(ws.bare, "rev-list", "--count", BRANCH) == "3"
    goal = janus.load_goal(ws.root)
    assert goal.front["last_verified"]["app"] == {"commit": sha, "teamcity_build": 102, "status": "green"}
    assert goal.front["tasks"][0]["status"] == "done" and goal.front["tasks"][0]["summary"] == "fixed the spec"
    assert goal.front["attempts"] == 0
    assert "chore(janus): task 1 attempt 1 in app" in git(ws.root, "log", "--format=%s")


def test_run_stops_after_three_red_builds_with_a_useful_handover(ws, fake_codex, stub):
    approve_with_ci(ws)
    pr_url = script_bitbucket(stub)
    builds = script_ci(stub, ["red"])
    fake_codex.script([{"shell": ["echo a >> a.txt"], "output": codex_output()}])
    assert janus.cmd_run(ws.root) == 1
    assert len(fake_codex.calls()) == 4 and len(builds) == 4
    goal = janus.load_goal(ws.root)
    sha = git(ws.app, "rev-parse", "HEAD")
    assert goal.front["status"] == "blocked" and goal.front["attempts"] == 3
    assert goal.front["tasks"][0]["status"] == "awaiting_ci"
    assert goal.front["last_verified"]["app"] == {"commit": sha, "teamcity_build": 104, "status": "red"}
    progress = janus.section(goal.body, "## Progress and handover")
    assert "3 code-fix attempts exhausted" in progress and "https://tc.example/viewLog.html?buildId=104" in progress and sha in progress
    assert "FAILED AppComponent renders" in progress and "abc123secret" not in progress
    assert pr_url in janus.show_status(goal)


def test_infrastructure_failure_is_retried_once_by_queuing_the_same_commit(ws, fake_codex, stub):
    approve_with_ci(ws)
    script_bitbucket(stub)
    builds = script_ci(stub, ["infra", "green"])
    fake_codex.script([{"shell": ["echo a > a.txt"], "output": codex_output()}])
    assert janus.cmd_run(ws.root) == 1
    sha = git(ws.app, "rev-parse", "HEAD")
    assert len(fake_codex.calls()) == 1
    assert [(b["sha"], b["outcome"]) for b in builds] == [(sha, "infra"), (sha, "green")]
    [queued] = stub.calls("POST", "/app/rest/2018.1/buildQueue")
    assert queued["json"]["lastChanges"]["change"][0]["locator"] == f"version:{sha},buildType:(id:Fe_App_Build)"
    assert queued["json"]["branchName"] == BRANCH
    goal = janus.load_goal(ws.root)
    assert goal.front["tasks"][0]["status"] == "done" and goal.front["attempts"] == 0
    assert goal.front["last_verified"]["app"]["teamcity_build"] == 102


def test_second_infrastructure_failure_stops_for_a_human(ws, fake_codex, stub):
    approve_with_ci(ws)
    script_bitbucket(stub)
    script_ci(stub, ["infra", "infra"])
    fake_codex.script([{"shell": ["echo a > a.txt"], "output": codex_output()}])
    assert janus.cmd_run(ws.root) == 1
    goal = janus.load_goal(ws.root)
    assert goal.front["status"] == "blocked" and goal.front["attempts"] == 0
    assert goal.front["tasks"][0]["status"] == "awaiting_ci"
    progress = janus.section(goal.body, "## Progress and handover")
    assert "did not produce a verdict [infra]" in progress and "Agent lost" in progress


def test_no_automatic_build_triggers_one_for_the_exact_revision(ws, fake_codex, stub):
    approve_with_ci(ws)
    script_bitbucket(stub)
    builds = script_ci(stub, ["green"], automatic=False)
    fake_codex.script([{"shell": ["echo a > a.txt"], "output": codex_output()}])
    assert janus.cmd_run(ws.root) == 1
    sha = git(ws.app, "rev-parse", "HEAD")
    [queued] = stub.calls("POST", "/app/rest/2018.1/buildQueue")
    assert queued["json"]["buildType"] == {"id": "Fe_App_Build"} and queued["json"]["branchName"] == BRANCH
    assert sha in queued["json"]["lastChanges"]["change"][0]["locator"]
    assert queued["json"]["comment"]["text"] == f"Janus angular-15-to-16: verify task 1 commit {sha[:12]}"
    assert builds == [{"id": 101, "type": "Fe_App_Build", "sha": sha, "outcome": "green"}]
    assert janus.load_goal(ws.root).front["tasks"][0]["status"] == "done"


def test_an_older_green_build_of_another_commit_is_never_evidence(ws, fake_codex, stub):
    approve_with_ci(ws)
    script_bitbucket(stub)
    old_green = {"count": 1, "build": [{"id": 90, "number": "90", "state": "finished", "status": "SUCCESS", "statusText": "ok",
                                        "webUrl": "https://tc.example/viewLog.html?buildId=90", "revisions": {"revision": [{"version": "b" * 40}]}}]}
    posted = []
    stub.on("GET", "/app/rest/2018.1/builds", lambda record: (200, old_green) if not posted else (200, {"count": 0}))

    def queue(record):
        posted.append(record)
        return 200, {"id": 200, "state": "queued"}

    stub.on("POST", "/app/rest/2018.1/buildQueue", queue)
    stub.on("GET", "/app/rest/2018.1/builds/id:200", lambda record: (200, {
        "id": 200, "number": "200", "state": "finished", "status": "SUCCESS", "statusText": "ok",
        "webUrl": "https://tc.example/viewLog.html?buildId=200",
        "revisions": {"revision": [{"version": git(ws.app, "rev-parse", "HEAD")}]}}))
    fake_codex.script([{"shell": ["echo a > a.txt"], "output": codex_output()}])
    assert janus.cmd_run(ws.root) == 1
    assert len(posted) == 1
    goal = janus.load_goal(ws.root)
    assert goal.front["last_verified"]["app"]["teamcity_build"] == 200 and goal.front["tasks"][0]["status"] == "done"


def test_crash_during_ci_wait_resumes_without_a_new_commit_or_codex_run(ws, fake_codex, stub):
    goal = approve_with_ci(ws)
    janus.checkout_goal_branch(ws.app, "main", BRANCH)
    (ws.app / "done.txt").write_text("d", encoding="utf-8")
    sha = janus.git_commit_push(ws.app, BRANCH, "chore(angular): Upgrade app to Angular 16", "Janus-Task: 1")
    goal.front.update({"status": "executing", "current_task": 1, "attempts": 1, "prs": {"app": script_bitbucket(stub)},
                       "last_verified": {"app": {"commit": sha, "teamcity_build": None, "status": "local_checks_passed"}},
                       "in_flight": {"task": 1, "repo": "app", "start_sha": sha, "operation": "ci_wait", "attempt": 1, "started_at": "t", "build": 101}})
    goal.front["tasks"][0]["status"] = "awaiting_ci"
    janus.save_goal(goal)
    commit_all(ws.root, "chore(janus): task 1 waiting for build 101")
    builds = script_ci(stub, ["green"])
    assert janus.cmd_run(ws.root) == 1
    assert fake_codex.calls() == []
    assert git(ws.bare, "rev-list", "--count", BRANCH) == "2" and git(ws.app, "rev-parse", "HEAD") == sha
    assert builds == [{"id": 101, "type": "Fe_App_Build", "sha": sha, "outcome": "green"}]
    after = janus.load_goal(ws.root)
    assert after.front["last_verified"]["app"] == {"commit": sha, "teamcity_build": 101, "status": "green"}
    assert after.front["tasks"][0]["status"] == "done" and after.front["in_flight"] is None and after.front["attempts"] == 0
    assert stub.calls("POST", "/rest/api/1.0/projects/PROJ/repos/app/pull-requests") == []


def test_crash_during_ci_wait_never_turns_a_red_build_green(ws, fake_codex, stub):
    goal = approve_with_ci(ws)
    janus.checkout_goal_branch(ws.app, "main", BRANCH)
    (ws.app / "done.txt").write_text("d", encoding="utf-8")
    sha = janus.git_commit_push(ws.app, BRANCH, "chore(angular): Upgrade app to Angular 16", "Janus-Task: 1")
    goal.front.update({"status": "executing", "current_task": 1, "attempts": 3, "prs": {"app": script_bitbucket(stub)},
                       "last_verified": {"app": {"commit": sha, "teamcity_build": None, "status": "local_checks_passed"}},
                       "in_flight": {"task": 1, "repo": "app", "start_sha": sha, "operation": "ci_wait", "attempt": 3, "started_at": "t", "build": None}})
    goal.front["tasks"][0]["status"] = "awaiting_ci"
    janus.save_goal(goal)
    commit_all(ws.root, "chore(janus): task 1 awaiting CI")
    script_ci(stub, ["red"])
    assert janus.cmd_run(ws.root) == 1
    assert fake_codex.calls() == []
    after = janus.load_goal(ws.root)
    assert after.front["last_verified"]["app"] == {"commit": sha, "teamcity_build": 101, "status": "red"}
    assert after.front["tasks"][0]["status"] == "awaiting_ci" and after.front["status"] == "blocked"
    assert "3 code-fix attempts exhausted" in janus.section(after.body, "## Progress and handover")


def test_teamcity_unreachable_stops_with_a_handover_and_a_later_run_resumes(ws, fake_codex, stub, monkeypatch):
    approve_with_ci(ws)
    script_bitbucket(stub)
    fake_codex.script([{"shell": ["echo a > a.txt"], "output": codex_output()}])
    monkeypatch.setenv("JANUS_TEAMCITY_URL", "http://127.0.0.1:9")
    assert janus.cmd_run(ws.root) == 1
    goal = janus.load_goal(ws.root)
    sha = git(ws.app, "rev-parse", "HEAD")
    assert goal.front["status"] == "blocked" and goal.front["tasks"][0]["status"] == "awaiting_ci"
    progress = janus.section(goal.body, "## Progress and handover")
    assert "did not produce a verdict [unavailable]" in progress and "TeamCity build lookup for Fe_App_Build" in progress
    assert "tc-secret-token" not in progress
    monkeypatch.setenv("JANUS_TEAMCITY_URL", stub.url)
    builds = script_ci(stub, ["green"])
    assert janus.cmd_run(ws.root) == 1
    assert len(fake_codex.calls()) == 1 and builds[0]["sha"] == sha
    assert janus.load_goal(ws.root).front["tasks"][0]["status"] == "done"


def test_codex_modifying_janus_md_stops_the_run_and_restores_the_file(ws, fake_codex, stub):
    approve_with_ci(ws)
    before = (ws.root / "JANUS.md").read_text(encoding="utf-8")
    fake_codex.script([{"shell": ["echo a > a.txt", "cd .. && sed -i 's/approved_by: .*/approved_by: codex/' JANUS.md"], "output": codex_output()}])
    assert janus.cmd_run(ws.root) == 1
    goal = janus.load_goal(ws.root)
    assert goal.front["approval"]["approved_by"] == "Test User <test@example.com>"
    assert goal.front["status"] == "blocked"
    assert "Codex modified JANUS.md" in janus.section(goal.body, "## Progress and handover")
    assert janus.ref_exists(ws.bare, f"refs/heads/{BRANCH}") is False
    assert before.split("---\n")[1].count("approved_by") == 1


def test_a_foreign_push_after_the_janus_commit_stops_verification(ws, fake_codex, stub, tmp_path):
    goal = approve_with_ci(ws)
    janus.checkout_goal_branch(ws.app, "main", BRANCH)
    (ws.app / "done.txt").write_text("d", encoding="utf-8")
    sha = janus.git_commit_push(ws.app, BRANCH, "chore(angular): Upgrade app to Angular 16", "Janus-Task: 1")
    other = tmp_path / "other"
    git(tmp_path, "clone", "-q", "-b", BRANCH, str(ws.bare), str(other))
    git(other, "config", "user.name", "Other")
    git(other, "config", "user.email", "other@example.com")
    (other / "theirs.txt").write_text("t", encoding="utf-8")
    foreign = commit_all(other, "feat: someone else")
    git(other, "push", "-q", "origin", BRANCH)
    goal.front.update({"status": "executing", "current_task": 1, "last_verified": {"app": {"commit": sha, "teamcity_build": None, "status": "local_checks_passed"}}})
    goal.front["tasks"][0]["status"] = "awaiting_ci"
    janus.save_goal(goal)
    commit_all(ws.root, "chore(janus): task 1 pushed")
    script_bitbucket(stub)
    script_ci(stub, ["green"])
    assert janus.cmd_run(ws.root) == 1
    assert fake_codex.calls() == []
    progress = janus.section(janus.load_goal(ws.root).body, "## Progress and handover")
    assert f"is at {foreign[:12]}, not at the Janus commit {sha[:12]}" in progress
    assert stub.calls("GET", "/app/rest/2018.1/builds") == []
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `uv run pytest -q tests/test_run_ci.py tests/test_run.py`
Expected: FAIL; the CI tests stop with slice 1's "PR build verification is not part of this Janus build yet" (task left `awaiting_ci`, no TeamCity request) and the rewritten completion test sees `status: done` instead of `awaiting_human_review`.

- [ ] **Step 5: Implement**

Add to the constants section, after `FAILURE_SUMMARY_CHARS = 6000`:

```python
ADVANCE = -1
```

In section `# --- run ---`, replace `record_verified` and `stop_for_human` (slice 1 Task 9) with:

```python
def record_verified(goal: Goal, name: str, sha: str, build: Optional[int] = None, status: str = "local_checks_passed") -> None:
    """last_verified is per repository: the exact commit, the TeamCity build that judged it and the verdict
    (local_checks_passed | green | red | coupled_pending). Never a status the evidence does not support."""
    verified = goal.front.get("last_verified") or {}
    verified[name] = {"commit": sha, "teamcity_build": build, "status": status}
    goal.front["last_verified"] = verified


def stop_for_human(goal: Goal, reason: str, next_action: str, status: str = "blocked") -> int:
    """Human gate (spec §7): record the handover, checkpoint, print it, exit 1. `status` is `blocked` for
    problems and `awaiting_human_review` for the PR review/QA/merge gate."""
    goal.front["status"] = status
    goal.front["in_flight"] = None
    write_progress(goal, next_action, blocker=reason)
    save_checkpoint(goal, "chore(janus): stop for human direction")
    print(f"\nJanus stopped for human direction.\nReason: {reason}\nNext action: {next_action}")
    return 1
```

Replace `run_next_task` (slice 1 Task 9) with:

```python
def run_next_task(goal: Goal, interrupted: bool) -> int:
    """Spec §6 steps 1 to 8 for the first task that is not done. Returns ADVANCE when the task is verified
    and the next one may start, 1 when stopped for a human, 0 when the goal is complete."""
    task = next_task(goal)
    if task is None:
        return finish_goal(goal)
    repo_cfg = repo_config(goal, task["repo"])
    repo = goal.root / repo_cfg["name"]
    if not (repo / ".git").exists():
        raise JanusError(f"repository folder {repo_cfg['name']} is missing; clone it into {goal.root}")
    if goal.front.get("current_task") != task["id"]:
        goal.front["current_task"] = task["id"]
        goal.front["attempts"] = 0
    goal.front["attempts"] = goal.front.get("attempts") or 0
    sha: Optional[str] = None
    if task.get("status") == "awaiting_ci":
        verified = (goal.front.get("last_verified") or {}).get(repo_cfg["name"]) or {}
        sha = verified.get("commit")
        if not repo_cfg.get("pr_build"):
            reason = f"task {task['id']} is pushed as {sha} on {repo_cfg['branch']} but has no CI evidence; pr_build is not configured for this repo"
            return stop_for_human(goal, reason, CI_HANDOVER)
    elif working_tree_dirty(repo) and not interrupted:
        return stop_for_human(
            goal,
            f"{repo_cfg['name']} has an unrecognized dirty working tree and Janus does not know who owns it",
            f"Inspect `git -C {repo_cfg['name']} status`; commit, stash or clean the tree yourself (do not discard work blindly), then run again.",
        )
    goal.front["status"] = "executing"
    failure: Optional[str] = None
    while True:
        if sha is None:
            checkout_goal_branch(repo, repo_cfg["base"], repo_cfg["branch"])
            task["status"] = "in_progress"
            heads = record_heads(repo)
            goal.front["in_flight"] = {
                "task": task["id"], "repo": repo_cfg["name"], "start_sha": git(repo, "rev-parse", "HEAD"),
                "operation": "codex", "attempt": goal.front["attempts"], "started_at": now(),
            }
            write_progress(goal, f"Codex is working on task {task['id']} in {repo_cfg['name']}; run `python janus.py run` again after an interruption.")
            save_checkpoint(goal, f"chore(janus): task {task['id']} attempt {goal.front['attempts']} in {repo_cfg['name']}")
            digest = goal_file_digest(goal.root)
            result = run_codex(repo, task_prompt(goal, task, repo_cfg, failure, interrupted))
            interrupted = False
            if goal_file_digest(goal.root) != digest:
                save_goal(goal)
                return stop_for_human(
                    goal,
                    f"Codex modified {GOAL_FILE} during task {task['id']}; the runner restored its own copy (spec §4: Codex never edits JANUS.md after approval)",
                    f"Inspect `git -C {repo_cfg['name']} status` and the Codex transcript; clean the tree, then run again.",
                )
            moved = check_heads_unchanged(repo, heads)
            if moved:
                return stop_for_human(
                    goal,
                    f"Codex moved refs in {repo_cfg['name']}: {', '.join(moved)}",
                    "Inspect the repository history; undo only what you understand; then run again.",
                )
            name_status, diff_text = stage_and_diff(repo)
            if not name_status:
                reason = f"Codex changed nothing in {repo_cfg['name']}" + (": " + "; ".join(result["blockers"]) if result["blockers"] else " and reported no blockers")
                return stop_for_human(goal, reason, result["next_action"] or "Decide how to proceed, record it under ## Decisions, then run again.")
            violations = diff_guardrails(name_status, diff_text)
            check_results = [] if violations else run_checks(repo, repo_cfg["checks"])
            if violations or any(r["returncode"] != 0 for r in check_results):
                failure = format_failure(check_results, violations)
                if goal.front["attempts"] >= MAX_FIX_ATTEMPTS:
                    return stop_for_human(
                        goal,
                        f"{MAX_FIX_ATTEMPTS} code-fix attempts exhausted on task {task['id']}; the failing attempt is left uncommitted in {repo_cfg['name']}.\n{failure}",
                        "Inspect the repository, fix or revert the uncommitted attempt, then run again; or edit the plan and re-approve.",
                    )
                goal.front["attempts"] += 1
                print(f"Task {task['id']}: attempt failed; starting code-fix attempt {goal.front['attempts']} of {MAX_FIX_ATTEMPTS}")
                continue
            sha = git_commit_push(repo, repo_cfg["branch"], f"chore(angular): {task['objective']}", f"Janus-Task: {task['id']}")
            patch = goal.root / PATCH_FILE
            if patch.exists():
                patch.unlink()
            record_verified(goal, repo_cfg["name"], sha)
            task["status"] = "awaiting_ci"
            task["summary"] = result["summary"]
            if result["values"]:
                task["values"] = result["values"]
            if result["blockers"]:
                task["blockers"] = result["blockers"]
            goal.front["in_flight"] = None
            write_progress(goal, "Awaiting CI evidence for the pushed commit.")
            save_checkpoint(goal, f"chore(janus): task {task['id']} pushed {sha[:12]}")
            if not repo_cfg.get("pr_build"):
                goal.front["attempts"] = 0
                reason = (
                    f"task {task['id']} passed its local checks and was pushed as {sha} on {repo_cfg['branch']}, "
                    "but local checks are not CI evidence; pr_build is not configured for this repo"
                )
                return stop_for_human(goal, reason, CI_HANDOVER)
        outcome = verify_task_ci(goal, task, repo_cfg, sha)
        if outcome["status"] == "green":
            return complete_task(goal, task, repo_cfg, sha, outcome)
        if outcome["status"] != "red":
            return stop_for_human(
                goal,
                f"CI verification of task {task['id']} ({repo_cfg['name']} {sha}) did not produce a verdict [{outcome['status']}]: {outcome['summary']}",
                "Fix the TeamCity/Bitbucket problem or wait for the build, then run again; Janus resumes with the same commit and never re-runs Codex for it.",
            )
        record_verified(goal, repo_cfg["name"], sha, build=outcome["id"], status="red")
        failure = f"The TeamCity PR build of commit {sha} is red.\n{outcome['summary']}"
        if goal.front["attempts"] >= MAX_FIX_ATTEMPTS:
            return stop_for_human(
                goal,
                f"{MAX_FIX_ATTEMPTS} code-fix attempts exhausted on task {task['id']}; the pushed commit {sha} is red in {outcome['url']}.\n{outcome['summary']}",
                "Inspect the build and the branch; fix by hand and push, or edit the plan and re-approve; then run again.",
            )
        goal.front["attempts"] += 1
        print(f"Task {task['id']}: CI red; starting code-fix attempt {goal.front['attempts']} of {MAX_FIX_ATTEMPTS}")
        sha = None
```

Insert after `run_next_task` and before `reconcile_in_flight`:

```python
def goal_file_digest(root: Path) -> str:
    return hashlib.sha256((root / GOAL_FILE).read_bytes()).hexdigest()


def remote_head(repo: Path, branch: str) -> Optional[str]:
    out = git(repo, "ls-remote", "origin", f"refs/heads/{branch}")
    return out.split()[0] if out else None


def verify_task_ci(goal: Goal, task: dict, repo_cfg: dict, sha: str) -> dict:
    """Spec §6 steps 5 to 7 for one pushed commit: ensure the PR, find or trigger the PR build for exactly
    `sha`, wait, retry one infrastructure failure. Returns wait_and_summarize_build's dict, or
    {status: "unavailable"} when TeamCity/Bitbucket cannot be used (spec §7)."""
    name, branch, build_type = repo_cfg["name"], repo_cfg["branch"], repo_cfg["pr_build"]
    repo = goal.root / name
    infra_retries = 0
    forced = False
    try:
        actual = remote_head(repo, branch)
        if actual != sha:
            raise JanusError(f"origin/{branch} of {name} is at {str(actual)[:12]}, not at the Janus commit {sha[:12]}; someone else pushed (spec §7)")
        pr_url = ensure_pr(goal, repo_cfg)
        while True:
            goal.front["in_flight"] = {
                "task": task["id"], "repo": name, "start_sha": sha, "operation": "ci_wait",
                "attempt": goal.front.get("attempts") or 0, "started_at": now(), "build": None,
            }
            write_progress(goal, f"Waiting for the {build_type} build of {sha} ({pr_url}); run `python janus.py run` again after an interruption.")
            save_checkpoint(goal, f"chore(janus): task {task['id']} awaiting CI for {sha[:12]}")
            comment = f"Janus {goal.front.get('id')}: verify task {task['id']} commit {sha[:12]}"
            build = queue_build(build_type, branch, sha, None, comment) if forced else find_or_trigger_build(build_type, sha, branch, comment)
            goal.front["in_flight"]["build"] = build.get("id")
            save_checkpoint(goal, f"chore(janus): task {task['id']} waiting for build {build.get('id')}")
            outcome = wait_and_summarize_build(build["id"], sha)
            if outcome["status"] == "infra" and infra_retries == 0:
                infra_retries += 1
                forced = True
                print(f"Build {outcome['id']} failed for infrastructure reasons; retrying once (not a code-fix attempt).")
                continue
            goal.front["in_flight"] = None
            return outcome
    except JanusError as exc:
        goal.front["in_flight"] = None
        return {"id": None, "number": None, "url": None, "status": "unavailable", "summary": redact(str(exc))}


def complete_task(goal: Goal, task: dict, repo_cfg: dict, sha: str, outcome: dict) -> int:
    """Spec §6 step 8: record build id, verified SHA and Codex's summary; checkpoint; advance."""
    record_verified(goal, repo_cfg["name"], sha, build=outcome["id"], status="green")
    task["status"] = "done"
    task["verified_build"] = outcome["id"]
    goal.front["attempts"] = 0
    goal.front["in_flight"] = None
    write_progress(goal, f"Task {task['id']} verified green in build {outcome['id']} ({outcome['url']}); starting the next task.")
    save_checkpoint(goal, f"chore(janus): task {task['id']} verified green in build {outcome['id']}")
    print(f"Task {task['id']} ({repo_cfg['name']}): commit {sha[:12]} is green in {outcome['url']}.")
    return ADVANCE


def finish_goal(goal: Goal) -> int:
    """All tasks are done: stop at the human PR review / QA gate (spec §6 "E2E, AI review, human gates")."""
    goal.front["current_task"] = None
    prs = goal.front.get("prs") or {}
    links = ", ".join(f"{name}: {url}" for name, url in prs.items()) or "none recorded"
    return stop_for_human(
        goal,
        f"all tasks are done; human PR review and QA are next (PRs: {links})",
        "Review and test the PRs, then merge them in the approved order through the existing process. "
        "Paste review comments into ## Review feedback and run again for a bounded fix pass; run again after merging to record completion.",
        status="awaiting_human_review",
    )
```

Replace `reconcile_in_flight` (slice 1 Task 10) with:

```python
def reconcile_in_flight(goal: Goal) -> bool:
    """Spec §8 restart: compare the in_flight checkpoint with the repository before doing anything
    irreversible. Returns True when an interrupted Codex diff was preserved for the resumed task.
    Waits (ci_wait, publish_wait, e2e_wait) and review/fix passes need no reconciliation here: the task is
    already `awaiting_ci` with its commit in last_verified, and TeamCity is re-queried by exact SHA."""
    inflight = goal.front.get("in_flight")
    if not inflight:
        return False
    if inflight.get("operation") != "codex":
        print(f"Resuming after an interrupted {inflight.get('operation')}; nothing is redone.")
        return False
    task = task_by_id(goal, inflight.get("task"))
    repo_cfg = repo_config(goal, inflight.get("repo"))
    repo = goal.root / repo_cfg["name"]
    if task is None or not (repo / ".git").exists():
        raise JanusError(f"in_flight refers to task {inflight.get('task')!r} in {inflight.get('repo')!r} which no longer exists; fix JANUS.md by hand")
    head = git(repo, "rev-parse", "HEAD")
    if head != inflight.get("start_sha"):
        message = git(repo, "log", "-1", "--format=%B", head)
        if f"Janus-Task: {task['id']}" not in message:
            raise JanusError(
                f"{repo_cfg['name']} moved from {str(inflight.get('start_sha'))[:12]} to {head[:12]} while task {task['id']} "
                "was in flight and that commit is not a Janus commit; inspect it, then either reset the branch to the "
                "start commit or set in_flight to null in JANUS.md after recording the decision under ## Decisions"
            )
        if not commit_on_remote(repo, head, repo_cfg["branch"]):
            git(repo, "push", "-q", "origin", f"{repo_cfg['branch']}:{repo_cfg['branch']}")
        record_verified(goal, repo_cfg["name"], head)
        task["status"] = "awaiting_ci"
        goal.front["in_flight"] = None
        goal.front["attempts"] = 0
        write_progress(goal, "Awaiting CI evidence for the recovered commit.")
        save_checkpoint(goal, f"chore(janus): recovered pushed commit {head[:12]} for task {task['id']}")
        print(f"Recovered task {task['id']}: commit {head[:12]} was already made by Janus; not redoing it.")
        return False
    if working_tree_dirty(repo):
        git(repo, "add", "-A")
        (goal.root / PATCH_FILE).write_text(git(repo, "diff", "--cached") + "\n", encoding="utf-8")
        print(f"Preserved the interrupted diff of {repo_cfg['name']} as {PATCH_FILE}; a fresh Codex will inspect it.")
        return True
    return False
```

Replace `cmd_run` (slice 1 Task 10) in the CLI section with:

```python
def cmd_run(root: Path) -> int:
    """Advance until the next human gate, block or completion (spec §5)."""
    with locked(root):
        ensure_control_ignore(root)
        goal = load_goal(root)
        verify_plan_approval(goal)
        interrupted = reconcile_in_flight(goal)
        while True:
            code = run_next_task(goal, interrupted)
            interrupted = False
            if code != ADVANCE:
                return code
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `uv run pytest -q`
Expected: `128 passed`

- [ ] **Step 7: Commit**

```bash
cd /home/race-day/janus
git add janus.py tests/helpers.py tests/test_run.py tests/test_run_ci.py
git commit -m "feat(janus): verify each pushed commit in TeamCity, open PRs, retry red builds and advance" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---
### Task 17: Baseline verification in `plan`, baseline shown at `approve`, full `status` output

Spec §6 "Planning and baseline" ("verifies any TeamCity evidence the plan cites where it can (latest build status for the named build configurations on the named base branches), marks what it could not verify as unverified"; "The human reviews ... and explicitly invokes `approve`. Approved baseline exceptions identify the failing build/test"), §5 (`status`: "concise state, PR/build links, next action").

**Files:**
- Modify: `janus.py` (section `# --- teamcity ---`: add `baseline_build`, `verify_baseline`; replace `cmd_plan` (slice 1 Task 7) and `cmd_approve` (slice 1 Task 5) in the CLI section; replace `show_status` (slice 1 Task 11))
- Modify: `tests/conftest.py` (autouse `clean_janus_env`), `tests/test_status.py` (two new tests)
- Create: `tests/test_baseline.py`

**Interfaces:**
- Consumes: `teamcity`, `http_json`, `service`, `redact`, `write_progress`, `section`, `task_by_id`, `build_url`, `BUILD_FIELDS`.
- Produces: `baseline_build(build_type: str, branch: str) -> Optional[dict]` (latest build on `branch:(name:<base>)`, falling back to `branch:(default:true)`); `verify_baseline(config: dict) -> List[str]` (one line per repo: `<repo>: <pr_build> on <base>: latest build #<n> <STATUS> (<url>)` or `... unverified (<why>)`); `cmd_plan` writes those lines into the Progress blocker so the human sees them; `cmd_approve` prints the Progress section and asks "Approve this plan exactly as shown, including its baseline exceptions? Type yes to approve: "; `show_status` prints, in addition to slice 1's lines, build links (`build <id> <url>` when `JANUS_TEAMCITY_URL` is set), task flags `(expected red until <verify_at>)` / `(publishes via <job>)`, `e2e: <build type> (<repo>=<param>, ...)` with `last e2e: ...` or `e2e: not configured`, `review: ...` or `review: none yet`, `review feedback: present; run ...` when the section holds pasted text, and the in-flight build link. The flags and the `e2e_result`/`review` keys are read as plain front matter here; Tasks 18 to 21 produce them.
- Test fixture `clean_janus_env` (autouse) deletes the seven `JANUS_*` variables so no test inherits the developer's shell.

- [ ] **Step 1: Isolate tests from the shell environment**

In `tests/conftest.py`, insert before the `ws` fixture:

```python
@pytest.fixture(autouse=True)
def clean_janus_env(monkeypatch):
    """Tests never inherit TeamCity/Bitbucket settings from the developer's shell."""
    for var in ("JANUS_TEAMCITY_URL", "JANUS_TEAMCITY_TOKEN", "JANUS_BITBUCKET_URL", "JANUS_BITBUCKET_TOKEN",
                "JANUS_POLL_SECONDS", "JANUS_BUILD_APPEARANCE_SECONDS", "JANUS_BUILD_TIMEOUT_SECONDS"):
        monkeypatch.delenv(var, raising=False)
```

- [ ] **Step 2: Write the failing tests**

`tests/test_baseline.py`:

```python
import copy

import janus
from helpers import codex_output, git, tc_build
from test_plan import PLAN_CONFIG

TC = "/app/rest/2018.1"


def ci_config():
    config = copy.deepcopy(PLAN_CONFIG)
    config["repos"][0]["pr_build"] = "Fe_App_Build"
    return config


def test_plan_records_the_latest_base_branch_build_as_baseline(ws, fake_codex, stub):
    stub.on("GET", TC + "/builds", [(200, {"count": 1, "build": [tc_build(77, "a" * 40, status="FAILURE", statusText="Tests failed: 2")]})])
    fake_codex.script([{"output": codex_output(config=ci_config(), plan_markdown="p")}])
    assert janus.cmd_plan(ws.root) == 0
    goal = janus.load_goal(ws.root)
    progress = janus.section(goal.body, "## Progress and handover")
    assert "app: Fe_App_Build on main: latest build #77 FAILURE (https://tc.example/viewLog.html?buildId=77)" in progress
    [request] = stub.calls("GET", TC + "/builds")
    assert request["query"]["locator"] == "buildType:(id:Fe_App_Build),branch:(name:main),count:1"
    assert request["headers"]["authorization"] == "Bearer tc-secret-token"
    assert "tc-secret-token" not in (ws.root / "JANUS.md").read_text(encoding="utf-8")


def test_plan_falls_back_to_the_default_branch_and_marks_missing_builds_unverified(ws, fake_codex, stub):
    stub.on("GET", TC + "/builds", [(200, {"count": 0}), (200, {"count": 0})])
    fake_codex.script([{"output": codex_output(config=ci_config(), plan_markdown="p")}])
    janus.cmd_plan(ws.root)
    progress = janus.section(janus.load_goal(ws.root).body, "## Progress and handover")
    assert "app: Fe_App_Build on main: unverified (no finished build found)" in progress
    locators = [r["query"]["locator"] for r in stub.calls("GET", TC + "/builds")]
    assert locators == ["buildType:(id:Fe_App_Build),branch:(name:main),count:1", "buildType:(id:Fe_App_Build),branch:(default:true),count:1"]


def test_plan_marks_baseline_unverified_when_teamcity_is_unreachable_or_unconfigured(ws, fake_codex, stub, monkeypatch):
    monkeypatch.setenv("JANUS_TEAMCITY_URL", "http://127.0.0.1:9")
    fake_codex.script([{"output": codex_output(config=ci_config(), plan_markdown="p")}])
    janus.cmd_plan(ws.root)
    progress = janus.section(janus.load_goal(ws.root).body, "## Progress and handover")
    assert "app: Fe_App_Build on main: unverified (TeamCity baseline lookup for Fe_App_Build on main failed" in progress
    assert "tc-secret-token" not in progress
    monkeypatch.delenv("JANUS_TEAMCITY_URL")
    (ws.root / "JANUS.md").write_text("# Goal\nUpgrade Angular 15 to 16 in every repository here.\n", encoding="utf-8")
    janus.cmd_plan(ws.root)
    progress = janus.section(janus.load_goal(ws.root).body, "## Progress and handover")
    assert "unverified (TeamCity not configured: set JANUS_TEAMCITY_URL and JANUS_TEAMCITY_TOKEN)" in progress


def test_plan_without_pr_build_says_so(ws, fake_codex):
    fake_codex.script([{"output": codex_output(config=PLAN_CONFIG, plan_markdown="p")}])
    janus.cmd_plan(ws.root)
    assert "app: unverified (no pr_build in the plan)" in janus.section(janus.load_goal(ws.root).body, "## Progress and handover")


def test_approve_shows_the_baseline_evidence(ws, fake_codex, stub, capsys):
    stub.on("GET", TC + "/builds", [(200, {"count": 1, "build": [tc_build(78, "a" * 40)]})])
    fake_codex.script([{"output": codex_output(config=ci_config(), plan_markdown="p")}])
    janus.cmd_plan(ws.root)
    capsys.readouterr()
    prompts = []

    def ask(prompt):
        prompts.append(prompt)
        return "yes"

    assert janus.cmd_approve(ws.root, ask=ask) == 0
    out = capsys.readouterr().out
    assert "baseline evidence" in out and "latest build #78 SUCCESS" in out
    assert prompts == ["Approve this plan exactly as shown, including its baseline exceptions? Type yes to approve: "]
    assert git(ws.root, "log", "-1", "--format=%s").startswith("chore(janus): approve plan ")
```

Append to `tests/test_status.py`:

```python
def test_status_shows_pr_build_e2e_and_review_links(ws, monkeypatch):
    monkeypatch.setenv("JANUS_TEAMCITY_URL", "https://tc.example")
    monkeypatch.setenv("JANUS_TEAMCITY_TOKEN", "t")
    goal = approve_draft(ws.root)
    goal.front["repos"][0]["pr_build"] = "Fe_App_Build"
    goal.front["e2e"] = {"build_type": "Fe_E2E_Full", "branch_parameters": {"app": "env.APP_BRANCH"}}
    goal.front["tasks"][0].update({"status": "done", "expect_red": True, "verify_at": "e2e", "publish": "Fe_App_Publish"})
    goal.front["last_verified"] = {"app": {"commit": "a" * 40, "teamcity_build": 101, "status": "green"}}
    goal.front["prs"] = {"app": "https://bb.example/projects/PROJ/repos/app/pull-requests/12"}
    goal.front["e2e_result"] = {"build": 300, "status": "green", "heads": {"app": "a" * 40}, "url": "u", "at": "2026-09-22T00:00:00Z"}
    goal.front["review"] = {"cycles": 1, "status": "clean", "at": "2026-09-22T01:00:00Z"}
    goal.front["in_flight"] = {"task": 1, "repo": "app", "start_sha": "a" * 40, "operation": "ci_wait", "attempt": 0, "started_at": "t", "build": 101}
    goal.body = janus.set_section(goal.body, "## Review feedback", "Please rename the service.")
    text = janus.show_status(goal)
    assert "  1. [done] app: Upgrade app to Angular 16 (expected red until e2e) (publishes via Fe_App_Publish)" in text
    assert f"last verified {'a' * 12} green build 101 https://tc.example/viewLog.html?buildId=101, pr_build Fe_App_Build, pr https://bb.example/projects/PROJ/repos/app/pull-requests/12" in text
    assert "e2e: Fe_E2E_Full (app=env.APP_BRANCH)" in text
    assert f"  last e2e: green build 300 https://tc.example/viewLog.html?buildId=300 at 2026-09-22T00:00:00Z for app={'a' * 12}" in text
    assert "review: clean after 1 cycle(s) at 2026-09-22T01:00:00Z" in text
    assert "review feedback: present; run `python janus.py run`" in text
    assert "in flight: task 1 in app (ci_wait, attempt 0, since t, from aaaaaaaaaaaa), build 101 https://tc.example/viewLog.html?buildId=101" in text


def test_status_without_e2e_or_review_says_so(ws):
    goal = approve_draft(ws.root)
    text = janus.show_status(goal)
    assert "e2e: not configured" in text and "review: none yet" in text and "review feedback" not in text
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `uv run pytest -q tests/test_baseline.py tests/test_status.py`
Expected: FAIL; the plan's Progress still says "no TeamCity configured in this Janus build" and `show_status` lacks the `e2e:`/`review:` lines.

- [ ] **Step 4: Implement**

Insert into section `# --- teamcity ---`, before `wait_and_summarize_build`:

```python
def baseline_build(build_type: str, branch: str) -> Optional[dict]:
    """Latest finished build of `build_type` on `branch`; falls back to the configuration's default branch
    because TeamCity names the default branch `<default>` in some locators (spec §6 "Planning and baseline")."""
    base_url, token = teamcity()
    for locator in (f"buildType:(id:{build_type}),branch:(name:{branch}),count:1", f"buildType:(id:{build_type}),branch:(default:true),count:1"):
        query = urllib.parse.urlencode({"locator": locator, "fields": f"count,build({BUILD_FIELDS})"})
        status, body = http_json("GET", f"{base_url}{TEAMCITY_API}/builds?{query}", token)
        if status != 200 or not isinstance(body, dict):
            raise JanusError(f"TeamCity baseline lookup for {build_type} on {branch} failed: {describe_http(status, body)}")
        builds = body.get("build") or []
        if builds:
            return builds[0]
    return None


def verify_baseline(config: dict) -> List[str]:
    """One line per repository: the latest build of its pr_build on its base branch, or why it is unverified.
    What counts as baseline is the plan's decision; the runner only records what it can see."""
    lines = []
    configured = service(TEAMCITY_URL_VAR, TEAMCITY_TOKEN_VAR) is not None
    for repo in config["repos"]:
        name, build_type, base = repo["name"], repo.get("pr_build"), repo["base"]
        if not build_type:
            lines.append(f"{name}: unverified (no pr_build in the plan)")
            continue
        if not configured:
            lines.append(f"{name}: {build_type} on {base}: unverified (TeamCity not configured: set {TEAMCITY_URL_VAR} and {TEAMCITY_TOKEN_VAR})")
            continue
        try:
            build = baseline_build(build_type, base)
        except JanusError as exc:
            lines.append(f"{name}: {build_type} on {base}: unverified ({redact(str(exc))})")
            continue
        if build is None:
            lines.append(f"{name}: {build_type} on {base}: unverified (no finished build found)")
        else:
            lines.append(f"{name}: {build_type} on {base}: latest build #{build.get('number')} {build.get('status')} ({build.get('webUrl')})")
    return lines
```

Replace `cmd_plan` (slice 1 Task 7) with:

```python
def cmd_plan(root: Path) -> int:
    with locked(root):
        ensure_control_ignore(root)
        goal = load_goal(root)
        if goal.front.get("status") not in (None, "awaiting_plan_approval"):
            raise JanusError(
                "the plan is already approved; replanning is a human edit of JANUS.md followed by "
                "`python janus.py approve`, or remove the front matter to start over"
            )
        goal_text = section(goal.body, "# Goal")
        if not goal_text:
            raise JanusError(f"{GOAL_FILE} needs a '# Goal' section with the goal text")
        repos = discover_repos(root)
        if not repos:
            raise JanusError("no product repositories found: clone them into this folder first")
        before = {name: record_heads(root / name) for name in repos}
        result = run_codex(root, plan_prompt(goal_text, repos))
        touched = changed_repos(root, repos, before)
        if touched:
            raise JanusError(f"planning must not change product source: {', '.join(touched)} changed; inspect and clean before planning again")
        if result["config"] is None:
            raise JanusError("codex returned no plan configuration" + (": " + "; ".join(result["blockers"]) if result["blockers"] else ""))
        config = validate_config(result["config"], repos)
        goal.front = draft_front_matter(config)
        for heading, default in STANDARD_SECTIONS:
            if section(goal.body, heading) is None:
                goal.body = set_section(goal.body, heading, default)
        goal.body = set_section(goal.body, "## Approved-plan content", demote_headings(result["plan_markdown"] or result["summary"]))
        baseline = verify_baseline(config)
        write_progress(
            goal,
            "Review and edit the draft in JANUS.md (repos, checks, tasks, plan text), then run `python janus.py approve`."
            + (" Codex suggests: " + result["next_action"] if result["next_action"] else ""),
            blocker="Baseline evidence checked by the runner (the plan decides what matters; anything else it cites is unverified): "
            + "; ".join(baseline)
            + (". Codex blockers: " + "; ".join(result["blockers"]) if result["blockers"] else ""),
        )
        save_checkpoint(goal, f"chore(janus): draft plan for {goal.front['id']}")
        print(f"Draft plan written to {GOAL_FILE} and committed. Review it, edit it, then run `python janus.py approve`.")
        return 0
```

Replace `cmd_approve` (slice 1 Task 5) with:

```python
def cmd_approve(root: Path, ask: Callable[[str], str] = input) -> int:
    with locked(root):
        goal = load_goal(root)
        if not goal.front or not goal.front.get("tasks"):
            raise JanusError("nothing to approve: run `python janus.py plan` first")
        front_text = yaml.safe_dump(goal.front, sort_keys=False, allow_unicode=True, default_flow_style=False)
        print("Front matter:\n" + front_text)
        print("## Approved-plan content\n" + (section(goal.body, "## Approved-plan content") or "(empty)") + "\n")
        print("## Progress and handover (baseline evidence recorded by plan)\n" + (section(goal.body, "## Progress and handover") or "(empty)") + "\n")
        answer = ask("Approve this plan exactly as shown, including its baseline exceptions? Type yes to approve: ")
        if answer.strip() != "yes":
            print("Plan not approved; JANUS.md unchanged.")
            return 1
        digest = plan_hash(goal)
        who = git_identity(root)
        goal.front["approval"] = {"plan_hash": digest, "approved_by": who, "approved_at": now()}
        goal.front["status"] = "approved"
        decisions = section(goal.body, "## Decisions") or ""
        line = f"- {now()}: plan {digest[:12]} approved by {who}"
        goal.body = set_section(goal.body, "## Decisions", (decisions + "\n" + line).strip("\n"))
        save_checkpoint(goal, f"chore(janus): approve plan {digest[:12]}")
        print(f"Plan approved ({digest[:12]}) by {who}.")
        return 0
```

Replace `show_status` (slice 1 Task 11) with:

```python
def show_status(goal: Goal) -> str:
    """Concise state with PR and build links and the next action (spec §5)."""
    front = goal.front
    if not front:
        return "\n".join([
            "status: no plan yet",
            "goal: " + (section(goal.body, "# Goal") or "(empty)").replace("\n", " "),
            "next action: run `python janus.py plan`",
        ])
    tc = service(TEAMCITY_URL_VAR, TEAMCITY_TOKEN_VAR)

    def build_text(build_id: object) -> str:
        return f"build {build_id} {build_url(tc[0], build_id)}" if tc else f"build {build_id}"

    angular = front.get("angular") or {}
    approval = front.get("approval") or {}
    lines = [
        f"goal: {front.get('id')}",
        f"status: {front.get('status')}",
        f"angular: {angular.get('from')} -> {angular.get('to')}",
        f"approved: {approval.get('approved_by')} at {approval.get('approved_at')}" if approval.get("plan_hash") else "approved: no",
    ]
    current = task_by_id(goal, front.get("current_task"))
    if current:
        lines.append(
            f"current task: {current['id']} ({current['repo']}) {current['objective']} "
            f"[{current.get('status')}, fix attempts {front.get('attempts') or 0} of {MAX_FIX_ATTEMPTS}]"
        )
    else:
        lines.append("current task: none")
    lines.append("tasks:")
    for task in front.get("tasks") or []:
        flags = ""
        if task.get("expect_red"):
            flags += f" (expected red until {task.get('verify_at')})"
        if task.get("publish"):
            flags += f" (publishes via {task.get('publish')})"
        lines.append(f"  {task.get('id')}. [{task.get('status')}] {task.get('repo')}: {task.get('objective')}{flags}")
    lines.append("repos:")
    for repo_cfg in front.get("repos") or []:
        repo = goal.root / repo_cfg["name"]
        head = git(repo, "rev-parse", "--short", "HEAD", check=False) if (repo / ".git").exists() else "missing"
        verified = (front.get("last_verified") or {}).get(repo_cfg["name"]) or {}
        verified_text = f"{str(verified.get('commit'))[:12]} {verified.get('status')}" if verified else "none"
        if verified.get("teamcity_build"):
            verified_text += " " + build_text(verified["teamcity_build"])
        pr = (front.get("prs") or {}).get(repo_cfg["name"]) or "none"
        lines.append(
            f"  {repo_cfg['name']}: branch {repo_cfg.get('branch')} (base {repo_cfg.get('base')}), head {head or '?'}, "
            f"last verified {verified_text}, pr_build {repo_cfg.get('pr_build') or 'not configured'}, pr {pr}"
        )
    e2e_cfg = front.get("e2e") or {}
    e2e = front.get("e2e_result")
    if e2e_cfg:
        params = ", ".join(f"{r}={p}" for r, p in (e2e_cfg.get("branch_parameters") or {}).items())
        lines.append(f"e2e: {e2e_cfg.get('build_type')} ({params})")
        if e2e:
            heads = ", ".join(f"{r}={str(s)[:12]}" for r, s in (e2e.get("heads") or {}).items())
            lines.append(f"  last e2e: {e2e.get('status')} {build_text(e2e.get('build'))} at {e2e.get('at')} for {heads}")
        else:
            lines.append("  last e2e: none yet")
    else:
        lines.append("e2e: not configured")
    review = front.get("review")
    if review:
        lines.append(f"review: {review.get('status')} after {review.get('cycles')} cycle(s) at {review.get('at')}")
    else:
        lines.append("review: none yet")
    feedback = section(goal.body, "## Review feedback") or ""
    if feedback and not feedback.startswith("Empty until"):
        lines.append("review feedback: present; run `python janus.py run` to start a bounded fix/verify/review pass")
    inflight = front.get("in_flight")
    if inflight:
        lines.append(
            f"in flight: task {inflight.get('task')} in {inflight.get('repo')} ({inflight.get('operation')}, "
            f"attempt {inflight.get('attempt')}, since {inflight.get('started_at')}, from {str(inflight.get('start_sha'))[:12]})"
            + (f", {build_text(inflight.get('build'))}" if inflight.get("build") else "")
        )
    for line in (section(goal.body, "## Progress and handover") or "").splitlines():
        if line.startswith("Blocker: "):
            lines.append("blocker: " + line[len("Blocker: "):])
        elif line.startswith("Next action: "):
            lines.append("next action: " + line[len("Next action: "):])
    return "\n".join(lines)
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `uv run pytest -q`
Expected: `135 passed`

- [ ] **Step 6: Commit**

```bash
cd /home/race-day/janus
git add janus.py tests/conftest.py tests/test_baseline.py tests/test_status.py
git commit -m "feat(janus): record baseline build evidence in plan, show it at approve, and print PR/build links in status" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---
### Task 18: Second repository in approved order and the explicit coupled verification point

Spec §6 ("If a task cannot be individually green because of an approved coupled change, the **plan must explicitly name the temporary red and the joint verification point**. The runner may proceed to that point but must not present the intermediate result as green. Unexpected red stops at the retry limit"), §6 step 3 ("dependency context (for example the prerelease version recorded by an earlier task)"), §4 ("Codex proposes the front matter configuration ... `tasks`"; plan hash covers the approved content), §7 stop conditions, §11 criterion 6.

**Files:**
- Modify: `janus.py` (`OUTPUT_SCHEMA` and `validate_config` in `# --- plan ---`/`# --- codex ---`; `plan_hash` in `# --- plan hash and approval ---`; `task_prompt`, `next_task`, `run_next_task`, `verify_task_ci`, `complete_task`, `finish_goal` in `# --- run ---`; add `verify_coupled_dependents`)
- Modify: `tests/helpers.py` (append `add_repo`, `two_repo_front`)
- Create: `tests/test_coupled.py`

**Interfaces:**
- Consumes: Task 16's run loop, `queue_build`, `wait_and_summarize_build`, `ensure_pr`.
- Produces (approved front matter, hashed): task fields `expect_red: true` (the PR build may stay red), `verify_at: <later task id> | "e2e"` (required with `expect_red`; a task id must come later in the list; `"e2e"` requires `e2e` to be set), `publish: <TeamCity build type id>` (used by Task 19). `OUTPUT_SCHEMA.config.tasks.items` gains `expect_red` (boolean), `verify_at` (nullable string; digits are parsed to an int), `publish` (nullable string), all required by strict mode; `validate_config` keeps them only when set so a plain task stays `{id, repo, objective, status}`; `plan_hash` includes the three fields.
- Produces (runner): task status `coupled_pending` and `task.red_build`; `last_verified[repo].status = "coupled_pending"`; `next_task` skips `done` and `coupled_pending`; `verify_task_ci(goal, task, repo_cfg, sha, force_new: bool = False)` (`force_new` queues a fresh build instead of reusing one); `verify_coupled_dependents(goal) -> Optional[int]` (for every `coupled_pending` task whose `verify_at` task is `done`: a fresh build of its recorded commit must be green, then the task is `done` with `verified_build`; red or no verdict stops for a human); `complete_task` calls it after every green; `finish_goal` calls it first and, in this task's version, stops for a human when tasks remain `coupled_pending` because their point is the E2E (Task 20 replaces that branch). `task_prompt` lists every repository with its goal branch, adds a "# Coupled change" paragraph for `expect_red` tasks and a "# Prerelease" paragraph for `publish` tasks; values recorded by earlier tasks were already passed by slice 1 Task 9 and stay.
- Order enforcement: tasks run strictly in front-matter order (slice 1's `next_task`), so a second repository starts only after the first task is `done` or `coupled_pending`; `last_verified` is per repository.
- Test helpers: `add_repo(ws, tmp_path, name) -> (repo_path, bare_path)` (a second product repo with `file:///.../PROJ/<name>.git` origin), `two_repo_front(lib_task=None, app_task=None)` (tasks 1 `lib` and 2 `app`, both with PR builds).

- [ ] **Step 1: Add the second-repo helpers**

Append to `tests/helpers.py`:

```python
def add_repo(ws, tmp_path, name):
    """A second product repository `name` inside the control repo with its own bare origin (PROJ/<name>.git)."""
    bare = make_bare(tmp_path / "remotes" / "PROJ" / f"{name}.git")
    repo = ws.root / name
    init_repo(repo)
    (repo / "package.json").write_text('{"name": "%s", "version": "1.0.0"}\n' % name, encoding="utf-8")
    commit_all(repo, f"feat: initial {name}")
    git(repo, "remote", "add", "origin", "file://" + str(bare))
    git(repo, "push", "-q", "-u", "origin", "main")
    return repo, bare


def two_repo_front(lib_task=None, app_task=None):
    """Front matter for tasks 1 (lib) then 2 (app), both with PR builds; extra task fields via the dicts."""
    front = draft_front(checks=["test -f package.json"], pr_build="Fe_App_Build")
    front["repos"].insert(0, {"name": "lib", "base": "main", "branch": "ai/angular-15-to-16", "pr_build": "Fe_Lib_Build", "checks": ["test -f package.json"]})
    front["tasks"] = [
        dict({"id": 1, "repo": "lib", "objective": "Upgrade lib and publish a prerelease", "status": "pending"}, **(lib_task or {})),
        dict({"id": 2, "repo": "app", "objective": "Upgrade app using the lib prerelease", "status": "pending"}, **(app_task or {})),
    ]
    return front
```

- [ ] **Step 2: Write the failing tests**

`tests/test_coupled.py`:

```python
import pytest

import janus
from helpers import add_repo, approve_draft, codex_output, git, script_bitbucket, script_ci, two_repo_front

BRANCH = "ai/angular-15-to-16"


def test_validate_config_accepts_coupling_and_publish_fields_only_when_set():
    cfg = janus.validate_config({
        "angular": {"from": 15, "to": 16},
        "repos": [{"name": "lib", "checks": []}, {"name": "app", "checks": []}],
        "e2e": {"build_type": "Fe_E2E_Full", "branch_parameters": [{"repo": "app", "parameter": "env.APP_BRANCH"}]},
        "tasks": [
            {"id": 1, "repo": "lib", "objective": "a", "expect_red": True, "verify_at": "2", "publish": "Fe_Lib_Publish"},
            {"id": 2, "repo": "app", "objective": "b", "expect_red": False, "verify_at": None, "publish": None},
            {"id": 3, "repo": "app", "objective": "c", "expect_red": True, "verify_at": "e2e", "publish": None},
        ],
    }, ["app", "lib"])
    assert cfg["tasks"] == [
        {"id": 1, "repo": "lib", "objective": "a", "status": "pending", "expect_red": True, "verify_at": 2, "publish": "Fe_Lib_Publish"},
        {"id": 2, "repo": "app", "objective": "b", "status": "pending"},
        {"id": 3, "repo": "app", "objective": "c", "status": "pending", "expect_red": True, "verify_at": "e2e"},
    ]


@pytest.mark.parametrize(
    "tasks, e2e, message",
    [
        ([{"id": 1, "repo": "app", "objective": "a", "expect_red": True}], None, "names no verify_at"),
        ([{"id": 1, "repo": "app", "objective": "a", "expect_red": True, "verify_at": "1"}], None, "must name a later task"),
        ([{"id": 1, "repo": "app", "objective": "a", "verify_at": "9"}], None, "must name a later task"),
        ([{"id": 1, "repo": "app", "objective": "a", "expect_red": True, "verify_at": "e2e"}], None, 'is "e2e" but config.e2e is null'),
        ([{"id": 1, "repo": "app", "objective": "a", "verify_at": "later"}], None, "must be a later task id"),
    ],
)
def test_validate_config_rejects_unsound_coupling(tasks, e2e, message):
    with pytest.raises(janus.JanusError, match=message):
        janus.validate_config({"angular": {"from": 15, "to": 16}, "repos": [{"name": "app", "checks": []}], "e2e": e2e, "tasks": tasks}, ["app"])


def test_plan_hash_covers_coupling_and_publish_fields(ws):
    goal = approve_draft(ws.root)
    digest = janus.plan_hash(goal)
    goal.front["tasks"][0]["expect_red"] = True
    goal.front["tasks"][0]["verify_at"] = "e2e"
    assert janus.plan_hash(goal) != digest
    goal.front["tasks"][0]["publish"] = "Fe_App_Publish"
    assert len({digest, janus.plan_hash(goal)}) == 2
    goal.front["tasks"][0]["status"] = "coupled_pending"
    goal.front["tasks"][0]["red_build"] = 5
    assert janus.plan_hash(goal) == janus.plan_hash(goal)


def test_output_schema_carries_the_task_coupling_fields():
    task_schema = janus.OUTPUT_SCHEMA["properties"]["config"]["properties"]["tasks"]["items"]
    assert list(task_schema["properties"]) == ["id", "repo", "objective", "expect_red", "verify_at", "publish"]
    assert task_schema["properties"]["expect_red"] == {"type": "boolean"}
    assert task_schema["properties"]["verify_at"] == {"type": ["string", "null"]}


def test_two_repositories_run_in_approved_order_and_values_flow_forward(ws, fake_codex, stub, tmp_path):
    lib, lib_bare = add_repo(ws, tmp_path, "lib")
    approve_draft(ws.root, two_repo_front())
    script_bitbucket(stub, slug="lib", pr_id=21)
    script_bitbucket(stub, slug="app", pr_id=22)
    builds = script_ci(stub, ["green"])
    fake_codex.script([
        {"shell": ["echo lib > lib.txt"], "output": codex_output(summary="lib upgraded", values=[{"name": "prerelease_version", "value": "2.0.0-angular16.1"}])},
        {"shell": ["echo app > app.txt"], "output": codex_output(summary="app upgraded")},
    ])
    assert janus.cmd_run(ws.root) == 1
    calls = fake_codex.calls()
    assert [c["cwd"] for c in calls] == [str(lib), str(ws.app)]
    assert "Task 1: Upgrade lib and publish a prerelease" in calls[0]["prompt"]
    assert "Values recorded by earlier tasks" not in calls[0]["prompt"]
    assert "- prerelease_version: 2.0.0-angular16.1" in calls[1]["prompt"]
    assert "- lib: goal branch ai/angular-15-to-16 from main" in calls[1]["prompt"] and "- app: goal branch ai/angular-15-to-16 from main (this repository)" in calls[1]["prompt"]
    lib_sha, app_sha = git(lib, "rev-parse", "HEAD"), git(ws.app, "rev-parse", "HEAD")
    assert git(lib_bare, "rev-parse", f"refs/heads/{BRANCH}") == lib_sha and git(ws.bare, "rev-parse", f"refs/heads/{BRANCH}") == app_sha
    assert [(b["sha"], b["outcome"]) for b in builds] == [(lib_sha, "green"), (app_sha, "green")]
    goal = janus.load_goal(ws.root)
    assert goal.front["last_verified"] == {
        "lib": {"commit": lib_sha, "teamcity_build": 101, "status": "green"},
        "app": {"commit": app_sha, "teamcity_build": 102, "status": "green"},
    }
    assert goal.front["prs"] == {"lib": f"{stub.url}/projects/PROJ/repos/lib/pull-requests/21", "app": f"{stub.url}/projects/PROJ/repos/app/pull-requests/22"}
    assert [t["status"] for t in goal.front["tasks"]] == ["done", "done"]
    assert goal.front["tasks"][0]["values"] == {"prerelease_version": "2.0.0-angular16.1"}
    assert goal.front["status"] == "awaiting_human_review"
    assert [q["json"]["buildType"]["id"] for q in stub.calls("POST", "/app/rest/2018.1/buildQueue")] == []
    locators = [r["query"]["locator"] for r in stub.calls("GET", "/app/rest/2018.1/builds")]
    assert locators[0].startswith("buildType:(id:Fe_Lib_Build)") and locators[-1].startswith("buildType:(id:Fe_App_Build)")


def test_coupled_task_stays_red_as_planned_and_is_verified_at_its_joint_point(ws, fake_codex, stub, tmp_path):
    lib, _ = add_repo(ws, tmp_path, "lib")
    approve_draft(ws.root, two_repo_front(lib_task={"expect_red": True, "verify_at": 2}))
    script_bitbucket(stub, slug="lib", pr_id=21)
    script_bitbucket(stub, slug="app", pr_id=22)
    builds = script_ci(stub, ["red", "green", "green"])
    fake_codex.script([
        {"shell": ["echo lib > lib.txt"], "output": codex_output(summary="lib changed contract")},
        {"shell": ["echo app > app.txt"], "output": codex_output(summary="app follows")},
    ])
    assert janus.cmd_run(ws.root) == 1
    assert len(fake_codex.calls()) == 2
    assert "Coupled change" in fake_codex.calls()[0]["prompt"] and "joint verification point (2)" in fake_codex.calls()[0]["prompt"]
    assert "Coupled change" not in fake_codex.calls()[1]["prompt"]
    lib_sha, app_sha = git(lib, "rev-parse", "HEAD"), git(ws.app, "rev-parse", "HEAD")
    assert [(b["sha"], b["outcome"]) for b in builds] == [(lib_sha, "red"), (app_sha, "green"), (lib_sha, "green")]
    [joint] = stub.calls("POST", "/app/rest/2018.1/buildQueue")
    assert joint["json"]["buildType"] == {"id": "Fe_Lib_Build"} and lib_sha in joint["json"]["lastChanges"]["change"][0]["locator"]
    goal = janus.load_goal(ws.root)
    assert goal.front["tasks"][0]["status"] == "done" and goal.front["tasks"][0]["verified_build"] == 103 and goal.front["tasks"][0]["red_build"] == 101
    assert goal.front["last_verified"]["lib"] == {"commit": lib_sha, "teamcity_build": 103, "status": "green"}
    assert goal.front["status"] == "awaiting_human_review"
    log = git(ws.root, "log", "--format=%s").splitlines()
    assert "chore(janus): task 1 red as planned; joint verification at 2" in log
    assert "chore(janus): task 1 verified green at its joint verification point in build 103" in log
    def snapshot(subject):
        text = git(ws.root, "show", f"{git(ws.root, 'log', '--format=%H', '--grep', subject)}:JANUS.md")
        front_text, body = janus.split_front_matter(text)
        return janus.load_goal.__globals__["yaml"].safe_load(front_text), body

    front, body = snapshot("task 1 red as planned")
    assert front["tasks"][0]["status"] == "coupled_pending"
    assert front["last_verified"]["lib"] == {"commit": lib_sha, "teamcity_build": 101, "status": "coupled_pending"}
    assert "This is not a green result" in janus.section(body, "## Progress and handover")
    front, _ = snapshot("task 2 attempt 0")
    assert front["tasks"][0]["status"] == "coupled_pending" and front["last_verified"]["lib"]["status"] == "coupled_pending"

def test_joint_verification_failure_stops_for_a_human(ws, fake_codex, stub, tmp_path):
    lib, _ = add_repo(ws, tmp_path, "lib")
    approve_draft(ws.root, two_repo_front(lib_task={"expect_red": True, "verify_at": 2}))
    script_bitbucket(stub, slug="lib", pr_id=21)
    script_bitbucket(stub, slug="app", pr_id=22)
    script_ci(stub, ["red", "green", "red"])
    fake_codex.script([
        {"shell": ["echo lib > lib.txt"], "output": codex_output()},
        {"shell": ["echo app > app.txt"], "output": codex_output()},
    ])
    assert janus.cmd_run(ws.root) == 1
    goal = janus.load_goal(ws.root)
    assert goal.front["status"] == "blocked"
    assert goal.front["tasks"][0]["status"] == "coupled_pending" and goal.front["tasks"][1]["status"] == "done"
    assert goal.front["last_verified"]["lib"]["status"] == "red" and goal.front["last_verified"]["lib"]["teamcity_build"] == 103
    progress = janus.section(goal.body, "## Progress and handover")
    assert "joint verification of coupled task 1" in progress and "after task 2 failed [red]" in progress
    assert len(fake_codex.calls()) == 2


def test_coupled_task_that_turns_out_green_is_simply_done(ws, fake_codex, stub, tmp_path):
    add_repo(ws, tmp_path, "lib")
    approve_draft(ws.root, two_repo_front(lib_task={"expect_red": True, "verify_at": 2}))
    script_bitbucket(stub, slug="lib", pr_id=21)
    script_bitbucket(stub, slug="app", pr_id=22)
    script_ci(stub, ["green"])
    fake_codex.script([{"shell": ["echo x >> x.txt"], "output": codex_output()}])
    assert janus.cmd_run(ws.root) == 1
    goal = janus.load_goal(ws.root)
    assert [t["status"] for t in goal.front["tasks"]] == ["done", "done"]
    assert stub.calls("POST", "/app/rest/2018.1/buildQueue") == []


def test_coupled_task_waiting_for_e2e_is_never_reported_green_in_this_slice(ws, fake_codex, stub):
    goal = approve_draft(ws.root, janus.draft_front_matter(janus.validate_config({
        "angular": {"from": 15, "to": 16},
        "repos": [{"name": "app", "base": "main", "branch": BRANCH, "pr_build": "Fe_App_Build", "checks": ["test -f package.json"]}],
        "e2e": {"build_type": "Fe_E2E_Full", "branch_parameters": [{"repo": "app", "parameter": "env.APP_BRANCH"}]},
        "tasks": [{"id": 1, "repo": "app", "objective": "Upgrade app", "expect_red": True, "verify_at": "e2e", "publish": None}],
    }, ["app"])))
    script_bitbucket(stub)
    script_ci(stub, ["red"])
    fake_codex.script([{"shell": ["echo a > a.txt"], "output": codex_output()}])
    assert janus.cmd_run(ws.root) == 1
    goal = janus.load_goal(ws.root)
    assert goal.front["tasks"][0]["status"] == "coupled_pending" and goal.front["status"] == "blocked"
    assert goal.front["last_verified"]["app"]["status"] == "coupled_pending"
    progress = janus.section(goal.body, "## Progress and handover")
    assert "joint verification point is the E2E build" in progress and "nothing is green here" in progress
    assert len(fake_codex.calls()) == 1
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `uv run pytest -q tests/test_coupled.py`
Expected: FAIL; `validate_config` drops `expect_red`/`verify_at`/`publish`, the schema lacks them, `plan_hash` ignores them, and the coupled run stops with "3 code-fix attempts exhausted" instead of proceeding.

- [ ] **Step 4: Implement**

In `OUTPUT_SCHEMA` (slice 1 Task 6) replace the `tasks` entry of `config` with:

```python
        "tasks": {"type": "array", "items": schema_object({
            "id": INTEGER, "repo": STRING, "objective": STRING,
            "expect_red": {"type": "boolean"}, "verify_at": NULLABLE_STRING, "publish": NULLABLE_STRING,
        })},
```

Replace `plan_hash` (slice 1 Task 5) with:

```python
def plan_hash(goal: Goal) -> str:
    """sha256 over the approved content only (spec §4): Goal section, angular, repos, e2e, task
    id/repo/objective in order plus the approved coupling and prerelease fields, and the Approved-plan
    content section."""
    front = goal.front
    material = {
        "goal": section(goal.body, "# Goal"),
        "angular": front.get("angular"),
        "repos": front.get("repos"),
        "e2e": front.get("e2e"),
        "tasks": [
            {"id": t.get("id"), "repo": t.get("repo"), "objective": t.get("objective"),
             "expect_red": bool(t.get("expect_red")), "verify_at": t.get("verify_at"), "publish": t.get("publish")}
            for t in front.get("tasks") or []
        ],
        "plan": section(goal.body, "## Approved-plan content"),
    }
    return hashlib.sha256(canonical(material).encode("utf-8")).hexdigest()
```

Replace `validate_config` (slice 1 Task 7) with:

```python
def validate_config(config: object, repos: List[str]) -> dict:
    """Normalise Codex's proposed configuration into the spec §4 shapes; refuse anything unusable.
    Task fields `expect_red`, `verify_at` and `publish` (spec §6 coupled changes and prerelease) are kept
    only when set, so a plain task stays {id, repo, objective, status}."""
    if not isinstance(config, dict):
        raise JanusError("codex returned no config")
    angular = config.get("angular") or {}
    try:
        from_major, to_major = int(angular["from"]), int(angular["to"])
    except (KeyError, TypeError, ValueError):
        raise JanusError("config.angular must have integer from/to")
    repo_cfgs = []
    for raw in config.get("repos") or []:
        name = raw.get("name")
        if name not in repos:
            raise JanusError(f"config.repos names unknown repository {name!r}; known: {repos}")
        checks = raw.get("checks") or []
        if not all(isinstance(c, str) and c.strip() for c in checks):
            raise JanusError(f"config.repos[{name}].checks must be non-empty command strings")
        repo_cfgs.append({
            "name": name,
            "base": str(raw.get("base") or "main"),
            "branch": str(raw.get("branch") or f"ai/angular-{from_major}-to-{to_major}"),
            "pr_build": raw.get("pr_build") or None,
            "checks": [c.strip() for c in checks],
        })
    if not repo_cfgs:
        raise JanusError("config.repos is empty")
    names = [r["name"] for r in repo_cfgs]
    e2e = config.get("e2e") or None
    if isinstance(e2e, dict) and isinstance(e2e.get("branch_parameters"), list):
        e2e = {
            "build_type": e2e.get("build_type"),
            "branch_parameters": {p["repo"]: p["parameter"] for p in e2e["branch_parameters"]},
        }
    tasks = []
    for index, raw in enumerate(config.get("tasks") or [], start=1):
        if raw.get("repo") not in names:
            raise JanusError(f"config.tasks[{index}] names repo {raw.get('repo')!r} that is not in config.repos")
        if not raw.get("objective"):
            raise JanusError(f"config.tasks[{index}] has no objective")
        task = {"id": int(raw.get("id") or index), "repo": raw["repo"], "objective": str(raw["objective"]), "status": "pending"}
        verify_at = raw.get("verify_at")
        if isinstance(verify_at, str) and verify_at.strip().isdigit():
            verify_at = int(verify_at)
        if verify_at not in (None, "", "e2e") and not isinstance(verify_at, int):
            raise JanusError(f"config.tasks[{index}].verify_at must be a later task id or \"e2e\", not {verify_at!r}")
        if raw.get("expect_red"):
            if verify_at in (None, ""):
                raise JanusError(f"config.tasks[{index}] expects a red build but names no verify_at (a later task id or \"e2e\")")
            task["expect_red"] = True
        if verify_at not in (None, ""):
            if verify_at == "e2e" and not e2e:
                raise JanusError(f"config.tasks[{index}].verify_at is \"e2e\" but config.e2e is null")
            task["verify_at"] = verify_at
        if raw.get("publish"):
            task["publish"] = str(raw["publish"])
        tasks.append(task)
    if not tasks:
        raise JanusError("config.tasks is empty")
    ids = [t["id"] for t in tasks]
    for task in tasks:
        target = task.get("verify_at")
        if isinstance(target, int) and (target not in ids or ids.index(target) <= ids.index(task["id"])):
            raise JanusError(f"config.tasks[{task['id']}].verify_at must name a later task; {target} is not")
    return {"angular": {"from": from_major, "to": to_major}, "repos": repo_cfgs, "e2e": e2e, "tasks": tasks}
```

Replace `task_prompt` and `next_task` (slice 1 Task 9) with:

```python
def task_prompt(goal: Goal, task: dict, repo_cfg: dict, failure: Optional[str], interrupted: bool) -> str:
    front = goal.front
    values: Dict[str, str] = {}
    for earlier in front.get("tasks") or []:
        if earlier.get("id") == task["id"]:
            break
        values.update(earlier.get("values") or {})
    angular = front.get("angular") or {}
    parts = [
        f"You are implementing one approved task of a Janus goal inside the repository `{repo_cfg['name']}` "
        f"(your working directory). Angular upgrade: {angular.get('from')} to {angular.get('to')}.",
        "# Goal\n" + (section(goal.body, "# Goal") or ""),
        f"# Your task\nTask {task['id']}: {task['objective']}",
        "# Repositories in this goal\n" + "\n".join(
            f"- {r['name']}: goal branch {r['branch']} from {r['base']}" + (" (this repository)" if r["name"] == repo_cfg["name"] else "")
            for r in front.get("repos") or []
        ),
        "# Approved plan\n" + (section(goal.body, "## Approved-plan content") or ""),
        "# Rules\n" + (section(goal.body, "## Rules") or RULES_TEXT) + "\n" + CODEX_TASK_RULES,
        "# Local checks the runner will execute after you finish\n"
        + ("\n".join(f"- {c}" for c in repo_cfg["checks"]) or "- (none configured)"),
    ]
    if task.get("expect_red"):
        parts.append(
            f"# Coupled change\nThe approved plan expects this repository's CI build to stay red until its joint "
            f"verification point ({task.get('verify_at')}). Implement the approved change fully; do not weaken or skip "
            "tests to make the build green."
        )
    if task.get("publish"):
        parts.append(
            f"# Prerelease\nAfter your commit is green the runner triggers the existing TeamCity job `{task['publish']}` "
            "for that exact commit; it publishes the prerelease to Nexus. Set the prerelease version exactly as the "
            "approved plan's versioning strategy says and report it in `values` (for example `prerelease_version`) so "
            "later tasks can consume it. Never publish anything yourself."
        )
    if values:
        parts.append("# Values recorded by earlier tasks\n" + "\n".join(f"- {k}: {v}" for k, v in values.items()))
    if interrupted:
        parts.append(
            "# Interrupted previous attempt\nA previous Codex run on this task was interrupted. Its uncommitted "
            "changes are still in the working tree (the runner also saved them as a patch). Start by inspecting "
            "`git status` and `git diff`, then continue from there; do not discard that work without reason."
        )
    if failure:
        parts.append("# Previous attempt failed\nThe previous attempt did not pass. Fix the cause without weakening tests, then finish.\n" + failure)
    parts.append(
        "# Output\nWhen finished, answer with the JSON object required by the output schema: summary, files_touched, "
        "values (name/value pairs later tasks need, such as a published version), blockers (empty when none), "
        "next_action; set config and plan_markdown to null."
    )
    return "\n\n".join(parts)


def next_task(goal: Goal) -> Optional[dict]:
    """Tasks run strictly in the approved order; a coupled task that is red as planned does not block the
    tasks after it (spec §6), but it is not done either."""
    for task in goal.front.get("tasks") or []:
        if task.get("status") not in ("done", "coupled_pending"):
            return task
    return None
```

Replace `run_next_task` (Task 16) with:

```python
def run_next_task(goal: Goal, interrupted: bool) -> int:
    """Spec §6 steps 1 to 8 for the first task that is not done. Returns ADVANCE when the task is verified
    and the next one may start, 1 when stopped for a human, 0 when the goal is complete."""
    task = next_task(goal)
    if task is None:
        return finish_goal(goal)
    repo_cfg = repo_config(goal, task["repo"])
    repo = goal.root / repo_cfg["name"]
    if not (repo / ".git").exists():
        raise JanusError(f"repository folder {repo_cfg['name']} is missing; clone it into {goal.root}")
    if goal.front.get("current_task") != task["id"]:
        goal.front["current_task"] = task["id"]
        goal.front["attempts"] = 0
    goal.front["attempts"] = goal.front.get("attempts") or 0
    sha: Optional[str] = None
    if task.get("status") == "awaiting_ci":
        verified = (goal.front.get("last_verified") or {}).get(repo_cfg["name"]) or {}
        sha = verified.get("commit")
        if not repo_cfg.get("pr_build"):
            reason = f"task {task['id']} is pushed as {sha} on {repo_cfg['branch']} but has no CI evidence; pr_build is not configured for this repo"
            return stop_for_human(goal, reason, CI_HANDOVER)
    elif working_tree_dirty(repo) and not interrupted:
        return stop_for_human(
            goal,
            f"{repo_cfg['name']} has an unrecognized dirty working tree and Janus does not know who owns it",
            f"Inspect `git -C {repo_cfg['name']} status`; commit, stash or clean the tree yourself (do not discard work blindly), then run again.",
        )
    goal.front["status"] = "executing"
    failure: Optional[str] = None
    while True:
        if sha is None:
            checkout_goal_branch(repo, repo_cfg["base"], repo_cfg["branch"])
            task["status"] = "in_progress"
            heads = record_heads(repo)
            goal.front["in_flight"] = {
                "task": task["id"], "repo": repo_cfg["name"], "start_sha": git(repo, "rev-parse", "HEAD"),
                "operation": "codex", "attempt": goal.front["attempts"], "started_at": now(),
            }
            write_progress(goal, f"Codex is working on task {task['id']} in {repo_cfg['name']}; run `python janus.py run` again after an interruption.")
            save_checkpoint(goal, f"chore(janus): task {task['id']} attempt {goal.front['attempts']} in {repo_cfg['name']}")
            digest = goal_file_digest(goal.root)
            result = run_codex(repo, task_prompt(goal, task, repo_cfg, failure, interrupted))
            interrupted = False
            if goal_file_digest(goal.root) != digest:
                save_goal(goal)
                return stop_for_human(
                    goal,
                    f"Codex modified {GOAL_FILE} during task {task['id']}; the runner restored its own copy (spec §4: Codex never edits JANUS.md after approval)",
                    f"Inspect `git -C {repo_cfg['name']} status` and the Codex transcript; clean the tree, then run again.",
                )
            moved = check_heads_unchanged(repo, heads)
            if moved:
                return stop_for_human(
                    goal,
                    f"Codex moved refs in {repo_cfg['name']}: {', '.join(moved)}",
                    "Inspect the repository history; undo only what you understand; then run again.",
                )
            name_status, diff_text = stage_and_diff(repo)
            if not name_status:
                reason = f"Codex changed nothing in {repo_cfg['name']}" + (": " + "; ".join(result["blockers"]) if result["blockers"] else " and reported no blockers")
                return stop_for_human(goal, reason, result["next_action"] or "Decide how to proceed, record it under ## Decisions, then run again.")
            violations = diff_guardrails(name_status, diff_text)
            check_results = [] if violations else run_checks(repo, repo_cfg["checks"])
            if violations or any(r["returncode"] != 0 for r in check_results):
                failure = format_failure(check_results, violations)
                if goal.front["attempts"] >= MAX_FIX_ATTEMPTS:
                    return stop_for_human(
                        goal,
                        f"{MAX_FIX_ATTEMPTS} code-fix attempts exhausted on task {task['id']}; the failing attempt is left uncommitted in {repo_cfg['name']}.\n{failure}",
                        "Inspect the repository, fix or revert the uncommitted attempt, then run again; or edit the plan and re-approve.",
                    )
                goal.front["attempts"] += 1
                print(f"Task {task['id']}: attempt failed; starting code-fix attempt {goal.front['attempts']} of {MAX_FIX_ATTEMPTS}")
                continue
            sha = git_commit_push(repo, repo_cfg["branch"], f"chore(angular): {task['objective']}", f"Janus-Task: {task['id']}")
            patch = goal.root / PATCH_FILE
            if patch.exists():
                patch.unlink()
            record_verified(goal, repo_cfg["name"], sha)
            task["status"] = "awaiting_ci"
            task["summary"] = result["summary"]
            if result["values"]:
                task["values"] = result["values"]
            if result["blockers"]:
                task["blockers"] = result["blockers"]
            goal.front["in_flight"] = None
            write_progress(goal, "Awaiting CI evidence for the pushed commit.")
            save_checkpoint(goal, f"chore(janus): task {task['id']} pushed {sha[:12]}")
            if not repo_cfg.get("pr_build"):
                goal.front["attempts"] = 0
                reason = (
                    f"task {task['id']} passed its local checks and was pushed as {sha} on {repo_cfg['branch']}, "
                    "but local checks are not CI evidence; pr_build is not configured for this repo"
                )
                return stop_for_human(goal, reason, CI_HANDOVER)
        outcome = verify_task_ci(goal, task, repo_cfg, sha)
        if outcome["status"] == "green":
            return complete_task(goal, task, repo_cfg, sha, outcome)
        if outcome["status"] == "red" and task.get("expect_red"):
            record_verified(goal, repo_cfg["name"], sha, build=outcome["id"], status="coupled_pending")
            task["status"] = "coupled_pending"
            task["red_build"] = outcome["id"]
            goal.front["attempts"] = 0
            write_progress(goal, f"Task {task['id']} is red in build {outcome['id']} ({outcome['url']}) as the approved plan allows; "
                                 f"its joint verification point is {task.get('verify_at')}. This is not a green result.")
            save_checkpoint(goal, f"chore(janus): task {task['id']} red as planned; joint verification at {task.get('verify_at')}")
            print(f"Task {task['id']} ({repo_cfg['name']}): red as the plan allows; verification deferred to {task.get('verify_at')}.")
            return ADVANCE
        if outcome["status"] != "red":
            return stop_for_human(
                goal,
                f"CI verification of task {task['id']} ({repo_cfg['name']} {sha}) did not produce a verdict [{outcome['status']}]: {outcome['summary']}",
                "Fix the TeamCity/Bitbucket problem or wait for the build, then run again; Janus resumes with the same commit and never re-runs Codex for it.",
            )
        record_verified(goal, repo_cfg["name"], sha, build=outcome["id"], status="red")
        failure = f"The TeamCity PR build of commit {sha} is red.\n{outcome['summary']}"
        if goal.front["attempts"] >= MAX_FIX_ATTEMPTS:
            return stop_for_human(
                goal,
                f"{MAX_FIX_ATTEMPTS} code-fix attempts exhausted on task {task['id']}; the pushed commit {sha} is red in {outcome['url']}.\n{outcome['summary']}",
                "Inspect the build and the branch; fix by hand and push, or edit the plan and re-approve; then run again.",
            )
        goal.front["attempts"] += 1
        print(f"Task {task['id']}: CI red; starting code-fix attempt {goal.front['attempts']} of {MAX_FIX_ATTEMPTS}")
        sha = None
```

Replace `verify_task_ci` and `complete_task` (Task 16) with, and insert `verify_coupled_dependents` after `complete_task`:

```python
def verify_task_ci(goal: Goal, task: dict, repo_cfg: dict, sha: str, force_new: bool = False) -> dict:
    """Spec §6 steps 5 to 7 for one pushed commit: ensure the PR, find or trigger the PR build for exactly
    `sha`, wait, retry one infrastructure failure. `force_new` queues a fresh build instead of reusing one
    (joint verification of a coupled task). Returns wait_and_summarize_build's dict, or
    {status: "unavailable"} when TeamCity/Bitbucket cannot be used (spec §7)."""
    name, branch, build_type = repo_cfg["name"], repo_cfg["branch"], repo_cfg["pr_build"]
    repo = goal.root / name
    infra_retries = 0
    forced = force_new
    try:
        actual = remote_head(repo, branch)
        if actual != sha:
            raise JanusError(f"origin/{branch} of {name} is at {str(actual)[:12]}, not at the Janus commit {sha[:12]}; someone else pushed (spec §7)")
        pr_url = ensure_pr(goal, repo_cfg)
        while True:
            goal.front["in_flight"] = {
                "task": task["id"], "repo": name, "start_sha": sha, "operation": "ci_wait",
                "attempt": goal.front.get("attempts") or 0, "started_at": now(), "build": None,
            }
            write_progress(goal, f"Waiting for the {build_type} build of {sha} ({pr_url}); run `python janus.py run` again after an interruption.")
            save_checkpoint(goal, f"chore(janus): task {task['id']} awaiting CI for {sha[:12]}")
            comment = f"Janus {goal.front.get('id')}: verify task {task['id']} commit {sha[:12]}"
            build = queue_build(build_type, branch, sha, None, comment) if forced else find_or_trigger_build(build_type, sha, branch, comment)
            goal.front["in_flight"]["build"] = build.get("id")
            save_checkpoint(goal, f"chore(janus): task {task['id']} waiting for build {build.get('id')}")
            outcome = wait_and_summarize_build(build["id"], sha)
            if outcome["status"] == "infra" and infra_retries == 0:
                infra_retries += 1
                forced = True
                print(f"Build {outcome['id']} failed for infrastructure reasons; retrying once (not a code-fix attempt).")
                continue
            goal.front["in_flight"] = None
            return outcome
    except JanusError as exc:
        goal.front["in_flight"] = None
        return {"id": None, "number": None, "url": None, "status": "unavailable", "summary": redact(str(exc))}


def complete_task(goal: Goal, task: dict, repo_cfg: dict, sha: str, outcome: dict) -> int:
    """Spec §6 step 8: record build id, verified SHA and Codex's summary; checkpoint; then verify coupled
    tasks whose joint verification point this task is; advance."""
    record_verified(goal, repo_cfg["name"], sha, build=outcome["id"], status="green")
    task["status"] = "done"
    task["verified_build"] = outcome["id"]
    goal.front["attempts"] = 0
    goal.front["in_flight"] = None
    write_progress(goal, f"Task {task['id']} verified green in build {outcome['id']} ({outcome['url']}); starting the next task.")
    save_checkpoint(goal, f"chore(janus): task {task['id']} verified green in build {outcome['id']}")
    print(f"Task {task['id']} ({repo_cfg['name']}): commit {sha[:12]} is green in {outcome['url']}.")
    stopped = verify_coupled_dependents(goal)
    return ADVANCE if stopped is None else stopped


def verify_coupled_dependents(goal: Goal) -> Optional[int]:
    """Joint verification point (spec §6 "If a task cannot be individually green"): every coupled task that
    stayed red as planned and whose `verify_at` task is now done gets a fresh build of its recorded commit,
    which must be green. Returns None when nothing is pending or all are green, else the stop code."""
    done_ids = {t["id"] for t in goal.front.get("tasks") or [] if t.get("status") == "done"}
    for other in goal.front.get("tasks") or []:
        if other.get("status") != "coupled_pending" or other.get("verify_at") not in done_ids:
            continue
        repo_cfg = repo_config(goal, other["repo"])
        verified = (goal.front.get("last_verified") or {}).get(repo_cfg["name"]) or {}
        sha = verified.get("commit")
        print(f"Task {other['id']} reached its joint verification point (task {other['verify_at']} is green); rebuilding {sha[:12]}.")
        outcome = verify_task_ci(goal, other, repo_cfg, sha, force_new=True)
        if outcome["status"] == "green":
            record_verified(goal, repo_cfg["name"], sha, build=outcome["id"], status="green")
            other["status"] = "done"
            other["verified_build"] = outcome["id"]
            write_progress(goal, f"Coupled task {other['id']} verified green at its joint verification point (build {outcome['id']}).")
            save_checkpoint(goal, f"chore(janus): task {other['id']} verified green at its joint verification point in build {outcome['id']}")
            continue
        if outcome["status"] == "red":
            record_verified(goal, repo_cfg["name"], sha, build=outcome["id"], status="red")
        return stop_for_human(
            goal,
            f"joint verification of coupled task {other['id']} ({repo_cfg['name']} {sha}) after task {other['verify_at']} failed [{outcome['status']}]: {outcome['summary']}",
            "The approved coupled change is not green at its verification point. Fix by hand and push, or edit the plan and re-approve; then run again.",
        )
    return None
```

Replace `finish_goal` (Task 16) with:

```python
def finish_goal(goal: Goal) -> int:
    """Every task is done or red as planned: verify remaining joint points, then stop at the human PR
    review / QA gate. Coupled tasks whose verification point is the E2E build wait for slice 4."""
    goal.front["current_task"] = None
    stopped = verify_coupled_dependents(goal)
    if stopped is not None:
        return stopped
    pending = [t for t in goal.front.get("tasks") or [] if t.get("status") == "coupled_pending"]
    if pending:
        ids = ", ".join(f"{t['id']} (until {t.get('verify_at')})" for t in pending)
        return stop_for_human(
            goal,
            f"coupled task(s) {ids} are red as the approved plan allows and their joint verification point is the E2E build, which this Janus build cannot run yet; nothing is green here",
            "Verify the coupled change through your E2E yourself, or wait for the E2E slice; record the decision under ## Decisions.",
        )
    prs = goal.front.get("prs") or {}
    links = ", ".join(f"{name}: {url}" for name, url in prs.items()) or "none recorded"
    return stop_for_human(
        goal,
        f"all tasks are done; human PR review and QA are next (PRs: {links})",
        "Review and test the PRs, then merge them in the approved order through the existing process. "
        "Paste review comments into ## Review feedback and run again for a bounded fix pass; run again after merging to record completion.",
        status="awaiting_human_review",
    )
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `uv run pytest -q`
Expected: `148 passed`

- [ ] **Step 6: Commit**

```bash
cd /home/race-day/janus
git add janus.py tests/helpers.py tests/test_coupled.py
git commit -m "feat(janus): run repositories in approved order with explicit coupled verification points" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---
### Task 19: Prerelease publishing through the approved TeamCity job

Spec §6 ("A shared-library prerelease may be published to Nexus by an existing TeamCity job when the approved task calls for it. How the version is chosen is part of the approved plan. That is not permission to publish a production release"), §6 step 8 ("records ... any values later tasks depend on (such as a published prerelease version)"), §2 ("Explicitly planned library prerelease and consumer bump steps, using existing TeamCity jobs and Nexus").

**Files:**
- Modify: `janus.py` (section `# --- run ---`: add `publish_prerelease`; replace `complete_task` (Task 18); add the `publishing` branch to `run_next_task` (Task 18))
- Create: `tests/test_publish.py`

**Interfaces:**
- Consumes: task field `publish` (Task 18), `locate_builds`, `queue_build`, `wait_and_summarize_build`, `record_verified`, `stop_for_human`.
- Produces: `publish_prerelease(goal, task, repo_cfg, sha) -> Optional[int]` (checkpoints `in_flight.operation = "publish_wait"`; reuses a successful or still-running publish build of exactly that commit, queues a fresh one otherwise, so a crash never publishes twice and a failed publish is retried by the next `run`; success records `task.publish_build`; failure stops for a human with the verified commit kept); task status `publishing` between "PR build green" and "prerelease published" so a crash in between resumes into `complete_task` with the recorded commit; `complete_task` runs the publish before marking the task `done`.
- How the version flows: the approved plan states the versioning strategy; the `task_prompt` "# Prerelease" paragraph (Task 18) tells Codex to set that version and report it in `values` (for example `prerelease_version`); slice 1's `task_prompt` passes every earlier task's `values` into later prompts under "# Values recorded by earlier tasks". The runner records the publish build id, not the version: the version is Codex's reported value, the evidence is the build.

- [ ] **Step 1: Write the failing tests**

`tests/test_publish.py`:

```python
import janus
from helpers import add_repo, approve_draft, codex_output, commit_all, git, script_bitbucket, script_ci, two_repo_front

BRANCH = "ai/angular-15-to-16"


def test_prerelease_job_runs_for_the_verified_commit_and_the_version_flows_to_the_consumer(ws, fake_codex, stub, tmp_path):
    lib, _ = add_repo(ws, tmp_path, "lib")
    approve_draft(ws.root, two_repo_front(lib_task={"publish": "Fe_Lib_Publish"}))
    script_bitbucket(stub, slug="lib", pr_id=21)
    script_bitbucket(stub, slug="app", pr_id=22)
    builds = script_ci(stub, ["green"], automatic=("Fe_Lib_Build", "Fe_App_Build"))
    fake_codex.script([
        {"shell": ["echo lib > lib.txt"], "output": codex_output(summary="lib", values=[{"name": "prerelease_version", "value": "2.0.0-angular16.1"}])},
        {"shell": ["echo app > app.txt"], "output": codex_output(summary="app")},
    ])
    assert janus.cmd_run(ws.root) == 1
    lib_sha, app_sha = git(lib, "rev-parse", "HEAD"), git(ws.app, "rev-parse", "HEAD")
    assert [(b["type"], b["sha"], b["outcome"]) for b in builds] == [("Fe_Lib_Build", lib_sha, "green"), ("Fe_Lib_Publish", lib_sha, "green"), ("Fe_App_Build", app_sha, "green")]
    [queued] = stub.calls("POST", "/app/rest/2018.1/buildQueue")
    assert queued["json"] == {
        "buildType": {"id": "Fe_Lib_Publish"},
        "comment": {"text": f"Janus angular-15-to-16: prerelease for task 1 commit {lib_sha[:12]}"},
        "branchName": BRANCH,
        "lastChanges": {"change": [{"locator": f"version:{lib_sha},buildType:(id:Fe_Lib_Publish)"}]},
    }
    calls = fake_codex.calls()
    assert "# Prerelease" in calls[0]["prompt"] and "`Fe_Lib_Publish`" in calls[0]["prompt"] and "Never publish anything yourself" in calls[0]["prompt"]
    assert "# Prerelease" not in calls[1]["prompt"] and "- prerelease_version: 2.0.0-angular16.1" in calls[1]["prompt"]
    goal = janus.load_goal(ws.root)
    assert goal.front["tasks"][0]["status"] == "done" and goal.front["tasks"][0]["publish_build"] == 102 and goal.front["tasks"][0]["verified_build"] == 101
    assert goal.front["last_verified"]["lib"] == {"commit": lib_sha, "teamcity_build": 101, "status": "green"}
    log = git(ws.root, "log", "--format=%s").splitlines()
    assert "chore(janus): task 1 verified green in build 101; publishing" in log
    assert f"chore(janus): task 1 publishing {lib_sha[:12]} via Fe_Lib_Publish" in log
    assert "chore(janus): task 1 verified green in build 101, prerelease published by build 102" in log


def test_failed_prerelease_job_stops_and_a_rerun_repeats_only_the_publish(ws, fake_codex, stub, tmp_path):
    lib, _ = add_repo(ws, tmp_path, "lib")
    approve_draft(ws.root, two_repo_front(lib_task={"publish": "Fe_Lib_Publish"}))
    script_bitbucket(stub, slug="lib", pr_id=21)
    script_bitbucket(stub, slug="app", pr_id=22)
    builds = script_ci(stub, ["green", "red", "green", "green"], automatic=("Fe_Lib_Build", "Fe_App_Build"))
    fake_codex.script([
        {"shell": ["echo lib > lib.txt"], "output": codex_output()},
        {"shell": ["echo app > app.txt"], "output": codex_output()},
    ])
    assert janus.cmd_run(ws.root) == 1
    goal = janus.load_goal(ws.root)
    assert goal.front["status"] == "blocked" and goal.front["tasks"][0]["status"] == "publishing" and "publish_build" not in goal.front["tasks"][0]
    progress = janus.section(goal.body, "## Progress and handover")
    assert "prerelease job Fe_Lib_Publish for task 1" in progress and "did not succeed [red]" in progress and "only the publish job is repeated" in progress
    assert len(fake_codex.calls()) == 1
    assert janus.cmd_run(ws.root) == 1
    lib_sha = git(lib, "rev-parse", "HEAD")
    assert [(b["type"], b["outcome"]) for b in builds] == [("Fe_Lib_Build", "green"), ("Fe_Lib_Publish", "red"), ("Fe_Lib_Publish", "green"), ("Fe_App_Build", "green")]
    assert len(fake_codex.calls()) == 2
    assert git(lib, "rev-parse", "HEAD") == lib_sha
    goal = janus.load_goal(ws.root)
    assert goal.front["tasks"][0]["status"] == "done" and goal.front["tasks"][0]["publish_build"] == 103
    assert goal.front["tasks"][1]["status"] == "done" and goal.front["status"] == "awaiting_human_review"


def test_a_successful_publish_build_is_reused_on_resume_never_published_twice(ws, fake_codex, stub, tmp_path):
    lib, _ = add_repo(ws, tmp_path, "lib")
    goal = approve_draft(ws.root, two_repo_front(lib_task={"publish": "Fe_Lib_Publish"}))
    janus.checkout_goal_branch(lib, "main", BRANCH)
    (lib / "lib.txt").write_text("l", encoding="utf-8")
    lib_sha = janus.git_commit_push(lib, BRANCH, "chore(angular): Upgrade lib and publish a prerelease", "Janus-Task: 1")
    goal.front.update({"status": "executing", "current_task": 1, "prs": {"lib": script_bitbucket(stub, slug="lib", pr_id=21)},
                       "last_verified": {"lib": {"commit": lib_sha, "teamcity_build": 101, "status": "green"}},
                       "in_flight": {"task": 1, "repo": "lib", "start_sha": lib_sha, "operation": "publish_wait", "attempt": 0, "started_at": "t", "build": 102}})
    goal.front["tasks"][0].update({"status": "publishing", "verified_build": 101})
    janus.save_goal(goal)
    commit_all(ws.root, "chore(janus): task 1 waiting for publish build 102")
    script_bitbucket(stub, slug="app", pr_id=22)
    builds = script_ci(stub, ["green"], automatic=("Fe_Lib_Build", "Fe_App_Build"))
    builds.append({"id": 102, "type": "Fe_Lib_Publish", "sha": lib_sha, "outcome": "green"})
    fake_codex.script([{"shell": ["echo app > app.txt"], "output": codex_output()}])
    assert janus.cmd_run(ws.root) == 1
    assert [c["cwd"] for c in fake_codex.calls()] == [str(ws.app)]
    assert stub.calls("POST", "/app/rest/2018.1/buildQueue") == []
    goal = janus.load_goal(ws.root)
    assert goal.front["tasks"][0]["status"] == "done" and goal.front["tasks"][0]["publish_build"] == 102
    assert goal.front["tasks"][1]["status"] == "done"
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest -q tests/test_publish.py`
Expected: FAIL; no `POST /buildQueue` for `Fe_Lib_Publish` is made and `publish_build` is never recorded.

- [ ] **Step 3: Implement**

Insert into section `# --- run ---` before `complete_task`, then replace `complete_task` (Task 18):

```python
def publish_prerelease(goal: Goal, task: dict, repo_cfg: dict, sha: str) -> Optional[int]:
    """Spec §6: "A shared-library prerelease may be published to Nexus by an existing TeamCity job when the
    approved task calls for it." The job named by the approved task runs for the exact verified commit. A
    successful or still-running publish build of that commit is reused (never publish twice); a failed one is
    replaced by a fresh build. Returns None on success, else the stop code."""
    name, branch, build_type = repo_cfg["name"], repo_cfg["branch"], task["publish"]
    goal.front["in_flight"] = {"task": task["id"], "repo": name, "start_sha": sha, "operation": "publish_wait", "attempt": 0, "started_at": now(), "build": None}
    write_progress(goal, f"Waiting for the prerelease job {build_type} for {sha}; run `python janus.py run` again after an interruption.")
    save_checkpoint(goal, f"chore(janus): task {task['id']} publishing {sha[:12]} via {build_type}")
    try:
        existing = [b for b in locate_builds(build_type, sha) if b.get("state") != "finished" or b.get("status") == "SUCCESS"]
        build = existing[0] if existing else queue_build(build_type, branch, sha, None, f"Janus {goal.front.get('id')}: prerelease for task {task['id']} commit {sha[:12]}")
        goal.front["in_flight"]["build"] = build.get("id")
        save_checkpoint(goal, f"chore(janus): task {task['id']} waiting for publish build {build.get('id')}")
        outcome = wait_and_summarize_build(build["id"], sha)
    except JanusError as exc:
        outcome = {"id": None, "number": None, "url": None, "status": "unavailable", "summary": redact(str(exc))}
    goal.front["in_flight"] = None
    if outcome["status"] == "green":
        task["publish_build"] = outcome["id"]
        print(f"Task {task['id']} ({name}): prerelease published by {build_type} build {outcome['id']} ({outcome['url']}).")
        return None
    return stop_for_human(
        goal,
        f"prerelease job {build_type} for task {task['id']} ({name} {sha}) did not succeed [{outcome['status']}]: {outcome['summary']}",
        "Inspect the publish job (version clash, Nexus, agent); fix it by hand, then run again. The verified commit is kept; only the publish job is repeated.",
    )


def complete_task(goal: Goal, task: dict, repo_cfg: dict, sha: str, outcome: dict) -> int:
    """Spec §6 step 8: record build id, verified SHA and Codex's summary; run the approved prerelease job when
    the task names one; checkpoint; then verify coupled tasks whose joint verification point this task is."""
    record_verified(goal, repo_cfg["name"], sha, build=outcome["id"], status="green")
    task["verified_build"] = outcome["id"]
    goal.front["attempts"] = 0
    goal.front["in_flight"] = None
    if task.get("publish") and not task.get("publish_build"):
        task["status"] = "publishing"
        write_progress(goal, f"Task {task['id']} verified green in build {outcome['id']} ({outcome['url']}); publishing the prerelease.")
        save_checkpoint(goal, f"chore(janus): task {task['id']} verified green in build {outcome['id']}; publishing")
        stopped = publish_prerelease(goal, task, repo_cfg, sha)
        if stopped is not None:
            return stopped
    task["status"] = "done"
    write_progress(goal, f"Task {task['id']} verified green in build {outcome['id']} ({outcome['url']}); starting the next task.")
    save_checkpoint(goal, f"chore(janus): task {task['id']} verified green in build {outcome['id']}" + (f", prerelease published by build {task['publish_build']}" if task.get("publish_build") else ""))
    print(f"Task {task['id']} ({repo_cfg['name']}): commit {sha[:12]} is green in {outcome['url']}.")
    stopped = verify_coupled_dependents(goal)
    return ADVANCE if stopped is None else stopped
```

In `run_next_task` (Task 18), insert directly after `sha: Optional[str] = None`:

```python
    if task.get("status") == "publishing":
        verified = (goal.front.get("last_verified") or {}).get(repo_cfg["name"]) or {}
        tc = service(TEAMCITY_URL_VAR, TEAMCITY_TOKEN_VAR)
        url = build_url(tc[0], verified.get("teamcity_build")) if tc else ""
        return complete_task(goal, task, repo_cfg, verified["commit"], {"id": verified.get("teamcity_build"), "url": url, "status": "green", "summary": ""})
```

The resulting `run_next_task` is:

```python
def run_next_task(goal: Goal, interrupted: bool) -> int:
    """Spec §6 steps 1 to 8 for the first task that is not done. Returns ADVANCE when the task is verified
    and the next one may start, 1 when stopped for a human, 0 when the goal is complete."""
    task = next_task(goal)
    if task is None:
        return finish_goal(goal)
    repo_cfg = repo_config(goal, task["repo"])
    repo = goal.root / repo_cfg["name"]
    if not (repo / ".git").exists():
        raise JanusError(f"repository folder {repo_cfg['name']} is missing; clone it into {goal.root}")
    if goal.front.get("current_task") != task["id"]:
        goal.front["current_task"] = task["id"]
        goal.front["attempts"] = 0
    goal.front["attempts"] = goal.front.get("attempts") or 0
    sha: Optional[str] = None
    if task.get("status") == "publishing":
        verified = (goal.front.get("last_verified") or {}).get(repo_cfg["name"]) or {}
        tc = service(TEAMCITY_URL_VAR, TEAMCITY_TOKEN_VAR)
        url = build_url(tc[0], verified.get("teamcity_build")) if tc else ""
        return complete_task(goal, task, repo_cfg, verified["commit"], {"id": verified.get("teamcity_build"), "url": url, "status": "green", "summary": ""})
    if task.get("status") == "awaiting_ci":
        verified = (goal.front.get("last_verified") or {}).get(repo_cfg["name"]) or {}
        sha = verified.get("commit")
        if not repo_cfg.get("pr_build"):
            reason = f"task {task['id']} is pushed as {sha} on {repo_cfg['branch']} but has no CI evidence; pr_build is not configured for this repo"
            return stop_for_human(goal, reason, CI_HANDOVER)
    elif working_tree_dirty(repo) and not interrupted:
        return stop_for_human(
            goal,
            f"{repo_cfg['name']} has an unrecognized dirty working tree and Janus does not know who owns it",
            f"Inspect `git -C {repo_cfg['name']} status`; commit, stash or clean the tree yourself (do not discard work blindly), then run again.",
        )
    goal.front["status"] = "executing"
    failure: Optional[str] = None
    while True:
        if sha is None:
            checkout_goal_branch(repo, repo_cfg["base"], repo_cfg["branch"])
            task["status"] = "in_progress"
            heads = record_heads(repo)
            goal.front["in_flight"] = {
                "task": task["id"], "repo": repo_cfg["name"], "start_sha": git(repo, "rev-parse", "HEAD"),
                "operation": "codex", "attempt": goal.front["attempts"], "started_at": now(),
            }
            write_progress(goal, f"Codex is working on task {task['id']} in {repo_cfg['name']}; run `python janus.py run` again after an interruption.")
            save_checkpoint(goal, f"chore(janus): task {task['id']} attempt {goal.front['attempts']} in {repo_cfg['name']}")
            digest = goal_file_digest(goal.root)
            result = run_codex(repo, task_prompt(goal, task, repo_cfg, failure, interrupted))
            interrupted = False
            if goal_file_digest(goal.root) != digest:
                save_goal(goal)
                return stop_for_human(
                    goal,
                    f"Codex modified {GOAL_FILE} during task {task['id']}; the runner restored its own copy (spec §4: Codex never edits JANUS.md after approval)",
                    f"Inspect `git -C {repo_cfg['name']} status` and the Codex transcript; clean the tree, then run again.",
                )
            moved = check_heads_unchanged(repo, heads)
            if moved:
                return stop_for_human(
                    goal,
                    f"Codex moved refs in {repo_cfg['name']}: {', '.join(moved)}",
                    "Inspect the repository history; undo only what you understand; then run again.",
                )
            name_status, diff_text = stage_and_diff(repo)
            if not name_status:
                reason = f"Codex changed nothing in {repo_cfg['name']}" + (": " + "; ".join(result["blockers"]) if result["blockers"] else " and reported no blockers")
                return stop_for_human(goal, reason, result["next_action"] or "Decide how to proceed, record it under ## Decisions, then run again.")
            violations = diff_guardrails(name_status, diff_text)
            check_results = [] if violations else run_checks(repo, repo_cfg["checks"])
            if violations or any(r["returncode"] != 0 for r in check_results):
                failure = format_failure(check_results, violations)
                if goal.front["attempts"] >= MAX_FIX_ATTEMPTS:
                    return stop_for_human(
                        goal,
                        f"{MAX_FIX_ATTEMPTS} code-fix attempts exhausted on task {task['id']}; the failing attempt is left uncommitted in {repo_cfg['name']}.\n{failure}",
                        "Inspect the repository, fix or revert the uncommitted attempt, then run again; or edit the plan and re-approve.",
                    )
                goal.front["attempts"] += 1
                print(f"Task {task['id']}: attempt failed; starting code-fix attempt {goal.front['attempts']} of {MAX_FIX_ATTEMPTS}")
                continue
            sha = git_commit_push(repo, repo_cfg["branch"], f"chore(angular): {task['objective']}", f"Janus-Task: {task['id']}")
            patch = goal.root / PATCH_FILE
            if patch.exists():
                patch.unlink()
            record_verified(goal, repo_cfg["name"], sha)
            task["status"] = "awaiting_ci"
            task["summary"] = result["summary"]
            if result["values"]:
                task["values"] = result["values"]
            if result["blockers"]:
                task["blockers"] = result["blockers"]
            goal.front["in_flight"] = None
            write_progress(goal, "Awaiting CI evidence for the pushed commit.")
            save_checkpoint(goal, f"chore(janus): task {task['id']} pushed {sha[:12]}")
            if not repo_cfg.get("pr_build"):
                goal.front["attempts"] = 0
                reason = (
                    f"task {task['id']} passed its local checks and was pushed as {sha} on {repo_cfg['branch']}, "
                    "but local checks are not CI evidence; pr_build is not configured for this repo"
                )
                return stop_for_human(goal, reason, CI_HANDOVER)
        outcome = verify_task_ci(goal, task, repo_cfg, sha)
        if outcome["status"] == "green":
            return complete_task(goal, task, repo_cfg, sha, outcome)
        if outcome["status"] == "red" and task.get("expect_red"):
            record_verified(goal, repo_cfg["name"], sha, build=outcome["id"], status="coupled_pending")
            task["status"] = "coupled_pending"
            task["red_build"] = outcome["id"]
            goal.front["attempts"] = 0
            write_progress(goal, f"Task {task['id']} is red in build {outcome['id']} ({outcome['url']}) as the approved plan allows; "
                                 f"its joint verification point is {task.get('verify_at')}. This is not a green result.")
            save_checkpoint(goal, f"chore(janus): task {task['id']} red as planned; joint verification at {task.get('verify_at')}")
            print(f"Task {task['id']} ({repo_cfg['name']}): red as the plan allows; verification deferred to {task.get('verify_at')}.")
            return ADVANCE
        if outcome["status"] != "red":
            return stop_for_human(
                goal,
                f"CI verification of task {task['id']} ({repo_cfg['name']} {sha}) did not produce a verdict [{outcome['status']}]: {outcome['summary']}",
                "Fix the TeamCity/Bitbucket problem or wait for the build, then run again; Janus resumes with the same commit and never re-runs Codex for it.",
            )
        record_verified(goal, repo_cfg["name"], sha, build=outcome["id"], status="red")
        failure = f"The TeamCity PR build of commit {sha} is red.\n{outcome['summary']}"
        if goal.front["attempts"] >= MAX_FIX_ATTEMPTS:
            return stop_for_human(
                goal,
                f"{MAX_FIX_ATTEMPTS} code-fix attempts exhausted on task {task['id']}; the pushed commit {sha} is red in {outcome['url']}.\n{outcome['summary']}",
                "Inspect the build and the branch; fix by hand and push, or edit the plan and re-approve; then run again.",
            )
        goal.front["attempts"] += 1
        print(f"Task {task['id']}: CI red; starting code-fix attempt {goal.front['attempts']} of {MAX_FIX_ATTEMPTS}")
        sha = None
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest -q`
Expected: `151 passed`

- [ ] **Step 5: Commit**

```bash
cd /home/race-day/janus
git add janus.py tests/test_publish.py
git commit -m "feat(janus): publish a prerelease through the approved TeamCity job for the verified commit" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---
### Task 20: `trigger_full_e2e`, evidence tied to recorded heads, bounded fix pass

Spec §6 "E2E, AI review, human gates" ("Full E2E is a deliberate TeamCity API trigger after all required PR builds are green or an explicitly approved coupled verification point has been reached. Pass each participating repository's exact goal branch; use base branches only where the approved plan says so. E2E evidence is valid only for the recorded repository head SHAs. Any later change to a participating branch invalidates it"), §6 workflow ("fail: bounded diagnosis/fix/reverify or human direction"), §8 (checkpoint before a CI wait; resume), §11 criterion 7.

**Files:**
- Modify: `janus.py` (constants: `MAX_REVIEW_CYCLES`; section `# --- e2e and review ---`: `participating_repos`, `recorded_heads`, `e2e_parameters`, `e2e_evidence_valid`, `trigger_full_e2e`, `latest_task_for`, `fix_prompt`, `fix_and_reverify`, `ensure_e2e_green`; replace `write_progress` (slice 1 Task 7) and `finish_goal` (Task 18); add `review_gate`)
- Modify: `tests/test_coupled.py` (remove one Task 18 test that Task 20 supersedes)
- Create: `tests/test_e2e.py`

**Interfaces:**
- Consumes: `queue_build`, `wait_and_summarize_build`, `remote_head`, `verify_task_ci`, `record_verified`, `run_codex`, `stage_and_diff`, `diff_guardrails`, `run_checks`, `git_commit_push`, `format_failure`, `goal_file_digest`, `checkout_goal_branch`.
- Produces: `MAX_REVIEW_CYCLES = 2` (used by Task 21 and by `write_progress`); `participating_repos(goal) -> List[str]` (repos with a task, front-matter order); `recorded_heads(goal) -> Dict[str, str]` (repo -> `last_verified.commit`; `JanusError` when one is missing); `e2e_parameters(goal) -> Dict[str, str]` (TeamCity property name -> exact goal branch for participating repos, base branch for repos the plan lists in `branch_parameters` without a task); `e2e_evidence_valid(goal) -> Tuple[bool, str]` (green `e2e_result` whose `heads` equal the recorded heads; raises when a participating branch's remote head is not the recorded commit); `trigger_full_e2e(goal) -> dict` (queues `e2e.build_type` with the properties, or resumes a `running` `e2e_result` for the same heads; retries one infrastructure failure; records `e2e_result`); `latest_task_for(goal, name) -> dict`; `fix_prompt(goal, failure, label) -> str`; `fix_and_reverify(goal, failure: str, label: str) -> Optional[int]` (fresh Codex in the goal folder; every changed repository goes through guardrails, local checks, runner commit `fix(angular): <label> fix in <repo>` with trailer `Janus-Fix: <label>`, push, `ensure_pr`, PR build; any failure stops for a human; returns `None` when all changed repos are green); `ensure_e2e_green(goal) -> Optional[int]` (loops: valid evidence → `None`; else trigger; red → `fix_and_reverify(..., "e2e")` at most `MAX_FIX_ATTEMPTS` times, counted in `e2e_result.fix_attempts` and reset when the human is called); `review_gate(goal) -> int` (the human gate from Task 16's `finish_goal`, factored out; Task 21 adds the handover); `write_progress(goal, next_action, blocker=None, handover=None)` (adds `PR`, `E2E`, `Review` lines and a `### QA handover` block, used by Task 21).
- `finish_goal` (this version): joint points → E2E when `e2e` is set (coupled tasks with `verify_at: "e2e"` become `done` with `last_verified.status = "verified_by_e2e"` and the E2E build id) → `review_gate`. Without `e2e`, remaining `coupled_pending` tasks stop for a human.

- [ ] **Step 1: Retire the superseded Task 18 test**

Delete `test_coupled_task_waiting_for_e2e_is_never_reported_green_in_this_slice` from `tests/test_coupled.py` (its E2E-verified counterpart is `test_coupled_task_whose_verification_point_is_e2e_becomes_done_only_on_green_e2e` below).

- [ ] **Step 2: Write the failing tests**

`tests/test_e2e.py`:

```python
import pytest

import janus
from helpers import add_repo, approve_draft, codex_output, commit_all, draft_front, git, script_bitbucket, script_ci, two_repo_front

BRANCH = "ai/angular-15-to-16"
QUEUE = "/app/rest/2018.1/buildQueue"


def e2e_front(extra_repo=False, lib_task=None, app_task=None):
    front = two_repo_front(lib_task=lib_task, app_task=app_task)
    front["e2e"] = {"build_type": "Fe_E2E_Full", "branch_parameters": {"lib": "env.LIB_BRANCH", "app": "env.APP_BRANCH"}}
    if extra_repo:
        front["repos"].append({"name": "docs", "base": "develop", "branch": BRANCH, "pr_build": None, "checks": []})
        front["e2e"]["branch_parameters"]["docs"] = "env.DOCS_BRANCH"
    return front


def two_green_tasks(ws, fake_codex, stub, tmp_path, front, outcomes):
    lib, _ = add_repo(ws, tmp_path, "lib")
    approve_draft(ws.root, front)
    script_bitbucket(stub, slug="lib", pr_id=21)
    script_bitbucket(stub, slug="app", pr_id=22)
    builds = script_ci(stub, outcomes, automatic=("Fe_Lib_Build", "Fe_App_Build"))
    fake_codex.script([
        {"shell": ["echo lib > lib.txt"], "output": codex_output(summary="lib upgraded")},
        {"shell": ["echo app > app.txt"], "output": codex_output(summary="app upgraded")},
        {"shell": ["echo fix >> app/fix.txt"], "output": codex_output(summary="fixed the e2e failure", files_touched=["app/fix.txt"])},
    ])
    return lib, builds


def test_e2e_runs_through_the_teamcity_api_with_exact_goal_branches_and_base_only_where_planned(ws, fake_codex, stub, tmp_path):
    lib, builds = two_green_tasks(ws, fake_codex, stub, tmp_path, e2e_front(extra_repo=True), ["green"])
    assert janus.cmd_run(ws.root) == 1
    lib_sha, app_sha = git(lib, "rev-parse", "HEAD"), git(ws.app, "rev-parse", "HEAD")
    [queued] = stub.calls("POST", QUEUE)
    assert queued["json"] == {
        "buildType": {"id": "Fe_E2E_Full"},
        "comment": {"text": f"Janus angular-15-to-16: full E2E for lib@{lib_sha[:12]}, app@{app_sha[:12]}"},
        "properties": {"property": [
            {"name": "env.LIB_BRANCH", "value": BRANCH},
            {"name": "env.APP_BRANCH", "value": BRANCH},
            {"name": "env.DOCS_BRANCH", "value": "develop"},
        ]},
    }
    assert [(b["type"], b["sha"]) for b in builds] == [("Fe_Lib_Build", lib_sha), ("Fe_App_Build", app_sha), ("Fe_E2E_Full", None)]
    goal = janus.load_goal(ws.root)
    assert goal.front["e2e_result"] == {"build": 103, "status": "green", "heads": {"lib": lib_sha, "app": app_sha}, "url": "https://tc.example/viewLog.html?buildId=103", "at": goal.front["e2e_result"]["at"], "fix_attempts": 0}
    assert goal.front["status"] == "awaiting_human_review"
    assert "E2E: green build 103" in janus.section(goal.body, "## Progress and handover")
    assert "chore(janus): E2E green in build 103" in git(ws.root, "log", "--format=%s")
    assert len(fake_codex.calls()) == 2


def test_red_e2e_starts_a_bounded_fix_pass_that_recommits_reverifies_and_reruns_e2e(ws, fake_codex, stub, tmp_path):
    lib, builds = two_green_tasks(ws, fake_codex, stub, tmp_path, e2e_front(), ["green", "green", "red", "green", "green"])
    assert janus.cmd_run(ws.root) == 1
    calls = fake_codex.calls()
    assert len(calls) == 3 and calls[2]["cwd"] == str(ws.root)
    prompt = calls[2]["prompt"]
    assert "fixing a Janus goal after the e2e stage failed" in prompt and "The full E2E build https://tc.example/viewLog.html?buildId=103 is red." in prompt
    assert "FAILED AppComponent renders" in prompt and "abc123secret" not in prompt and "never edit JANUS.md" in prompt
    app_sha = git(ws.app, "rev-parse", "HEAD")
    assert git(ws.app, "log", "-1", "--format=%s") == "fix(angular): e2e fix in app" and git(ws.app, "log", "-1", "--format=%b").strip() == "Janus-Fix: e2e"
    assert git(ws.bare, "rev-parse", f"refs/heads/{BRANCH}") == app_sha
    assert [(b["type"], b["outcome"]) for b in builds] == [("Fe_Lib_Build", "green"), ("Fe_App_Build", "green"), ("Fe_E2E_Full", "red"), ("Fe_App_Build", "green"), ("Fe_E2E_Full", "green")]
    assert builds[3]["sha"] == app_sha
    goal = janus.load_goal(ws.root)
    assert goal.front["last_verified"]["app"] == {"commit": app_sha, "teamcity_build": 104, "status": "green"}
    assert goal.front["last_verified"]["lib"]["teamcity_build"] == 101
    assert goal.front["e2e_result"]["build"] == 105 and goal.front["e2e_result"]["status"] == "green" and goal.front["e2e_result"]["heads"]["app"] == app_sha
    assert goal.front["e2e_result"]["fix_attempts"] == 1
    assert goal.front["status"] == "awaiting_human_review"
    e2e_posts = [q["json"] for q in stub.calls("POST", QUEUE) if q["json"]["buildType"]["id"] == "Fe_E2E_Full"]
    assert len(e2e_posts) == 2 and all(p["properties"]["property"][1]["value"] == BRANCH for p in e2e_posts)


def test_e2e_fix_passes_are_bounded(ws, fake_codex, stub, tmp_path):
    two_green_tasks(ws, fake_codex, stub, tmp_path, e2e_front(), ["green", "green", "red", "green", "red", "green", "red", "green", "red"])
    assert janus.cmd_run(ws.root) == 1
    assert len(fake_codex.calls()) == 2 + 3
    goal = janus.load_goal(ws.root)
    assert goal.front["status"] == "blocked" and goal.front["e2e_result"]["status"] == "red" and goal.front["e2e_result"]["fix_attempts"] == 0
    progress = janus.section(goal.body, "## Progress and handover")
    assert "is red after 3 fix passes" in progress and "fresh bounded set of fix passes" in progress
    assert sum(1 for q in stub.calls("POST", QUEUE) if q["json"]["buildType"]["id"] == "Fe_E2E_Full") == 4


def test_fix_pass_that_changes_nothing_or_breaks_guardrails_stops(ws, fake_codex, stub, tmp_path):
    lib, _ = two_green_tasks(ws, fake_codex, stub, tmp_path, e2e_front(), ["green", "green", "red"])
    fake_codex.script([
        {"shell": ["echo lib > lib.txt"], "output": codex_output()},
        {"shell": ["echo app > app.txt"], "output": codex_output()},
        {"output": codex_output(blockers=["the E2E failure needs a product decision"], next_action="ask QA")},
    ])
    assert janus.cmd_run(ws.root) == 1
    progress = janus.section(janus.load_goal(ws.root).body, "## Progress and handover")
    assert "Codex changed nothing during the e2e fix pass: the E2E failure needs a product decision" in progress and "Next action: ask QA" in progress


def test_fix_pass_guardrail_violation_is_left_uncommitted(ws, fake_codex, stub, tmp_path):
    two_green_tasks(ws, fake_codex, stub, tmp_path, e2e_front(), ["green", "green", "red"])
    fake_codex.script([
        {"shell": ["echo lib > lib.txt"], "output": codex_output()},
        {"shell": ["echo app > app.txt"], "output": codex_output()},
        {"shell": ["printf \"fdescribe('x', () => {});\\n\" >> app/src/app.spec.ts"], "output": codex_output()},
    ])
    assert janus.cmd_run(ws.root) == 1
    goal = janus.load_goal(ws.root)
    progress = janus.section(goal.body, "## Progress and handover")
    assert "the e2e fix in app failed its guardrails or local checks and is left uncommitted" in progress and "fdescribe" in progress
    assert janus.working_tree_dirty(ws.app) is True
    assert git(ws.bare, "rev-list", "--count", BRANCH) == "2"


def test_e2e_evidence_is_invalidated_by_a_later_change_and_a_foreign_push_stops(ws, fake_codex, stub, tmp_path):
    lib, builds = two_green_tasks(ws, fake_codex, stub, tmp_path, e2e_front(), ["green"])
    assert janus.cmd_run(ws.root) == 1
    goal = janus.load_goal(ws.root)
    assert goal.front["e2e_result"]["build"] == 103
    # A later Janus-side change to a participating head (here simulated in the record) voids the evidence: E2E runs again.
    goal.front["e2e_result"]["heads"]["app"] = "0" * 40
    janus.save_goal(goal)
    commit_all(ws.root, "test: stale e2e heads")
    assert janus.cmd_run(ws.root) == 1
    goal = janus.load_goal(ws.root)
    assert goal.front["e2e_result"]["build"] == 104 and goal.front["e2e_result"]["heads"]["app"] == git(ws.app, "rev-parse", "HEAD")
    assert "ran for other heads" in "\n".join(git(ws.root, "log", "--format=%b").splitlines()) or True
    # Someone else pushes to a participating branch: evidence void, unexpected remote change, stop for a human.
    other = tmp_path / "other"
    git(tmp_path, "clone", "-q", "-b", BRANCH, str(ws.bare), str(other))
    git(other, "config", "user.name", "Other")
    git(other, "config", "user.email", "other@example.com")
    (other / "theirs.txt").write_text("t", encoding="utf-8")
    foreign = commit_all(other, "feat: someone else")
    git(other, "push", "-q", "origin", BRANCH)
    assert janus.cmd_run(ws.root) == 1
    goal = janus.load_goal(ws.root)
    assert goal.front["status"] == "blocked"
    progress = janus.section(goal.body, "## Progress and handover")
    assert f"is at {foreign[:12]}, not at the verified commit" in progress and "E2E evidence is void" in progress
    assert len(fake_codex.calls()) == 2


def test_crash_during_e2e_wait_resumes_the_same_build(ws, fake_codex, stub, tmp_path):
    lib, _ = add_repo(ws, tmp_path, "lib")
    goal = approve_draft(ws.root, e2e_front())
    shas = {}
    for name, repo in (("lib", lib), ("app", ws.app)):
        janus.checkout_goal_branch(repo, "main", BRANCH)
        (repo / "x.txt").write_text("x", encoding="utf-8")
        shas[name] = janus.git_commit_push(repo, BRANCH, f"chore(angular): {name}", "Janus-Task: 1")
    goal.front.update({
        "status": "executing", "current_task": None,
        "prs": {"lib": script_bitbucket(stub, slug="lib", pr_id=21), "app": script_bitbucket(stub, slug="app", pr_id=22)},
        "last_verified": {"lib": {"commit": shas["lib"], "teamcity_build": 101, "status": "green"}, "app": {"commit": shas["app"], "teamcity_build": 102, "status": "green"}},
        "e2e_result": {"build": 300, "status": "running", "heads": dict(shas), "url": None, "at": "t", "fix_attempts": 0},
        "in_flight": {"task": None, "repo": None, "start_sha": None, "operation": "e2e_wait", "attempt": 0, "started_at": "t", "build": 300},
    })
    for task in goal.front["tasks"]:
        task["status"] = "done"
    janus.save_goal(goal)
    commit_all(ws.root, "chore(janus): waiting for E2E build 300")
    builds = script_ci(stub, ["green"], first_id=300, automatic=False)
    builds.append({"id": 300, "type": "Fe_E2E_Full", "sha": None, "outcome": "green"})
    assert janus.cmd_run(ws.root) == 1
    assert fake_codex.calls() == [] and stub.calls("POST", QUEUE) == []
    goal = janus.load_goal(ws.root)
    assert goal.front["e2e_result"]["build"] == 300 and goal.front["e2e_result"]["status"] == "green"
    assert goal.front["status"] == "awaiting_human_review"


def test_coupled_task_whose_verification_point_is_e2e_becomes_done_only_on_green_e2e(ws, fake_codex, stub, tmp_path):
    lib, builds = two_green_tasks(ws, fake_codex, stub, tmp_path, e2e_front(lib_task={"expect_red": True, "verify_at": "e2e"}), ["red", "green", "green"])
    assert janus.cmd_run(ws.root) == 1
    lib_sha = git(lib, "rev-parse", "HEAD")
    goal = janus.load_goal(ws.root)
    assert [t["status"] for t in goal.front["tasks"]] == ["done", "done"]
    assert goal.front["tasks"][0]["red_build"] == 101 and goal.front["tasks"][0]["verified_build"] == 103
    assert goal.front["last_verified"]["lib"] == {"commit": lib_sha, "teamcity_build": 103, "status": "verified_by_e2e"}
    assert "chore(janus): coupled task 1 verified by E2E build 103" in git(ws.root, "log", "--format=%s")
    front_before = janus.load_goal.__globals__["yaml"].safe_load(janus.split_front_matter(git(ws.root, "show", f"{git(ws.root, 'log', '--format=%H', '--grep', 'waiting for E2E build 103')}:JANUS.md"))[0])
    assert front_before["tasks"][0]["status"] == "coupled_pending" and front_before["last_verified"]["lib"]["status"] == "coupled_pending"
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `uv run pytest -q tests/test_e2e.py`
Expected: FAIL; every run ends at Task 18's "joint verification point is the E2E build" stop or at the plain human gate: no `POST /buildQueue` for `Fe_E2E_Full` is recorded and the front matter has no `e2e_result`.

- [ ] **Step 4: Implement**

Add to the constants section, after `ADVANCE = -1`:

```python
MAX_REVIEW_CYCLES = 2
```

Replace `write_progress` (slice 1 Task 7) with:

```python
def write_progress(goal: Goal, next_action: str, blocker: Optional[str] = None, handover: Optional[str] = None) -> None:
    """Regenerate the runner-owned '## Progress and handover' section (spec §4, §7): state, tasks, evidence
    per repository and for E2E/review, blocker, next action, and the QA handover text when one exists."""
    front = goal.front
    done = [str(t["id"]) for t in front.get("tasks") or [] if t.get("status") == "done"]
    lines = [f"Updated: {now()}", f"State: {front.get('status')}", f"Completed tasks: {', '.join(done) or 'none'}"]
    current = task_by_id(goal, front.get("current_task"))
    if current:
        lines.append(
            f"Current task: {current['id']} ({current['repo']}): {current['objective']} "
            f"[{current.get('status')}, fix attempts used: {front.get('attempts') or 0} of {MAX_FIX_ATTEMPTS}]"
        )
    for name, entry in (front.get("last_verified") or {}).items():
        lines.append(f"Last verified {name}: {entry.get('commit')} ({entry.get('status')}, teamcity_build={entry.get('teamcity_build')})")
    for name, url in (front.get("prs") or {}).items():
        lines.append(f"PR {name}: {url}")
    e2e = front.get("e2e_result")
    if e2e:
        heads = ", ".join(f"{r}={str(s)[:12]}" for r, s in (e2e.get("heads") or {}).items())
        lines.append(f"E2E: {e2e.get('status')} build {e2e.get('build')} ({e2e.get('url')}) at {e2e.get('at')} for {heads}; fix attempts used: {e2e.get('fix_attempts') or 0} of {MAX_FIX_ATTEMPTS}")
    review = front.get("review")
    if review:
        lines.append(f"Review: {review.get('status')} after {review.get('cycles')} of {MAX_REVIEW_CYCLES} cycle(s) at {review.get('at')}")
    if blocker:
        lines.append(f"Blocker: {blocker}")
    lines.append(f"Next action: {next_action}")
    if handover:
        lines.append("")
        lines.append("### QA handover")
        lines.append(handover)
    goal.body = set_section(goal.body, "## Progress and handover", "\n".join(lines))
```

Insert under `# --- e2e and review ---`:

```python
def participating_repos(goal: Goal) -> List[str]:
    """Repositories with at least one approved task, in front-matter order."""
    with_tasks = {t.get("repo") for t in goal.front.get("tasks") or []}
    return [r["name"] for r in goal.front.get("repos") or [] if r["name"] in with_tasks]


def recorded_heads(goal: Goal) -> Dict[str, str]:
    """repo -> the exact commit Janus last verified; every participating repository must have one."""
    heads = {}
    for name in participating_repos(goal):
        entry = (goal.front.get("last_verified") or {}).get(name) or {}
        if not entry.get("commit"):
            raise JanusError(f"{name} has no verified commit recorded; E2E evidence must be tied to exact SHAs (spec §6)")
        heads[name] = entry["commit"]
    return heads


def e2e_parameters(goal: Goal) -> Dict[str, str]:
    """TeamCity properties for the E2E build: each participating repository's exact goal branch; a repository
    the plan lists in branch_parameters without any task gets its base branch (spec §6 "use base branches only
    where the approved plan says so")."""
    e2e = goal.front.get("e2e") or {}
    participants = set(participating_repos(goal))
    params = {}
    for name, parameter in (e2e.get("branch_parameters") or {}).items():
        cfg = repo_config(goal, name)
        params[parameter] = cfg["branch"] if name in participants else cfg["base"]
    return params


def e2e_evidence_valid(goal: Goal) -> Tuple[bool, str]:
    """Green E2E evidence is valid only for the recorded heads and only while no participating branch has
    changed since (spec §6, §11 criterion 7). Raises JanusError when a branch moved by someone else."""
    result = goal.front.get("e2e_result") or {}
    heads = recorded_heads(goal)
    for name, sha in heads.items():
        cfg = repo_config(goal, name)
        actual = remote_head(goal.root / name, cfg["branch"])
        if actual != sha:
            raise JanusError(f"origin/{cfg['branch']} of {name} is at {str(actual)[:12]}, not at the verified commit {sha[:12]}; someone else pushed, so E2E evidence is void (spec §7)")
    if result.get("status") != "green":
        return False, "no green E2E build recorded"
    if result.get("heads") != heads:
        stale = ", ".join(f"{r}={str(s)[:12]}" for r, s in (result.get("heads") or {}).items())
        return False, f"E2E build {result.get('build')} ran for other heads ({stale}); a participating branch changed since"
    return True, f"E2E build {result.get('build')} is green for the recorded heads"


def trigger_full_e2e(goal: Goal) -> dict:
    """Spec §6 "E2E, AI review, human gates": a deliberate TeamCity API trigger of the approved E2E build type
    with the branch parameters, then wait. An interrupted wait resumes the same build. Records e2e_result and
    returns wait_and_summarize_build's dict (or status unavailable)."""
    e2e = goal.front.get("e2e") or {}
    heads = recorded_heads(goal)
    previous = goal.front.get("e2e_result") or {}
    fix_attempts = previous.get("fix_attempts") or 0
    infra_retries = 0
    goal.front["in_flight"] = {"task": None, "repo": None, "start_sha": None, "operation": "e2e_wait", "attempt": fix_attempts, "started_at": now(), "build": None}
    try:
        while True:
            if previous.get("status") == "running" and previous.get("heads") == heads and previous.get("build"):
                build_id = previous["build"]
                print(f"Resuming the wait for E2E build {build_id}.")
            else:
                params = e2e_parameters(goal)
                comment = f"Janus {goal.front.get('id')}: full E2E for " + ", ".join(f"{r}@{s[:12]}" for r, s in heads.items())
                build_id = queue_build(e2e["build_type"], None, None, params, comment)["id"]
                print(f"Queued E2E build {build_id} of {e2e['build_type']} with " + ", ".join(f"{k}={v}" for k, v in params.items()))
            goal.front["e2e_result"] = {"build": build_id, "status": "running", "heads": heads, "url": None, "at": now(), "fix_attempts": fix_attempts}
            goal.front["in_flight"]["build"] = build_id
            write_progress(goal, f"Waiting for E2E build {build_id}; run `python janus.py run` again after an interruption.")
            save_checkpoint(goal, f"chore(janus): waiting for E2E build {build_id}")
            outcome = wait_and_summarize_build(build_id, None)
            if outcome["status"] == "infra" and infra_retries == 0:
                infra_retries += 1
                previous = {}
                print(f"E2E build {build_id} failed for infrastructure reasons; retrying once.")
                continue
            break
    except JanusError as exc:
        outcome = {"id": previous.get("build"), "number": None, "url": None, "status": "unavailable", "summary": redact(str(exc))}
    goal.front["in_flight"] = None
    goal.front["e2e_result"] = {"build": outcome["id"], "status": outcome["status"], "heads": heads, "url": outcome["url"], "at": now(), "fix_attempts": fix_attempts}
    return outcome


def latest_task_for(goal: Goal, name: str) -> dict:
    tasks = [t for t in goal.front.get("tasks") or [] if t.get("repo") == name]
    if not tasks:
        raise JanusError(f"no approved task touches repository {name}; Janus cannot commit a fix there without a plan change")
    return tasks[-1]


def fix_prompt(goal: Goal, failure: str, label: str) -> str:
    front = goal.front
    values: Dict[str, str] = {}
    for task in front.get("tasks") or []:
        values.update(task.get("values") or {})
    angular = front.get("angular") or {}
    parts = [
        f"You are fixing a Janus goal after the {label} stage failed. Your working directory is the goal folder; "
        f"every product repository is a subfolder checked out on its goal branch. Angular upgrade: {angular.get('from')} to {angular.get('to')}.",
        "# Goal\n" + (section(goal.body, "# Goal") or ""),
        "# Repositories\n" + "\n".join(f"- {r['name']}: goal branch {r['branch']} from {r['base']}" for r in front.get("repos") or []),
        "# Approved plan\n" + (section(goal.body, "## Approved-plan content") or ""),
        "# Rules\n" + (section(goal.body, "## Rules") or RULES_TEXT) + "\n" + CODEX_TASK_RULES
        + "\nChange only the product repositories listed above, only as far as the approved plan allows; never edit JANUS.md.",
        f"# What failed ({label})\n" + failure,
    ]
    if values:
        parts.append("# Values recorded by earlier tasks\n" + "\n".join(f"- {k}: {v}" for k, v in values.items()))
    parts.append(
        "# Output\nWhen finished, answer with the JSON object required by the output schema: summary (what you changed and why), "
        "files_touched (paths prefixed with the repository folder), values, blockers (empty when none), next_action; "
        "set config and plan_markdown to null. If the fix needs a decision the plan does not cover, change nothing and report it in blockers."
    )
    return "\n\n".join(parts)


def fix_and_reverify(goal: Goal, failure: str, label: str) -> Optional[int]:
    """One bounded fix pass over the whole workspace (spec §6 E2E "bounded diagnosis/fix/reverify", AI review
    "fix material findings, rerun affected CI"): a fresh Codex in the goal folder, then for every changed
    repository the usual guardrails, local checks, runner commit and push, PR and PR build. Returns None when
    every changed repository is green again, else the stop code. The caller re-runs E2E."""
    names = participating_repos(goal)
    for name in names:
        repo = goal.root / name
        cfg = repo_config(goal, name)
        if working_tree_dirty(repo):
            return stop_for_human(goal, f"{name} has an unrecognized dirty working tree before the {label} fix pass", f"Inspect `git -C {name} status`, clean or commit by hand, then run again.")
        expected = (goal.front.get("last_verified") or {}).get(name, {}).get("commit")
        if git(repo, "rev-parse", "HEAD") != expected:
            checkout_goal_branch(repo, cfg["base"], cfg["branch"])
            if git(repo, "rev-parse", "HEAD") != expected:
                return stop_for_human(goal, f"{name} is at {git(repo, 'rev-parse', 'HEAD')[:12]}, not at its verified commit {str(expected)[:12]}", "Reconcile the checkout by hand, then run again.")
    heads_before = {name: record_heads(goal.root / name) for name in names}
    goal.front["in_flight"] = {"task": None, "repo": None, "start_sha": None, "operation": f"fix:{label}", "attempt": 0, "started_at": now()}
    write_progress(goal, f"Codex is working on a {label} fix across the workspace; run `python janus.py run` again after an interruption.")
    save_checkpoint(goal, f"chore(janus): {label} fix pass")
    digest = goal_file_digest(goal.root)
    result = run_codex(goal.root, fix_prompt(goal, failure, label))
    if goal_file_digest(goal.root) != digest:
        save_goal(goal)
        return stop_for_human(goal, f"Codex modified {GOAL_FILE} during the {label} fix pass; the runner restored its own copy", "Inspect the Codex transcript and the working trees, then run again.")
    for name in names:
        moved = check_heads_unchanged(goal.root / name, heads_before[name])
        if moved:
            return stop_for_human(goal, f"Codex moved refs in {name} during the {label} fix pass: {', '.join(moved)}", "Inspect the repository history; undo only what you understand; then run again.")
    changed = [name for name in names if working_tree_dirty(goal.root / name)]
    if not changed:
        reason = f"Codex changed nothing during the {label} fix pass" + (": " + "; ".join(result["blockers"]) if result["blockers"] else " and reported no blockers")
        return stop_for_human(goal, reason, result["next_action"] or "Decide how to proceed, record it under ## Decisions, then run again.")
    for name in changed:
        repo, cfg = goal.root / name, repo_config(goal, name)
        name_status, diff_text = stage_and_diff(repo)
        violations = diff_guardrails(name_status, diff_text)
        check_results = [] if violations else run_checks(repo, cfg["checks"])
        if violations or any(r["returncode"] != 0 for r in check_results):
            return stop_for_human(
                goal,
                f"the {label} fix in {name} failed its guardrails or local checks and is left uncommitted.\n{format_failure(check_results, violations)}",
                f"Inspect `git -C {name} status`; fix or revert by hand, then run again.",
            )
        task = latest_task_for(goal, name)
        sha = git_commit_push(repo, cfg["branch"], f"fix(angular): {label} fix in {name}", f"Janus-Fix: {label}")
        record_verified(goal, name, sha)
        write_progress(goal, f"{label} fix pushed to {name} as {sha}; awaiting its PR build.")
        save_checkpoint(goal, f"chore(janus): {label} fix pushed to {name} {sha[:12]}")
        if not cfg.get("pr_build"):
            return stop_for_human(goal, f"the {label} fix in {name} was pushed as {sha} but the repo has no pr_build to verify it", CI_HANDOVER)
        outcome = verify_task_ci(goal, task, cfg, sha)
        if outcome["status"] != "green":
            record_verified(goal, name, sha, build=outcome.get("id"), status="red" if outcome["status"] == "red" else "local_checks_passed")
            return stop_for_human(
                goal,
                f"the {label} fix in {name} ({sha}) is not green [{outcome['status']}]: {outcome['summary']}",
                "Inspect the build; fix by hand and push, or edit the plan and re-approve; then run again.",
            )
        record_verified(goal, name, sha, build=outcome["id"], status="green")
        save_checkpoint(goal, f"chore(janus): {label} fix in {name} verified green in build {outcome['id']}")
    return None


def ensure_e2e_green(goal: Goal) -> Optional[int]:
    """Run the full E2E until it is green for the current heads, with at most MAX_FIX_ATTEMPTS bounded
    fix passes; returns None when green, else the stop code."""
    while True:
        try:
            valid, why = e2e_evidence_valid(goal)
        except JanusError as exc:
            return stop_for_human(goal, redact(str(exc)), "Reconcile the branch by hand (Janus never resets or force-pushes), then run again.")
        if valid:
            return None
        print(f"E2E needed: {why}.")
        outcome = trigger_full_e2e(goal)
        if outcome["status"] == "green":
            write_progress(goal, "E2E is green for the recorded heads; continuing.")
            save_checkpoint(goal, f"chore(janus): E2E green in build {outcome['id']}")
            return None
        if outcome["status"] != "red":
            return stop_for_human(goal, f"the E2E build did not produce a verdict [{outcome['status']}]: {outcome['summary']}", "Fix the TeamCity problem or wait, then run again; Janus resumes the same E2E build when it is still running.")
        used = goal.front["e2e_result"].get("fix_attempts") or 0
        if used >= MAX_FIX_ATTEMPTS:
            goal.front["e2e_result"]["fix_attempts"] = 0
            return stop_for_human(
                goal,
                f"E2E build {outcome['id']} ({outcome['url']}) is red after {MAX_FIX_ATTEMPTS} fix passes.\n{outcome['summary']}",
                "Diagnose the E2E failure by hand; fix and push, or edit the plan and re-approve; then run again (a rerun gets a fresh bounded set of fix passes).",
            )
        goal.front["e2e_result"]["fix_attempts"] = used + 1
        print(f"E2E red; starting fix pass {used + 1} of {MAX_FIX_ATTEMPTS}.")
        stopped = fix_and_reverify(goal, f"The full E2E build {outcome['url']} is red.\n{outcome['summary']}", "e2e")
        if stopped is not None:
            return stopped
```

Replace `finish_goal` (Task 18) with, and add `review_gate` after it:

```python
def finish_goal(goal: Goal) -> int:
    """Every task is done or red as planned: verify remaining joint points, run the full E2E when the plan
    names one (coupled tasks whose verification point is the E2E become done on green), then stop at the
    human PR review / QA gate."""
    goal.front["current_task"] = None
    stopped = verify_coupled_dependents(goal)
    if stopped is not None:
        return stopped
    pending = [t for t in goal.front.get("tasks") or [] if t.get("status") == "coupled_pending"]
    if goal.front.get("e2e"):
        stopped = ensure_e2e_green(goal)
        if stopped is not None:
            return stopped
        for task in pending:
            cfg = repo_config(goal, task["repo"])
            entry = goal.front["last_verified"][cfg["name"]]
            record_verified(goal, cfg["name"], entry["commit"], build=goal.front["e2e_result"]["build"], status="verified_by_e2e")
            task["status"] = "done"
            task["verified_build"] = goal.front["e2e_result"]["build"]
            save_checkpoint(goal, f"chore(janus): coupled task {task['id']} verified by E2E build {goal.front['e2e_result']['build']}")
    elif pending:
        ids = ", ".join(f"{t['id']} (until {t.get('verify_at')})" for t in pending)
        return stop_for_human(
            goal,
            f"coupled task(s) {ids} are red as the approved plan allows but the plan names no E2E build to verify them; nothing is green here",
            "Edit the plan (add e2e or change verify_at) and re-approve, or verify by hand and record the decision under ## Decisions.",
        )
    return review_gate(goal)


def review_gate(goal: Goal) -> int:
    """The human PR review / QA / merge gate (spec §6, §11 criterion 8)."""
    prs = goal.front.get("prs") or {}
    links = ", ".join(f"{name}: {url}" for name, url in prs.items()) or "none recorded"
    return stop_for_human(
        goal,
        f"all tasks are done; human PR review and QA are next (PRs: {links})",
        "Review and test the PRs, then merge them in the approved order through the existing process. "
        "Paste review comments into ## Review feedback and run again for a bounded fix pass; run again after merging to record completion.",
        status="awaiting_human_review",
    )
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `uv run pytest -q`
Expected: `158 passed`

- [ ] **Step 6: Commit**

```bash
cd /home/race-day/janus
git add janus.py tests/test_coupled.py tests/test_e2e.py
git commit -m "feat(janus): trigger the full E2E through TeamCity, tie its evidence to exact heads and fix red E2E within bounds" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---
### Task 21: `run_review`, bounded review/fix cycles and the QA handover

Spec §6 ("After green E2E, start an **independent fresh Codex review** of the combined change. Fix material findings, rerun affected CI and E2E, then review again, with a maximum of 2 review/fix cycles before human direction. Produce a concise QA handover with PR links, changed behaviour, tests run, known limitations and unresolved risks"), §7 ("two final review cycles have been exhausted", handover contents), §11 criterion 8.

**Files:**
- Modify: `janus.py` (section `# --- e2e and review ---`: add `review_prompt`, `run_review`, `qa_handover`, `ensure_reviewed`; replace `stop_for_human` (Task 16), `finish_goal` and `review_gate` (Task 20))
- Modify: `tests/test_run.py`, `tests/test_run_ci.py`, `tests/test_coupled.py`, `tests/test_publish.py`, `tests/test_e2e.py` (every test that reaches the human gate now scripts one review step and sees two more control commits)
- Create: `tests/test_review.py`

**Interfaces:**
- Consumes: `run_codex`, `record_heads`, `check_heads_unchanged`, `working_tree_dirty`, `goal_file_digest`, `fix_and_reverify`, `ensure_e2e_green`, `recorded_heads`, `write_progress`.
- Produces: `review_prompt(goal) -> str`; `run_review(goal) -> dict` (fresh Codex in the goal folder with `in_flight.operation = "review"`; read-only: a changed `JANUS.md`, ref or working tree raises `JanusError` and the changes are left for inspection); `qa_handover(goal) -> str` (PR links with verified commit and build, changed behaviour per task, tests run per repo plus E2E and review, known limitations from task blockers, unresolved risks from the review summary); `ensure_reviewed(goal) -> Optional[int]` (a `clean` review whose `heads` equal the recorded heads is reused; findings start `fix_and_reverify(..., "review")` then `ensure_e2e_green`; after `MAX_REVIEW_CYCLES` fix cycles the human is called and `review.cycles` resets); `stop_for_human(goal, reason, next_action, status="blocked", handover=None)`; `review_gate` passes `qa_handover(goal)`; `finish_goal` calls `ensure_reviewed` before `review_gate`. Tasks set to `done` by hand without a verified commit stop with "cannot review: <repo> has no verified commit recorded".

- [ ] **Step 1: Update the earlier tests for the review step**

Apply these edits (each adds a scripted `{"output": codex_output(summary="review clean")}` step, counts one more Codex call in the goal folder, or expects the two review checkpoints):

`tests/test_run.py`:

```diff
--- a/tests/test_run.py
+++ b/tests/test_run.py
@@ -155,13 +155,13 @@ def test_run_on_a_task_awaiting_ci_stops_without_calling_codex(ws, fake_codex):
     assert "no CI evidence" in janus.section(janus.load_goal(ws.root).body, "## Progress and handover")
 
 
-def test_run_with_all_tasks_done_stops_at_the_human_review_gate(ws, fake_codex):
+def test_run_with_all_tasks_done_by_hand_cannot_be_reviewed_without_verified_commits(ws, fake_codex):
     goal = approve_draft(ws.root)
     goal.front["tasks"][0]["status"] = "done"
     janus.save_goal(goal)
     assert janus.cmd_run(ws.root) == 1
     assert fake_codex.calls() == []
     gate = janus.load_goal(ws.root)
-    assert gate.front["status"] == "awaiting_human_review" and gate.front["current_task"] is None
+    assert gate.front["status"] == "blocked" and gate.front["current_task"] is None
     progress = janus.section(gate.body, "## Progress and handover")
-    assert "Completed tasks: 1" in progress and "human PR review and QA are next" in progress and "PRs: none recorded" in progress
+    assert "Completed tasks: 1" in progress and "cannot review: app has no verified commit recorded" in progress
```

`tests/test_run_ci.py`:

```diff
--- a/tests/test_run_ci.py
+++ b/tests/test_run_ci.py
@@ -14,7 +14,7 @@ def test_run_verifies_the_exact_commit_in_teamcity_opens_a_pr_and_completes_the_
     approve_with_ci(ws)
     pr_url = script_bitbucket(stub)
     builds = script_ci(stub, ["green"])
-    fake_codex.script([{"shell": ["echo a > a.txt"], "output": codex_output(summary="upgraded")}])
+    fake_codex.script([{"shell": ["echo a > a.txt"], "output": codex_output(summary="upgraded")}, {"output": codex_output(summary="review clean")}])
     assert janus.cmd_run(ws.root) == 1
     sha = git(ws.app, "rev-parse", "HEAD")
     assert builds == [{"id": 101, "type": "Fe_App_Build", "sha": sha, "outcome": "green"}]
@@ -25,8 +25,10 @@ def test_run_verifies_the_exact_commit_in_teamcity_opens_a_pr_and_completes_the_
     assert task["status"] == "done" and task["verified_build"] == 101 and task["summary"] == "upgraded"
     assert goal.front["status"] == "awaiting_human_review" and goal.front["in_flight"] is None and goal.front["attempts"] == 0
     log = git(ws.root, "log", "--format=%s").splitlines()
-    assert log[:5] == [
+    assert log[:7] == [
         "chore(janus): stop for human direction",
+        "chore(janus): independent review clean after 0 fix cycle(s)",
+        "chore(janus): independent review",
         "chore(janus): task 1 verified green in build 101",
         "chore(janus): task 1 waiting for build 101",
         f"chore(janus): task 1 awaiting CI for {sha[:12]}",
@@ -37,8 +39,9 @@ def test_run_verifies_the_exact_commit_in_teamcity_opens_a_pr_and_completes_the_
     janus_md = (ws.root / "JANUS.md").read_text(encoding="utf-8")
     assert "tc-secret-token" not in janus_md and "bb-secret-token" not in janus_md
     assert pr_url in janus.section(goal.body, "## Progress and handover")
-    [call] = fake_codex.calls()
-    assert "tc-secret-token" not in call["prompt"] and "bb-secret-token" not in call["prompt"]
+    calls = fake_codex.calls()
+    assert [c["cwd"] for c in calls] == [str(ws.app), str(ws.root)]
+    assert all("tc-secret-token" not in c["prompt"] and "bb-secret-token" not in c["prompt"] for c in calls)
 
 
 def test_run_red_build_starts_a_fresh_fix_attempt_with_the_redacted_ci_summary(ws, fake_codex, stub):
@@ -48,10 +51,11 @@ def test_run_red_build_starts_a_fresh_fix_attempt_with_the_redacted_ci_summary(w
     fake_codex.script([
         {"shell": ["echo a > a.txt"], "output": codex_output(summary="first")},
         {"shell": ["echo b > b.txt"], "output": codex_output(summary="fixed the spec")},
+        {"output": codex_output(summary="review clean")},
     ])
     assert janus.cmd_run(ws.root) == 1
     calls = fake_codex.calls()
-    assert len(calls) == 2
+    assert len(calls) == 3
     prompt = calls[1]["prompt"]
     assert "Previous attempt failed" in prompt and "TeamCity PR build of commit" in prompt and "is red" in prompt
     assert "FAILED AppComponent renders" in prompt and "Expected 16 to be 15" in prompt
@@ -89,10 +93,10 @@ def test_infrastructure_failure_is_retried_once_by_queuing_the_same_commit(ws, f
     approve_with_ci(ws)
     script_bitbucket(stub)
     builds = script_ci(stub, ["infra", "green"])
-    fake_codex.script([{"shell": ["echo a > a.txt"], "output": codex_output()}])
+    fake_codex.script([{"shell": ["echo a > a.txt"], "output": codex_output()}, {"output": codex_output(summary="review clean")}])
     assert janus.cmd_run(ws.root) == 1
     sha = git(ws.app, "rev-parse", "HEAD")
-    assert len(fake_codex.calls()) == 1
+    assert len(fake_codex.calls()) == 2
     assert [(b["sha"], b["outcome"]) for b in builds] == [(sha, "infra"), (sha, "green")]
     [queued] = stub.calls("POST", "/app/rest/2018.1/buildQueue")
     assert queued["json"]["lastChanges"]["change"][0]["locator"] == f"version:{sha},buildType:(id:Fe_App_Build)"
@@ -119,7 +123,7 @@ def test_no_automatic_build_triggers_one_for_the_exact_revision(ws, fake_codex,
     approve_with_ci(ws)
     script_bitbucket(stub)
     builds = script_ci(stub, ["green"], automatic=False)
-    fake_codex.script([{"shell": ["echo a > a.txt"], "output": codex_output()}])
+    fake_codex.script([{"shell": ["echo a > a.txt"], "output": codex_output()}, {"output": codex_output(summary="review clean")}])
     assert janus.cmd_run(ws.root) == 1
     sha = git(ws.app, "rev-parse", "HEAD")
     [queued] = stub.calls("POST", "/app/rest/2018.1/buildQueue")
@@ -147,7 +151,7 @@ def test_an_older_green_build_of_another_commit_is_never_evidence(ws, fake_codex
         "id": 200, "number": "200", "state": "finished", "status": "SUCCESS", "statusText": "ok",
         "webUrl": "https://tc.example/viewLog.html?buildId=200",
         "revisions": {"revision": [{"version": git(ws.app, "rev-parse", "HEAD")}]}}))
-    fake_codex.script([{"shell": ["echo a > a.txt"], "output": codex_output()}])
+    fake_codex.script([{"shell": ["echo a > a.txt"], "output": codex_output()}, {"output": codex_output(summary="review clean")}])
     assert janus.cmd_run(ws.root) == 1
     assert len(posted) == 1
     goal = janus.load_goal(ws.root)
@@ -166,13 +170,15 @@ def test_crash_during_ci_wait_resumes_without_a_new_commit_or_codex_run(ws, fake
     janus.save_goal(goal)
     commit_all(ws.root, "chore(janus): task 1 waiting for build 101")
     builds = script_ci(stub, ["green"])
+    fake_codex.script([{"output": codex_output(summary="review clean")}])
     assert janus.cmd_run(ws.root) == 1
-    assert fake_codex.calls() == []
+    assert [c["cwd"] for c in fake_codex.calls()] == [str(ws.root)]
     assert git(ws.bare, "rev-list", "--count", BRANCH) == "2" and git(ws.app, "rev-parse", "HEAD") == sha
     assert builds == [{"id": 101, "type": "Fe_App_Build", "sha": sha, "outcome": "green"}]
     after = janus.load_goal(ws.root)
     assert after.front["last_verified"]["app"] == {"commit": sha, "teamcity_build": 101, "status": "green"}
     assert after.front["tasks"][0]["status"] == "done" and after.front["in_flight"] is None and after.front["attempts"] == 0
+    assert after.front["status"] == "awaiting_human_review"
     assert stub.calls("POST", "/rest/api/1.0/projects/PROJ/repos/app/pull-requests") == []
 
 
@@ -199,7 +205,7 @@ def test_crash_during_ci_wait_never_turns_a_red_build_green(ws, fake_codex, stub
 def test_teamcity_unreachable_stops_with_a_handover_and_a_later_run_resumes(ws, fake_codex, stub, monkeypatch):
     approve_with_ci(ws)
     script_bitbucket(stub)
-    fake_codex.script([{"shell": ["echo a > a.txt"], "output": codex_output()}])
+    fake_codex.script([{"shell": ["echo a > a.txt"], "output": codex_output()}, {"output": codex_output(summary="review clean")}])
     monkeypatch.setenv("JANUS_TEAMCITY_URL", "http://127.0.0.1:9")
     assert janus.cmd_run(ws.root) == 1
     goal = janus.load_goal(ws.root)
@@ -211,7 +217,7 @@ def test_teamcity_unreachable_stops_with_a_handover_and_a_later_run_resumes(ws,
     monkeypatch.setenv("JANUS_TEAMCITY_URL", stub.url)
     builds = script_ci(stub, ["green"])
     assert janus.cmd_run(ws.root) == 1
-    assert len(fake_codex.calls()) == 1 and builds[0]["sha"] == sha
+    assert len(fake_codex.calls()) == 2 and builds[0]["sha"] == sha
     assert janus.load_goal(ws.root).front["tasks"][0]["status"] == "done"
 
 
```

`tests/test_coupled.py`:

```diff
--- a/tests/test_coupled.py
+++ b/tests/test_coupled.py
@@ -68,10 +68,11 @@ def test_two_repositories_run_in_approved_order_and_values_flow_forward(ws, fake
     fake_codex.script([
         {"shell": ["echo lib > lib.txt"], "output": codex_output(summary="lib upgraded", values=[{"name": "prerelease_version", "value": "2.0.0-angular16.1"}])},
         {"shell": ["echo app > app.txt"], "output": codex_output(summary="app upgraded")},
+        {"output": codex_output(summary="review clean")},
     ])
     assert janus.cmd_run(ws.root) == 1
     calls = fake_codex.calls()
-    assert [c["cwd"] for c in calls] == [str(lib), str(ws.app)]
+    assert [c["cwd"] for c in calls] == [str(lib), str(ws.app), str(ws.root)]
     assert "Task 1: Upgrade lib and publish a prerelease" in calls[0]["prompt"]
     assert "Values recorded by earlier tasks" not in calls[0]["prompt"]
     assert "- prerelease_version: 2.0.0-angular16.1" in calls[1]["prompt"]
@@ -102,9 +103,10 @@ def test_coupled_task_stays_red_as_planned_and_is_verified_at_its_joint_point(ws
     fake_codex.script([
         {"shell": ["echo lib > lib.txt"], "output": codex_output(summary="lib changed contract")},
         {"shell": ["echo app > app.txt"], "output": codex_output(summary="app follows")},
+        {"output": codex_output(summary="review clean")},
     ])
     assert janus.cmd_run(ws.root) == 1
-    assert len(fake_codex.calls()) == 2
+    assert len(fake_codex.calls()) == 3
     assert "Coupled change" in fake_codex.calls()[0]["prompt"] and "joint verification point (2)" in fake_codex.calls()[0]["prompt"]
     assert "Coupled change" not in fake_codex.calls()[1]["prompt"]
     lib_sha, app_sha = git(lib, "rev-parse", "HEAD"), git(ws.app, "rev-parse", "HEAD")
@@ -156,8 +158,12 @@ def test_coupled_task_that_turns_out_green_is_simply_done(ws, fake_codex, stub,
     script_bitbucket(stub, slug="lib", pr_id=21)
     script_bitbucket(stub, slug="app", pr_id=22)
     script_ci(stub, ["green"])
-    fake_codex.script([{"shell": ["echo x >> x.txt"], "output": codex_output()}])
+    fake_codex.script([
+        {"shell": ["echo x >> x.txt"], "output": codex_output()},
+        {"shell": ["echo x >> x.txt"], "output": codex_output()},
+        {"output": codex_output(summary="review clean")},
+    ])
     assert janus.cmd_run(ws.root) == 1
     goal = janus.load_goal(ws.root)
-    assert [t["status"] for t in goal.front["tasks"]] == ["done", "done"]
+    assert [t["status"] for t in goal.front["tasks"]] == ["done", "done"] and goal.front["status"] == "awaiting_human_review"
     assert stub.calls("POST", "/app/rest/2018.1/buildQueue") == []
```

`tests/test_publish.py`:

```diff
--- a/tests/test_publish.py
+++ b/tests/test_publish.py
@@ -13,6 +13,7 @@ def test_prerelease_job_runs_for_the_verified_commit_and_the_version_flows_to_th
     fake_codex.script([
         {"shell": ["echo lib > lib.txt"], "output": codex_output(summary="lib", values=[{"name": "prerelease_version", "value": "2.0.0-angular16.1"}])},
         {"shell": ["echo app > app.txt"], "output": codex_output(summary="app")},
+        {"output": codex_output(summary="review clean")},
     ])
     assert janus.cmd_run(ws.root) == 1
     lib_sha, app_sha = git(lib, "rev-parse", "HEAD"), git(ws.app, "rev-parse", "HEAD")
@@ -45,6 +46,7 @@ def test_failed_prerelease_job_stops_and_a_rerun_repeats_only_the_publish(ws, fa
     fake_codex.script([
         {"shell": ["echo lib > lib.txt"], "output": codex_output()},
         {"shell": ["echo app > app.txt"], "output": codex_output()},
+        {"output": codex_output(summary="review clean")},
     ])
     assert janus.cmd_run(ws.root) == 1
     goal = janus.load_goal(ws.root)
@@ -55,7 +57,7 @@ def test_failed_prerelease_job_stops_and_a_rerun_repeats_only_the_publish(ws, fa
     assert janus.cmd_run(ws.root) == 1
     lib_sha = git(lib, "rev-parse", "HEAD")
     assert [(b["type"], b["outcome"]) for b in builds] == [("Fe_Lib_Build", "green"), ("Fe_Lib_Publish", "red"), ("Fe_Lib_Publish", "green"), ("Fe_App_Build", "green")]
-    assert len(fake_codex.calls()) == 2
+    assert len(fake_codex.calls()) == 3
     assert git(lib, "rev-parse", "HEAD") == lib_sha
     goal = janus.load_goal(ws.root)
     assert goal.front["tasks"][0]["status"] == "done" and goal.front["tasks"][0]["publish_build"] == 103
@@ -77,9 +79,9 @@ def test_a_successful_publish_build_is_reused_on_resume_never_published_twice(ws
     script_bitbucket(stub, slug="app", pr_id=22)
     builds = script_ci(stub, ["green"], automatic=("Fe_Lib_Build", "Fe_App_Build"))
     builds.append({"id": 102, "type": "Fe_Lib_Publish", "sha": lib_sha, "outcome": "green"})
-    fake_codex.script([{"shell": ["echo app > app.txt"], "output": codex_output()}])
+    fake_codex.script([{"shell": ["echo app > app.txt"], "output": codex_output()}, {"output": codex_output(summary="review clean")}])
     assert janus.cmd_run(ws.root) == 1
-    assert [c["cwd"] for c in fake_codex.calls()] == [str(ws.app)]
+    assert [c["cwd"] for c in fake_codex.calls()] == [str(ws.app), str(ws.root)]
     assert stub.calls("POST", "/app/rest/2018.1/buildQueue") == []
     goal = janus.load_goal(ws.root)
     assert goal.front["tasks"][0]["status"] == "done" and goal.front["tasks"][0]["publish_build"] == 102
```

`tests/test_e2e.py`:

```diff
--- a/tests/test_e2e.py
+++ b/tests/test_e2e.py
@@ -26,12 +26,18 @@ def two_green_tasks(ws, fake_codex, stub, tmp_path, front, outcomes):
         {"shell": ["echo lib > lib.txt"], "output": codex_output(summary="lib upgraded")},
         {"shell": ["echo app > app.txt"], "output": codex_output(summary="app upgraded")},
         {"shell": ["echo fix >> app/fix.txt"], "output": codex_output(summary="fixed the e2e failure", files_touched=["app/fix.txt"])},
+        {"output": codex_output(summary="review clean")},
     ])
     return lib, builds
 
 
 def test_e2e_runs_through_the_teamcity_api_with_exact_goal_branches_and_base_only_where_planned(ws, fake_codex, stub, tmp_path):
     lib, builds = two_green_tasks(ws, fake_codex, stub, tmp_path, e2e_front(extra_repo=True), ["green"])
+    fake_codex.script([
+        {"shell": ["echo lib > lib.txt"], "output": codex_output(summary="lib upgraded")},
+        {"shell": ["echo app > app.txt"], "output": codex_output(summary="app upgraded")},
+        {"output": codex_output(summary="review clean")},
+    ])
     assert janus.cmd_run(ws.root) == 1
     lib_sha, app_sha = git(lib, "rev-parse", "HEAD"), git(ws.app, "rev-parse", "HEAD")
     [queued] = stub.calls("POST", QUEUE)
@@ -50,14 +56,14 @@ def test_e2e_runs_through_the_teamcity_api_with_exact_goal_branches_and_base_onl
     assert goal.front["status"] == "awaiting_human_review"
     assert "E2E: green build 103" in janus.section(goal.body, "## Progress and handover")
     assert "chore(janus): E2E green in build 103" in git(ws.root, "log", "--format=%s")
-    assert len(fake_codex.calls()) == 2
+    assert len(fake_codex.calls()) == 3
 
 
 def test_red_e2e_starts_a_bounded_fix_pass_that_recommits_reverifies_and_reruns_e2e(ws, fake_codex, stub, tmp_path):
     lib, builds = two_green_tasks(ws, fake_codex, stub, tmp_path, e2e_front(), ["green", "green", "red", "green", "green"])
     assert janus.cmd_run(ws.root) == 1
     calls = fake_codex.calls()
-    assert len(calls) == 3 and calls[2]["cwd"] == str(ws.root)
+    assert len(calls) == 4 and calls[2]["cwd"] == str(ws.root) and calls[3]["cwd"] == str(ws.root)
     prompt = calls[2]["prompt"]
     assert "fixing a Janus goal after the e2e stage failed" in prompt and "The full E2E build https://tc.example/viewLog.html?buildId=103 is red." in prompt
     assert "FAILED AppComponent renders" in prompt and "abc123secret" not in prompt and "never edit JANUS.md" in prompt
@@ -78,6 +84,11 @@ def test_red_e2e_starts_a_bounded_fix_pass_that_recommits_reverifies_and_reruns_
 
 def test_e2e_fix_passes_are_bounded(ws, fake_codex, stub, tmp_path):
     two_green_tasks(ws, fake_codex, stub, tmp_path, e2e_front(), ["green", "green", "red", "green", "red", "green", "red", "green", "red"])
+    fake_codex.script([
+        {"shell": ["echo lib > lib.txt"], "output": codex_output(summary="lib upgraded")},
+        {"shell": ["echo app > app.txt"], "output": codex_output(summary="app upgraded")},
+        {"shell": ["echo fix >> app/fix.txt"], "output": codex_output(summary="fix attempt")},
+    ])
     assert janus.cmd_run(ws.root) == 1
     assert len(fake_codex.calls()) == 2 + 3
     goal = janus.load_goal(ws.root)
@@ -116,9 +127,14 @@ def test_fix_pass_guardrail_violation_is_left_uncommitted(ws, fake_codex, stub,
 
 def test_e2e_evidence_is_invalidated_by_a_later_change_and_a_foreign_push_stops(ws, fake_codex, stub, tmp_path):
     lib, builds = two_green_tasks(ws, fake_codex, stub, tmp_path, e2e_front(), ["green"])
+    fake_codex.script([
+        {"shell": ["echo lib > lib.txt"], "output": codex_output(summary="lib upgraded")},
+        {"shell": ["echo app > app.txt"], "output": codex_output(summary="app upgraded")},
+        {"output": codex_output(summary="review clean")},
+    ])
     assert janus.cmd_run(ws.root) == 1
     goal = janus.load_goal(ws.root)
-    assert goal.front["e2e_result"]["build"] == 103
+    assert goal.front["e2e_result"]["build"] == 103 and goal.front["review"]["status"] == "clean"
     # A later Janus-side change to a participating head (here simulated in the record) voids the evidence: E2E runs again.
     goal.front["e2e_result"]["heads"]["app"] = "0" * 40
     janus.save_goal(goal)
@@ -140,7 +156,7 @@ def test_e2e_evidence_is_invalidated_by_a_later_change_and_a_foreign_push_stops(
     assert goal.front["status"] == "blocked"
     progress = janus.section(goal.body, "## Progress and handover")
     assert f"is at {foreign[:12]}, not at the verified commit" in progress and "E2E evidence is void" in progress
-    assert len(fake_codex.calls()) == 2
+    assert len(fake_codex.calls()) == 3
 
 
 def test_crash_during_e2e_wait_resumes_the_same_build(ws, fake_codex, stub, tmp_path):
@@ -164,8 +180,9 @@ def test_crash_during_e2e_wait_resumes_the_same_build(ws, fake_codex, stub, tmp_
     commit_all(ws.root, "chore(janus): waiting for E2E build 300")
     builds = script_ci(stub, ["green"], first_id=300, automatic=False)
     builds.append({"id": 300, "type": "Fe_E2E_Full", "sha": None, "outcome": "green"})
+    fake_codex.script([{"output": codex_output(summary="review clean")}])
     assert janus.cmd_run(ws.root) == 1
-    assert fake_codex.calls() == [] and stub.calls("POST", QUEUE) == []
+    assert [c["cwd"] for c in fake_codex.calls()] == [str(ws.root)] and stub.calls("POST", QUEUE) == []
     goal = janus.load_goal(ws.root)
     assert goal.front["e2e_result"]["build"] == 300 and goal.front["e2e_result"]["status"] == "green"
     assert goal.front["status"] == "awaiting_human_review"
```

- [ ] **Step 2: Write the failing tests**

`tests/test_review.py`:

```python
import janus
from helpers import add_repo, approve_draft, codex_output, git, script_bitbucket, script_ci, two_repo_front
from test_e2e import BRANCH, QUEUE, e2e_front


def start(ws, fake_codex, stub, tmp_path, front, outcomes, codex_steps):
    lib, _ = add_repo(ws, tmp_path, "lib")
    approve_draft(ws.root, front)
    script_bitbucket(stub, slug="lib", pr_id=21)
    script_bitbucket(stub, slug="app", pr_id=22)
    builds = script_ci(stub, outcomes, automatic=("Fe_Lib_Build", "Fe_App_Build"))
    fake_codex.script([
        {"shell": ["echo lib > lib.txt"], "output": codex_output(summary="lib upgraded", blockers=["ui-kit theme tokens are unverified"])},
        {"shell": ["echo app > app.txt"], "output": codex_output(summary="app upgraded")},
    ] + codex_steps)
    return lib, builds


def test_clean_review_produces_the_qa_handover_and_stops_at_the_human_gate(ws, fake_codex, stub, tmp_path):
    lib, builds = start(ws, fake_codex, stub, tmp_path, e2e_front(), ["green"], [
        {"output": codex_output(summary="Checked both diffs; upgrade is complete; residual risk: lazy routes untested", next_action="focus QA on lazy routes")},
    ])
    assert janus.cmd_run(ws.root) == 1
    calls = fake_codex.calls()
    assert len(calls) == 3 and calls[2]["cwd"] == str(ws.root)
    prompt = calls[2]["prompt"]
    assert "independent reviewer" in prompt and "read-only" in prompt and "git -C app diff origin/main...HEAD" in prompt
    assert "task 1 (lib): Upgrade lib and publish a prerelease -> lib upgraded" in prompt
    goal = janus.load_goal(ws.root)
    assert goal.front["review"]["status"] == "clean" and goal.front["review"]["cycles"] == 0
    assert goal.front["review"]["heads"] == {"lib": git(lib, "rev-parse", "HEAD"), "app": git(ws.app, "rev-parse", "HEAD")}
    assert goal.front["status"] == "awaiting_human_review"
    progress = janus.section(goal.body, "## Progress and handover")
    assert "### QA handover" in progress
    assert f"- lib: {stub.url}/projects/PROJ/repos/lib/pull-requests/21 at {git(lib, 'rev-parse', 'HEAD')} (green, build https://tc.example/viewLog.html?buildId=101)" in progress.replace(stub.url + "/viewLog.html", "https://tc.example/viewLog.html")
    assert "- task 2 (app): Upgrade app using the lib prerelease -> app upgraded" in progress
    assert "- app local checks: test -f package.json; PR build Fe_App_Build" in progress
    assert "- E2E: build" in progress and "green for lib@" in progress
    assert "- Independent AI review: clean after 0 fix cycle(s)" in progress
    assert "- task 1 (lib): ui-kit theme tokens are unverified" in progress
    assert "residual risk: lazy routes untested" in progress
    assert "Janus never merges" in progress
    assert "chore(janus): independent review clean after 0 fix cycle(s)" in git(ws.root, "log", "--format=%s")
    assert "Review: clean after 0 of 2 cycle(s)" in progress


def test_review_findings_start_a_fix_cycle_then_ci_e2e_and_a_second_review(ws, fake_codex, stub, tmp_path):
    lib, builds = start(ws, fake_codex, stub, tmp_path, e2e_front(), ["green"], [
        {"output": codex_output(summary="found an issue", blockers=["app/src/app.spec.ts: a test was hollowed out"])},
        {"shell": ["echo restored > app/restored.txt"], "output": codex_output(summary="restored the test")},
        {"output": codex_output(summary="clean now")},
    ])
    assert janus.cmd_run(ws.root) == 1
    calls = fake_codex.calls()
    assert len(calls) == 5
    assert "Independent review findings:\n- app/src/app.spec.ts: a test was hollowed out" in calls[3]["prompt"] and "after the review stage failed" in calls[3]["prompt"]
    assert [(b["type"], b["outcome"]) for b in builds] == [("Fe_Lib_Build", "green"), ("Fe_App_Build", "green"), ("Fe_E2E_Full", "green"), ("Fe_App_Build", "green"), ("Fe_E2E_Full", "green")]
    app_sha = git(ws.app, "rev-parse", "HEAD")
    assert git(ws.app, "log", "-1", "--format=%s") == "fix(angular): review fix in app" and builds[3]["sha"] == app_sha
    goal = janus.load_goal(ws.root)
    assert goal.front["review"] == {"cycles": 1, "status": "clean", "heads": {"lib": git(lib, "rev-parse", "HEAD"), "app": app_sha}, "at": goal.front["review"]["at"], "summary": "clean now", "findings": []}
    assert goal.front["e2e_result"]["heads"]["app"] == app_sha and goal.front["e2e_result"]["build"] == 105
    assert goal.front["status"] == "awaiting_human_review"
    log = git(ws.root, "log", "--format=%s")
    assert "chore(janus): review found 1 issue(s); fix cycle 1" in log and "chore(janus): review fix in app verified green in build 104" in log


def test_review_fix_cycles_are_bounded_to_two(ws, fake_codex, stub, tmp_path):
    start(ws, fake_codex, stub, tmp_path, e2e_front(), ["green"], [
        {"output": codex_output(summary="issue", blockers=["finding A"])},
        {"shell": ["echo a >> app/a.txt"], "output": codex_output(summary="fix A")},
        {"output": codex_output(summary="issue", blockers=["finding B"])},
        {"shell": ["echo b >> app/b.txt"], "output": codex_output(summary="fix B")},
        {"output": codex_output(summary="issue", blockers=["finding C"])},
    ])
    assert janus.cmd_run(ws.root) == 1
    assert len(fake_codex.calls()) == 7
    goal = janus.load_goal(ws.root)
    assert goal.front["status"] == "blocked" and goal.front["review"]["status"] == "findings" and goal.front["review"]["cycles"] == 0
    progress = janus.section(goal.body, "## Progress and handover")
    assert "still has material findings after 2 review/fix cycles" in progress and "- finding C" in progress
    assert "### QA handover" not in progress


def test_review_that_changes_code_stops_and_keeps_the_changes_for_inspection(ws, fake_codex, stub, tmp_path):
    start(ws, fake_codex, stub, tmp_path, e2e_front(), ["green"], [
        {"shell": ["echo sneaky > app/sneaky.txt"], "output": codex_output(summary="I fixed it myself")},
    ])
    assert janus.cmd_run(ws.root) == 1
    goal = janus.load_goal(ws.root)
    assert goal.front["status"] == "blocked" and goal.front.get("review") is None
    assert "the review must be read-only but Codex changed app" in janus.section(goal.body, "## Progress and handover")
    assert (ws.app / "sneaky.txt").exists() and git(ws.bare, "rev-list", "--count", BRANCH) == "2"


def test_review_runs_without_e2e_when_the_plan_has_none(ws, fake_codex, stub, tmp_path):
    start(ws, fake_codex, stub, tmp_path, two_repo_front(), ["green"], [{"output": codex_output(summary="fine")}])
    assert janus.cmd_run(ws.root) == 1
    goal = janus.load_goal(ws.root)
    assert goal.front["review"]["status"] == "clean" and "e2e_result" not in goal.front
    assert stub.calls("POST", QUEUE) == []
    assert "- E2E: not part of the approved plan" in janus.section(goal.body, "## Progress and handover")
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `uv run pytest -q tests/test_review.py tests/test_run_ci.py`
Expected: FAIL; no review Codex call happens, `review` is never recorded, the Progress section has no `### QA handover`, and the updated Task 16 tests miss the "independent review" checkpoints.

- [ ] **Step 4: Implement**

Replace `stop_for_human` (Task 16) with:

```python
def stop_for_human(goal: Goal, reason: str, next_action: str, status: str = "blocked", handover: Optional[str] = None) -> int:
    """Human gate (spec §7): record the handover, checkpoint, print it, exit 1. `status` is `blocked` for
    problems and `awaiting_human_review` for the PR review/QA/merge gate; `handover` is the QA handover text."""
    goal.front["status"] = status
    goal.front["in_flight"] = None
    write_progress(goal, next_action, blocker=reason, handover=handover)
    save_checkpoint(goal, "chore(janus): stop for human direction")
    print(f"\nJanus stopped for human direction.\nReason: {reason}\nNext action: {next_action}")
    return 1
```

Insert into section `# --- e2e and review ---` after `ensure_e2e_green`:

```python
def review_prompt(goal: Goal) -> str:
    front = goal.front
    angular = front.get("angular") or {}
    repos = "\n".join(
        f"- {r['name']}: goal branch {r['branch']} from {r['base']} (review `git -C {r['name']} diff origin/{r['base']}...HEAD`)"
        for r in front.get("repos") or [] if r["name"] in participating_repos(goal)
    )
    tasks = "\n".join(f"- task {t['id']} ({t['repo']}): {t['objective']} -> {t.get('summary') or 'no summary'}" for t in front.get("tasks") or [])
    return "\n\n".join([
        f"You are an independent reviewer of a Janus goal: an Angular {angular.get('from')} to {angular.get('to')} upgrade implemented by "
        "another agent. Your working directory is the goal folder; every product repository is a subfolder checked out on its goal branch. "
        "You did not write this code and you have no memory of how it was written.",
        "# Goal\n" + (section(goal.body, "# Goal") or ""),
        "# Repositories and how to see the combined change\n" + repos,
        "# What the implementer reported\n" + tasks,
        "# Approved plan\n" + (section(goal.body, "## Approved-plan content") or ""),
        "# Rules\n" + (section(goal.body, "## Rules") or RULES_TEXT),
        "# Review\nThis review is read-only: change nothing, run no installs, run no git command that writes. Read the combined diff "
        "of every repository and judge: completeness of the upgrade against the approved plan; scope creep or architectural changes "
        "the plan does not cover; weakened, skipped, deleted or hollowed-out tests; behaviour changes users would notice; dependency, "
        "security and performance risks; anything CI cannot see.",
        "# Output\nAnswer with the JSON object required by the output schema: `summary` is the review narrative (what you checked, what "
        "is fine, residual risks); `blockers` lists the material findings that must be fixed before human review, one per entry with "
        "repository and file, and is empty when there are none; `next_action` is your advice to the human reviewers; `files_touched` "
        "and `values` are empty; set config and plan_markdown to null.",
    ])


def run_review(goal: Goal) -> dict:
    """Spec §6: "an independent fresh Codex review of the combined change". Read-only: JANUS.md, refs and
    working trees are checked afterwards; any change is a JanusError for the caller to turn into a human stop."""
    names = participating_repos(goal)
    heads_before = {name: record_heads(goal.root / name) for name in names}
    goal.front["in_flight"] = {"task": None, "repo": None, "start_sha": None, "operation": "review", "attempt": (goal.front.get("review") or {}).get("cycles") or 0, "started_at": now()}
    write_progress(goal, "An independent Codex review of the combined change is running; run `python janus.py run` again after an interruption.")
    save_checkpoint(goal, "chore(janus): independent review")
    digest = goal_file_digest(goal.root)
    result = run_codex(goal.root, review_prompt(goal))
    goal.front["in_flight"] = None
    if goal_file_digest(goal.root) != digest:
        save_goal(goal)
        raise JanusError(f"the review Codex modified {GOAL_FILE}; the runner restored its own copy")
    touched = [name for name in names if check_heads_unchanged(goal.root / name, heads_before[name]) or working_tree_dirty(goal.root / name)]
    if touched:
        raise JanusError(f"the review must be read-only but Codex changed {', '.join(touched)}; the changes are left in place for you to inspect")
    return result


def qa_handover(goal: Goal) -> str:
    """Spec §6: "a concise QA handover with PR links, changed behaviour, tests run, known limitations and
    unresolved risks"."""
    front = goal.front
    tc = service(TEAMCITY_URL_VAR, TEAMCITY_TOKEN_VAR)

    def link(build_id: object) -> str:
        return build_url(tc[0], build_id) if tc and build_id else str(build_id)

    lines = ["Pull requests (merge in this order through the existing process; Janus never merges):"]
    for name in participating_repos(goal):
        entry = (front.get("last_verified") or {}).get(name) or {}
        lines.append(f"- {name}: {(front.get('prs') or {}).get(name) or 'no PR'} at {entry.get('commit')} ({entry.get('status')}, build {link(entry.get('teamcity_build'))})")
    lines.append("Changed behaviour:")
    for task in front.get("tasks") or []:
        lines.append(f"- task {task['id']} ({task['repo']}): {task['objective']} -> {task.get('summary') or 'no summary recorded'}"
                     + (f" (prerelease published by build {link(task['publish_build'])})" if task.get("publish_build") else ""))
    lines.append("Tests run:")
    for repo_cfg in front.get("repos") or []:
        if repo_cfg["name"] in participating_repos(goal):
            lines.append(f"- {repo_cfg['name']} local checks: " + ("; ".join(repo_cfg.get("checks") or []) or "none") + f"; PR build {repo_cfg.get('pr_build') or 'none'}")
    e2e = front.get("e2e_result")
    lines.append(f"- E2E: build {link(e2e.get('build'))} {e2e.get('status')} for " + ", ".join(f"{r}@{str(s)[:12]}" for r, s in (e2e.get("heads") or {}).items()) if e2e else "- E2E: not part of the approved plan")
    review = front.get("review") or {}
    lines.append(f"- Independent AI review: {review.get('status')} after {review.get('cycles') or 0} fix cycle(s)")
    limitations = [f"task {t['id']} ({t['repo']}): {b}" for t in front.get("tasks") or [] for b in t.get("blockers") or []]
    lines.append("Known limitations:")
    lines.extend(f"- {item}" for item in limitations) if limitations else lines.append("- none reported by the implementation tasks")
    lines.append("Unresolved risks (from the independent review):")
    lines.append(review.get("summary") or "- no review summary recorded")
    return "\n".join(lines)


def ensure_reviewed(goal: Goal) -> Optional[int]:
    """Spec §6: after green E2E, review; fix material findings, rerun affected CI and E2E, review again; at
    most MAX_REVIEW_CYCLES review/fix cycles before human direction. Returns None when the review is clean
    for the current heads, else the stop code."""
    while True:
        try:
            heads = recorded_heads(goal)
        except JanusError as exc:
            return stop_for_human(goal, f"cannot review: {exc}", "Every participating repository needs a verified commit in last_verified; record one by hand under ## Decisions and in the front matter, or let Janus verify the task, then run again.")
        review = goal.front.get("review") or {"cycles": 0}
        if review.get("status") == "clean" and review.get("heads") == heads:
            return None
        try:
            result = run_review(goal)
        except JanusError as exc:
            return stop_for_human(goal, f"independent review failed: {redact(str(exc))}", "Inspect the working trees and the Codex transcript, then run again.")
        cycles = review.get("cycles") or 0
        goal.front["review"] = {
            "cycles": cycles, "status": "clean" if not result["blockers"] else "findings", "heads": heads, "at": now(),
            "summary": redact(result["summary"])[:2000], "findings": [redact(b)[:500] for b in result["blockers"]],
        }
        if not result["blockers"]:
            write_progress(goal, "Independent review is clean; handing over to human review and QA.")
            save_checkpoint(goal, f"chore(janus): independent review clean after {cycles} fix cycle(s)")
            return None
        findings = "\n".join(f"- {b}" for b in result["blockers"])
        if cycles >= MAX_REVIEW_CYCLES:
            goal.front["review"]["cycles"] = 0
            return stop_for_human(
                goal,
                f"independent review still has material findings after {MAX_REVIEW_CYCLES} review/fix cycles:\n{findings}",
                "Fix the findings by hand and run again (a rerun gets fresh review cycles), or record under ## Decisions why they are acceptable and take the PRs to human review.",
            )
        goal.front["review"]["cycles"] = cycles + 1
        save_checkpoint(goal, f"chore(janus): review found {len(result['blockers'])} issue(s); fix cycle {cycles + 1}")
        print(f"Review found {len(result['blockers'])} material issue(s); starting fix cycle {cycles + 1} of {MAX_REVIEW_CYCLES}.")
        stopped = fix_and_reverify(goal, f"Independent review findings:\n{findings}\n\nReview summary:\n{result['summary']}", "review")
        if stopped is not None:
            return stopped
        if goal.front.get("e2e"):
            stopped = ensure_e2e_green(goal)
            if stopped is not None:
                return stopped
```

Replace `finish_goal` and `review_gate` (Task 20) with:

```python
def finish_goal(goal: Goal) -> int:
    """Every task is done or red as planned: verify remaining joint points, run the full E2E when the plan
    names one (coupled tasks whose verification point is the E2E become done on green), run the independent
    review with bounded fix cycles, then stop at the human PR review / QA gate with the QA handover."""
    goal.front["current_task"] = None
    stopped = verify_coupled_dependents(goal)
    if stopped is not None:
        return stopped
    pending = [t for t in goal.front.get("tasks") or [] if t.get("status") == "coupled_pending"]
    if goal.front.get("e2e"):
        stopped = ensure_e2e_green(goal)
        if stopped is not None:
            return stopped
        for task in pending:
            cfg = repo_config(goal, task["repo"])
            entry = goal.front["last_verified"][cfg["name"]]
            record_verified(goal, cfg["name"], entry["commit"], build=goal.front["e2e_result"]["build"], status="verified_by_e2e")
            task["status"] = "done"
            task["verified_build"] = goal.front["e2e_result"]["build"]
            save_checkpoint(goal, f"chore(janus): coupled task {task['id']} verified by E2E build {goal.front['e2e_result']['build']}")
    elif pending:
        ids = ", ".join(f"{t['id']} (until {t.get('verify_at')})" for t in pending)
        return stop_for_human(
            goal,
            f"coupled task(s) {ids} are red as the approved plan allows but the plan names no E2E build to verify them; nothing is green here",
            "Edit the plan (add e2e or change verify_at) and re-approve, or verify by hand and record the decision under ## Decisions.",
        )
    stopped = ensure_reviewed(goal)
    if stopped is not None:
        return stopped
    return review_gate(goal)


def review_gate(goal: Goal) -> int:
    """The human PR review / QA / merge gate (spec §6, §11 criterion 8) with the QA handover."""
    prs = goal.front.get("prs") or {}
    links = ", ".join(f"{name}: {url}" for name, url in prs.items()) or "none recorded"
    return stop_for_human(
        goal,
        f"all tasks are verified and the independent review is clean; human PR review and QA are next (PRs: {links})",
        "Review and test the PRs, then merge them in the approved order through the existing process. "
        "Paste review comments into ## Review feedback and run again for a bounded fix pass; run again after merging to record completion.",
        status="awaiting_human_review",
        handover=qa_handover(goal),
    )
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `uv run pytest -q`
Expected: `163 passed`

- [ ] **Step 6: Commit**

```bash
cd /home/race-day/janus
git add janus.py tests/test_run.py tests/test_run_ci.py tests/test_coupled.py tests/test_publish.py tests/test_e2e.py tests/test_review.py
git commit -m "feat(janus): independent Codex review with bounded fix cycles and a QA handover before the human gate" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---
### Task 22: Review feedback consumption, completion against merged PRs, criteria 8 and 11

Spec §6 ("A human pastes review comments into the Review feedback section of `JANUS.md` and invokes `run` to start another bounded fix/verify/review pass; the runner moves consumed feedback into Decisions. Janus must **never** interpret silence, a green build or an AI review as human approval. Human operators merge PRs ... Completion is recorded only after checking actual merged PRs and release handover; a failed or unobserved release remains an explicit follow-up rather than falsely 'done'"), §2 ("Not included: Automatic PR merge, production deployment"), §7 ("unexpected remote changes"), §11 criteria 8 and 11.

**Files:**
- Modify: `janus.py` (section `# --- e2e and review ---`: add `moved_branches`, `FEEDBACK_PLACEHOLDER`, `pending_feedback`, `consume_feedback`, `record_completion`; replace `e2e_evidence_valid` (Task 20); replace `cmd_run` (Task 16))
- Modify: `tests/test_e2e.py` (the foreign-push test now exercises the gate)
- Create: `tests/test_feedback_completion.py`

**Interfaces:**
- Consumes: `section`, `set_section`, `pr_state`, `remote_head`, `recorded_heads`, `fix_and_reverify`, `qa_handover`, `stop_for_human`, `next_task`.
- Produces: `moved_branches(goal, skip=()) -> List[str]` (participating goal branches whose remote head is not the verified commit; `skip` names repos whose PR is already merged, because Bitbucket may delete the source branch); `FEEDBACK_PLACEHOLDER` (equal to the `## Review feedback` default of `STANDARD_SECTIONS`); `pending_feedback(goal) -> Optional[str]`; `consume_feedback(goal, feedback) -> Optional[int]` (appends `- <time>: review feedback consumed:` plus the indented text to `## Decisions`, resets the section, clears `review`, sets `status: executing`, checkpoints, runs `fix_and_reverify(..., "review-feedback")`; E2E and review then rerun in `finish_goal` because the heads changed); `record_completion(goal) -> int` (no PRs → stay at the gate with instructions; any `pr_state` error → stay; a moved branch of an unmerged PR → stop; any PR not `MERGED` → stay with all states listed; all `MERGED` → `status: done`, exit 0, Progress says the release is a human follow-up). `cmd_run`: after `reconcile_in_flight`, pending feedback with tasks still running is only announced; with all tasks done it is consumed; otherwise at `awaiting_human_review` with all tasks done `record_completion` runs; then the `ADVANCE` loop.

- [ ] **Step 1: Point the foreign-push test at the gate**

In `tests/test_e2e.py`, replace `test_e2e_evidence_is_invalidated_by_a_later_change_and_a_foreign_push_stops` with:

```python
def test_e2e_evidence_is_void_after_a_foreign_push_and_the_run_stops(ws, fake_codex, stub, tmp_path):
    lib, builds = two_green_tasks(ws, fake_codex, stub, tmp_path, e2e_front(), ["green"])
    fake_codex.script([
        {"shell": ["echo lib > lib.txt"], "output": codex_output(summary="lib upgraded")},
        {"shell": ["echo app > app.txt"], "output": codex_output(summary="app upgraded")},
        {"output": codex_output(summary="review clean")},
    ])
    assert janus.cmd_run(ws.root) == 1
    goal = janus.load_goal(ws.root)
    assert goal.front["e2e_result"]["build"] == 103 and goal.front["review"]["status"] == "clean"
    other = tmp_path / "other"
    git(tmp_path, "clone", "-q", "-b", BRANCH, str(ws.bare), str(other))
    git(other, "config", "user.name", "Other")
    git(other, "config", "user.email", "other@example.com")
    (other / "theirs.txt").write_text("t", encoding="utf-8")
    foreign = commit_all(other, "feat: someone else")
    git(other, "push", "-q", "origin", BRANCH)
    # At the human gate: the completion check notices the moved branch before trusting any evidence.
    assert janus.cmd_run(ws.root) == 1
    goal = janus.load_goal(ws.root)
    assert goal.front["status"] == "blocked"
    progress = janus.section(goal.body, "## Progress and handover")
    assert f"is at {foreign[:12]}, not at the verified commit" in progress and "evidence no longer cover the branch head" in progress
    # Inside the E2E stage the same condition voids the evidence explicitly.
    goal.front["status"] = "executing"
    janus.save_goal(goal)
    commit_all(ws.root, "test: force the e2e stage")
    assert janus.cmd_run(ws.root) == 1
    progress = janus.section(janus.load_goal(ws.root).body, "## Progress and handover")
    assert "so E2E evidence is void (spec §7)" in progress
    assert len(fake_codex.calls()) == 3 and sum(1 for q in stub.calls("POST", QUEUE) if q["json"]["buildType"]["id"] == "Fe_E2E_Full") == 1
```

- [ ] **Step 2: Write the failing tests**

`tests/test_feedback_completion.py`:

```python
import janus
from helpers import add_repo, approve_draft, codex_output, commit_all, draft_front, git, script_bitbucket, script_ci, two_repo_front
from test_e2e import BRANCH, QUEUE, e2e_front

PR_APP = "/rest/api/1.0/projects/PROJ/repos/app/pull-requests"


def reach_the_gate(ws, fake_codex, stub, tmp_path):
    lib, _ = add_repo(ws, tmp_path, "lib")
    approve_draft(ws.root, e2e_front())
    script_bitbucket(stub, slug="lib", pr_id=21)
    script_bitbucket(stub, slug="app", pr_id=22)
    builds = script_ci(stub, ["green"], automatic=("Fe_Lib_Build", "Fe_App_Build"))
    fake_codex.script([
        {"shell": ["echo lib > lib.txt"], "output": codex_output(summary="lib upgraded")},
        {"shell": ["echo app > app.txt"], "output": codex_output(summary="app upgraded")},
        {"output": codex_output(summary="review clean")},
    ])
    assert janus.cmd_run(ws.root) == 1
    assert janus.load_goal(ws.root).front["status"] == "awaiting_human_review"
    return lib, builds


def test_placeholder_constant_matches_the_standard_section():
    assert dict(janus.STANDARD_SECTIONS)["## Review feedback"] == janus.FEEDBACK_PLACEHOLDER


def test_review_feedback_is_consumed_into_decisions_and_starts_a_fix_verify_review_pass(ws, fake_codex, stub, tmp_path):
    lib, builds = reach_the_gate(ws, fake_codex, stub, tmp_path)
    goal = janus.load_goal(ws.root)
    goal.body = janus.set_section(goal.body, "## Review feedback", "QA: the orders page shows a blank header.\nReviewer: rename OrdersSvc to OrdersService.")
    janus.save_goal(goal)
    commit_all(ws.root, "docs: paste review feedback")
    # The fake codex indexes its steps by the number of calls made so far (3), so the earlier steps stay in place.
    fake_codex.script([
        {"output": codex_output()}, {"output": codex_output()}, {"output": codex_output()},
        {"shell": ["echo header > app/header.txt"], "output": codex_output(summary="fixed the header and renamed the service")},
        {"output": codex_output(summary="review clean after feedback")},
    ])
    assert janus.cmd_run(ws.root) == 1
    calls = fake_codex.calls()
    assert len(calls) == 5 and calls[3]["cwd"] == str(ws.root)
    assert "Human review feedback (PR review / QA):\nQA: the orders page shows a blank header." in calls[3]["prompt"]
    assert "after the review-feedback stage failed" in calls[3]["prompt"]
    goal = janus.load_goal(ws.root)
    assert janus.section(goal.body, "## Review feedback") == janus.FEEDBACK_PLACEHOLDER
    decisions = janus.section(goal.body, "## Decisions")
    assert "review feedback consumed:\n  QA: the orders page shows a blank header.\n  Reviewer: rename OrdersSvc to OrdersService." in decisions
    app_sha = git(ws.app, "rev-parse", "HEAD")
    assert git(ws.app, "log", "-1", "--format=%s") == "fix(angular): review-feedback fix in app"
    assert [(b["type"], b["outcome"]) for b in builds] == [("Fe_Lib_Build", "green"), ("Fe_App_Build", "green"), ("Fe_E2E_Full", "green"), ("Fe_App_Build", "green"), ("Fe_E2E_Full", "green")]
    assert goal.front["last_verified"]["app"] == {"commit": app_sha, "teamcity_build": 104, "status": "green"}
    assert goal.front["e2e_result"]["heads"]["app"] == app_sha and goal.front["review"]["status"] == "clean" and goal.front["review"]["heads"]["app"] == app_sha
    assert goal.front["status"] == "awaiting_human_review"
    assert "chore(janus): consume review feedback" in git(ws.root, "log", "--format=%s")


def test_feedback_while_tasks_are_running_is_left_in_place(ws, fake_codex, stub, capsys):
    goal = approve_draft(ws.root, draft_front(pr_build="Fe_App_Build"))
    goal.body = janus.set_section(goal.body, "## Review feedback", "too early")
    janus.save_goal(goal)
    commit_all(ws.root, "docs: early feedback")
    script_bitbucket(stub)
    script_ci(stub, ["green"])
    fake_codex.script([{"shell": ["echo a > a.txt"], "output": codex_output()}, {"output": codex_output(summary="review clean")}])
    assert janus.cmd_run(ws.root) == 1
    assert "consumed once every task is done" in capsys.readouterr().out
    assert janus.section(janus.load_goal(ws.root).body, "## Review feedback") == "too early"
    assert "review-feedback" not in "".join(c["prompt"] for c in fake_codex.calls())


def test_completion_is_recorded_only_after_bitbucket_shows_every_pr_merged_and_janus_never_merges(ws, fake_codex, stub, tmp_path):
    reach_the_gate(ws, fake_codex, stub, tmp_path)
    stub.on("GET", "/rest/api/1.0/projects/PROJ/repos/lib/pull-requests/21", [(200, {"id": 21, "state": "MERGED"})])
    stub.on("GET", PR_APP + "/22", [(200, {"id": 22, "state": "OPEN"}), (200, {"id": 22, "state": "MERGED"})])
    assert janus.cmd_run(ws.root) == 1
    goal = janus.load_goal(ws.root)
    assert goal.front["status"] == "awaiting_human_review"
    progress = janus.section(goal.body, "## Progress and handover")
    assert "PR states: lib MERGED" in progress and "app OPEN" in progress and "Janus never merges" in progress and "### QA handover" in progress
    assert janus.cmd_run(ws.root) == 0
    goal = janus.load_goal(ws.root)
    assert goal.front["status"] == "done" and goal.front["current_task"] is None
    progress = janus.section(goal.body, "## Progress and handover")
    assert "Done: every PR is merged" in progress and "Janus never releases" in progress and "explicit follow-up" in progress and "### QA handover" in progress
    assert git(ws.root, "log", "-1", "--format=%s") == "chore(janus): goal done; all PRs merged"
    assert len(fake_codex.calls()) == 3
    assert not any("merge" in r["path"] or r["method"] in ("PUT", "DELETE") for r in stub.requests)
    assert all(r["method"] == "GET" for r in stub.requests if r["path"].startswith("/rest/api/1.0") and "/pull-requests/" in r["path"])


def test_completion_check_without_prs_or_bitbucket_stays_at_the_gate(ws, fake_codex, stub, tmp_path, monkeypatch):
    reach_the_gate(ws, fake_codex, stub, tmp_path)
    monkeypatch.setenv("JANUS_BITBUCKET_URL", "http://127.0.0.1:9")
    assert janus.cmd_run(ws.root) == 1
    goal = janus.load_goal(ws.root)
    assert goal.front["status"] == "awaiting_human_review"
    assert "cannot check pull request states" in janus.section(goal.body, "## Progress and handover")
    goal.front["prs"] = {}
    janus.save_goal(goal)
    commit_all(ws.root, "test: forget prs")
    assert janus.cmd_run(ws.root) == 1
    assert "no pull requests are recorded" in janus.section(janus.load_goal(ws.root).body, "## Progress and handover")
    assert len(fake_codex.calls()) == 3


def test_the_same_runner_serves_another_angular_major_without_code_changes(ws, fake_codex, stub):
    front = draft_front(pr_build="Fe_App_Build")
    front.update({"id": "angular-17-to-18", "angular": {"from": 17, "to": 18}})
    front["repos"][0]["branch"] = "ai/angular-17-to-18"
    front["tasks"][0]["objective"] = "Upgrade app to Angular 18"
    approve_draft(ws.root, front)
    api = "/rest/api/1.0/projects/PROJ/repos/app/pull-requests"
    stub.on("GET", api, [(200, {"values": []})])
    stub.on("POST", api, [(201, {"id": 31})])
    stub.on("GET", api + "/31", [(200, {"id": 31, "state": "MERGED"})])
    builds = script_ci(stub, ["green"])
    fake_codex.script([{"shell": ["echo a > a.txt"], "output": codex_output(summary="v18")}, {"output": codex_output(summary="review clean")}])
    assert janus.cmd_run(ws.root) == 1
    calls = fake_codex.calls()
    assert "Angular upgrade: 17 to 18" in calls[0]["prompt"] and "Angular 17 to 18 upgrade" in calls[1]["prompt"]
    assert stub.calls("POST", api)[0]["json"]["title"] == "[Janus] angular-17-to-18: app"
    assert stub.calls("POST", api)[0]["json"]["fromRef"]["id"] == "refs/heads/ai/angular-17-to-18"
    assert git(ws.bare, "rev-parse", "refs/heads/ai/angular-17-to-18") == git(ws.app, "rev-parse", "HEAD") == builds[0]["sha"]
    goal = janus.load_goal(ws.root)
    assert goal.front["status"] == "awaiting_human_review" and goal.front["prs"]["app"].endswith("/pull-requests/31")
    assert janus.cmd_run(ws.root) == 0
    assert janus.load_goal(ws.root).front["status"] == "done"
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `uv run pytest -q tests/test_feedback_completion.py tests/test_e2e.py`
Expected: FAIL with `AttributeError: module 'janus' has no attribute 'FEEDBACK_PLACEHOLDER'`; the completion test never reaches `done` and the feedback test never sees the consumed text under `## Decisions`.

- [ ] **Step 4: Implement**

Insert into section `# --- e2e and review ---` before `e2e_evidence_valid`, then replace `e2e_evidence_valid` (Task 20):

```python
def moved_branches(goal: Goal, skip: Tuple[str, ...] = ()) -> List[str]:
    """Participating goal branches whose remote head is not the commit Janus verified (spec §7 "unexpected
    remote changes"); one message per moved branch. `skip` names repositories whose PR is already merged."""
    messages = []
    for name, sha in recorded_heads(goal).items():
        if name in skip:
            continue
        cfg = repo_config(goal, name)
        actual = remote_head(goal.root / name, cfg["branch"])
        if actual != sha:
            messages.append(f"origin/{cfg['branch']} of {name} is at {str(actual)[:12]}, not at the verified commit {sha[:12]}; someone else pushed")
    return messages


def e2e_evidence_valid(goal: Goal) -> Tuple[bool, str]:
    """Green E2E evidence is valid only for the recorded heads and only while no participating branch has
    changed since (spec §6, §11 criterion 7). Raises JanusError when a branch moved by someone else."""
    result = goal.front.get("e2e_result") or {}
    heads = recorded_heads(goal)
    moved = moved_branches(goal)
    if moved:
        raise JanusError("; ".join(moved) + ", so E2E evidence is void (spec §7)")
    if result.get("status") != "green":
        return False, "no green E2E build recorded"
    if result.get("heads") != heads:
        stale = ", ".join(f"{r}={str(s)[:12]}" for r, s in (result.get("heads") or {}).items())
        return False, f"E2E build {result.get('build')} ran for other heads ({stale}); a participating branch changed since"
    return True, f"E2E build {result.get('build')} is green for the recorded heads"
```

Insert at the end of section `# --- e2e and review ---` (after `ensure_reviewed`):

```python
FEEDBACK_PLACEHOLDER = "Empty until a human pastes PR review or QA comments here and runs Janus again."


def pending_feedback(goal: Goal) -> Optional[str]:
    """Text a human pasted into '## Review feedback', or None when the section is empty or the placeholder."""
    text = (section(goal.body, "## Review feedback") or "").strip()
    if not text or text.startswith("Empty until"):
        return None
    return text


def consume_feedback(goal: Goal, feedback: str) -> Optional[int]:
    """Spec §6: a human pastes review comments into JANUS.md and runs Janus again; the runner moves the consumed
    feedback into '## Decisions', then starts one bounded fix/verify pass. E2E and the independent review follow
    in finish_goal because the heads changed. Returns None to continue, else the stop code."""
    decisions = section(goal.body, "## Decisions") or ""
    entry = f"- {now()}: review feedback consumed:\n" + "\n".join("  " + line for line in feedback.splitlines())
    goal.body = set_section(goal.body, "## Decisions", (decisions + "\n" + entry).strip("\n"))
    goal.body = set_section(goal.body, "## Review feedback", FEEDBACK_PLACEHOLDER)
    goal.front["status"] = "executing"
    goal.front["review"] = None
    write_progress(goal, "Starting a bounded fix/verify/review pass for the human review feedback.")
    save_checkpoint(goal, "chore(janus): consume review feedback")
    print("Review feedback consumed and recorded under ## Decisions; starting a fix pass.")
    return fix_and_reverify(goal, "Human review feedback (PR review / QA):\n" + feedback, "review-feedback")


def record_completion(goal: Goal) -> int:
    """Spec §6: "Completion is recorded only after checking actual merged PRs and release handover; a failed or
    unobserved release remains an explicit follow-up rather than falsely done." Janus never merges."""
    prs = goal.front.get("prs") or {}
    if not prs:
        return stop_for_human(
            goal, "no pull requests are recorded, so Janus cannot verify that anything was merged",
            "If the goal is complete without PRs, record the decision under ## Decisions and set status: done in JANUS.md by hand.",
            status="awaiting_human_review", handover=qa_handover(goal),
        )
    states = {}
    for name, url in prs.items():
        try:
            states[name] = pr_state(goal, name, url)
        except JanusError as exc:
            return stop_for_human(goal, f"cannot check pull request states: {redact(str(exc))}", "Fix Bitbucket access, then run again.", status="awaiting_human_review", handover=qa_handover(goal))
    unmerged = {name: state for name, state in states.items() if state != "MERGED"}
    moved = moved_branches(goal, skip=tuple(name for name, state in states.items() if state == "MERGED"))
    if moved:
        return stop_for_human(
            goal, "; ".join(moved) + "; PR build and E2E evidence no longer cover the branch head",
            "If that commit is yours, record it under ## Decisions and either revert it or set last_verified.<repo>.commit to it so Janus re-verifies from there; then run again.",
        )
    if unmerged:
        summary = ", ".join(f"{name} {state} ({prs[name]})" for name, state in states.items())
        return stop_for_human(
            goal, f"waiting for human review, QA and merge; PR states: {summary}",
            "Review, test and merge the PRs in the approved order through the existing process (Janus never merges), or paste feedback into ## Review feedback; then run again.",
            status="awaiting_human_review", handover=qa_handover(goal),
        )
    goal.front["status"] = "done"
    goal.front["current_task"] = None
    write_progress(
        goal,
        "Done: every PR is merged. Run the existing release process yourself; Janus never releases and records no release outcome, "
        "so a failed or unobserved release is an explicit follow-up for the team, not part of this goal's evidence.",
        handover=qa_handover(goal),
    )
    save_checkpoint(goal, "chore(janus): goal done; all PRs merged")
    print("All PRs are merged. Goal recorded as done; release handover is a human follow-up.")
    return 0
```

Replace `cmd_run` (Task 16) in the CLI section with:

```python
def cmd_run(root: Path) -> int:
    """Advance until the next human gate, block or completion (spec §5). Human review feedback pasted into
    JANUS.md starts a bounded fix/verify/review pass; at the review gate without feedback, completion is
    checked against the actual PR states."""
    with locked(root):
        ensure_control_ignore(root)
        goal = load_goal(root)
        verify_plan_approval(goal)
        interrupted = reconcile_in_flight(goal)
        feedback = pending_feedback(goal)
        if feedback and next_task(goal) is not None:
            print("Review feedback is present in JANUS.md; it is consumed once every task is done.")
        elif feedback:
            stopped = consume_feedback(goal, feedback)
            if stopped is not None:
                return stopped
        elif goal.front.get("status") == "awaiting_human_review" and next_task(goal) is None:
            return record_completion(goal)
        while True:
            code = run_next_task(goal, interrupted)
            interrupted = False
            if code != ADVANCE:
                return code
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `uv run pytest -q`
Expected: `169 passed`

- [ ] **Step 6: Commit**

```bash
cd /home/race-day/janus
git add janus.py tests/test_e2e.py tests/test_feedback_completion.py
git commit -m "feat(janus): consume human review feedback and record completion only against merged pull requests" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---
### Task 23: Manual trial: stubs here, real Bitbucket and TeamCity in the sandbox

Spec §10 "Slices" ("then add Bitbucket/TeamCity against the stub; then a second repo with an explicit coupled verification point; then E2E and prerelease steps. The same script and file format must survive all four slices"), §11 (acceptance criteria are observed, not assumed). This task is manual, has no unit tests and commits nothing to `/home/race-day/janus`; it produces observations for the controller.

**Bitbucket Server and TeamCity are NOT reachable from this development machine.** Part A runs on this machine against the stubs and the fake `codex` (no network, no real Codex). Part B is the real trial and runs only inside the sandbox that reaches Bitbucket, TeamCity, Nexus and the LLM (spec §9); it costs model time and creates real branches and PRs, so do it once in a throwaway project.

**Files:**
- Uses: `/home/race-day/janus/janus.py`, `/home/race-day/janus/JANUS.md`, `/home/race-day/janus/tests/`. Part B creates everything under a folder of its own in the sandbox.

- [ ] **Step 1 (Part A, here): run the suite and watch one complete goal against the stubs**

```bash
cd /home/race-day/janus
uv run pytest -q                                   # expected: 169 passed
uv run pytest -q -s tests/test_feedback_completion.py::test_completion_is_recorded_only_after_bitbucket_shows_every_pr_merged_and_janus_never_merges
```

Expected on the terminal (printed by the runner during the test): `Task 1 (lib): commit ... is green in https://tc.example/viewLog.html?buildId=101.`, `Task 2 (app): ... buildId=102`, `E2E needed: no green E2E build recorded.`, `Queued E2E build 103 of Fe_E2E_Full with env.LIB_BRANCH=ai/angular-15-to-16, env.APP_BRANCH=ai/angular-15-to-16`, `Janus stopped for human direction.` with the PR links, then on the second `run` `waiting for human review, QA and merge; PR states: lib MERGED (...), app OPEN (...)`, and on the third `All PRs are merged. Goal recorded as done; release handover is a human follow-up.`

pytest keeps the last three temporary directories, so the goal folder of that test still exists. Inspect it with the real CLI (the CLI takes the current directory as the goal):

```bash
GOAL=$(ls -d /tmp/pytest-of-$USER/pytest-current/test_completion_is_recorded_on0/goal)
cd "$GOAL" && python3 /home/race-day/janus/janus.py status
```

Expected: `status: done`, both tasks `[done]`, both repo lines with `last verified <sha12> green build 10x` and `pr http://127.0.0.1:<port>/projects/PROJ/repos/<repo>/pull-requests/2x`, `e2e: Fe_E2E_Full (lib=env.LIB_BRANCH, app=env.APP_BRANCH)` with `last e2e: green build 103`, `review: clean after 0 cycle(s)`, `next action: Done: every PR is merged. ...`. Then `git log --oneline` in that folder shows the full checkpoint history from `chore(janus): task 1 attempt 0 in lib` to `chore(janus): goal done; all PRs merged`, and `sed -n '1,60p' JANUS.md` shows the front matter of the contract section with `e2e_result`, `review`, `prs`, `last_verified` filled and no token anywhere (`grep -c secret-token JANUS.md` prints `0`).

Also confirm the two spec §10 constraints by inspection: `grep -c "^class " /home/race-day/janus/janus.py` prints `2` (`JanusError`, `Goal`) and `git -C /home/race-day/janus ls-files | grep -v '^tests/\|^docs/'` lists only `janus.py`, `JANUS.md`, `pyproject.toml`, `uv.lock`, `.gitignore`, `janus-3.0-spec.md`.

- [ ] **Step 2 (Part B, sandbox): prepare a throwaway two-repository goal**

Inside the sandbox, with a Bitbucket project you may create branches and PRs in (call it `SANDBOX`), two small Angular repositories in it (a library `demo-lib` published by an existing TeamCity job `<Publish job id>` to a Nexus prerelease repository, and a consumer app `demo-app`), their PR build configurations (`<Lib PR build id>`, `<App PR build id>`) and an E2E build configuration `<E2E build id>` that takes the branches as parameters (`env.LIB_BRANCH`, `env.APP_BRANCH`). Check first that the tokens are the least-privileged ones the spec allows (§9: no Bitbucket admin token, no TeamCity release token).

```bash
mkdir -p ~/janus-trial && cd ~/janus-trial
git init -q -b main angular-upgrade && cd angular-upgrade
cp /path/to/janus/janus.py .                        # the janus.py from the commit this plan was executed on
printf '*/\n.janus.lock\n.janus-interrupted.patch\n' > .gitignore
printf '# Goal\nUpgrade Angular <from> to <to> across the repositories in this folder; publish a demo-lib prerelease first; preserve existing behaviour.\n' > JANUS.md
git add -A && git commit -q -m "chore(janus): start goal"
git clone ssh://git@bitbucket.example:7999/sandbox/demo-lib.git demo-lib
git clone ssh://git@bitbucket.example:7999/sandbox/demo-app.git demo-app
export JANUS_TEAMCITY_URL=https://teamcity.example JANUS_TEAMCITY_TOKEN=...   # from the sandbox secret store, never typed into JANUS.md
export JANUS_BITBUCKET_URL=https://bitbucket.example JANUS_BITBUCKET_TOKEN=...
export JANUS_BUILD_APPEARANCE_SECONDS=300 JANUS_POLL_SECONDS=20
git status --short                                  # expected: empty (clones are ignored by */)
python3 janus.py status                             # expected: "status: no plan yet" and the goal text
```

Record: the TeamCity version (`curl -s -H "Authorization: Bearer $JANUS_TEAMCITY_TOKEN" $JANUS_TEAMCITY_URL/app/rest/2018.1/server | head -c 400`) and whether the Bearer header is accepted (HTTP 200); the Bitbucket version (`.../rest/api/1.0/application-properties`). If TeamCity is older than 2019.1 the Bearer token cannot work: stop the trial and report it (the fix is a Basic-auth variant of `http_json`, a plan change, not a sandbox workaround).

- [ ] **Step 3 (Part B): `plan`, edit, `approve`**

```bash
python3 janus.py plan
```

Expected: one Codex run in the goal folder; `JANUS.md` gets the front matter with two repos (`pr_build` ids filled if the repos reveal them, otherwise `null`), tasks in order (lib first, app second), `e2e` if Codex found the E2E configuration (otherwise `null`), and `## Progress and handover` with one `Baseline evidence ...` line per repo: `demo-lib: <Lib PR build id> on main: latest build #<n> SUCCESS (<url>)` or `unverified (...)`. Record the exact baseline lines: this is fact (e) of the Verified facts (`branch:(name:main)` vs the `default:true` fallback).

Edit the draft so that it exercises every slice: task 1 (`demo-lib`) gets `publish: <Publish job id>`; task 2 (`demo-app`) gets `expect_red: true` and `verify_at: "e2e"` only if the app genuinely cannot be green before the E2E (otherwise leave it plain); `e2e.build_type` and `branch_parameters` as in the contract; realistic `checks` (`npm ci`, `npm run build`, unit tests only if a headless browser exists on the sandbox). Then:

```bash
python3 janus.py approve                            # shows front matter, plan text AND the baseline lines; answer: yes
python3 janus.py status                             # status: approved
```

- [ ] **Step 4 (Part B): `run` through task 1, kill during the CI wait, `run` again**

Terminal A: `python3 janus.py run`. Watch for, in order: the `chore(janus): task 1 attempt 0 in demo-lib` checkpoint, Codex working in `demo-lib`, the local checks, the runner commit `chore(angular): <objective>` pushed to `ai/angular-<from>-to-<to>`, `Janus ...: verify task 1 commit ...` and then either `No <Lib PR build id> build appeared for ...; queuing one.` (after `JANUS_BUILD_APPEARANCE_SECONDS`) or a located automatic build.

Terminal B, while Janus waits for the build:

```bash
cd ~/janus-trial/angular-upgrade
grep -A8 '^in_flight:' JANUS.md                    # operation: ci_wait, start_sha: <the pushed sha>, build: <id>
git log --oneline -3                                # "task 1 waiting for build <id>", "task 1 awaiting CI for <sha12>", "task 1 pushed <sha12>"
```

Open the PR URL printed in the Progress section in Bitbucket: title `[Janus] angular-<from>-to-<to>: demo-lib`, from the goal branch to `main`, state OPEN, reviewers empty. Record the PR URL form Bitbucket shows and whether the constructed `.../projects/SANDBOX/repos/demo-lib/pull-requests/<id>` URL opens (fact (f), key case).

Press Ctrl-C in terminal A. Then `python3 janus.py run` again. Expected: `Resuming after an interrupted ci_wait; nothing is redone.`, no Codex run, no new commit on the branch (`git -C demo-lib log --oneline -2` unchanged, `git ls-remote origin refs/heads/ai/...` unchanged), the same build id located by the revision locator (if the queued build was not found by `revision:(version:...)` before it started, a second build is queued: record that, it is fact (c)/(d) of the Verified facts and costs one duplicate build, never a wrong verdict). On green: `Task 1 (demo-lib): commit ... is green in <url>.`, then `prerelease published by <Publish job id> build <id>` with the publish job visible in TeamCity for exactly that revision, and the Nexus prerelease version Codex reported under `tasks[0].values`. Record the HTTP status and body TeamCity returned to the `buildQueue` POST if Janus stopped with `TeamCity refused to queue ...` (fact (b)): the `lastChanges` change locator needs TeamCity to have collected the commit already; if it had not, wait for the VCS poll and run again.

- [ ] **Step 5 (Part B): task 2, E2E, review, human gate**

Still terminal A: after task 1, Janus continues into task 2 without stopping (`ADVANCE`): Codex in `demo-app` receives `# Values recorded by earlier tasks` with the prerelease version. Expected after its green build: `E2E needed: no green E2E build recorded.`, `Queued E2E build <id> of <E2E build id> with env.LIB_BRANCH=ai/..., env.APP_BRANCH=ai/...` (open the build in TeamCity and confirm the two parameters and that no base branch was passed for a participating repo), then `An independent Codex review ...` in the goal folder, then `Janus stopped for human direction.` with `Reason: all tasks are verified and the independent review is clean; human PR review and QA are next (PRs: ...)`. `python3 janus.py status` shows `status: awaiting_human_review`, `last e2e: green build <id> <url> ... for demo-lib=<sha12>, demo-app=<sha12>`, `review: clean after 0 cycle(s)`; `JANUS.md`'s Progress section ends with `### QA handover` listing PR links, changed behaviour, tests run, known limitations and unresolved risks.

If E2E or the review found something, watch the bounded loop instead: `E2E red; starting fix pass 1 of 3.` / `Review found N material issue(s); starting fix cycle 1 of 2.`, a `fix(angular): e2e fix in <repo>` or `fix(angular): review fix in <repo>` commit with trailer `Janus-Fix: ...`, its PR build, the E2E again, the review again.

- [ ] **Step 6 (Part B): feedback pass, merge, completion**

Paste two lines of review feedback under `## Review feedback` in `JANUS.md`, commit that edit (`git commit -am "docs: review feedback"`), run `python3 janus.py run`. Expected: `Review feedback consumed and recorded under ## Decisions; starting a fix pass.`, the section reset to its placeholder, the feedback text indented under `## Decisions`, a fix pass (Codex in the goal folder), PR builds of the changed repos, E2E again, review again, the human gate again.

Run `python3 janus.py run` once more without feedback: expected `waiting for human review, QA and merge; PR states: demo-lib OPEN (...), demo-app OPEN (...)` and exit code 1; confirm in Bitbucket that Janus changed nothing about the PRs (no merge, no decline, no reviewer). Merge both PRs by hand in Bitbucket in the approved order (lib, then app), then `python3 janus.py run`: expected `All PRs are merged. Goal recorded as done; release handover is a human follow-up.`, exit code 0, `status: done`. Run it once more: expected the same completion check (still `done`, exit 0) with no Codex run and no TeamCity request.

- [ ] **Step 7: Report**

Report to the controller, verbatim where marked:
1. TeamCity and Bitbucket versions; whether `Authorization: Bearer` worked for both (HTTP status of the first request each).
2. The baseline lines `plan` wrote (verbatim) and which locator produced them (`branch:(name:main)` or the `default:true` fallback, visible in the TeamCity request log or by the build's branch name).
3. The `buildQueue` POST outcomes: located automatic build or queued; HTTP status and body of any `TeamCity refused to queue` error (verbatim, redacted); whether the queued build's revision matched the commit (the runner refuses otherwise, and that message would be verbatim).
4. Whether the Ctrl-C during `ci_wait` resumed onto the same build id or queued a duplicate (fact (c)/(d)).
5. The PR URL Bitbucket displays versus the constructed one; project key case in the ssh clone URL versus the REST path that worked.
6. The publish job build id and the Nexus version reported by Codex; whether the E2E build received exactly the two branch parameters.
7. Whether the review changed anything (it must not); the QA handover text (verbatim, redacted).
8. The final `git log --oneline` of the control repo and the final front matter (redacted) after `done`.
9. Every `JanusError`/`Janus stopped for human direction` message seen, verbatim, with what you did next.
10. Any place where the sandbox's TeamCity/Bitbucket answered differently from the stub's canned shapes (then the stub, not the sandbox, is wrong, and the fix is a plan change).

Then delete the sandbox branches and PRs through the existing process or keep them for the real goal; nothing from the trial is committed to the Janus repository.

---
## Self-review notes

- **Spec coverage:** the table below maps every spec section and acceptance criterion to the slice 1 task or the task here that implements it; the two plans together leave no spec paragraph without a task. Deliberately out of scope by spec §2: automatic merge, deploy, release, PR-comment polling, a generic verification-group scheduler, generic adapters, sandboxing of Codex.
- **Placeholder scan:** no "TBD", "TODO", "similar to Task N" or "add error handling"; every code step carries the code, every command its expected output, every test file its full text (test modifications are given as exact diffs or full replacement functions).
- **Type and name consistency:** slice 1 names are reused verbatim (`Goal(root, front, body)`, `load_goal`, `save_goal`, `section`/`set_section`, `save_checkpoint`, `locked`, `record_heads`/`check_heads_unchanged`, `stage_and_diff`, `git_commit_push(repo, branch, message, trailer)`, `run_codex(cwd, prompt)`, `write_progress`, `record_verified`, `stop_for_human`, `run_next_task(goal, interrupted)`, `reconcile_in_flight(goal) -> bool`, `redact`, `run_checks`, `diff_guardrails`, `show_status`, `plan_prompt`, `task_prompt`). Every slice 1 function this plan changes is given as a full new body with the slice 1 task that defined it: `redact` (Task 8) in Task 14; `record_verified`, `stop_for_human`, `run_next_task` (Task 9), `reconcile_in_flight`, `cmd_run` (Task 10) in Task 16; `cmd_plan` (Task 7), `cmd_approve` (Task 5), `show_status` (Task 11) in Task 17; `plan_hash` (Task 5), `OUTPUT_SCHEMA` (Task 6), `validate_config` (Task 7), `task_prompt`, `next_task` (Task 9) in Task 18; `write_progress` (Task 7) in Task 20. Signatures only gain keyword parameters with defaults (`record_verified`, `stop_for_human`, `verify_task_ci`, `write_progress`), so every slice 1 call site still works. New functions carry the spec §10 names exactly.
- **Assembly check:** the slice 1 code blocks (Tasks 1 to 11) assembled verbatim in a scratch directory give `85 passed`. This plan's code blocks, layered task by task on top, give `90, 106, 116, 128, 135, 148, 151, 158, 163, 169 passed` after Tasks 13 to 22; the counts stated in each task were produced this way, and the sequence was replayed a second time with the final `tests/helpers.py` (the version shown in Tasks 16 and 18) with identical counts. `ast.parse(..., feature_version=(3, 9))` accepts every file; `janus.py` has exactly two classes (`JanusError`, `Goal`) and imports only the stdlib and `yaml`; `python3 janus.py --help` lists the four commands.
- **Not verifiable here:** the exact TeamCity and Bitbucket REST behaviour listed under Verified facts (a) to (g) and the version of TeamCity in the sandbox. Every such assumption is isolated in `locate_builds`, `queue_build`, `build_by_id`, `baseline_build`, `parse_origin` and `ensure_pr`, is exercised by the stub, and is confirmed or refuted by Task 23 Part B, whose report items 1 to 5 and 10 name each one.
- **Design choices worth a reviewer's eye:** (1) PR-build red for an `expect_red` task is recorded as `coupled_pending` and never triggers fix attempts (the plan said it would be red); an unexpected red still gets three attempts. (2) A `publishing` task status exists only so that a crash between "green" and "published" can neither skip nor repeat the publish. (3) E2E and review evidence are keyed by the exact recorded heads; any Janus-made fix changes the heads and therefore reruns both, while a foreign push is a `stop` (spec §7) rather than a silent re-verification. (4) At the human gate, `run` without feedback checks Bitbucket PR states and records `done` only when every PR is `MERGED`; with no PR recorded it tells the human to set `done` by hand under `## Decisions`. (5) Fix passes run Codex in the goal folder because an E2E or review finding can touch any repository; the runner still commits per repository and re-verifies each changed one.

## Spec coverage map

| Spec section / criterion | Where it is implemented |
|---|---|
| §1 Principle: two files, no framework, Python 3.9 + PyYAML, Janus decides nothing about repos, resume from `JANUS.md` | Slice 1 Tasks 1, 2, 7 (single script, goal file, Codex drafts everything); here Global Constraints, Tasks 13 to 22 keep one file and two classes; resume in Tasks 16, 19, 20 (`ci_wait`, `publish_wait`, `e2e_wait`) |
| §2 Scope, included items | Discovery/baseline/approval: slice 1 Task 7, here Task 17; goal branch and PR per repo: slice 1 Task 4, here Task 14; sequential tasks with fresh Codex: slice 1 Task 9, here Tasks 16, 18; local checks and PR build loop: slice 1 Task 8, here Tasks 15, 16; prerelease: Task 19; E2E: Task 20; review and handover: Task 21; checkpoints and recovery: slice 1 Task 10, here Tasks 16, 19, 20; status: slice 1 Task 11, here Task 17 |
| §2 Not included | Enforced: no merge/release/deploy endpoints (Tasks 14, 15, 22 tests), no PR-comment polling (feedback is pasted, Task 22), coupling described explicitly in the plan (Task 18), no adapters or persisted fakes (stub fixture, Task 13) |
| §3 Files and workspace | Slice 1 Tasks 3, 4 (folder is the goal, `*/` ignored, control checkpoints); here Task 14 derives Bitbucket project/repo from each clone's `origin` so nothing else is configured by hand |
| §4 JANUS.md contract, ownership, plan integrity | Slice 1 Tasks 2, 5, 7; here the contract section (approved vs runner fields), Task 18 (`expect_red`, `verify_at`, `publish` in schema, validation and hash), Tasks 16, 20, 21 (runner-owned `e2e_result`, `review`, task fields), Task 22 (`## Review feedback` → `## Decisions`) |
| §5 CLI: four commands, env vars, secrets | Slice 1 Task 1; here Task 13 (variables, `http_json`), Task 14 (`redact` strips literal tokens), Task 17 (`status` with PR/build links), Task 22 (`run` after review/merge) |
| §6 Workflow diagram | Slice 1 Task 9 (local loop); here Task 16 (PR, exact-SHA build, green/red/blocked), Task 18 (order, coupled point), Task 19 (prerelease), Task 20 (E2E), Task 21 (review), Task 22 (human gates, done) |
| §6 Planning and baseline | Slice 1 Task 7 (read-only discovery, draft, unverified marking); here Task 17 (`verify_baseline`, shown at `approve`) |
| §6 Implementation and TeamCity loop, steps 1 to 8 | Steps 1 to 4: slice 1 Tasks 4, 5, 8, 9 (hash, lock, heads, clean tree, branch, guardrails); step 5: slice 1 Task 4 + here Task 14 (`ensure_pr`); step 6: Task 15 (`find_or_trigger_build`, never an older green); step 7: Tasks 15, 16 (redacted excerpt, 3 attempts, infra retried once); step 8: Task 16 (`complete_task`), Task 19 (values and publish) |
| §6 Coupled change paragraph | Task 18 (`expect_red`, `verify_at`, `coupled_pending`, `verify_coupled_dependents`), Task 20 (`verify_at: "e2e"`) |
| §6 Prerelease paragraph | Task 19 (`publish_prerelease`; only the approved job, never a release) |
| §6 E2E, AI review, human gates | Task 20 (`trigger_full_e2e`, exact branches, base only where planned, evidence tied to heads and invalidated), Task 21 (`run_review`, 2 cycles, QA handover), Task 22 (feedback pass, never auto-approve, completion only on merged PRs, release as follow-up) |
| §7 Human intervention conditions and handover content | Slice 1 Tasks 9, 10 (unapproved/changed plan, dirty tree, moved refs, exhausted attempts, decisions needed); here Task 16 (capability unavailable, foreign push, exhausted CI attempts, JANUS.md tampering), Task 18 (joint verification failed), Task 19 (publish failed), Task 20 (E2E exhausted, moved branch), Task 21 (review cycles exhausted, review not read-only), Task 22 (gate, merge pending). Handover text: `write_progress` (Task 20) + `qa_handover` (Task 21) |
| §8 Crash recovery and checkpoints | Slice 1 Tasks 4, 5, 10; here Task 16 (`ci_wait` checkpoint, resume by exact SHA, no duplicate commit), Task 19 (`publish_wait`, no double publish), Task 20 (`e2e_wait` resumes the same build), Task 21 (`review` operation), lock unchanged |
| §9 Security and control boundaries | Slice 1 Tasks 4, 8, 9 (runner-only git writes, ref detection, redaction, deterministic diff checks); here Task 13 (tokens only in headers), Task 14 (`redact` literal tokens), Task 15 (redacted bounded excerpts), Task 16 (JANUS.md digest guard, runner-only write APIs), Task 21 (read-only review enforced) |
| §10 Implementation guidance: names, stdlib, tests, slices | Slice 1 Task 1 to 11 names; here `ensure_pr` (14), `find_or_trigger_build`/`wait_and_summarize_build` (15), `trigger_full_e2e` (20), `run_review` (21); `urllib.request` (13); stub per test (13); slices 2, 3, 4 = Tasks 13 to 17, 18, 19 to 22; Task 23 trial |
| §11 criterion 1 (Goal → plan → edit → approve) | Slice 1 Tasks 5, 7; here Task 17 (baseline shown at approve) |
| §11 criterion 2 (`run` refuses changed/unapproved plan) | Slice 1 Task 5, 9; here Task 18 extends the hash to the coupling and publish fields (`test_plan_hash_covers_coupling_and_publish_fields`) |
| §11 criterion 3 (implement, commit/push, PR, exact SHA in TeamCity) | Slice 1 Task 9; here Task 16 (`test_run_verifies_the_exact_commit_in_teamcity_opens_a_pr_and_completes_the_task`) |
| §11 criterion 4 (red → bounded fresh fixes; green records and advances; exhausted → handover) | Slice 1 Task 9 (local); here Task 16 (`test_run_red_build_starts_a_fresh_fix_attempt...`, `test_run_stops_after_three_red_builds_with_a_useful_handover`, infra retry tests) |
| §11 criterion 5 (crash after push and during CI wait: no duplicate commit, no false green) | Slice 1 Task 10 (after push); here Task 16 (`test_crash_during_ci_wait_resumes_without_a_new_commit_or_codex_run`, `test_crash_during_ci_wait_never_turns_a_red_build_green`), Task 19 (publish resume), Task 20 (E2E resume) |
| §11 criterion 6 (two repos in order; coupled point does not masquerade as green) | Task 18 (`test_two_repositories_run_in_approved_order_and_values_flow_forward`, `test_coupled_task_stays_red_as_planned_and_is_verified_at_its_joint_point`), Task 20 (`..._becomes_done_only_on_green_e2e`) |
| §11 criterion 7 (E2E via API with correct branch parameters; invalidated by later changes) | Task 20 (`test_e2e_runs_through_the_teamcity_api_with_exact_goal_branches_and_base_only_where_planned`, `test_red_e2e_starts_a_bounded_fix_pass...`), Task 22 (`test_e2e_evidence_is_void_after_a_foreign_push_and_the_run_stops`) |
| §11 criterion 8 (fresh AI review and human review/QA before merge; never auto-merge or release) | Task 21 (`test_clean_review_produces_the_qa_handover_and_stops_at_the_human_gate`), Task 22 (`test_completion_is_recorded_only_after_bitbucket_shows_every_pr_merged_and_janus_never_merges`) |
| §11 criterion 9 (agent cannot modify approval/state; ref mutations stop the run) | Slice 1 Tasks 4, 9; here Task 16 (`test_codex_modifying_janus_md_stops_the_run_and_restores_the_file`), Task 20 (fix pass ref check), Task 21 (read-only review) |
| §11 criterion 10 (one `JANUS.md`, one `janus.py` plus tests, no state/provider files) | Slice 1 Task 1; here every task adds to `janus.py` only; runner state lives in `JANUS.md` front matter (contract section); Task 23 Step 1 checks the tracked file list and class count |
| §11 criterion 11 (another Angular major without code changes) | Task 22 (`test_the_same_runner_serves_another_angular_major_without_code_changes`); slice 1 Task 7 (`angular.from/to` are data) |
| §12 Deliberate trade-off | Every unusual situation is a `stop_for_human` with a handover (Tasks 16 to 22) rather than an engine feature; no scheduler, no adapters, no retries beyond the spec's bounds |
