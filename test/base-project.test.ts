import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Testing } from "projen";
import { BaseProject } from "../src/base-project";
import { Stack } from "../src/stack";

describe("BaseProject", () => {
  it("uses MIT for a non-frontend stack, and still adds biome.json", () => {
    const project = new BaseProject({ name: "test", stack: [Stack.PYTHON], opt: { python: { minVersion: "3.11" } } });
    const snapshot = Testing.synth(project);
    expect(snapshot.LICENSE).toContain("Permission is hereby granted, free of charge");
    expect(snapshot["biome.json"].$schema).toBe("https://biomejs.dev/schemas/2.5.4/schema.json");
  });

  it("throws without opt.python.minVersion for a python stack", () => {
    expect(() => new BaseProject({ name: "test", stack: [Stack.PYTHON] })).toThrow("Stack.PYTHON requires opt.python.minVersion to be set");
  });

  it("renders default_language_version.python from opt.python.minVersion", () => {
    const project = new BaseProject({ name: "test", stack: [Stack.PYTHON], opt: { python: { minVersion: "3.11" } } });
    const snapshot = Testing.synth(project);
    expect(snapshot[".pre-commit-config.yaml"]).toContain("default_language_version:\n  python: python3.11\n");
  });

  it("uses AGPL-3.0-or-later and adds a frontend-specific biome.json for a frontend stack", () => {
    const project = new BaseProject({ name: "test", stack: [Stack.FRONTEND] });
    const snapshot = Testing.synth(project);
    expect(snapshot.LICENSE).toContain("GNU AFFERO GENERAL PUBLIC LICENSE");
    expect(snapshot["biome.json"].$schema).toBe("https://biomejs.dev/schemas/2.5.4/schema.json");
    expect(snapshot["biome.json"].css.parser.tailwindDirectives).toBe(true);
    expect(snapshot["biome.json"].linter.rules.style.useImportType.options.style).toBe("separatedType");
  });

  it("uses AGPL-3.0-or-later for a javascript stack, but does not manage biome.json", () => {
    const project = new BaseProject({ name: "test", stack: [Stack.JAVASCRIPT] });
    const snapshot = Testing.synth(project);
    expect(snapshot.LICENSE).toContain("GNU AFFERO GENERAL PUBLIC LICENSE");
    expect(snapshot["biome.json"]).toBeUndefined();
  });

  it("writes the mergify and renovate config", () => {
    const project = new BaseProject({ name: "test", stack: [] });
    const snapshot = Testing.synth(project);
    expect(snapshot[".github/mergify.yml"]).toContain("renovate[bot]");
    expect(snapshot[".github/mergify.yml"]).toContain("author=mxr-base-copier-sync[bot]");
    expect(snapshot[".github/renovate.jsonc"]).toMatchObject({ commitMessagePrefix: "[renovate]" });
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

  it("skips shared frontend config files for a javascript stack", () => {
    const project = new BaseProject({ name: "test", stack: [Stack.JAVASCRIPT] });
    const snapshot = Testing.synth(project);
    expect(snapshot["tsconfig.json"]).toBeUndefined();
    expect(snapshot["vitest.config.mts"]).toBeUndefined();
    expect(snapshot["postcss.config.mjs"]).toBeUndefined();
    expect(snapshot["next.config.ts"]).toBeUndefined();
    expect(snapshot["vercel.json"]).toBeUndefined();
    expect(snapshot[".github/workflows/main.yml"]).toBeUndefined();
    expect(snapshot[".github/workflows/release.yml"]).toBeUndefined();
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

  it("auto-disables tar in renovate for a frontend stack, but not a javascript stack", () => {
    const frontend = Testing.synth(new BaseProject({ name: "test", stack: [Stack.FRONTEND] }));
    expect(frontend[".github/renovate.jsonc"].packageRules).toContainEqual({ matchPackageNames: ["tar"], enabled: false });

    const javascript = Testing.synth(new BaseProject({ name: "test", stack: [Stack.JAVASCRIPT] }));
    expect(javascript[".github/renovate.jsonc"].packageRules).not.toContainEqual(expect.objectContaining({ matchPackageNames: ["tar"] }));
  });
});

describe("BaseProject mirror stack", () => {
  const preCommitMirrorMaker = {
    command: "pre-commit-mirror . --language python --package-name ty --id ty --entry 'ty check' --types python",
  };

  it("throws without opt.mirror.preCommitMirrorMaker or opt.mirror.custom", () => {
    expect(() => new BaseProject({ name: "test", stack: [Stack.MIRROR] })).toThrow(
      "Stack.MIRROR requires opt.mirror.preCommitMirrorMaker or opt.mirror.custom to be set",
    );
    expect(() => new BaseProject({ name: "test", stack: [Stack.MIRROR], opt: { mirror: {} } })).toThrow(
      "Stack.MIRROR requires opt.mirror.preCommitMirrorMaker or opt.mirror.custom to be set",
    );
  });

  it("leaves .github/workflows/main.yml unmanaged for a custom mirror", () => {
    const project = new BaseProject({ name: "test", stack: [Stack.MIRROR], opt: { mirror: { custom: {} } } });
    const snapshot = Testing.synth(project);
    expect(snapshot[".github/workflows/main.yml"]).toBeUndefined();
  });

  it("renders the workflow with an unpinned install when no version is given", () => {
    const project = new BaseProject({ name: "test", stack: [Stack.MIRROR], opt: { mirror: { preCommitMirrorMaker } } });
    const snapshot = Testing.synth(project);
    expect(snapshot[".github/workflows/main.yml"]).toContain("pip install pre-commit-mirror-maker");
    expect(snapshot[".github/workflows/main.yml"]).toContain("pre-commit-mirror . --language python");
    expect(snapshot[".github/workflows/main.yml"]).toContain("python-version: '3.14'");
  });

  it("indents continuation lines of a multi-line command", () => {
    const project = new BaseProject({
      name: "test",
      stack: [Stack.MIRROR],
      opt: {
        mirror: {
          preCommitMirrorMaker: {
            command: "pre-commit-mirror . \\\n--language python \\\n--id ty",
          },
        },
      },
    });
    const snapshot = Testing.synth(project);
    expect(snapshot[".github/workflows/main.yml"]).toContain(
      "        pre-commit-mirror . \\\n          --language python \\\n          --id ty",
    );
  });

  it("does not treat $-patterns in the command as replacement specials", () => {
    const project = new BaseProject({
      name: "test",
      stack: [Stack.MIRROR],
      opt: {
        mirror: {
          preCommitMirrorMaker: {
            command: "pre-commit-mirror . --files-regex '(^|/)(openapi|.*[.](json|ya?ml))$'",
          },
        },
      },
    });
    const snapshot = Testing.synth(project);
    expect(snapshot[".github/workflows/main.yml"]).toContain("pre-commit-mirror . --files-regex '(^|/)(openapi|.*[.](json|ya?ml))$'");
  });

  it("pins the install to a version when given", () => {
    const project = new BaseProject({
      name: "test",
      stack: [Stack.MIRROR],
      opt: { mirror: { preCommitMirrorMaker: { ...preCommitMirrorMaker, version: "abc123" } } },
    });
    const snapshot = Testing.synth(project);
    expect(snapshot[".github/workflows/main.yml"]).toContain(
      "pip install git+https://github.com/pre-commit/pre-commit-mirror-maker@abc123",
    );
  });

  it("includes actionlint and zizmor pre-commit hooks for a mirror stack", () => {
    const project = new BaseProject({ name: "test", stack: [Stack.MIRROR], opt: { mirror: { preCommitMirrorMaker } } });
    const snapshot = Testing.synth(project);
    expect(snapshot[".pre-commit-config.yaml"]).toContain("actionlint");
    expect(snapshot[".pre-commit-config.yaml"]).toContain("zizmor");
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
