import os

from copier_template_extensions import ContextHook

_SKIP_DIRS = {".git", "node_modules", "__pycache__"}


def _scan(dst):
    dst = str(dst)
    suffixes = set()
    top_level = set()
    gha = False
    for root, dirs, files in os.walk(dst):
        dirs[:] = [d for d in dirs if d not in _SKIP_DIRS]
        if root == dst:
            top_level = set(dirs) | set(files)
        elif root == os.path.join(dst, ".github") and "workflows" in dirs:
            gha = True
        for name in files:
            suffixes.add(os.path.splitext(name)[1])
    return suffixes, top_level, gha


_UNCONDITIONAL = [
    {
        "repo": "https://github.com/pre-commit/pre-commit-hooks",
        "rev": "v0.0.0",
        "hooks": [{"id": "trailing-whitespace"}],
    },
    {
        "repo": "https://github.com/macisamuele/language-formatters-pre-commit-hooks",
        "rev": "v0.0.0",
        "hooks": [{"id": "pretty-format-yaml", "args": ["--autofix"]}],
    },
]

_STACK_REPOS = {
    "python": [
        {
            "repo": "https://github.com/astral-sh/ruff-pre-commit",
            "rev": "v0.0.0",
            "hooks": [
                {"id": "ruff-check", "args": ["--fix"]},
                {"id": "ruff-format"},
            ],
        },
    ],
    "sql": [
        {
            "repo": "https://github.com/sqlfluff/sqlfluff",
            "rev": "v0.0.0",
            "hooks": [{"id": "sqlfluff-fix", "args": ["--dialect", "sqlite"]}],
        },
    ],
    "json": [
        {
            "repo": "https://github.com/pre-commit/pre-commit-hooks",
            "rev": "v0.0.0",
            "hooks": [{"id": "pretty-format-json", "args": ["--autofix"]}],
        },
    ],
    "frontend": [
        {
            "repo": "https://github.com/pre-commit/sync-pre-commit-deps",
            "rev": "v0.0.0",
            "hooks": [
                {
                    "id": "sync-pre-commit-deps",
                    "args": ["--yaml-mapping=2", "--yaml-sequence=2", "--yaml-offset=0"],
                },
            ],
        },
        {
            "repo": "https://github.com/biomejs/pre-commit",
            "rev": "v0.0.0",
            "hooks": [{"id": "biome-check"}],
        },
        {
            "repo": "local",
            "hooks": [
                {
                    "id": "biome-migrate",
                    "name": "biome migrate",
                    "entry": "biome migrate --write",
                    "language": "node",
                    "additional_dependencies": ["@biomejs/biome@2.5.4"],
                    "files": r"^\.pre-commit-config\.yaml$",
                    "pass_filenames": False,
                },
            ],
        },
    ],
    "rust": [
        {
            "repo": "https://github.com/AndrejOrsula/pre-commit-cargo",
            "rev": "v0.0.0",
            "hooks": [
                {"id": "cargo-fmt"},
                {
                    "id": "cargo-clippy",
                    "args": [
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
                    ],
                },
            ],
        },
    ],
    "shell": [
        {
            "repo": "https://github.com/mxr/mirrors-shfmt",
            "rev": "v0.0.0",
            "hooks": [{"id": "shfmt"}],
        },
    ],
    "gha": [
        {
            "repo": "https://github.com/zizmorcore/zizmor-pre-commit",
            "rev": "v0.0.0",
            "hooks": [{"id": "zizmor", "args": ["--no-progress", "--fix"]}],
        },
        {
            "repo": "https://github.com/rhysd/actionlint",
            "rev": "v0.0.0",
            "hooks": [
                {
                    "id": "actionlint",
                    "additional_dependencies": [
                        "github.com/wasilibs/go-shellcheck/cmd/shellcheck@latest",
                    ],
                },
            ],
        },
    ],
}


def _merge_repos(entries):
    by_repo = {}
    order = []
    for entry in entries:
        key = entry["repo"]
        if key not in by_repo:
            by_repo[key] = {"repo": key, "rev": entry.get("rev"), "hooks": []}
            order.append(key)
        by_repo[key]["hooks"].extend(entry["hooks"])
    return [by_repo[key] for key in order]


def _sort_repos(repos):
    local = [r for r in repos if r["repo"] == "local"]
    others = [r for r in repos if r["repo"] != "local"]
    others.sort(key=lambda r: r["repo"])
    for r in others + local:
        r["hooks"].sort(key=lambda h: h["id"])
    for r in local:
        r.pop("rev", None)
    return others + local


class DetectStack(ContextHook):
    def hook(self, context):
        dst = context["_copier_conf"]["dst_path"]
        suffixes, top_level, gha = _scan(dst)
        detected = []
        if "Cargo.toml" in top_level:
            detected.append("rust")
        if "pyproject.toml" in top_level:
            detected.append("python")
        if gha:
            detected.append("gha")
        if ".sql" in suffixes:
            detected.append("sql")
        if ".sh" in suffixes:
            detected.append("shell")
        if "package.json" in top_level or ".js" in suffixes or ".ts" in suffixes:
            detected.append("frontend")
        elif ".json" in suffixes:
            detected.append("json")

        entries = list(_UNCONDITIONAL)
        for name in detected:
            entries.extend(_STACK_REPOS.get(name, []))

        context["_stack_detected"] = detected
        context["_pre_commit_repos"] = _sort_repos(_merge_repos(entries))
        return context
