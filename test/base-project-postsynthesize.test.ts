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
import { Stack } from "../src/stack";

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
    expect(shCallScript(execFileSyncMock)).toContain("'pinact' 'run' '-u' '.github/workflows/main.yml' '.github/workflows/release.yml'");
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

    expect(shCallScript(execFileSyncMock)).toContain("'pinact' 'run' '-u' '.github/workflows/main.yml' '.github/workflows/release.yml'");
    const gitignore = fs.readFileSync(path.join(dir, ".gitignore"), "utf-8");
    expect(gitignore).toContain("/.next/");
    expect(gitignore).toContain(".env*");
    expect(gitignore).toContain("next-env.d.ts");
  });

  it("runs pinact for a mirror stack with preCommitMirrorMaker", () => {
    const dir = outdir();
    realChildProcess.execFileSync("git", ["init", "-q"], { cwd: dir });
    const project = new BaseProject({
      name: "test",
      stack: [Stack.MIRROR],
      outdir: dir,
      opt: {
        mirror: {
          preCommitMirrorMaker: {
            command: "pre-commit-mirror . --language python --package-name ty --id ty --entry 'ty check' --types python",
          },
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

    expect(shCallScript(execFileSyncMock)).toContain("'pinact' 'run' '-u' '.github/workflows/main.yml' '.github/workflows/release.yml'");
  });

  it("skips pinact for a mirror stack with a custom mirror", () => {
    const dir = outdir();
    realChildProcess.execFileSync("git", ["init", "-q"], { cwd: dir });
    const project = new BaseProject({ name: "test", stack: [Stack.MIRROR], outdir: dir, opt: { mirror: { custom: {} } } });

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

  it("removes the default README only when it's still the projen placeholder", () => {
    const dir = outdir();
    realChildProcess.execFileSync("git", ["init", "-q"], { cwd: dir });
    const project = new BaseProject({ name: "test", stack: [], outdir: dir, readme: { contents: "not the placeholder" } });

    execFileSyncMock.mockImplementation((cmd, args) => {
      if (cmd === "git") {
        return realChildProcess.execFileSync(cmd, args as string[], { cwd: dir });
      }
      return "";
    });

    project.synth();

    expect(fs.readFileSync(path.join(dir, "README.md"), "utf-8")).toBe("not the placeholder");
  });
});
