import { Document, isScalar, Scalar, visit } from "yaml";
import { Stack } from "./stack";

const INLINE_LIST_MAX_WIDTH = 60;

/**
 * Field names are camelCase here but rendered as snake_case keys in
 * `.pre-commit-config.yaml` (pre-commit's own convention), e.g.
 * `additionalDependencies` -> `additional_dependencies`. See {@link toSnakeCaseKeys}.
 */
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
  {
    repo: "https://github.com/biomejs/pre-commit",
    hooks: [{ id: "biome-check" }],
  },
  {
    repo: "https://github.com/hukkin/mdformat",
    hooks: [{ id: "mdformat", args: ["--number", "--wrap", "120"], additionalDependencies: ["mdformat-gfm"] }],
  },
  {
    repo: "local",
    hooks: [
      {
        id: "biome-schema-version",
        name: "biome schema version",
        entry:
          'python3 -c \'import re, pathlib; cfg = pathlib.Path(".pre-commit-config.yaml").read_text(); ver = re.search(r"biomejs/pre-commit.*?frozen: v([0-9.]+)", cfg, re.S)[1]; p = pathlib.Path("biome.json"); p.write_text(re.sub(r"schemas/[^/]+/schema\\.json", f"schemas/{ver}/schema.json", p.read_text()))\'',
        language: "python",
        files: "^(biome\\.json|\\.pre-commit-config\\.yaml)$",
        passFilenames: false,
      },
    ],
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
      hooks: [{ id: "pretty-format-toml", args: ["--autofix", "--trailing-commas"], exclude: "Cargo.lock" }],
    },
  ],
  [Stack.SQL]: [
    {
      repo: "https://github.com/sqlfluff/sqlfluff",
      hooks: [{ id: "sqlfluff-fix", args: ["--dialect", "sqlite"] }],
    },
  ],
  [Stack.RUST]: [
    {
      repo: "https://github.com/AndrejOrsula/pre-commit-cargo",
      hooks: [{ id: "cargo-fmt" }],
    },
    {
      repo: "https://github.com/doublify/pre-commit-rust",
      hooks: [
        { id: "fmt" },
        {
          id: "clippy",
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
      hooks: [{ id: "shellcheck" }],
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
 * Stacks that pull in another stack's hooks alongside their own, e.g. every
 * rust repo also wants toml formatting and GitHub Actions linting.
 */
const IMPLIED_STACKS: Partial<Record<Stack, Stack[]>> = {
  [Stack.FRONTEND]: [Stack.GITHUB_ACTIONS],
  [Stack.RUST]: [Stack.TOML, Stack.GITHUB_ACTIONS],
};

function expandStacks(stack: Stack[]): Stack[] {
  return [...new Set(stack.flatMap((name) => [name, ...(IMPLIED_STACKS[name] ?? [])]))];
}

/**
 * Hook ids that pre-commit.ci should skip for a given stack, keyed by why:
 * rust's `clippy` already runs via GitHub Actions, since pre-commit.ci's
 * containers don't keep a project's own crate versions in sync.
 */
const CI_SKIP: Partial<Record<Stack, string[]>> = {
  [Stack.RUST]: ["clippy"],
};

/**
 * Builds the `ci.skip` hook id list for the given stacks, deduplicated.
 */
export function buildCiSkip(stack: Stack[]): string[] {
  return [...new Set(stack.flatMap((name) => CI_SKIP[name] ?? []))];
}

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
 * Fine for now since we only ever have a single local entry (biome-schema-version).
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
  const entries = [...UNCONDITIONAL, ...expandStacks(stack).flatMap((name) => STACK_REPOS[name] ?? /* v8 ignore next */ [])];
  return mergeRepos(entries);
}

function toSnakeCaseKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(toSnakeCaseKeys);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`), toSnakeCaseKeys(v)]),
    );
  }
  return value;
}

/**
 * Renders the `.pre-commit-config.yaml` contents for the given stacks,
 * inlining short scalar lists (e.g. `args: [--fix]`) and leaving longer or
 * non-scalar ones as block lists.
 */
export function renderPreCommitConfig(stack: Stack[]): string {
  const repos = toSnakeCaseKeys(buildPreCommitRepos(stack));
  const doc = new Document({ repos });

  visit(doc, {
    Seq(_, node) {
      const values = node.items.map((item) => (isScalar(item) ? item.value : item));
      const isScalarList = values.every((value) => ["string", "number", "boolean"].includes(typeof value));
      if (isScalarList && values.map(String).join(", ").length <= INLINE_LIST_MAX_WIDTH) {
        node.flow = true;
      }
    },
    Pair(_, pair) {
      if (isScalar(pair.key) && pair.key.value === "entry" && isScalar(pair.value) && typeof pair.value.value === "string") {
        pair.value.type = Scalar.BLOCK_LITERAL;
      }
    },
  });

  return doc.toString({ indentSeq: false, lineWidth: 0, flowCollectionPadding: false });
}
