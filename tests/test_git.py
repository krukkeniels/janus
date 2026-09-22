import shutil

import pytest

import janus
from helpers import commit_all, git, init_repo, make_bare


@pytest.fixture
def repo(root):
    init_repo(root)
    commit_all(root, "init")
    return root


@pytest.fixture
def repo_with_upstream(repo, tmp_path):
    bare = make_bare(tmp_path / "origin.git")
    git(repo, "remote", "add", "origin", str(bare))
    git(repo, "push", "-q", "-u", "origin", "main")
    return repo, bare


def test_every_journal_write_is_committed_with_key_and_status(repo):
    janus.step("push", lambda: 1)
    assert git(repo, "log", "--format=%s").splitlines() == ["janus: push done", "janus: push running", "init"]
    assert git(repo, "status", "--porcelain") == ""


def test_janus_md_changes_are_committed_together_with_the_journal(repo):
    with pytest.raises(SystemExit):
        janus.human_gate("Approve?", key="approve")
    assert git(repo, "log", "-1", "--format=%s") == "janus: approve open"
    assert sorted(git(repo, "show", "--name-only", "--format=", "HEAD").splitlines()) == ["JANUS.md", "journal.yaml"]


def test_commits_are_pushed_when_the_branch_has_an_upstream(repo_with_upstream):
    repo, bare = repo_with_upstream
    janus.step("push", lambda: 1)
    assert git(bare, "log", "-1", "--format=%s", "main") == "janus: push done"


def test_failed_push_warns_and_the_run_continues(repo_with_upstream, capsys):
    repo, bare = repo_with_upstream
    shutil.rmtree(bare)
    assert janus.step("push", lambda: 1) == 1
    assert "janus: warning: git push failed" in capsys.readouterr().err
    assert git(repo, "log", "-1", "--format=%s") == "janus: push done"
