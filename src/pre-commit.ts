import { Stack } from "./stack";

const INLINE_LIST_MAX_WIDTH = 60;

export interface PreCommitHook {
  readonly id: string;
  readonly args?: string[];
  readonly exclude?: string;
  readonly types?: string[];
  readonly excludeTypes?: string[];
  readonly additionalDependencies?: string[];
  readonly name?: string;
  readonly entry?: string;
  readonly language?: string;
  readonly files?: string;
  readonly passFilenames?: boolean;
}

export interface PreCommitRepo {
  readonly repo: string;
  readonly hooks: PreCommitHook[];
}

const UNCONDITIONAL: PreCommitRepo[] = [
  {
    repo: "https://github.com/pre-commit/pre-commit-hooks",
    hooks: [{ id: "check-merge-conflict", args: ["--assume-in-merge"] }, { id: "end-of-file-fixer" }, { id: "trailing-whitespace" }],
  },
  {
    repo: "https://github.com/macisamuele/language-formatters-pre-commit-hooks",
    hooks: [{ id: "pretty-format-yaml", args: ["--autofix"] }],
  },
];

const STACK_REPOS: Partial<Record<Stack, PreCommitRepo[]>> = {
  [Stack.PYTHON]: [
    {
      repo: "https://github.com/astral-sh/ruff-pre-commit",
      hooks: [{ id: "ruff-check", args: ["--fix"] }, { id: "ruff-format" }],
    },
    {
      repo: "https://github.com/pre-commit/mirrors-mypy",
      hooks: [{ id: "mypy" }],
    },
    {
      repo: "https://github.com/mxr/mirrors-ty",
      hooks: [{ id: "ty" }],
    },
    {
      repo: "https://github.com/mxr/sync-typing-deps",
      hooks: [{ id: "sync-typing-deps" }],
    },
    {
      repo: "https://github.com/pre-commit/pre-commit-hooks",
      hooks: [{ id: "debug-statements" }],
    },
  ],
  [Stack.TOML]: [
    {
      repo: "https://github.com/macisamuele/language-formatters-pre-commit-hooks",
      hooks: [{ id: "pretty-format-toml", args: ["--autofix", "--trailing-commas"] }],
    },
  ],
  [Stack.SQL]: [
    {
      repo: "https://github.com/sqlfluff/sqlfluff",
      hooks: [{ id: "sqlfluff-fix", args: ["--dialect", "sqlite"] }],
    },
  ],
  [Stack.JSON]: [
    {
      repo: "https://github.com/pre-commit/pre-commit-hooks",
      hooks: [{ id: "pretty-format-json", args: ["--autofix"], exclude: "package-lock.json" }],
    },
  ],
  [Stack.FRONTEND]: [
    {
      repo: "https://github.com/pre-commit/sync-pre-commit-deps",
      hooks: [
        {
          id: "sync-pre-commit-deps",
          args: ["--yaml-mapping=2", "--yaml-sequence=2", "--yaml-offset=0"],
        },
      ],
    },
    {
      repo: "https://github.com/biomejs/pre-commit",
      hooks: [{ id: "biome-check" }],
    },
    {
      repo: "local",
      hooks: [
        {
          id: "biome-migrate",
          name: "biome migrate",
          entry: "biome migrate --write",
          language: "node",
          additionalDependencies: ["@biomejs/biome@2.5.4"],
          files: "^\\.pre-commit-config\\.yaml$",
          passFilenames: false,
        },
      ],
    },
  ],
  [Stack.RUST]: [
    {
      repo: "https://github.com/AndrejOrsula/pre-commit-cargo",
      hooks: [
        { id: "cargo-fmt" },
        {
          id: "cargo-clippy",
          args: [
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
  [Stack.SHELL]: [
    {
      repo: "https://github.com/mxr/mirrors-shfmt",
      hooks: [{ id: "shfmt" }],
    },
    {
      repo: "https://github.com/shellcheck-py/shellcheck-py",
      hooks: [{ id: "shellcheck", types: ["shell"], excludeTypes: ["zsh"] }],
    },
  ],
  [Stack.GITHUB_ACTIONS]: [
    {
      repo: "https://github.com/zizmorcore/zizmor-pre-commit",
      hooks: [{ id: "zizmor", args: ["--no-progress", "--fix"] }],
    },
    {
      repo: "https://github.com/rhysd/actionlint",
      hooks: [
        {
          id: "actionlint",
          additionalDependencies: ["github.com/wasilibs/go-shellcheck/cmd/shellcheck@latest"],
        },
      ],
    },
  ],
};

/**
 * Merges hooks that share a `repo` url into a single entry (sorted by hook
 * id), assigns each non-local repo a placeholder `rev`, and sorts `local`
 * last.
 *
 * `pre-commit autoupdate --freeze` matches hooks structurally by repo url, so
 * the placeholder rev text itself doesn't matter.
 *
 * TODO: this merges hooks across all "repo: local" entries into one block,
 * which is wrong if there's ever more than one distinct local repo entry.
 * Fine for now since we only ever have a single local entry (biome-migrate).
 */
export function mergeRepos(entries: PreCommitRepo[]): PreCommitRepo[] {
  const hooksByRepo = new Map<string, PreCommitHook[]>();
  for (const entry of entries) {
    const hooks = hooksByRepo.get(entry.repo) ?? [];
    hooks.push(...entry.hooks);
    hooksByRepo.set(entry.repo, hooks);
  }

  const repos: (PreCommitRepo & { rev?: string })[] = [];
  for (const [repo, hooks] of hooksByRepo) {
    repos.push({
      repo,
      ...(repo === "local" ? {} : { rev: "v0.0.0" }),
      hooks: [...hooks].sort((a, b) => a.id.localeCompare(b.id)),
    });
  }

  return repos.sort((a, b) => {
    if ((a.repo === "local") !== (b.repo === "local")) {
      return a.repo === "local" ? 1 : -1;
    }
    return a.repo.localeCompare(b.repo);
  });
}

/**
 * Builds the merged, sorted `.pre-commit-config.yaml` `repos` list for the
 * given stacks.
 */
export function buildPreCommitRepos(stack: Stack[]): PreCommitRepo[] {
  // every Stack member has an entry in STACK_REPOS today; the fallback just
  // guards against a future stack being added to one without the other
  const entries = [...UNCONDITIONAL, ...stack.flatMap((name) => STACK_REPOS[name] ?? /* v8 ignore next */ [])];
  return mergeRepos(entries);
}

class InlineList extends Array<string | number | boolean> {
  static wrap(items: (string | number | boolean)[]): InlineList {
    const list = new InlineList();
    list.push(...items);
    return list;
  }
}

function inlineShortLists<T>(value: T): T {
  if (Array.isArray(value)) {
    const items = value.map((item) => inlineShortLists(item));
    const isScalarList = items.every((item) => ["string", "number", "boolean"].includes(typeof item));
    if (isScalarList && items.map(String).join(", ").length <= INLINE_LIST_MAX_WIDTH) {
      return InlineList.wrap(items as (string | number | boolean)[]) as unknown as T;
    }
    return items as unknown as T;
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, inlineShortLists(v)])) as T;
  }
  return value;
}

const SNAKE_CASE_KEYS: Record<string, string> = {
  additionalDependencies: "additional_dependencies",
  passFilenames: "pass_filenames",
  excludeTypes: "exclude_types",
};

function toSnakeCaseKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(toSnakeCaseKeys);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [SNAKE_CASE_KEYS[k] ?? k, toSnakeCaseKeys(v)]));
  }
  return value;
}

function sp(count: number): string {
  return " ".repeat(count);
}

function scalar(value: string | number | boolean): string {
  if (typeof value !== "string") {
    return String(value);
  }
  // only the YAML indicator characters that are actually ambiguous as the
  // *start* of a plain scalar (dash/question/colon followed by whitespace or
  // end-of-string, or any of the flow/quote/comment indicators) need
  // quoting; a leading "-" as in "--fix" is not one of them
  const needsQuoting =
    value === "" || /^[-?:](\s|$)/.test(value) || /^[,[\]{}#&*!|>'"%@`]/.test(value) || value.includes(": ") || value.endsWith(":");
  return needsQuoting ? JSON.stringify(value) : value;
}

function entryLines(key: string, value: unknown, indent: number, prefix: string): string[] {
  if (value instanceof InlineList) {
    return [`${prefix}${key}: [${value.map((item) => scalar(item)).join(", ")}]`];
  }
  if (Array.isArray(value)) {
    return [`${prefix}${key}:`, ...seqLines(value, indent)];
  }
  /* v8 ignore next 3 - defensive: no current hook field is object-valued */
  if (value !== null && typeof value === "object") {
    throw new Error(`unreachable: unsupported object-valued key "${key}"`);
  }
  return [`${prefix}${key}: ${scalar(value as string | number | boolean)}`];
}

function seqLines(items: readonly unknown[], indent: number): string[] {
  const lines: string[] = [];
  for (const item of items) {
    if (item !== null && typeof item === "object" && !Array.isArray(item)) {
      Object.entries(item as Record<string, unknown>).forEach(([k, v], i) => {
        const prefix = i === 0 ? `${sp(indent)}- ` : sp(indent + 2);
        lines.push(...entryLines(k, v, indent + 2, prefix));
      });
    } else {
      lines.push(`${sp(indent)}- ${scalar(item as string | number | boolean)}`);
    }
  }
  return lines;
}

/**
 * Renders the `.pre-commit-config.yaml` contents for the given stacks,
 * inlining short scalar lists (e.g. `args: [--fix]`) and leaving longer or
 * non-scalar ones as block lists.
 */
export function renderPreCommitConfig(stack: Stack[]): string {
  const repos = toSnakeCaseKeys(inlineShortLists(buildPreCommitRepos(stack)));
  return [...entryLines("repos", repos, 0, ""), ""].join("\n");
}
