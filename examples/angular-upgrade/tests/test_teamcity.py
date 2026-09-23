import os

import teamcity

RUNNING = {"build": [{"id": 42, "webUrl": "http://tc/viewLog.html?buildId=42", "state": "running"}]}
FINISHED = {"build": [{"id": 42, "webUrl": "http://tc/viewLog.html?buildId=42",
                       "state": "finished", "status": "SUCCESS"}]}
FAILED = {"build": [{"id": 42, "webUrl": "http://tc/viewLog.html?buildId=42",
                     "state": "finished", "status": "FAILURE"}]}


def test_configured_is_false_until_both_variables_are_set(monkeypatch):
    monkeypatch.delenv("JANUS_TEAMCITY_URL", raising=False)
    monkeypatch.delenv("JANUS_TEAMCITY_TOKEN", raising=False)
    teamcity.reload_env()
    assert teamcity.configured() is False
    monkeypatch.setenv("JANUS_TEAMCITY_URL", "http://tc")
    teamcity.reload_env()
    assert teamcity.configured() is False
    monkeypatch.setenv("JANUS_TEAMCITY_TOKEN", "t0ken")
    teamcity.reload_env()
    assert teamcity.configured() is True


def test_the_token_is_taken_out_of_the_environment_that_codex_inherits(teamcity_server):
    """Every `codex exec` inherits this process's environment, so the token must not be in it."""
    assert teamcity.configured() is True
    assert "JANUS_TEAMCITY_TOKEN" not in os.environ
    assert os.environ["JANUS_TEAMCITY_URL"].startswith("http://127.0.0.1:")
    teamcity_server.serve([FINISHED])
    assert teamcity.wait_for_build("app_Build", "abc123", timeout=5, poll=0)["status"] == "SUCCESS"
    assert teamcity_server.requests()[0]["auth"] == "Bearer t0ken"


def test_wait_for_build_returns_success_and_the_build_url(teamcity_server):
    teamcity_server.serve([FINISHED])
    assert teamcity.wait_for_build("app_Build", "abc123", timeout=5, poll=0) == {
        "status": "SUCCESS", "url": "http://tc/viewLog.html?buildId=42", "excerpt": ""}


def test_wait_for_build_looks_the_build_up_by_revision_with_a_bearer_token(teamcity_server):
    teamcity_server.serve([FINISHED])
    teamcity.wait_for_build("app_Build", "abc123", timeout=5, poll=0)
    request = teamcity_server.requests()[0]
    assert request["auth"] == "Bearer t0ken"
    assert request["path"].startswith("/app/rest/2018.1/builds?locator=")
    assert "buildType%3A%28id%3Aapp_Build%29" in request["path"]
    assert "revision%3A%28version%3Aabc123%29" in request["path"]


def test_wait_for_build_returns_failure_with_the_failed_test_names(teamcity_server):
    teamcity_server.serve([FAILED, {"testOccurrence": [{"name": "AppComponent should create the app"},
                                                       {"name": "AppComponent should render title"}]}])
    result = teamcity.wait_for_build("app_Build", "abc123", timeout=5, poll=0)
    assert result["status"] == "FAILURE"
    assert result["excerpt"] == "AppComponent should create the app\nAppComponent should render title"
    assert "build%3A%28id%3A42%29%2Cstatus%3AFAILURE" in teamcity_server.requests()[1]["path"]


def test_wait_for_build_polls_by_build_id_until_the_build_is_finished(teamcity_server):
    teamcity_server.serve([RUNNING, {"id": 42, "webUrl": "http://tc/viewLog.html?buildId=42",
                                     "state": "finished", "status": "SUCCESS"}])
    assert teamcity.wait_for_build("app_Build", "abc123", timeout=5, poll=0)["status"] == "SUCCESS"
    assert teamcity_server.requests()[1]["path"].startswith("/app/rest/2018.1/builds/id:42?")


def test_wait_for_build_returns_not_found_when_no_build_has_that_revision(teamcity_server):
    teamcity_server.serve([{"count": 0}])
    assert teamcity.wait_for_build("app_Build", "abc123", timeout=5, poll=0) == {
        "status": "NOT_FOUND", "url": "", "excerpt": "no app_Build build for abc123"}


def test_wait_for_build_returns_timeout_when_the_build_never_finishes(teamcity_server):
    teamcity_server.serve([RUNNING])
    assert teamcity.wait_for_build("app_Build", "abc123", timeout=0, poll=0) == {
        "status": "TIMEOUT", "url": "http://tc/viewLog.html?buildId=42",
        "excerpt": "still running after 0 s"}
