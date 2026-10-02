import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Testing } from "projen";
import { BaseProject } from "../src/base-project";
import { PythonPackaging, Stack } from "../src/stack";

describe("BaseProject", () => {
  it("uses MIT for a non-frontend stack, and still adds biome.json", () => {
    const project = new BaseProject({ name: "test", stack: [Stack.PYTHON], opt: { python: { minVersion: "3.11" } } });
    const snapshot = Testing.synth(project);
    expect(snapshot["LICENSE"]).toContain("Permission is hereby granted, free of charge");
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
    expect(snapshot["LICENSE"]).toContain("GNU AFFERO GENERAL PUBLIC LICENSE");
    expect(snapshot["biome.json"].$schema).toBe("https://biomejs.dev/schemas/2.5.4/schema.json");
    expect(snapshot["biome.json"].css.parser.tailwindDirectives).toBe(true);
    expect(snapshot["biome.json"].linter.rules.style.useImportType.options.style).toBe("separatedType");
  });

  it("uses AGPL-3.0-or-later for a javascript stack, but does not manage biome.json", () => {
    const project = new BaseProject({ name: "test", stack: [Stack.JAVASCRIPT] });
    const snapshot = Testing.synth(project);
    expect(snapshot["LICENSE"]).toContain("GNU AFFERO GENERAL PUBLIC LICENSE");
    expect(snapshot["biome.json"]).toBeUndefined();
  });

  it("writes the mergify and renovate config", () => {
    const project = new BaseProject({ name: "test", stack: [] });
    const snapshot = Testing.synth(project);
    expect(snapshot[".github/mergify.yml"]).toContain("renovate[bot]");
    expect(snapshot[".github/mergify.yml"]).toContain("author=mxr-base-sync[bot]");
    expect(snapshot[".github/renovate.jsonc"]).toMatchObject({ commitMessagePrefix: "[renovate]" });
    expect(snapshot[".github/renovate.jsonc"].packageRules).toContainEqual({
      matchDatasources: ["github-runners"],
      minimumReleaseAgeBehaviour: "timestamp-optional",
    });
  });

  it("writes rust workflow files and .config/tombi.toml only for a rust stack", () => {
    const rust = Testing.synth(new BaseProject({ name: "test", stack: [Stack.RUST] }));
    expect(rust[".github/workflows/main.yml"]).toContain("cargo clippy");
    expect(rust[".github/workflows/release.yml"]).toContain("cargo publish");
    expect(rust[".config/tombi.toml"]).toContain('\noffline = true\nstring-quote-style = "double"');

    const nonRust = Testing.synth(new BaseProject({ name: "test", stack: [] }));
    expect(nonRust[".github/workflows/main.yml"]).toBeUndefined();
    expect(nonRust[".config/tombi.toml"]).toBeUndefined();
    expect(nonRust[".github/workflows/release.yml"]).toBeUndefined();
  });

  it("writes shared frontend config files for a frontend stack", () => {
    const project = new BaseProject({ name: "test", stack: [Stack.FRONTEND] });
    const snapshot = Testing.synth(project);
    expect(snapshot["tsconfig.json"].compilerOptions.jsx).toBe("react-jsx");
    expect(snapshot["tsconfig.json"].extends).toBe("@tsconfig/strictest/tsconfig.json");
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

  it.each([
    { name: "github-actions", stack: [Stack.GITHUB_ACTIONS], expected: true },
    { name: "rust (implies github-actions)", stack: [Stack.RUST], expected: true },
    { name: "shell", stack: [Stack.SHELL], expected: false },
  ])("writes .github/actionlint.yml only when github actions is in the stack: $name", ({ stack, expected }) => {
    const snapshot = Testing.synth(new BaseProject({ name: "test", stack }));
    if (expected) {
      expect(snapshot[".github/actionlint.yml"]).toContain("self-hosted-runner:\n  labels:\n  - ubuntu-26.04");
    } else {
      expect(snapshot[".github/actionlint.yml"]).toBeUndefined();
    }
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

  it("adds a renovate custom manager for the windows runner for a python stack only", () => {
    const python = Testing.synth(
      new BaseProject({ name: "test", stack: [Stack.PYTHON], opt: { python: { minVersion: "3.14", packaging: PythonPackaging.WHEEL } } }),
    );
    const [manager] = python[".github/renovate.jsonc"].customManagers;
    expect(manager).toMatchObject({ datasourceTemplate: "github-runners", versioningTemplate: "docker" });
    const match = new RegExp(manager.matchStrings[0]).exec(python[".github/workflows/main.yml"]);
    expect(match?.groups).toEqual({ depName: "windows", currentValue: "2025" });

    const nonPython = Testing.synth(new BaseProject({ name: "test", stack: [] }));
    expect(nonPython[".github/renovate.jsonc"].customManagers).toBeUndefined();
  });
});

describe("BaseProject mirror stack", () => {
  const mirror = {
    command: "pre-commit-mirror . --language python --package-name ty --id ty --entry 'ty check' --types python",
  };

  it("throws without opt.mirror", () => {
    expect(() => new BaseProject({ name: "test", stack: [Stack.MIRROR] })).toThrow("Stack.MIRROR requires opt.mirror to be set");
  });

  it("renders the workflow with an unpinned install when no version is given", () => {
    const project = new BaseProject({ name: "test", stack: [Stack.MIRROR], opt: { mirror } });
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
          command: "pre-commit-mirror . \\\n--language python \\\n--id ty",
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
          command: "pre-commit-mirror . --files-regex '(^|/)(openapi|.*[.](json|ya?ml))$'",
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
      opt: { mirror: { ...mirror, version: "abc123" } },
    });
    const snapshot = Testing.synth(project);
    expect(snapshot[".github/workflows/main.yml"]).toContain(
      "pip install git+https://github.com/pre-commit/pre-commit-mirror-maker@abc123",
    );
  });

  it("includes actionlint and zizmor pre-commit hooks for a mirror stack", () => {
    const project = new BaseProject({ name: "test", stack: [Stack.MIRROR], opt: { mirror } });
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

describe("BaseProject python packaging", () => {
  const homeAssistant = { name: "Foo", minVersion: "2026.4.0" };

  it("writes no workflows or hacs.json without opt.python.packaging", () => {
    const snapshot = Testing.synth(new BaseProject({ name: "test", stack: [Stack.PYTHON], opt: { python: { minVersion: "3.12" } } }));
    expect(snapshot[".github/workflows/main.yml"]).toBeUndefined();
    expect(snapshot[".github/workflows/release.yml"]).toBeUndefined();
    expect(snapshot["hacs.json"]).toBeUndefined();
  });

  it("tests and publishes a wheel to PyPI", () => {
    const project = new BaseProject({
      name: "test",
      stack: [Stack.PYTHON],
      opt: { python: { minVersion: "3.12", packaging: PythonPackaging.WHEEL } },
    });
    const snapshot = Testing.synth(project);
    expect(snapshot[".github/workflows/main.yml"]).toContain(`env: '["py312", "py313", "py314", "py315", "pypy3"]'`);
    expect(snapshot[".github/workflows/release.yml"]).toContain("python-version: '3.12'");
    expect(snapshot[".github/workflows/release.yml"]).toContain("uses: pypa/gh-action-pypi-publish@v0.0.0");
    expect(snapshot[".github/workflows/release.yml"]).toContain(
      'gh release create "$GITHUB_REF_NAME" dist/* --verify-tag --generate-notes',
    );
    expect(snapshot["hacs.json"]).toBeUndefined();
  });

  it("releases a home assistant integration through GitHub and writes hacs.json", () => {
    const project = new BaseProject({
      name: "test",
      stack: [Stack.PYTHON],
      opt: { python: { packaging: PythonPackaging.HOME_ASSISTANT, homeAssistant } },
    });
    const snapshot = Testing.synth(project);
    expect(snapshot[".github/workflows/main.yml"]).toContain(`env: '["py314"]'`);
    expect(snapshot[".pre-commit-config.yaml"]).toContain("default_language_version:\n  python: python3.14\n");
    expect(snapshot[".github/workflows/release.yml"]).toContain("uses: mxr/workflows/.github/workflows/github-release.yml@v0.0.0");
    expect(snapshot["hacs.json"]).toEqual({ content_in_root: false, homeassistant: "2026.4.0", name: "Foo" });
  });

  it.each([
    { name: "a wheel", packaging: PythonPackaging.WHEEL },
    { name: "no packaging", packaging: undefined },
  ])("runs type checks in GHA instead of pre-commit.ci for $name", ({ packaging }) => {
    const project = new BaseProject({
      name: "test",
      stack: [Stack.PYTHON],
      opt: { python: { minVersion: "3.14", runTypeChecksInGithubActions: true, ...(packaging ? { packaging } : {}) } },
    });
    const snapshot = Testing.synth(project);
    expect(snapshot[".pre-commit-config.yaml"]).toContain(
      "ci:\n  skip: [mypy, pyright, ty] # venv is too big; runs with github action instead\n",
    );
    expect(snapshot[".github/workflows/typing.yml"]).toContain("typing-real:");
  });

  it("keeps type checks on pre-commit.ci by default", () => {
    const project = new BaseProject({
      name: "test",
      stack: [Stack.PYTHON],
      opt: { python: { minVersion: "3.14", packaging: PythonPackaging.WHEEL } },
    });
    const snapshot = Testing.synth(project);
    expect(snapshot[".pre-commit-config.yaml"]).not.toContain("ci:");
    expect(snapshot[".github/workflows/typing.yml"]).toBeUndefined();
  });

  it("pins generated python workflows to the ubuntu-26.04 runner", () => {
    const project = new BaseProject({
      name: "test",
      stack: [Stack.PYTHON],
      opt: { python: { minVersion: "3.14", packaging: PythonPackaging.WHEEL } },
    });
    const snapshot = Testing.synth(project);
    expect(snapshot[".github/workflows/main.yml"]).toContain("runs-on: ubuntu-26.04");
    expect(snapshot[".github/workflows/main.yml"]).not.toContain("ubuntu-latest");
    expect(snapshot[".github/workflows/release.yml"]).toContain("runs-on: ubuntu-26.04");
  });

  it("throws without opt.python.homeAssistant for home assistant packaging", () => {
    expect(
      () =>
        new BaseProject({
          name: "test",
          stack: [Stack.PYTHON],
          opt: { python: { packaging: PythonPackaging.HOME_ASSISTANT } },
        }),
    ).toThrow("PythonPackaging.HOME_ASSISTANT requires opt.python.homeAssistant to be set");
  });

  it("throws when home assistant packaging sets opt.python.minVersion", () => {
    expect(
      () =>
        new BaseProject({
          name: "test",
          stack: [Stack.PYTHON],
          opt: { python: { minVersion: "3.14", packaging: PythonPackaging.HOME_ASSISTANT, homeAssistant } },
        }),
    ).toThrow("PythonPackaging.HOME_ASSISTANT always uses python 3.14; omit opt.python.minVersion");
  });
});
