from collections import defaultdict
from pathlib import Path
from typing import Any, override

import yaml
from copier_template_extensions import ContextHook

_SKIP_DIRS = frozenset({".git", "node_modules", "__pycache__"})
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
            {"id": "check-merge-conflict"},
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
            "hooks": ({"id": "pretty-format-json", "args": ("--autofix",)},),
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


def _inline_short_lists(value: Any) -> Any:
    if isinstance(value, dict):
        return {k: _inline_short_lists(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        items = [_inline_short_lists(v) for v in value]
        is_scalar_list = all(isinstance(v, (str, int, float, bool)) for v in items)
        if is_scalar_list and len(", ".join(map(str, items))) <= _INLINE_LIST_MAX_WIDTH:
            return _InlineList(items)
        return items
    return value


def _scan(dst: Path, wanted_suffixes: frozenset[str]) -> tuple[set[str], set[str]]:
    suffixes: set[str] = set()
    top_level: set[str] = set()
    for root, dirs, files in dst.walk():
        dirs[:] = [d for d in dirs if d not in _SKIP_DIRS]
        if root == dst:
            top_level = set(dirs) | set(files)
        for name in files:
            suffixes.add(Path(name).suffix)
        if suffixes >= wanted_suffixes:
            break
    return suffixes, top_level


def _merge_repos(entries: list[dict[str, Any]]) -> list[dict[str, Any]]:
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
            repo["rev"] = "v0.0.0"
        repo["hooks"] = sorted(hooks, key=lambda h: h["id"])
        repos.append(repo)

    return sorted(repos, key=lambda r: (r["repo"] == "local", r["repo"]))


class DetectStack(ContextHook):
    @override
    def hook(self, context: dict[str, Any]) -> dict[str, Any]:
        dst = Path(context["_copier_conf"]["dst_path"])
        suffixes, top_level = _scan(dst, _WANTED_SUFFIXES)

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

        # fencepost this since it's annoying to find in _scan()
        if (dst / ".github" / "workflows").is_dir():
            detected.append("github-actions")

        # mutually exclusive because biome sorts json
        if "package.json" in top_level or ".js" in suffixes or ".ts" in suffixes:
            detected.append("frontend")
        elif ".json" in suffixes:
            detected.append("json")

        entries = [
            *_UNCONDITIONAL,
            *(h for name in detected for h in _STACK_REPOS.get(name, ())),
        ]

        return {
            **context,
            "_stack_detected": detected,
            "_pre_commit_repos": _inline_short_lists(_merge_repos(entries)),
        }
