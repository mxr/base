from __future__ import annotations

import os
import subprocess
from datetime import UTC, datetime

import jinja2
import pytest

from extensions import DetectStack, _InlineList


@pytest.fixture
def detector():
    return DetectStack(jinja2.Environment())


def _write(tmp_path, files):
    for relpath, content in files.items():
        path = tmp_path / relpath
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)


def _git_commit(repo, message, date):
    env = {
        **os.environ,
        "GIT_AUTHOR_NAME": "test",
        "GIT_AUTHOR_EMAIL": "test@test.com",
        "GIT_COMMITTER_NAME": "test",
        "GIT_COMMITTER_EMAIL": "test@test.com",
        "GIT_AUTHOR_DATE": date,
        "GIT_COMMITTER_DATE": date,
    }
    subprocess.run(
        ["git", "commit", "--allow-empty", "-m", message],
        cwd=repo,
        env=env,
        check=True,
        capture_output=True,
    )


def test_iter_suffixes_yields_suffix_of_every_file(tmp_path, detector):
    _write(tmp_path, {"a.py": "", "sub/b.sql": ""})
    assert set(detector._iter_suffixes(tmp_path)) == {".py", ".sql"}


@pytest.mark.parametrize(
    "skip_dir",
    [".git", ".tox", ".venv", "__pycache__", "node_modules", "venv"],
)
def test_iter_suffixes_skips_configured_dirs(tmp_path, detector, skip_dir):
    _write(
        tmp_path,
        {
            f"{skip_dir}/polluted.ext": "",
            "real.py": "",
        },
    )
    assert set(detector._iter_suffixes(tmp_path)) == {".py"}


def test_scan_breaks_early_once_wanted_suffixes_satisfied(tmp_path, detector):
    _write(tmp_path, {"a.sql": "", "b.sh": "", "c.unwanted": ""})
    suffixes, top_level = detector._scan(tmp_path, frozenset({".sql", ".sh"}))
    assert suffixes == {".sql", ".sh"}
    assert top_level == {"a.sql", "b.sh", "c.unwanted"}


def test_scan_exhausts_walk_when_wanted_suffixes_never_satisfied(tmp_path, detector):
    _write(tmp_path, {"a.sql": ""})
    suffixes, top_level = detector._scan(tmp_path, frozenset({".sql", ".missing"}))
    assert suffixes == {".sql"}
    assert top_level == {"a.sql"}


def test_merge_repos_merges_hooks_for_same_repo(detector):
    entries = [
        {"repo": "https://x", "hooks": [{"id": "b"}]},
        {"repo": "https://x", "hooks": [{"id": "a"}]},
    ]
    result = detector._merge_repos(entries)
    assert result == [
        {"repo": "https://x", "rev": "v0.0.0-x", "hooks": [{"id": "a"}, {"id": "b"}]},
    ]


@pytest.mark.parametrize(
    ("repo", "expect_rev"),
    [
        pytest.param("https://x", True, id="non-local-has-rev"),
        pytest.param("local", False, id="local-has-no-rev"),
    ],
)
def test_merge_repos_rev_handling(detector, repo, expect_rev):
    result = detector._merge_repos([{"repo": repo, "hooks": [{"id": "a"}]}])
    assert ("rev" in result[0]) == expect_rev


def test_merge_repos_sorts_local_last_and_others_alphabetically(detector):
    entries = [
        {"repo": "local", "hooks": [{"id": "z"}]},
        {"repo": "https://b", "hooks": [{"id": "a"}]},
        {"repo": "https://a", "hooks": [{"id": "a"}]},
    ]
    result = detector._merge_repos(entries)
    assert [r["repo"] for r in result] == ["https://a", "https://b", "local"]


def test_merge_repos_sorts_hooks_by_id(detector):
    entries = [{"repo": "https://x", "hooks": [{"id": "b"}, {"id": "a"}]}]
    result = detector._merge_repos(entries)
    assert [h["id"] for h in result[0]["hooks"]] == ["a", "b"]


@pytest.mark.parametrize(
    ("value", "expected_type", "expected_items"),
    [
        pytest.param(
            ["--autofix"],
            _InlineList,
            ["--autofix"],
            id="short-scalar-list-inlines",
        ),
        pytest.param(
            [f"--flag-{i}" for i in range(20)],
            list,
            [f"--flag-{i}" for i in range(20)],
            id="long-scalar-list-stays-plain",
        ),
        pytest.param(
            [{"id": "a"}],
            list,
            [{"id": "a"}],
            id="non-scalar-list-stays-plain",
        ),
        pytest.param(
            ("--fix",),
            _InlineList,
            ["--fix"],
            id="tuple-input-inlines",
        ),
    ],
)
def test_inline_short_lists_list_and_tuple_handling(
    detector, value, expected_type, expected_items
):
    result = detector._inline_short_lists(value)
    assert type(result) is expected_type
    assert list(result) == expected_items


def test_inline_short_lists_recurses_into_dicts(detector):
    result = detector._inline_short_lists({"args": ["--fix"]})
    assert isinstance(result["args"], _InlineList)


@pytest.mark.parametrize("value", ["plain", 1, True, 1.5])
def test_inline_short_lists_returns_scalars_unchanged(detector, value):
    assert detector._inline_short_lists(value) == value


@pytest.mark.parametrize(
    ("commit_dates", "expected_year"),
    [
        pytest.param(["2020-01-01T00:00:00"], 2020, id="single-commit"),
        pytest.param(
            ["2020-01-01T00:00:00", "2023-06-15T00:00:00"],
            2020,
            id="multiple-commits-returns-earliest",
        ),
    ],
)
def test_first_commit_year_reads_root_commit_date(
    tmp_path, detector, commit_dates, expected_year
):
    subprocess.run(["git", "init", "-q"], cwd=tmp_path, check=True)
    for i, date in enumerate(commit_dates):
        _git_commit(tmp_path, f"commit {i}", date)
    assert detector._first_commit_year(tmp_path) == expected_year


def test_first_commit_year_falls_back_to_current_year_without_commits(
    tmp_path, detector
):
    subprocess.run(["git", "init", "-q"], cwd=tmp_path, check=True)
    assert detector._first_commit_year(tmp_path) == datetime.now(tz=UTC).year


def test_first_commit_year_falls_back_to_current_year_without_git_repo(
    tmp_path, detector
):
    assert detector._first_commit_year(tmp_path) == datetime.now(tz=UTC).year


@pytest.mark.parametrize(
    ("files", "expected_detected"),
    [
        pytest.param({}, [], id="empty"),
        pytest.param({"Cargo.toml": ""}, ["rust", "toml"], id="rust"),
        pytest.param(
            {"pyproject.toml": ""},
            ["python", "toml"],
            id="python",
        ),
        pytest.param({"other.toml": ""}, ["toml"], id="toml-only"),
        pytest.param({"seed.sql": ""}, ["sql"], id="sql"),
        pytest.param({"tag.sh": ""}, ["shell"], id="shell"),
        pytest.param(
            {".github/workflows/ci.yml": ""},
            ["github-actions"],
            id="github-actions",
        ),
        pytest.param({"app.js": ""}, ["frontend"], id="frontend-via-js"),
        pytest.param({"app.ts": ""}, ["frontend"], id="frontend-via-ts"),
        pytest.param({"data.json": ""}, ["json"], id="json-only"),
        pytest.param(
            {"package.json": "{}"},
            ["frontend", "json"],
            id="package-json-triggers-both",
        ),
        pytest.param(
            {
                "Cargo.toml": "",
                "pyproject.toml": "",
                "other.toml": "",
                "seed.sql": "",
                "tag.sh": "",
                ".github/workflows/ci.yml": "",
                "package.json": "{}",
            },
            [
                "frontend",
                "github-actions",
                "json",
                "python",
                "rust",
                "shell",
                "sql",
                "toml",
            ],
            id="full",
        ),
    ],
)
def test_hook_detects_stack(tmp_path, detector, files, expected_detected):
    _write(tmp_path, files)
    context = {"_copier_conf": {"dst_path": tmp_path}}
    result = detector.hook(context)
    assert result["_stack_detected"] == expected_detected


def test_hook_keeps_manually_added_stack_entry_with_no_matching_files(
    tmp_path, detector
):
    context = {"_copier_conf": {"dst_path": tmp_path}, "stack": ["shell"]}
    result = detector.hook(context)
    assert result["_stack_detected"] == ["shell"]


def test_hook_readds_stack_entry_when_files_still_present_despite_dropped_answer(
    tmp_path, detector
):
    _write(tmp_path, {"tag.sh": ""})
    context = {"_copier_conf": {"dst_path": tmp_path}, "stack": []}
    result = detector.hook(context)
    assert result["_stack_detected"] == ["shell"]


def test_hook_drops_stack_entry_once_both_answer_and_files_are_gone(tmp_path, detector):
    context = {"_copier_conf": {"dst_path": tmp_path}, "stack": []}
    result = detector.hook(context)
    assert result["_stack_detected"] == []


def test_hook_preserves_existing_context_keys(tmp_path, detector):
    context = {"_copier_conf": {"dst_path": tmp_path}, "other_key": "value"}
    result = detector.hook(context)
    assert result["other_key"] == "value"


def test_hook_empty_repo_only_has_unconditional_repos(tmp_path, detector):
    context = {"_copier_conf": {"dst_path": tmp_path}}
    result = detector.hook(context)
    repos = result["_pre_commit_repos"]
    assert [r["repo"] for r in repos] == [
        "https://github.com/macisamuele/language-formatters-pre-commit-hooks",
        "https://github.com/pre-commit/pre-commit-hooks",
    ]


def test_hook_frontend_adds_local_repo_last(tmp_path, detector):
    _write(tmp_path, {"package.json": "{}"})
    context = {"_copier_conf": {"dst_path": tmp_path}}
    result = detector.hook(context)
    repos = result["_pre_commit_repos"]
    assert repos[-1]["repo"] == "local"
    assert "rev" not in repos[-1]


def test_hook_sets_license_year_from_first_commit(tmp_path, detector):
    subprocess.run(["git", "init", "-q"], cwd=tmp_path, check=True)
    _git_commit(tmp_path, "init", "2019-03-01T00:00:00")
    context = {"_copier_conf": {"dst_path": tmp_path}}
    result = detector.hook(context)
    assert result["_license_year"] == 2019
