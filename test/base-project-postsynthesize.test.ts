import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const realChildProcess = jest.requireActual<typeof import("child_process")>("child_process");
const execFileSyncMock = jest.fn<ReturnType<typeof realChildProcess.execFileSync>, Parameters<typeof realChildProcess.execFileSync>>();

jest.mock("child_process", () => ({
  ...jest.requireActual("child_process"),
  execFileSync: (...args: Parameters<typeof realChildProcess.execFileSync>) => execFileSyncMock(...args),
}));

import { BANNER } from "../src/banner";
import { BaseProject } from "../src/base-project";
import { buildPreCommitRepos } from "../src/pre-commit";
import { MANAGED_MARKER } from "../src/pyproject";
import { PythonPackaging, Stack } from "../src/stack";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function outdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "base-projen-postsynth-"));
}

// pinact/pre-commit run as a gather-style `sh -c` script (see
// runTasksInParallelIgnoringFailure in base-project.ts) rather than as their
// own direct execFileSync calls, so assert against that script's contents
function shCallScript(mock: jest.Mock): string {
  const call = mock.mock.calls.find(([cmd]) => cmd === "sh");
  return (call?.[1] as string[] | undefined)?.[1] ?? "";
}

describe("BaseProject.postSynthesize with a mocked git/pre-commit binary", () => {
  afterEach(() => {
    execFileSyncMock.mockReset();
  });

  it("cleans up projen scaffolding and runs pre-commit inside a git repo", () => {
    const dir = outdir();
    realChildProcess.execFileSync("git", ["init", "-q"], { cwd: dir });
    const project = new BaseProject({ name: "test", stack: [], outdir: dir });

    execFileSyncMock.mockImplementation((cmd, args) => {
      if (cmd === "git") {
        return realChildProcess.execFileSync(cmd, args as string[], { cwd: dir });
      }
      if (Array.isArray(args) && args.includes("autoupdate")) {
        throw new Error("simulated autoupdate failure");
      }
      return "";
    });

    project.synth();

    expect(fs.existsSync(path.join(dir, ".gitignore"))).toBe(false);
    expect(fs.existsSync(path.join(dir, ".gitattributes"))).toBe(false);
    expect(fs.existsSync(path.join(dir, ".projen"))).toBe(false);
    expect(execFileSyncMock).toHaveBeenCalledWith("chmod", ["-R", "u+w", dir]);
    expect(execFileSyncMock).toHaveBeenCalledWith("pre-commit", ["run", "--all-files"], { cwd: dir, stdio: "inherit" });
    // no pre-existing .pre-commit-config.yaml, so every default repo counts
    // as newly added and gets scoped into autoupdate --freeze, run via the
    // gather-style `sh -c` script (see runTasksInParallelIgnoringFailure)
    const defaultRepoUrls = buildPreCommitRepos([])
      .map((r) => r.repo)
      .filter((repo) => repo !== "local");
    const shScript = shCallScript(execFileSyncMock);
    expect(shScript).toContain("autoupdate");
    for (const repo of defaultRepoUrls) {
      expect(shScript).toContain(repo);
    }
  });

  it("skips autoupdate when every hook already has a pinned rev", () => {
    const dir = outdir();
    realChildProcess.execFileSync("git", ["init", "-q"], { cwd: dir });

    const existingRepoUrls = buildPreCommitRepos([])
      .map((r) => r.repo)
      .filter((repo) => repo !== "local");
    fs.writeFileSync(
      path.join(dir, ".pre-commit-config.yaml"),
      ["repos:", ...existingRepoUrls.flatMap((repo) => [`- repo: ${repo}`, "  rev: v9.9.9", "  hooks: []"])].join("\n"),
    );

    const project = new BaseProject({ name: "test", stack: [], outdir: dir });

    execFileSyncMock.mockImplementation((cmd, args) => {
      if (cmd === "git") {
        return realChildProcess.execFileSync(cmd, args as string[], { cwd: dir });
      }
      return "";
    });

    project.synth();

    expect(shCallScript(execFileSyncMock)).not.toContain("autoupdate");
    expect(fs.readFileSync(path.join(dir, ".pre-commit-config.yaml"), "utf-8")).toContain("rev: v9.9.9");
  });

  it("writes a /target/ gitignore for a rust stack, and runs pinact", () => {
    const dir = outdir();
    realChildProcess.execFileSync("git", ["init", "-q"], { cwd: dir });
    const project = new BaseProject({ name: "test", stack: [Stack.RUST], outdir: dir });

    execFileSyncMock.mockImplementation((cmd, args) => {
      if (cmd === "git") {
        return realChildProcess.execFileSync(cmd, args as string[], { cwd: dir });
      }
      return "";
    });

    project.synth();

    expect(fs.readFileSync(path.join(dir, ".gitignore"), "utf-8")).toBe(`# ${BANNER}\n/target/\n`);
    expect(shCallScript(execFileSyncMock)).toContain("'pinact' 'run' '-u' '-i' '^actions/checkout$'");
  });

  it("runs pinact for a frontend stack, and excludes Next.js build/env artifacts from .gitignore", () => {
    const dir = outdir();
    realChildProcess.execFileSync("git", ["init", "-q"], { cwd: dir });
    const project = new BaseProject({ name: "test", stack: [Stack.FRONTEND], outdir: dir });

    execFileSyncMock.mockImplementation((cmd, args) => {
      if (cmd === "git") {
        return realChildProcess.execFileSync(cmd, args as string[], { cwd: dir });
      }
      return "";
    });

    project.synth();

    expect(shCallScript(execFileSyncMock)).toContain("'pinact' 'run' '-u' '-i' '^actions/checkout$'");
    const gitignore = fs.readFileSync(path.join(dir, ".gitignore"), "utf-8");
    expect(gitignore).toContain("/.next/");
    expect(gitignore).toContain(".env*");
    expect(gitignore).toContain("next-env.d.ts");
  });

  it("runs pinact for a mirror stack", () => {
    const dir = outdir();
    realChildProcess.execFileSync("git", ["init", "-q"], { cwd: dir });
    const project = new BaseProject({
      name: "test",
      stack: [Stack.MIRROR],
      outdir: dir,
      opt: {
        mirror: {
          command: "pre-commit-mirror . --language python --package-name ty --id ty --entry 'ty check' --types python",
        },
      },
    });

    execFileSyncMock.mockImplementation((cmd, args) => {
      if (cmd === "git") {
        return realChildProcess.execFileSync(cmd, args as string[], { cwd: dir });
      }
      return "";
    });

    project.synth();

    expect(shCallScript(execFileSyncMock)).toContain("'pinact' 'run' '-u' '-i' '^actions/checkout$'");
  });

  it("keeps existing action refs and only pins newly added actions with pinact", () => {
    const dir = outdir();
    realChildProcess.execFileSync("git", ["init", "-q"], { cwd: dir });
    fs.mkdirSync(path.join(dir, ".github", "workflows"), { recursive: true });
    const sha = "a".repeat(40);
    fs.writeFileSync(
      path.join(dir, ".github", "workflows", "main.yml"),
      [
        `- uses: actions/checkout@${sha} # v1.2.3`,
        `- uses: dorny/paths-filter@${sha} # v4.5.6`,
        `- uses: actions-rust-lang/setup-rust-toolchain@${sha} # v2.0.0`,
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(dir, ".github", "workflows", "release.yml"),
      [
        `- uses: actions/checkout@${sha} # v1.2.3`,
        `- uses: actions-rust-lang/setup-rust-toolchain@${sha} # v2.0.0`,
        `- uses: rust-lang/crates-io-auth-action@${sha} # v1.0.5`,
      ].join("\n"),
    );
    const project = new BaseProject({ name: "test", stack: [Stack.RUST], outdir: dir });

    execFileSyncMock.mockImplementation((cmd, args) => {
      if (cmd === "git") {
        return realChildProcess.execFileSync(cmd, args as string[], { cwd: dir });
      }
      return "";
    });

    project.synth();

    const main = fs.readFileSync(path.join(dir, ".github", "workflows", "main.yml"), "utf-8");
    expect(main).toContain(`uses: actions/checkout@${sha} # v1.2.3`);
    expect(main).toContain(`uses: dorny/paths-filter@${sha} # v4.5.6`);
    expect(main).toContain("taiki-e/install-action@v0.0.0");
    const script = shCallScript(execFileSyncMock);
    expect(script).toContain("'pinact' 'run' '-u' '-i' '^taiki-e/install-action$' '.github/workflows/main.yml'");
    expect(script).not.toContain("actions/checkout$");
    expect(script).not.toContain("paths-filter");
  });

  it("runs pinact separately per file so an action new to one file is not re-resolved in another", () => {
    const dir = outdir();
    realChildProcess.execFileSync("git", ["init", "-q"], { cwd: dir });
    fs.mkdirSync(path.join(dir, ".github", "workflows"), { recursive: true });
    const sha = "a".repeat(40);
    fs.writeFileSync(path.join(dir, ".github", "workflows", "main.yml"), `- uses: actions/checkout@${sha} # v1`);
    const project = new BaseProject({ name: "test", stack: [Stack.RUST], outdir: dir });

    execFileSyncMock.mockImplementation((cmd, args) => {
      if (cmd === "git") {
        return realChildProcess.execFileSync(cmd, args as string[], { cwd: dir });
      }
      return "";
    });

    project.synth();

    const script = shCallScript(execFileSyncMock);
    expect(script).toMatch(/'-i' '\^actions\/checkout\$'[^;]*'\.github\/workflows\/release\.yml'/);
    expect(script).not.toContain("'^actions/checkout$' '.github/workflows/main.yml'");
    expect(script).not.toContain("'.github/workflows/main.yml' '.github/workflows/release.yml'");
  });

  it("skips pinact when every action already has an existing ref", () => {
    const dir = outdir();
    realChildProcess.execFileSync("git", ["init", "-q"], { cwd: dir });
    fs.mkdirSync(path.join(dir, ".github", "workflows"), { recursive: true });
    const sha = "a".repeat(40);
    fs.writeFileSync(
      path.join(dir, ".github", "workflows", "main.yml"),
      ["actions/checkout", "dorny/paths-filter", "actions-rust-lang/setup-rust-toolchain", "taiki-e/install-action"]
        .map((a) => `- uses: ${a}@${sha} # v1`)
        .join("\n"),
    );
    fs.writeFileSync(
      path.join(dir, ".github", "workflows", "release.yml"),
      ["actions/checkout", "actions-rust-lang/setup-rust-toolchain", "rust-lang/crates-io-auth-action"]
        .map((a) => `- uses: ${a}@${sha} # v1`)
        .join("\n"),
    );
    const project = new BaseProject({ name: "test", stack: [Stack.RUST], outdir: dir });

    execFileSyncMock.mockImplementation((cmd, args) => {
      if (cmd === "git") {
        return realChildProcess.execFileSync(cmd, args as string[], { cwd: dir });
      }
      return "";
    });

    project.synth();

    expect(shCallScript(execFileSyncMock)).not.toContain("pinact");
  });

  it("skips pinact for a non-rust, non-frontend stack", () => {
    const dir = outdir();
    realChildProcess.execFileSync("git", ["init", "-q"], { cwd: dir });
    const project = new BaseProject({ name: "test", stack: [], outdir: dir });

    execFileSyncMock.mockImplementation((cmd, args) => {
      if (cmd === "git") {
        return realChildProcess.execFileSync(cmd, args as string[], { cwd: dir });
      }
      return "";
    });

    project.synth();

    expect(shCallScript(execFileSyncMock)).not.toContain("pinact");
  });

  it("skips pinact for a javascript stack", () => {
    const dir = outdir();
    realChildProcess.execFileSync("git", ["init", "-q"], { cwd: dir });
    const project = new BaseProject({ name: "test", stack: [Stack.JAVASCRIPT], outdir: dir });

    execFileSyncMock.mockImplementation((cmd, args) => {
      if (cmd === "git") {
        return realChildProcess.execFileSync(cmd, args as string[], { cwd: dir });
      }
      return "";
    });

    project.synth();

    expect(shCallScript(execFileSyncMock)).not.toContain("pinact");
  });

  it("does not manage a .gitignore for a javascript stack", () => {
    const dir = outdir();
    realChildProcess.execFileSync("git", ["init", "-q"], { cwd: dir });
    const project = new BaseProject({ name: "test", stack: [Stack.JAVASCRIPT], outdir: dir });

    execFileSyncMock.mockImplementation((cmd, args) => {
      if (cmd === "git") {
        return realChildProcess.execFileSync(cmd, args as string[], { cwd: dir });
      }
      return "";
    });

    project.synth();

    expect(fs.existsSync(path.join(dir, ".gitignore"))).toBe(false);
  });

  it("does not manage a .gitignore for a stack with nothing to ignore (e.g. shell-only)", () => {
    const dir = outdir();
    realChildProcess.execFileSync("git", ["init", "-q"], { cwd: dir });
    const project = new BaseProject({ name: "test", stack: [], outdir: dir });

    execFileSyncMock.mockImplementation((cmd, args) => {
      if (cmd === "git") {
        return realChildProcess.execFileSync(cmd, args as string[], { cwd: dir });
      }
      return "";
    });

    project.synth();

    expect(fs.existsSync(path.join(dir, ".gitignore"))).toBe(false);
  });

  it("merges sqlfluff config into an existing pyproject.toml for a sql stack", () => {
    const dir = outdir();
    realChildProcess.execFileSync("git", ["init", "-q"], { cwd: dir });
    fs.writeFileSync(
      path.join(dir, "pyproject.toml"),
      '[project]\nname = "x"\n\n[tool.sqlfluff.layout.type.comma]\nline_position = "trailing"\n',
    );
    const project = new BaseProject({ name: "test", stack: [Stack.SQL], outdir: dir });

    execFileSyncMock.mockImplementation((cmd, args) => {
      if (cmd === "git") {
        return realChildProcess.execFileSync(cmd, args as string[], { cwd: dir });
      }
      return "";
    });

    project.synth();

    const pyproject = fs.readFileSync(path.join(dir, "pyproject.toml"), "utf-8");
    expect(pyproject).toMatch(
      new RegExp(
        `^\\[project\\]\\nname = "x"\\n\\n\\[tool\\.sqlfluff\\.layout\\.type\\.comma\\]  ${MANAGED_MARKER}\\nline_position = "leading"\\n`,
      ),
    );
    expect(pyproject).not.toContain("trailing");
    expect(pyproject).toContain("require_final_semicolon = true");
    expect(pyproject).toContain(`[tool.tombi]  ${MANAGED_MARKER}\noffline = true\nstring-quote-style = "double"\n`);
    const staged = realChildProcess.execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: dir, encoding: "utf-8" });
    expect(staged.split("\n")).toContain("pyproject.toml");
  });

  it("merges python and sqlfluff config into an existing pyproject.toml for a wheel", () => {
    const dir = outdir();
    realChildProcess.execFileSync("git", ["init", "-q"], { cwd: dir });
    fs.writeFileSync(path.join(dir, "pyproject.toml"), '[project]\nlicense = "GPL"\nname = "x"\n\n[tool.ruff]\ntarget-version = "py39"\n');
    const project = new BaseProject({
      name: "test",
      stack: [Stack.PYTHON, Stack.SQL],
      opt: { python: { minVersion: "3.12", packaging: PythonPackaging.WHEEL } },
      outdir: dir,
    });

    execFileSyncMock.mockImplementation((cmd, args) => {
      if (cmd === "git") {
        return realChildProcess.execFileSync(cmd, args as string[], { cwd: dir });
      }
      return "";
    });

    project.synth();

    const pyproject = fs.readFileSync(path.join(dir, "pyproject.toml"), "utf-8");
    expect(pyproject).toMatch(new RegExp(`^\\[project\\]\\nauthors = .*\\nlicense = "MIT"  ${MANAGED_MARKER}\\n`));
    expect(pyproject).toContain('name = "x"\n');
    expect(pyproject).not.toContain("GPL");
    expect(pyproject).not.toContain("py39");
    expect(pyproject).toContain(`[tool.ruff]  ${MANAGED_MARKER}\ntarget-version = "py312"\n`);
    expect(pyproject).toContain(`[tool.sqlfluff.layout.type.comma]  ${MANAGED_MARKER}\n`);
  });

  it("merges python config into opt.python.pyprojectPath instead of pyproject.toml", () => {
    const dir = outdir();
    realChildProcess.execFileSync("git", ["init", "-q"], { cwd: dir });
    fs.mkdirSync(path.join(dir, "templates"));
    const template = '[project]\ndependencies = [\n{{#httpx}}\n  "httpx",\n{{/httpx}}\n]\nversion = "{{{packageVersion}}}"\n';
    fs.writeFileSync(path.join(dir, "templates/pyproject.mustache"), template);
    fs.writeFileSync(path.join(dir, "pyproject.toml"), '[project]\nversion = "1.0.0"\n');
    const project = new BaseProject({
      name: "test",
      stack: [Stack.PYTHON],
      opt: { python: { minVersion: "3.12", pyprojectPath: "templates/pyproject.mustache", extras: { generated: ["gen"] } } },
      outdir: dir,
    });

    execFileSyncMock.mockImplementation((cmd, args) => {
      if (cmd === "git") {
        return realChildProcess.execFileSync(cmd, args as string[], { cwd: dir });
      }
      return "";
    });

    project.synth();

    const merged = fs.readFileSync(path.join(dir, "templates/pyproject.mustache"), "utf-8");
    expect(merged).toMatch(new RegExp(`^${escapeRegExp(template)}\\n\\[tool\\.coverage\\.run\\]  ${MANAGED_MARKER}\\n`));
    expect(merged).toContain(`[tool.ruff]  ${MANAGED_MARKER}\ntarget-version = "py312"\n`);
    expect(merged).toContain(`[[tool.mypy.overrides]]  ${MANAGED_MARKER}\nignore_errors = true\nmodule = ["gen.*"]\n`);
    expect(fs.readFileSync(path.join(dir, "pyproject.toml"), "utf-8")).toBe('[project]\nversion = "1.0.0"\n');
    const staged = realChildProcess.execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: dir, encoding: "utf-8" });
    expect(staged.split("\n")).toContain("templates/pyproject.mustache");
  });

  it("does not write a pyproject.toml for a non-sql stack", () => {
    const dir = outdir();
    realChildProcess.execFileSync("git", ["init", "-q"], { cwd: dir });
    const project = new BaseProject({ name: "test", stack: [Stack.SHELL], outdir: dir });

    execFileSyncMock.mockImplementation((cmd, args) => {
      if (cmd === "git") {
        return realChildProcess.execFileSync(cmd, args as string[], { cwd: dir });
      }
      return "";
    });

    project.synth();

    expect(fs.existsSync(path.join(dir, "pyproject.toml"))).toBe(false);
  });
});
