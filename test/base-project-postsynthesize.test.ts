import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const realChildProcess = jest.requireActual<typeof import("child_process")>("child_process");
const execFileSyncMock = jest.fn<ReturnType<typeof realChildProcess.execFileSync>, Parameters<typeof realChildProcess.execFileSync>>();

jest.mock("child_process", () => ({
  ...jest.requireActual("child_process"),
  execFileSync: (...args: Parameters<typeof realChildProcess.execFileSync>) => execFileSyncMock(...args),
}));

import { BaseProject } from "../src/base-project";
import { Stack } from "../src/stack";

function outdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "base-projen-postsynth-"));
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
    expect(execFileSyncMock).toHaveBeenCalledWith("uvx", ["pre-commit", "run", "--all-files"], { cwd: dir, stdio: "inherit" });
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

    expect(fs.readFileSync(path.join(dir, ".gitignore"), "utf-8")).toBe("/target/\n");
    expect(execFileSyncMock).toHaveBeenCalledWith("pinact", ["run", "-u", ".github/workflows/main.yml", ".github/workflows/release.yml"], {
      cwd: dir,
      stdio: "inherit",
    });
  });

  it("skips pinact for a non-rust stack", () => {
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

    expect(execFileSyncMock).not.toHaveBeenCalledWith("pinact", expect.anything(), expect.anything());
  });

  it("skips the gitignore for a non-rust stack", () => {
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
