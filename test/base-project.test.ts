import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Testing } from "projen";
import { BaseProject } from "../src/base-project";
import { Stack } from "../src/stack";

describe("BaseProject", () => {
  it("uses MIT for a non-frontend stack, and still adds biome.json", () => {
    const project = new BaseProject({ name: "test", stack: [Stack.PYTHON] });
    const snapshot = Testing.synth(project);
    expect(snapshot.LICENSE).toContain("Permission is hereby granted, free of charge");
    expect(snapshot["biome.json"].$schema).toBe("https://biomejs.dev/schemas/2.5.4/schema.json");
  });

  it("uses AGPL-3.0-or-later and adds a frontend-specific biome.json for a frontend stack", () => {
    const project = new BaseProject({ name: "test", stack: [Stack.FRONTEND] });
    const snapshot = Testing.synth(project);
    expect(snapshot.LICENSE).toContain("GNU AFFERO GENERAL PUBLIC LICENSE");
    expect(snapshot["biome.json"].$schema).toBe("https://biomejs.dev/schemas/2.5.4/schema.json");
    expect(snapshot["biome.json"].css.parser.tailwindDirectives).toBe(true);
    expect(snapshot["biome.json"].linter.rules.style.useImportType.options.style).toBe("separatedType");
  });

  it("excludes Next.js build/env artifacts from .gitignore for a frontend stack", () => {
    const project = new BaseProject({ name: "test", stack: [Stack.FRONTEND] });
    const snapshot = Testing.synth(project);
    expect(snapshot[".gitignore"]).toContain("/.next/");
    expect(snapshot[".gitignore"]).toContain(".env*");
    expect(snapshot[".gitignore"]).toContain("next-env.d.ts");
  });

  it("writes the mergify and renovate config", () => {
    const project = new BaseProject({ name: "test", stack: [] });
    const snapshot = Testing.synth(project);
    expect(snapshot[".github/mergify.yml"]).toContain("renovate[bot]");
    expect(snapshot[".github/mergify.yml"]).toContain("author=mxr-base-copier-sync[bot]");
    expect(snapshot[".github/renovate.jsonc"]).toMatchObject({ commitMessagePrefix: "[renovate]" });
  });

  it("keeps mxr-base-sync[bot] as the mergify author for the dotfiles repo", () => {
    const project = new BaseProject({ name: "dotfiles", stack: [] });
    const snapshot = Testing.synth(project);
    expect(snapshot[".github/mergify.yml"]).toContain("author=mxr-base-sync[bot]");
  });

  it("writes rust workflow files only for a rust stack", () => {
    const rust = Testing.synth(new BaseProject({ name: "test", stack: [Stack.RUST] }));
    expect(rust[".github/workflows/main.yml"]).toContain("cargo clippy");
    expect(rust[".github/workflows/release.yml"]).toContain("cargo publish");

    const nonRust = Testing.synth(new BaseProject({ name: "test", stack: [] }));
    expect(nonRust[".github/workflows/main.yml"]).toBeUndefined();
    expect(nonRust[".github/workflows/release.yml"]).toBeUndefined();
  });

  it("writes shared frontend config files for a frontend stack", () => {
    const project = new BaseProject({ name: "test", stack: [Stack.FRONTEND] });
    const snapshot = Testing.synth(project);
    expect(snapshot["tsconfig.json"].compilerOptions.jsx).toBe("react-jsx");
    expect(snapshot["vitest.config.mts"]).toContain("defineConfig");
    expect(snapshot["postcss.config.mjs"]).toContain("@tailwindcss/postcss");
    expect(snapshot["next.config.ts"]).toContain("useTypeScriptCli");
    expect(snapshot["vercel.json"]).toMatchObject({ git: { deploymentEnabled: { main: false } } });

    const nonFrontend = Testing.synth(new BaseProject({ name: "test", stack: [] }));
    expect(nonFrontend["tsconfig.json"]).toBeUndefined();
    expect(nonFrontend["vercel.json"]).toBeUndefined();
  });

  it("skips shared frontend config files when opts.frontend.nextJs is false", () => {
    const project = new BaseProject({
      name: "test",
      stack: [Stack.FRONTEND],
      opts: { frontend: { nextJs: false } },
    });
    const snapshot = Testing.synth(project);
    expect(snapshot["tsconfig.json"]).toBeUndefined();
    expect(snapshot["vitest.config.mts"]).toBeUndefined();
    expect(snapshot["postcss.config.mjs"]).toBeUndefined();
    expect(snapshot["next.config.ts"]).toBeUndefined();
    expect(snapshot["vercel.json"]).toBeUndefined();
  });

  it("writes frontend workflow files with a Vercel deploy for a frontend stack", () => {
    const project = new BaseProject({ name: "test", stack: [Stack.FRONTEND] });
    const snapshot = Testing.synth(project);
    expect(snapshot[".github/workflows/main.yml"]).toContain("npm run test:coverage");
    expect(snapshot[".github/workflows/release.yml"]).toContain("npx vercel deploy --prebuilt --prod");
  });

  it("includes actionlint and zizmor pre-commit hooks for a frontend stack", () => {
    const project = new BaseProject({ name: "test", stack: [Stack.FRONTEND] });
    const snapshot = Testing.synth(project);
    expect(snapshot[".pre-commit-config.yaml"]).toContain("actionlint");
    expect(snapshot[".pre-commit-config.yaml"]).toContain("zizmor");
  });

  it("writes a pre-commit config", () => {
    const project = new BaseProject({ name: "test", stack: [] });
    const snapshot = Testing.synth(project);
    expect(snapshot[".pre-commit-config.yaml"]).toContain("repos:");
  });

  it("writes a ci.skip block for a rust stack, and skips it otherwise", () => {
    const rust = Testing.synth(new BaseProject({ name: "test", stack: [Stack.RUST] }));
    expect(rust[".pre-commit-config.yaml"]).toContain("ci:\n  skip: [clippy] # runs via GHA to avoid keeping deps in-sync here\n");

    const nonRust = Testing.synth(new BaseProject({ name: "test", stack: [] }));
    expect(nonRust[".pre-commit-config.yaml"]).not.toContain("ci:");
  });

  it("adds a renovate packageRule disabling major updates for the given packages", () => {
    const project = new BaseProject({ name: "test", stack: [], renovateIgnoreMajor: ["typescript"] });
    const snapshot = Testing.synth(project);
    expect(snapshot[".github/renovate.jsonc"].packageRules).toContainEqual({
      matchPackageNames: ["typescript"],
      matchUpdateTypes: ["major"],
      enabled: false,
    });
  });

  it("adds a renovate packageRule disabling the given packages entirely", () => {
    const project = new BaseProject({ name: "test", stack: [], opts: { renovate: { tar: false } } });
    const snapshot = Testing.synth(project);
    expect(snapshot[".github/renovate.jsonc"].packageRules).toContainEqual({
      matchPackageNames: ["tar"],
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
