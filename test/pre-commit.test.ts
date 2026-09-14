import { buildCiSkip, buildPreCommitRepos, mergeRepos, renderPreCommitConfig } from "../src/pre-commit.ts";
import { Stack } from "../src/stack.ts";

describe("mergeRepos", () => {
  it("merges hooks for the same repo", () => {
    const result = mergeRepos([
      { repo: "https://x", hooks: [{ id: "b" }] },
      { repo: "https://x", hooks: [{ id: "a" }] },
    ]);
    expect(result).toEqual([{ repo: "https://x", rev: "v0.0.0", hooks: [{ id: "a" }, { id: "b" }] }]);
  });

  it.each([
    ["https://x", true],
    ["local", false],
  ])("sets rev for %s: %s", (repo, expectRev) => {
    const [result] = mergeRepos([{ repo, hooks: [{ id: "a" }] }]);
    expect("rev" in result).toBe(expectRev);
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
    expect(result.hooks.map((h) => h.id)).toEqual(["a", "b"]);
  });
});

describe("buildPreCommitRepos", () => {
  it("has only the unconditional repos for an empty stack", () => {
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
    const repos = buildPreCommitRepos([Stack.python]);
    expect(repos.at(-1).repo).toBe("local");
    expect("rev" in repos.at(-1)).toBe(false);
  });

  it("pulls in toml and github-actions hooks for a rust stack", () => {
    const repos = buildPreCommitRepos([Stack.rust]);
    expect(repos.map((r) => r.repo)).toEqual(
      expect.arrayContaining([
        "https://github.com/macisamuele/language-formatters-pre-commit-hooks",
        "https://github.com/rhysd/actionlint",
        "https://github.com/zizmorcore/zizmor-pre-commit",
      ]),
    );
    const formatters = repos.find((r) => r.repo === "https://github.com/macisamuele/language-formatters-pre-commit-hooks");
    expect(formatters?.hooks.map((h) => h.id)).toEqual(expect.arrayContaining(["pretty-format-toml", "pretty-format-yaml"]));
  });

  it("excludes Cargo.lock from pretty-format-toml", () => {
    const repos = buildPreCommitRepos([Stack.toml]);
    const formatters = repos.find((r) => r.repo === "https://github.com/macisamuele/language-formatters-pre-commit-hooks");
    expect(formatters?.hooks.find((h) => h.id === "pretty-format-toml")?.exclude).toBe("Cargo.lock");
  });

  it("includes gitignore-tidy for a rust stack", () => {
    const repos = buildPreCommitRepos([Stack.rust]);
    expect(repos.map((r) => r.repo)).toContain("https://github.com/lorenzwalthert/gitignore-tidy");
  });

  it("includes gitignore-tidy for a frontend stack", () => {
    const repos = buildPreCommitRepos([Stack.frontend]);
    expect(repos.map((r) => r.repo)).toContain("https://github.com/lorenzwalthert/gitignore-tidy");
  });

  it("pulls in github-actions hooks for a javascript stack", () => {
    const repos = buildPreCommitRepos([Stack.javascript]);
    expect(repos.map((r) => r.repo)).toEqual(
      expect.arrayContaining(["https://github.com/rhysd/actionlint", "https://github.com/zizmorcore/zizmor-pre-commit"]),
    );
  });

  it("excludes gitignore-tidy for a javascript stack", () => {
    const repos = buildPreCommitRepos([Stack.javascript]);
    expect(repos.map((r) => r.repo)).not.toContain("https://github.com/lorenzwalthert/gitignore-tidy");
  });
});

describe("buildCiSkip", () => {
  it("is empty for a stack with nothing to skip", () => {
    expect(buildCiSkip([Stack.python])).toEqual([]);
  });

  it("skips clippy for a rust stack", () => {
    expect(buildCiSkip([Stack.rust])).toEqual(["clippy"]);
  });
});

const TRAILING_NEWLINE = /\n$/;

describe("renderPreCommitConfig", () => {
  it("inlines short scalar lists but not long or non-scalar ones", () => {
    const yaml = renderPreCommitConfig([Stack.python, Stack.githubActions]);
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
    expect(renderPreCommitConfig([])).toMatch(TRAILING_NEWLINE);
  });

  it("renders long scalar lists as an indentless block sequence", () => {
    const yaml = renderPreCommitConfig([Stack.rust]);
    expect(yaml).toContain("    args:\n    - --all-targets\n    - --locked");
  });
});
