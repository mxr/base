import { buildPreCommitRepos, mergeRepos, newRepoUrls, readExistingRevs, renderPreCommitConfig } from "../src/pre-commit";
import { Stack } from "../src/stack";

describe("readExistingRevs", () => {
  it("maps repo url to rev, skipping local and revless entries", () => {
    const revs = readExistingRevs(
      ["repos:", "- repo: https://x", "  rev: v1.2.3", "  hooks: []", "- repo: local", "  hooks: []"].join("\n"),
    );
    expect(revs).toEqual(new Map([["https://x", { rev: "v1.2.3", comment: undefined }]]));
  });

  it("keeps the inline frozen comment", () => {
    const revs = readExistingRevs(["repos:", "- repo: https://x", "  rev: abc123  # frozen: v1.2.3", "  hooks: []"].join("\n"));
    expect(revs).toEqual(new Map([["https://x", { rev: "abc123", comment: "frozen: v1.2.3" }]]));
  });

  it("returns an empty map for a config with no repos", () => {
    expect(readExistingRevs("repos: []")).toEqual(new Map());
  });
});

describe("renderPreCommitConfig", () => {
  it("re-emits the frozen comment for an already-pinned hook", () => {
    const [firstRepo] = buildPreCommitRepos([]);
    if (!firstRepo) throw new Error("expected a repo");
    const rendered = renderPreCommitConfig([], undefined, new Map([[firstRepo.repo, { rev: "abc123", comment: "frozen: v1.2.3" }]]));
    expect(rendered).toContain("rev: abc123  # frozen: v1.2.3\n");
  });
});

describe("mergeRepos", () => {
  it("merges hooks for the same repo", () => {
    const result = mergeRepos([
      { repo: "https://x", hooks: [{ id: "b" }] },
      { repo: "https://x", hooks: [{ id: "a" }] },
    ]);
    expect(result).toEqual([{ repo: "https://x", rev: "v0.0.0", hooks: [{ id: "a" }, { id: "b" }] }]);
  });

  it("keeps an existing rev instead of the placeholder", () => {
    const [result] = mergeRepos([{ repo: "https://x", hooks: [{ id: "a" }] }], new Map([["https://x", { rev: "v1.2.3" }]]));
    expect(result).toMatchObject({ rev: "v1.2.3" });
  });

  it("falls back to the placeholder for a repo with no existing rev", () => {
    const [result] = mergeRepos([{ repo: "https://x", hooks: [{ id: "a" }] }], new Map([["https://y", { rev: "v1.2.3" }]]));
    expect(result).toMatchObject({ rev: "v0.0.0" });
  });

  it.each([
    ["https://x", true],
    ["local", false],
  ])("sets rev for %s: %s", (repo, expectRev) => {
    const [result] = mergeRepos([{ repo, hooks: [{ id: "a" }] }]);
    expect(result !== undefined && "rev" in result).toBe(expectRev);
  });

  it("sorts local last and everything else alphabetically", () => {
    const result = mergeRepos([
      { repo: "local", hooks: [{ id: "z" }] },
      { repo: "https://b", hooks: [{ id: "a" }] },
      { repo: "https://a", hooks: [{ id: "a" }] },
    ]);
    expect(result.map((r) => r.repo)).toEqual(["https://a", "https://b", "local"]);
  });

  it("sorts hooks by id", () => {
    const [result] = mergeRepos([{ repo: "https://x", hooks: [{ id: "b" }, { id: "a" }] }]);
    expect(result?.hooks.map((h) => h.id)).toEqual(["a", "b"]);
  });
});

describe("buildPreCommitRepos", () => {
  it("has only the default repos for an empty stack", () => {
    const repos = buildPreCommitRepos([]);
    expect(repos.map((r) => r.repo)).toEqual([
      "https://github.com/biomejs/pre-commit",
      "https://github.com/hukkin/mdformat",
      "https://github.com/macisamuele/language-formatters-pre-commit-hooks",
      "https://github.com/pre-commit/pre-commit-hooks",
      "local",
    ]);
  });

  it("puts the local repo last, with no rev, regardless of stack", () => {
    const repos = buildPreCommitRepos([Stack.PYTHON]);
    expect(repos.at(-1)?.repo).toBe("local");
    expect(repos.at(-1)).not.toHaveProperty("rev");
  });

  it("includes check-docstring-first and the pyright-pre-commit hook for a python stack", () => {
    const repos = buildPreCommitRepos([Stack.PYTHON]);
    const hooks = repos.find((r) => r.repo === "https://github.com/pre-commit/pre-commit-hooks");
    expect(hooks?.hooks.map((h) => h.id)).toEqual(expect.arrayContaining(["check-docstring-first", "debug-statements"]));
    expect(repos.map((r) => r.repo)).toContain("https://github.com/mxr/pyright-pre-commit");
  });

  it.each([
    { name: "python", stack: Stack.PYTHON },
    { name: "sql", stack: Stack.SQL },
  ])("pulls in toml hooks for a $name stack", ({ stack }) => {
    const repos = buildPreCommitRepos([stack]);
    const tombi = repos.find((r) => r.repo === "https://github.com/tombi-toml/tombi-pre-commit");
    expect(tombi?.hooks.map((h) => h.id)).toEqual(["tombi-format"]);
  });

  it("pulls in toml and github-actions hooks for a rust stack", () => {
    const repos = buildPreCommitRepos([Stack.RUST]);
    expect(repos.map((r) => r.repo)).toEqual(
      expect.arrayContaining([
        "https://github.com/rhysd/actionlint",
        "https://github.com/tombi-toml/tombi-pre-commit",
        "https://github.com/zizmorcore/zizmor-pre-commit",
      ]),
    );
    const tombi = repos.find((r) => r.repo === "https://github.com/tombi-toml/tombi-pre-commit");
    expect(tombi?.hooks.map((h) => h.id)).toEqual(["tombi-format"]);
  });

  it.each([
    { name: "rust", stack: [Stack.RUST], exclude: "^(Cargo\\.lock)$" },
    { name: "python", stack: [Stack.PYTHON], exclude: "^(uv\\.lock)$" },
    { name: "python and rust", stack: [Stack.PYTHON, Stack.RUST], exclude: "^(uv\\.lock|Cargo\\.lock)$" },
    { name: "toml", stack: [Stack.TOML], exclude: undefined },
  ])("sets tombi-format lockfile exclude for $name stack", ({ stack, exclude }) => {
    const tombi = buildPreCommitRepos(stack).find((r) => r.repo === "https://github.com/tombi-toml/tombi-pre-commit");
    expect(tombi?.hooks.find((h) => h.id === "tombi-format")?.exclude).toBe(exclude);
  });

  it("includes gitignore-tidy for a rust stack", () => {
    const repos = buildPreCommitRepos([Stack.RUST]);
    expect(repos.map((r) => r.repo)).toContain("https://github.com/lorenzwalthert/gitignore-tidy");
  });

  it("includes gitignore-tidy for a frontend stack", () => {
    const repos = buildPreCommitRepos([Stack.FRONTEND]);
    expect(repos.map((r) => r.repo)).toContain("https://github.com/lorenzwalthert/gitignore-tidy");
  });

  it("pulls in github-actions hooks for a javascript stack", () => {
    const repos = buildPreCommitRepos([Stack.JAVASCRIPT]);
    expect(repos.map((r) => r.repo)).toEqual(
      expect.arrayContaining(["https://github.com/rhysd/actionlint", "https://github.com/zizmorcore/zizmor-pre-commit"]),
    );
  });

  it("pulls in github-actions hooks for a mirror stack", () => {
    const repos = buildPreCommitRepos([Stack.MIRROR]);
    expect(repos.map((r) => r.repo)).toEqual(
      expect.arrayContaining(["https://github.com/rhysd/actionlint", "https://github.com/zizmorcore/zizmor-pre-commit"]),
    );
  });

  it("pulls in github-actions hooks and gitignore-tidy for a typescript stack", () => {
    const repos = buildPreCommitRepos([Stack.TYPESCRIPT]).map((r) => r.repo);
    expect(repos).toContain("https://github.com/rhysd/actionlint");
    expect(repos).toContain("https://github.com/lorenzwalthert/gitignore-tidy");
  });

  it("excludes gitignore-tidy for a javascript stack", () => {
    const repos = buildPreCommitRepos([Stack.JAVASCRIPT]);
    expect(repos.map((r) => r.repo)).not.toContain("https://github.com/lorenzwalthert/gitignore-tidy");
  });
});

describe("newRepoUrls", () => {
  it("lists every non-local repo when there are no existing revs", () => {
    const urls = newRepoUrls([Stack.TOML]);
    expect(urls).toEqual(
      buildPreCommitRepos([Stack.TOML])
        .filter((r) => r.repo !== "local")
        .map((r) => r.repo),
    );
  });

  it("excludes a repo that already has an existing rev", () => {
    const [firstRepo] = buildPreCommitRepos([]).filter((r) => r.repo !== "local");
    if (!firstRepo) throw new Error("expected a remote repo");
    const urls = newRepoUrls([], new Map([[firstRepo.repo, { rev: "v1.2.3" }]]));
    expect(urls).not.toContain(firstRepo.repo);
  });
});

describe("renderPreCommitConfig", () => {
  it("inlines short scalar lists but not long or non-scalar ones", () => {
    const yaml = renderPreCommitConfig([Stack.PYTHON, Stack.GITHUB_ACTIONS]);
    expect(yaml).toContain("args: [--fix]");
    // additional_dependencies for actionlint is a single long url, still scalar-list-inlined
    expect(yaml).toContain("additional_dependencies: [github.com/wasilibs/go-shellcheck/cmd/shellcheck@latest]");
    // ty/mypy get seeded with several deps by sync-typing-deps downstream, not by us: no additional_dependencies here at all
    expect(yaml).not.toContain("additional_dependencies:\n");
  });

  it("renders block hooks under their repo at the same indent, sequence items indentless", () => {
    const yaml = renderPreCommitConfig([]);
    expect(yaml.split("\n").slice(0, 8)).toEqual([
      "repos:",
      "- repo: https://github.com/biomejs/pre-commit",
      "  rev: v0.0.0",
      "  hooks:",
      "  - id: biome-check",
      "- repo: https://github.com/hukkin/mdformat",
      "  rev: v0.0.0",
      "  hooks:",
    ]);
  });

  it("ends with a trailing newline", () => {
    expect(renderPreCommitConfig([])).toMatch(/\n$/);
  });

  it("renders long scalar lists as an indentless block sequence", () => {
    const yaml = renderPreCommitConfig([Stack.RUST]);
    expect(yaml).toContain("    args:\n    - --all-targets\n    - --locked");
  });

  it("renders default_language_version.python when given, and omits it otherwise", () => {
    expect(renderPreCommitConfig([Stack.PYTHON], "3.11")).toMatch(/^default_language_version:\n {2}python: python3\.11\nrepos:/);
    expect(renderPreCommitConfig([Stack.PYTHON])).not.toContain("default_language_version");
  });

  it("omits the top-level exclude when empty", () => {
    expect(renderPreCommitConfig([], undefined, undefined, [])).toMatch(/^repos:/);
  });
});
