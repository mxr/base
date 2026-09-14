import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const realChildProcess = jest.requireActual<typeof import("child_process")>("child_process");
const execFileSyncMock = jest.fn<ReturnType<typeof realChildProcess.execFileSync>, Parameters<typeof realChildProcess.execFileSync>>();

jest.mock("child_process", () => ({
  ...jest.requireActual("child_process"),
  execFileSync: (...args: Parameters<typeof realChildProcess.execFileSync>) => execFileSyncMock(...args),
}));

import { BANNER } from "../src/banner.ts";
import { BaseProject } from "../src/base-project.ts";
import { Stack } from "../src/stack.ts";

function outdir(): string {
  return mkdtempSync(join(tmpdir(), "base-projen-postsynth-"));
}

/**
 * Creates a `BaseProject` in a fresh temp git repo, and mocks `execFileSync`
 * so `git` commands pass through to the real binary (scoped to that repo)
 * while every other command (`chmod`, `uvx pre-commit`, `pinact`, ...) is a
 * no-op returning `onOther`'s result (empty string by default).
 */
function setUpProject(
  stack: Stack[],
  options: { readme?: { contents: string }; onOther?: (cmd: string, args: readonly string[]) => string } = {},
): { dir: string; project: BaseProject } {
  const dir = outdir();
  realChildProcess.execFileSync("git", ["init", "-q"], { cwd: dir });
  const project = new BaseProject({ name: "test", stack, outdir: dir, readme: options.readme });

  execFileSyncMock.mockImplementation((cmd, args) => {
    if (cmd === "git") {
      return realChildProcess.execFileSync(cmd, args as string[], { cwd: dir });
    }
    return options.onOther?.(cmd, args as string[]) ?? "";
  });

  return { dir, project };
}

describe("BaseProject.postSynthesize cleanup and pinact", () => {
  afterEach(() => {
    execFileSyncMock.mockReset();
  });

  it("cleans up projen scaffolding and runs pre-commit inside a git repo", () => {
    const { dir, project } = setUpProject([], {
      onOther: (_cmd, args) => {
        if (args.includes("autoupdate")) {
          throw new Error("simulated autoupdate failure");
        }
        return "";
      },
    });

    project.synth();

    expect(existsSync(join(dir, ".gitignore"))).toBe(false);
    expect(existsSync(join(dir, ".gitattributes"))).toBe(false);
    expect(existsSync(join(dir, ".projen"))).toBe(false);
    expect(execFileSyncMock).toHaveBeenCalledWith("chmod", ["-R", "u+w", dir]);
    expect(execFileSyncMock).toHaveBeenCalledWith("uvx", ["pre-commit", "run", "--all-files"], { cwd: dir, stdio: "inherit" });
  });

  it("writes a /target/ gitignore for a rust stack, and runs pinact", () => {
    const { dir, project } = setUpProject([Stack.rust]);
    project.synth();

    expect(readFileSync(join(dir, ".gitignore"), "utf-8")).toBe(`# ${BANNER}\n/target/\n`);
    expect(execFileSyncMock).toHaveBeenCalledWith("pinact", ["run", "-u", ".github/workflows/main.yml", ".github/workflows/release.yml"], {
      cwd: dir,
      stdio: "inherit",
    });
  });

  it("runs pinact for a frontend stack, and excludes Next.js build/env artifacts from .gitignore", () => {
    const { dir, project } = setUpProject([Stack.frontend]);
    project.synth();

    expect(execFileSyncMock).toHaveBeenCalledWith("pinact", ["run", "-u", ".github/workflows/main.yml", ".github/workflows/release.yml"], {
      cwd: dir,
      stdio: "inherit",
    });
    const gitignore = readFileSync(join(dir, ".gitignore"), "utf-8");
    expect(gitignore).toContain("/.next/");
    expect(gitignore).toContain(".env*");
    expect(gitignore).toContain("next-env.d.ts");
  });

  it("skips pinact for a non-rust, non-frontend stack", () => {
    const { project } = setUpProject([]);
    project.synth();
    expect(execFileSyncMock).not.toHaveBeenCalledWith("pinact", expect.anything(), expect.anything());
  });

  it("skips pinact for a javascript stack", () => {
    const { project } = setUpProject([Stack.javascript]);
    project.synth();
    expect(execFileSyncMock).not.toHaveBeenCalledWith("pinact", expect.anything(), expect.anything());
  });
});

describe("BaseProject.postSynthesize gitignore and README cleanup", () => {
  afterEach(() => {
    execFileSyncMock.mockReset();
  });

  it("does not manage a .gitignore for a javascript stack", () => {
    const { dir, project } = setUpProject([Stack.javascript]);
    project.synth();
    expect(existsSync(join(dir, ".gitignore"))).toBe(false);
  });

  it("does not manage a .gitignore for a stack with nothing to ignore (e.g. shell-only)", () => {
    const { dir, project } = setUpProject([]);
    project.synth();
    expect(existsSync(join(dir, ".gitignore"))).toBe(false);
  });

  it("removes the default README only when it's still the projen placeholder", () => {
    const { dir, project } = setUpProject([], { readme: { contents: "not the placeholder" } });
    project.synth();
    expect(readFileSync(join(dir, "README.md"), "utf-8")).toBe("not the placeholder");
  });
});
