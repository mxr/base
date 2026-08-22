import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Testing } from "projen";
import { BaseProject } from "../src/base-project";
import { Stack } from "../src/stack";

describe("BaseProject", () => {
  it("uses MIT for a non-frontend stack, and skips biome.json", () => {
    const project = new BaseProject({ name: "test", stack: [Stack.PYTHON] });
    const snapshot = Testing.synth(project);
    expect(snapshot.LICENSE).toContain("Permission is hereby granted, free of charge");
    expect(snapshot["biome.json"]).toBeUndefined();
  });

  it("uses AGPL-3.0-or-later and adds biome.json for a frontend stack", () => {
    const project = new BaseProject({ name: "test", stack: [Stack.FRONTEND] });
    const snapshot = Testing.synth(project);
    expect(snapshot.LICENSE).toContain("GNU AFFERO GENERAL PUBLIC LICENSE");
    expect(snapshot["biome.json"].$schema).toBe("https://biomejs.dev/schemas/2.5.4/schema.json");
  });

  it("skips biome.json for a frontend stack when opts.frontend.skipBiomeJson is set", () => {
    const project = new BaseProject({ name: "test", stack: [Stack.FRONTEND], opts: { frontend: { skipBiomeJson: true } } });
    const snapshot = Testing.synth(project);
    expect(snapshot.LICENSE).toContain("GNU AFFERO GENERAL PUBLIC LICENSE");
    expect(snapshot["biome.json"]).toBeUndefined();
  });

  it("writes the mergify and renovate config", () => {
    const project = new BaseProject({ name: "test", stack: [] });
    const snapshot = Testing.synth(project);
    expect(snapshot[".github/mergify.yml"]).toContain("renovate[bot]");
    expect(snapshot[".github/mergify.yml"]).toContain("mxr-base-sync[bot]");
    expect(snapshot[".github/renovate.json"]).toMatchObject({ commitMessagePrefix: "[renovate]" });
  });

  it("writes a pre-commit config", () => {
    const project = new BaseProject({ name: "test", stack: [] });
    const snapshot = Testing.synth(project);
    expect(snapshot[".pre-commit-config.yaml"]).toContain("repos:");
  });

  it("adds a renovate packageRule disabling major updates for the given packages", () => {
    const project = new BaseProject({ name: "test", stack: [], renovateIgnoreMajor: ["typescript"] });
    const snapshot = Testing.synth(project);
    expect(snapshot[".github/renovate.json"].packageRules).toContainEqual({
      matchPackageNames: ["typescript"],
      matchUpdateTypes: ["major"],
      enabled: false,
    });
  });
});

describe("BaseProject.postSynthesize", () => {
  it("skips pre-commit and cleanup entirely outside a git repo", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "base-projen-postsynth-"));
    const project = new BaseProject({ name: "test", stack: [], outdir: dir });
    project.synth();
    expect(fs.existsSync(path.join(dir, ".gitignore"))).toBe(true);
  });
});
