import os
import subprocess
from collections import defaultdict
from collections.abc import Iterator
from collections.abc import Set as AbstractSet
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, override

import yaml
from copier_template_extensions import ContextHook

_SKIP_DIRS = frozenset(
    {".git", ".tox", ".venv", "__pycache__", "node_modules", "venv"},
)
_WANTED_SUFFIXES = frozenset({".js", ".json", ".sh", ".sql", ".toml", ".ts"})
_INLINE_LIST_MAX_WIDTH = 60


class _InlineList(list[Any]):
    pass


yaml.add_representer(
    _InlineList,
    lambda dumper, data: dumper.represent_sequence(
        "tag:yaml.org,2002:seq",
        data,
        flow_style=True,
    ),
)

_UNCONDITIONAL: tuple[dict[str, Any], ...] = (
    {
        "repo": "https://github.com/pre-commit/pre-commit-hooks",
        "hooks": (
            {"id": "check-merge-conflict", "args": ("--assume-in-merge",)},
            {"id": "end-of-file-fixer"},
            {"id": "trailing-whitespace"},
        ),
    },
    {
        "repo": "https://github.com/macisamuele/language-formatters-pre-commit-hooks",
        "hooks": ({"id": "pretty-format-yaml", "args": ("--autofix",)},),
    },
)

_STACK_REPOS: dict[str, tuple[dict[str, Any], ...]] = {
    "python": (
        {
            "repo": "https://github.com/astral-sh/ruff-pre-commit",
            "hooks": (
                {"id": "ruff-check", "args": ("--fix",)},
                {"id": "ruff-format"},
            ),
        },
        {
            "repo": "https://github.com/pre-commit/mirrors-mypy",
            "hooks": ({"id": "mypy"},),
        },
        {
            "repo": "https://github.com/mxr/mirrors-ty",
            "hooks": ({"id": "ty"},),
        },
        {
            "repo": "https://github.com/mxr/sync-typing-deps",
            "hooks": ({"id": "sync-typing-deps"},),
        },
        {
            "repo": "https://github.com/pre-commit/pre-commit-hooks",
            "hooks": ({"id": "debug-statements"},),
        },
    ),
    "toml": (
        {
            "repo": "https://github.com/macisamuele/language-formatters-pre-commit-hooks",
            "hooks": (
                {
                    "id": "pretty-format-toml",
                    "args": ("--autofix", "--trailing-commas"),
                },
            ),
        },
    ),
    "sql": (
        {
            "repo": "https://github.com/sqlfluff/sqlfluff",
            "hooks": ({"id": "sqlfluff-fix", "args": ("--dialect", "sqlite")},),
        },
    ),
    "json": (
        {
            "repo": "https://github.com/pre-commit/pre-commit-hooks",
            "hooks": (
                {
                    "id": "pretty-format-json",
                    "args": ("--autofix",),
                    "exclude": "package-lock.json",
                },
            ),
        },
    ),
    "frontend": (
        {
            "repo": "https://github.com/pre-commit/sync-pre-commit-deps",
            "hooks": (
                {
                    "id": "sync-pre-commit-deps",
                    "args": (
                        "--yaml-mapping=2",
                        "--yaml-sequence=2",
                        "--yaml-offset=0",
                    ),
                },
            ),
        },
        {
            "repo": "https://github.com/biomejs/pre-commit",
            "hooks": ({"id": "biome-check"},),
        },
        {
            "repo": "local",
            "hooks": (
                {
                    "id": "biome-migrate",
                    "name": "biome migrate",
                    "entry": "biome migrate --write",
                    "language": "node",
                    "additional_dependencies": ("@biomejs/biome@2.5.4",),
                    "files": r"^\.pre-commit-config\.yaml$",
                    "pass_filenames": False,
                },
            ),
        },
    ),
    "rust": (
        {
            "repo": "https://github.com/AndrejOrsula/pre-commit-cargo",
            "hooks": (
                {"id": "cargo-fmt"},
                {
                    "id": "cargo-clippy",
                    "args": (
                        "--all-targets",
                        "--locked",
                        "--",
                        "-D",
                        "warnings",
                        "-D",
                        "clippy::pedantic",
                        "-D",
                        "clippy::nursery",
                        "-D",
                        "clippy::cargo",
                    ),
                },
            ),
        },
    ),
    "shell": (
        {
            "repo": "https://github.com/mxr/mirrors-shfmt",
            "hooks": ({"id": "shfmt"},),
        },
    ),
    "github-actions": (
        {
            "repo": "https://github.com/zizmorcore/zizmor-pre-commit",
            "hooks": ({"id": "zizmor", "args": ("--no-progress", "--fix")},),
        },
        {
            "repo": "https://github.com/rhysd/actionlint",
            "hooks": (
                {
                    "id": "actionlint",
                    "additional_dependencies": (
                        "github.com/wasilibs/go-shellcheck/cmd/shellcheck@latest",
                    ),
                },
            ),
        },
    ),
}


class DetectStack(ContextHook):
    @override
    def hook(self, context: dict[str, Any]) -> dict[str, Any]:
        dst = Path(context["_copier_conf"]["dst_path"])
        suffixes, top_level = self._scan(dst, _WANTED_SUFFIXES)

        detected = []

        if "Cargo.toml" in top_level:
            detected.append("rust")
        if "pyproject.toml" in top_level:
            detected.append("python")

        if ".toml" in suffixes:
            detected.append("toml")
        if ".sql" in suffixes:
            detected.append("sql")
        if ".sh" in suffixes:
            detected.append("shell")

        # fencepost this since it's annoying to find in _scan(). also imply it
        # for any stack whose own templated files land under .github/workflows
        # (currently just python) so a first-time bootstrap doesn't need a
        # workflows dir to already exist before it'll ever get created.
        if (dst / ".github" / "workflows").is_dir() or "python" in detected:
            detected.append("github-actions")

        if "package.json" in top_level or ".js" in suffixes or ".ts" in suffixes:
            detected.append("frontend")
        if ".json" in suffixes:
            detected.append("json")

        # union with whatever was already answered/persisted, so `stack` only
        # grows (e.g. adding a .json file later still picks up "json") and
        # never flip-flops or drops something a prior render already set
        prior_stack = context.get("stack") or ()
        detected = sorted({*detected, *prior_stack})

        # once `stack` has actually been answered (interactively, from
        # --defaults, or persisted from a prior `copier update`), it's the
        # source of truth for which hooks to render — not a fresh directory
        # scan, which can't see files this same render is about to create
        # (e.g. `.github/workflows` on a repo's very first python bootstrap)
        active_stacks = context.get("stack", detected)

        entries = [
            *_UNCONDITIONAL,
            *(h for name in active_stacks for h in _STACK_REPOS.get(name, ())),
        ]

        return {
            **context,
            "_stack_detected": detected,
            "_pre_commit_repos": self._inline_short_lists(self._merge_repos(entries)),
            "_license_year": self._first_commit_year(dst),
        }

    def _first_commit_year(self, dst: Path) -> int:
        try:
            root = (
                subprocess.run(
                    ["git", "-C", str(dst), "rev-list", "--max-parents=0", "HEAD"],
                    capture_output=True,
                    text=True,
                    timeout=10,
                    check=True,
                )
                .stdout.strip()
                .splitlines()[0]
            )
            year = subprocess.run(
                [
                    "git",
                    "-C",
                    str(dst),
                    "log",
                    "-1",
                    "--format=%ad",
                    "--date=format:%Y",
                    root,
                ],
                capture_output=True,
                text=True,
                timeout=10,
                check=True,
            ).stdout.strip()
            return int(year)
        except (
            subprocess.CalledProcessError,
            FileNotFoundError,
            ValueError,
            IndexError,
        ):
            return datetime.now(tz=UTC).year

    def _scan(
        self, dst: Path, wanted_suffixes: AbstractSet[str]
    ) -> tuple[set[str], set[str]]:
        suffixes = set()
        for suffix in self._iter_suffixes(dst):
            suffixes.add(suffix)
            if suffixes >= wanted_suffixes:
                break

        top_level = {p.name for p in dst.iterdir()}

        return suffixes, top_level

    def _iter_suffixes(self, dst: Path) -> Iterator[str]:
        for _, dirs, files in dst.walk():
            dirs[:] = [d for d in dirs if d not in _SKIP_DIRS]
            for name in files:
                yield os.path.splitext(name)[1]

    def _merge_repos(self, entries: list[dict[str, Any]]) -> list[dict[str, Any]]:
        # TODO: this merges hooks across all "repo: local" entries into one block,
        # which is wrong if there's ever more than one distinct local repo entry.
        # Fine for now since we only ever have a single local entry (biome-migrate).
        hooks_by_repo: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for entry in entries:
            hooks_by_repo[entry["repo"]].extend(entry["hooks"])

        repos = []
        for key, hooks in hooks_by_repo.items():
            repo: dict[str, Any] = {"repo": key}
            if key != "local":
                # unique per repo rather than a shared "v0.0.0" literal: copier's
                # diff engine is difflib-based, not a real git diff3, and with
                # every unfrozen entry carrying the exact same "rev: v0.0.0"
                # line it misaligns hunks across the file and conflicts with
                # your locally frozen revs even when that entry never changed.
                # `pre-commit autoupdate --freeze` matches hooks structurally
                # by repo url, so the placeholder text itself doesn't matter.
                repo["rev"] = f"v0.0.0-{key.rsplit('/', 1)[-1]}"
            repo["hooks"] = sorted(hooks, key=lambda h: h["id"])
            repos.append(repo)

        return sorted(repos, key=lambda r: (r["repo"] == "local", r["repo"]))

    def _inline_short_lists(self, value: Any) -> Any:
        if isinstance(value, dict):
            return {k: self._inline_short_lists(v) for k, v in value.items()}
        if isinstance(value, (list, tuple)):
            items = [self._inline_short_lists(v) for v in value]
            is_scalar_list = all(isinstance(v, (str, int, float, bool)) for v in items)
            if (
                is_scalar_list
                and len(", ".join(map(str, items))) <= _INLINE_LIST_MAX_WIDTH
            ):
                return _InlineList(items)
            return items
        return value
