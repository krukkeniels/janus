"""TeamCity lookup for the Angular upgrade flow. This is flow code, not engine code: Janus itself
knows nothing about CI. The URL and the token are read from the environment, so the engine never
holds a secret; the flow calls it only when ``configured()`` is true."""
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request

REST = "/app/rest/2018.1"


def configured():
    """True when both environment variables are set; the flow skips the CI wait otherwise."""
    return bool(os.environ.get("JANUS_TEAMCITY_URL") and os.environ.get("JANUS_TEAMCITY_TOKEN"))


def get(path):
    """One authenticated GET returning parsed JSON, or None when TeamCity answers 404."""
    url = os.environ["JANUS_TEAMCITY_URL"].rstrip("/") + path
    request = urllib.request.Request(url, headers={
        "Authorization": "Bearer " + os.environ["JANUS_TEAMCITY_TOKEN"], "Accept": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return None
        raise


def failed_tests(build_id):
    """The names of up to twenty failed tests of a build, one per line."""
    locator = urllib.parse.quote("build:(id:%s),status:FAILURE" % build_id, safe="")
    data = get("%s/testOccurrences?locator=%s&count=20&fields=testOccurrence(name)" % (REST, locator)) or {}
    return "\n".join(t.get("name", "") for t in data.get("testOccurrence", []))


def wait_for_build(build_type, sha, timeout=7200, poll=30):
    """Find the ``build_type`` build of commit ``sha`` and wait for it to finish.
    Returns {status, url, excerpt} with status SUCCESS, FAILURE, TIMEOUT or NOT_FOUND.
    It carries its own deadline and is safe to run again: step() gives it neither."""
    locator = urllib.parse.quote(
        "buildType:(id:%s),revision:(version:%s),defaultFilter:false" % (build_type, sha), safe="")
    found = get("%s/builds?locator=%s&count=1&fields=build(id,webUrl,state,status)" % (REST, locator)) or {}
    builds = found.get("build") or []
    if not builds:
        return {"status": "NOT_FOUND", "url": "", "excerpt": "no %s build for %s" % (build_type, sha)}
    build = builds[0]
    deadline = time.time() + timeout
    while build.get("state") != "finished":
        if time.time() >= deadline:
            return {"status": "TIMEOUT", "url": build.get("webUrl", ""),
                    "excerpt": "still %s after %s s" % (build.get("state"), timeout)}
        time.sleep(poll)
        build = get("%s/builds/id:%s?fields=id,webUrl,state,status" % (REST, build["id"])) or build
    ok = build.get("status") == "SUCCESS"
    return {"status": "SUCCESS" if ok else "FAILURE", "url": build.get("webUrl", ""),
            "excerpt": "" if ok else failed_tests(build["id"])}
