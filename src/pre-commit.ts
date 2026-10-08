import { Document, isMap, isScalar, isSeq, parseDocument, Scalar, visit } from "yaml";
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

const DEFAULT: PreCommitRepo[] = [
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
    hooks: [
      {
        id: "mdformat",
        args: ["--number", "--wrap", "120"],
        additionalDependencies: ["mdformat-footnote", "mdformat-gfm", "mdformat-gfm-alerts"],
      },
    ],
  },
  {
    repo: "local",
    hooks: [
      {
        id: "biome-schema-version",
        name: "biome schema version",
        entry:
          'python3 -c \'import re, pathlib, subprocess; cfg = pathlib.Path(".pre-commit-config.yaml").read_text(); ver = re.search(r"biomejs/pre-commit.*?frozen: v([0-9.]+)", cfg, re.S)[1]; paths = subprocess.check_output(["git", "ls-files", ":(glob)**/biome.json"], text=True).splitlines(); [p.write_text(re.sub(r"schemas/[^/]+/schema\\.json", f"schemas/{ver}/schema.json", p.read_text())) for p in map(pathlib.Path, paths)]\'',
        language: "python",
        files: "(^|/)biome\\.json$|^\\.pre-commit-config\\.yaml$",
        passFilenames: false,
      },
    ],
  },
];

const GITIGNORE_TIDY_REPO: PreCommitRepo = {
  repo: "https://github.com/lorenzwalthert/gitignore-tidy",
  hooks: [{ id: "tidy-gitignore" }],
};

const STACK_REPOS: Partial<Record<Stack, PreCommitRepo[]>> = {
  [Stack.FRONTEND]: [],
  [Stack.GITIGNORE]: [GITIGNORE_TIDY_REPO],
  [Stack.JAVASCRIPT]: [],
  [Stack.MIRROR]: [],
  [Stack.TYPESCRIPT]: [],
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
      repo: "https://github.com/mxr/pyright-pre-commit",
      hooks: [{ id: "pyright" }],
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
      hooks: [{ id: "check-docstring-first" }, { id: "debug-statements" }],
    },
  ],
  [Stack.TOML]: [
    {
      repo: "https://github.com/tombi-toml/tombi-pre-commit",
      hooks: [{ id: "tombi-format", args: ["--offline", "--quiet"] }],
    },
  ],
  [Stack.SQL]: [
    {
      repo: "https://github.com/sqlfluff/sqlfluff",
      hooks: [{ id: "sqlfluff-fix", args: ["--dialect", "sqlite"] }],
    },
    {
      repo: "https://github.com/adamtheturtle/doccmd-pre-commit",
      hooks: [
        {
          id: "doccmd",
          name: "doccmd-sqlfluff",
          args: ["--no-pad-file", "--language", "sql", "--command", "sqlfluff fix --dialect sqlite"],
          additionalDependencies: ["sqlfluff"],
        },
      ],
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
  [Stack.FRONTEND]: [Stack.GITHUB_ACTIONS, Stack.GITIGNORE],
  [Stack.JAVASCRIPT]: [Stack.GITHUB_ACTIONS],
  [Stack.MIRROR]: [Stack.GITHUB_ACTIONS],
  [Stack.PYTHON]: [Stack.TOML, Stack.GITHUB_ACTIONS],
  [Stack.RUST]: [Stack.TOML, Stack.GITHUB_ACTIONS, Stack.GITIGNORE],
  [Stack.SQL]: [Stack.TOML],
  [Stack.TYPESCRIPT]: [Stack.GITHUB_ACTIONS, Stack.GITIGNORE],
};

export function expandStacks(stack: Stack[]): Stack[] {
  return [...new Set(stack.flatMap((name) => [name, ...(IMPLIED_STACKS[name] ?? [])]))];
}

/**
 * Generated files that a formatter hook should skip, keyed by hook id then
 * stack, to avoid diff noise, e.g. toml lockfiles for tombi-format, and the
 * pre-commit-mirror-maker-rendered `.pre-commit-hooks.yaml` (whose style
 * pretty-format-yaml would otherwise flip on every mirror release).
 */
const GENERATED_FILES: Record<string, Partial<Record<Stack, string[]>>> = {
  "tombi-format": {
    [Stack.PYTHON]: ["uv.lock"],
    [Stack.RUST]: ["Cargo.lock"],
  },
  "pretty-format-yaml": {
    [Stack.MIRROR]: [".pre-commit-hooks.yaml"],
  },
};

/**
 * A hook's pinned `rev` from an existing `.pre-commit-config.yaml`, plus its
 * inline comment (e.g. `frozen: v2.5.14` from `pre-commit autoupdate --freeze`)
 * so re-synthing doesn't drop it.
 */
export interface ExistingRev {
  readonly rev: string;
  readonly comment?: string;
}

/**
 * Parses a downstream repo's current `.pre-commit-config.yaml` (if any) into
 * a `repo` url -> `rev` map, so a re-synth can keep an already-pinned hook at
 * its existing rev instead of resetting it to the `v0.0.0` placeholder that
 * `pre-commit autoupdate --freeze` would then re-resolve on every synth.
 */
export function readExistingRevs(configYaml: string): Map<string, ExistingRev> {
  const revs = new Map<string, ExistingRev>();
  const repos = parseDocument(configYaml).get("repos");
  if (!isSeq(repos)) {
    return revs;
  }
  for (const item of repos.items) {
    if (!isMap(item)) {
      continue;
    }
    const repo = item.get("repo");
    const rev = item.get("rev", true);
    if (typeof repo === "string" && isScalar(rev) && rev.value) {
      const comment = rev.comment?.trim();
      revs.set(repo, { rev: String(rev.value), ...(comment ? { comment } : {}) });
    }
  }
  return revs;
}

/**
 * Merges hooks that share a `repo` url into a single entry (sorted by hook
 * id), and sorts `local` last.
 *
 * Each non-local repo keeps its rev from `existingRevs` (the downstream
 * repo's current `.pre-commit-config.yaml`) when one exists, so a re-synth
 * doesn't touch a hook that's already pinned. A repo with no existing rev
 * (i.e. a newly added hook) gets the `v0.0.0` placeholder instead -
 * `pre-commit autoupdate --freeze` matches hooks structurally by repo url, so
 * the placeholder rev text itself doesn't matter, only that it's a value
 * `autoupdate` will treat as needing resolution.
 *
 * TODO: this merges hooks across all "repo: local" entries into one block,
 * which is wrong if there's ever more than one distinct local repo entry.
 * Fine for now since we only ever have a single local entry (biome-schema-version).
 */
export function mergeRepos(entries: PreCommitRepo[], existingRevs?: ReadonlyMap<string, ExistingRev>): PreCommitRepo[] {
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
      ...(repo === "local" ? {} : { rev: existingRevs?.get(repo)?.rev ?? "v0.0.0" }),
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
export function buildPreCommitRepos(stack: Stack[], existingRevs?: ReadonlyMap<string, ExistingRev>): PreCommitRepo[] {
  // every Stack member has an entry in STACK_REPOS today; the fallback just
  // guards against a future stack being added to one without the other
  const entries = [...DEFAULT, ...expandStacks(stack).flatMap((name) => STACK_REPOS[name] ?? /* v8 ignore next */ [])];
  const repos = mergeRepos(entries, existingRevs);
  return repos.map((repo) => ({
    ...repo,
    hooks: repo.hooks.map((hook) => {
      const files = stack.flatMap((name) => GENERATED_FILES[hook.id]?.[name] ?? []);
      if (files.length === 0) {
        return hook;
      }
      return { ...hook, exclude: `^(${files.map((file) => file.replaceAll(".", "\\.")).join("|")})$` };
    }),
  }));
}

/**
 * The non-local repo urls that got the `v0.0.0` placeholder rev, i.e. hooks
 * newly added to this stack combination that aren't in the downstream repo's
 * current `.pre-commit-config.yaml` yet. Scopes `pre-commit autoupdate
 * --freeze` (via `--repo`) to just these, leaving already-pinned hooks alone.
 */
export function newRepoUrls(stack: Stack[], existingRevs?: ReadonlyMap<string, ExistingRev>): string[] {
  return buildPreCommitRepos(stack, existingRevs)
    .filter((repo) => repo.repo !== "local" && (repo as { rev?: string }).rev === "v0.0.0")
    .map((repo) => repo.repo);
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
 *
 * `pythonMinVersion` (e.g. `"3.11"`) sets the file's top-level
 * `default_language_version.python`, so individual Python hooks (mypy, ty,
 * etc.) don't need their own per-hook `language_version`.
 *
 * `exclude` regexes are combined into the file's top-level `exclude`, one
 * alternative per line in a verbose regex.
 */
export function renderPreCommitConfig(
  stack: Stack[],
  pythonMinVersion?: string,
  existingRevs?: ReadonlyMap<string, ExistingRev>,
  exclude?: readonly string[],
): string {
  const repos = toSnakeCaseKeys(buildPreCommitRepos(stack, existingRevs));
  const doc = new Document({
    ...(pythonMinVersion ? { default_language_version: { python: `python${pythonMinVersion}` } } : {}),
    ...(exclude?.length ? { exclude: `(?x)^(\n${exclude.map((pattern) => `    ${pattern}`).join("|\n")}\n)$\n` } : {}),
    repos,
  });
  const excludeNode = doc.get("exclude", true);
  if (isScalar(excludeNode)) {
    excludeNode.type = Scalar.BLOCK_LITERAL;
  }

  visit(doc, {
    Map(_, node) {
      const repo = node.get("repo");
      const rev = node.get("rev", true);
      const comment = typeof repo === "string" ? existingRevs?.get(repo)?.comment : undefined;
      if (comment && isScalar(rev)) {
        rev.comment = ` ${comment}`;
      }
    },
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

  // yaml emits one space before an inline comment, but `pre-commit autoupdate
  // --freeze` writes two (`rev: <sha>  # frozen: <ref>`) and no formatter
  // hook normalizes it, so match freeze's own spacing
  return doc.toString({ indentSeq: false, lineWidth: 0, flowCollectionPadding: false }).replace(/^(\s*rev: \S+) # /gm, "$1  # ");
}
