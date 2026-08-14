import { buildPreCommitRepos, mergeRepos, renderPreCommitConfig } from "../src/pre-commit";
import { Stack } from "../src/stack";

describe("mergeRepos", () => {
  it("merges hooks for the same repo", () => {
    const result = mergeRepos([
      { repo: "https://x", hooks: [{ id: "b" }] },
      { repo: "https://x", hooks: [{ id: "a" }] },
    ]);
    expect(result).toEqual([{ repo: "https://x", rev: "v0.0.0-x", hooks: [{ id: "a" }, { id: "b" }] }]);
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
      "https://github.com/macisamuele/language-formatters-pre-commit-hooks",
      "https://github.com/pre-commit/pre-commit-hooks",
    ]);
  });

  it("puts the frontend local repo last, with no rev", () => {
    const repos = buildPreCommitRepos([Stack.FRONTEND]);
    expect(repos[repos.length - 1].repo).toBe("local");
    expect("rev" in repos[repos.length - 1]).toBe(false);
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
    expect(yaml.split("\n").slice(0, 6)).toEqual([
      "repos:",
      "- repo: https://github.com/macisamuele/language-formatters-pre-commit-hooks",
      "  rev: v0.0.0-language-formatters-pre-commit-hooks",
      "  hooks:",
      "  - id: pretty-format-yaml",
      "    args: [--autofix]",
    ]);
  });

  it("ends with a trailing newline", () => {
    expect(renderPreCommitConfig([])).toMatch(/\n$/);
  });
});
