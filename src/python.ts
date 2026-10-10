import { tomlEntries } from "./pyproject";
import { PythonPackaging, Stack } from "./stack";
import { RUNNER, WINDOWS_RUNNER } from "./workflow-actions";
import type { ManagedPyproject, ManagedTable } from "./pyproject";

/**
 * Newest CPython a wheel is tested against; uv runs a prerelease of it until
 * it's released.
 */
const LATEST_PYTHON = "3.15";

/**
 * Newest GA CPython, used where a workflow needs one python to run tooling.
 * Renovate bumps setup-python but not this, so update it on each release.
 */
export const STABLE_PYTHON = "3.14";

/**
 * The only CPython Home Assistant runs on, so a home assistant integration
 * is pinned to it instead of taking a `minVersion`.
 */
export const HOME_ASSISTANT_PYTHON = "3.14";

/**
 * Newest python version PyPy implements, so PyPy is only tested when a
 * wheel's `minVersion` is at or below it.
 */
const LATEST_PYPY = "3.12";

export interface PythonPackagingOptions {
  readonly packaging?: PythonPackaging;

  /**
   * Tox envs CI runs, oldest first; windows runs only the first.
   */
  readonly envs: readonly string[];
  readonly stack: readonly Stack[];
}

function minor(version: string): number {
  return Number(version.split(".")[1]);
}

export function toxEnv(version: string): string {
  return `py${version.replace(".", "")}`;
}

/**
 * Every CPython tox env from `minVersion` through {@link LATEST_PYTHON}.
 */
export function supportedToxEnvs(minVersion: string): string[] {
  const [major, minor] = minVersion.split(".").map(Number);
  const [, latestMinor] = LATEST_PYTHON.split(".").map(Number);
  if (major === undefined || minor === undefined || latestMinor === undefined || minor > latestMinor) {
    throw new Error(`unsupported python version: ${minVersion}`);
  }
  return Array.from({ length: latestMinor - minor + 1 }, (_, i) => toxEnv(`${major}.${minor + i}`));
}

/**
 * {@link supportedToxEnvs} plus PyPy on `minVersion` (e.g. `pypy311`) when PyPy
 * implements it. Versioned since a bare `pypy3` gets uv's newest PyPy.
 */
export function pythonToxEnvs(minVersion: string): string[] {
  return [...supportedToxEnvs(minVersion), ...(minor(minVersion) <= minor(LATEST_PYPY) ? [`pypy${minVersion.replace(".", "")}`] : [])];
}

// a `<name>-real` job plus the `<name>` gate that branch protection requires,
// which passes when `<output>` is false so the check still reports when skipped
function gatedJob(name: string, output: string, real: string): string {
  const env = (job: string): string => `${job.toUpperCase().replace(/-/g, "_")}_RESULT`;
  const outputEnv = output.toUpperCase();
  return `  ${name}-real:
    needs: [changes]
    if: needs.changes.outputs.${output} == 'true'
${real}
  ${name}:
    needs: [changes, ${name}-real]
    if: always()
    runs-on: ${RUNNER}
    steps:
    - env:
        ${outputEnv}: \${{ needs.changes.outputs.${output} }}
        ${env(`${name}-real`)}: \${{ needs.${name}-real.result }}
      run: |
        if [ "$${outputEnv}" != "true" ]; then
          exit 0
        fi
        if [ "$${env(`${name}-real`)}" != "success" ]; then
          exit 1
        fi
`;
}

function toxJob(envs: readonly string[], os: string): string {
  return `    uses: mxr/workflows/.github/workflows/tox-uv.yml@v0.0.0
    with:
      env: '${JSON.stringify(envs).replace(/,/g, ", ")}'
      os: ${os}`;
}

/**
 * `.github/workflows/main.yml`: tox across `envs`, gated on whether python
 * project files changed. A home assistant integration only runs on Linux, so
 * it gets no windows job.
 */
export function pythonMainWorkflow(options: PythonPackagingOptions): string[] {
  const isHomeAssistant = options.packaging === PythonPackaging.HOME_ASSISTANT;
  const projectFiles = [
    ".github/workflows/main.yml",
    "'**/*.py'",
    ...(options.stack.includes(Stack.SQL) ? ["'**/*.sql'"] : []),
    "'**/*.toml'",
    "uv.lock",
    ...(isHomeAssistant ? ["custom_components/*/manifest.json"] : []),
  ];
  return workflow("main", "project_files", projectFiles, [
    gatedJob("main", "project_files", toxJob(options.envs, RUNNER)),
    ...(isHomeAssistant ? [] : [gatedJob("main-win", "project_files", toxJob(options.envs.slice(0, 1), WINDOWS_RUNNER))]),
  ]);
}

/**
 * `.github/workflows/typing.yml`: the typing pre-commit hooks, which
 * pre-commit.ci skips since the project venv is too big for it. Its own file,
 * so it doesn't depend on base owning `main.yml`.
 */
export function typingWorkflow(): string[] {
  return workflow(
    "typing",
    "typing_linting_files",
    [".github/workflows/typing.yml", "'**/*.py'", ".pre-commit-config.yaml"],
    [gatedJob("typing", "typing_linting_files", "    uses: mxr/workflows/.github/workflows/pre-commit-typing.yml@v0.0.0")],
  );
}

// a PR/push workflow whose jobs are gated on a `changes` job's paths filter
function workflow(name: string, output: string, files: readonly string[], jobs: readonly string[]): string[] {
  const changes = `  changes:
    runs-on: ${RUNNER}
    outputs:
      ${output}: \${{ steps.filter.outputs.${output} }}
    steps:
    - uses: actions/checkout@v0.0.0
      with:
        persist-credentials: false
    - uses: dorny/paths-filter@v0.0.0
      id: filter
      with:
        filters: |
          ${output}:
${files.map((file) => `            - ${file}`).join("\n")}
`;
  return `name: ${name}

on:
  pull_request:
  push:
    branches: [main]

permissions: {}

jobs:
${[changes, ...jobs].join("\n")}`
    .trimEnd()
    .split("\n");
}

// installs the integration's runtime requirements, which live in its manifest rather than pyproject.toml
const HOME_ASSISTANT_INSTALL_REQUIREMENTS = `import json
import pathlib
import subprocess
import sys

manifest = json.loads(next(pathlib.Path("custom_components").glob("*/manifest.json")).read_text())
subprocess.check_call(["uv", "pip", "install", "--python", sys.executable, *manifest["requirements"]])
`;

export interface ManagedPyprojectOptions {
  readonly packaging?: PythonPackaging;
  readonly minVersion: string;
  readonly name: string;
  readonly license: string;

  /**
   * Directory tox runs pytest on and mypy relaxes `disallow_untyped_defs` for.
   *
   * @default "tests"
   */
  readonly testsDir?: string;

  /**
   * More test directories, treated like `testsDir`.
   */
  readonly extraTestsDirs?: readonly string[];

  /**
   * Directories of generated code the type checkers skip.
   */
  readonly generatedDirs?: readonly string[];

  /**
   * Whether tox runs in CI, which is all the tox config is for.
   *
   * @default true
   */
  readonly ci?: boolean;

  /**
   * Whether the repo ships a `<name>` console script at `<module>._main:main`,
   * and tox installs from `uv.lock` via tox-uv's `uv-venv-lock-runner`.
   *
   * @default false
   */
  readonly consoleScript?: boolean;
}

// a directory as a mypy module glob, e.g. `pkg/gen` -> `pkg.gen.*`
function moduleGlob(dir: string): string {
  return `${dir.replace(/\/+$/, "").replaceAll("/", ".")}.*`;
}

/**
 * Lint, typing, and tox config shared by every python repo regardless of
 * packaging, plus PyPI metadata for a wheel and manifest-driven installs for a
 * home assistant integration. `pytest` and the rest of `[project]` differ per
 * repo, so they stay downstream.
 */
export function managedPyproject(options: ManagedPyprojectOptions): ManagedPyproject {
  const isWheel = options.packaging === PythonPackaging.WHEEL;
  const isHomeAssistant = options.packaging === PythonPackaging.HOME_ASSISTANT;
  const testsDir = options.testsDir ?? "tests";
  const testsDirs = [testsDir, ...(options.extraTestsDirs ?? [])];
  const generatedDirs = [...(options.generatedDirs ?? [])];
  const ci = options.ci ?? true;
  const consoleScript = options.consoleScript ?? false;
  const table = (name: string, values: Parameters<typeof tomlEntries>[0], array?: boolean): ManagedTable => ({
    name,
    lines: tomlEntries(values),
    ...(array ? { array } : {}),
  });

  const tables: ManagedTable[] = [
    ...(isWheel ? [table("build-system", { requires: ["setuptools"], "build-backend": "setuptools.build_meta" })] : []),
    ...(isWheel ? [table("project.urls", { Homepage: `https://github.com/mxr/${options.name}` })] : []),
    ...(consoleScript ? [table("project.scripts", { [options.name]: `${options.name.replaceAll("-", "_")}._main:main` })] : []),
    table("tool.coverage.run", { plugins: ["covdefaults"] }),
    table("tool.mypy", {
      check_untyped_defs: true,
      disallow_any_generics: true,
      disallow_incomplete_defs: true,
      disallow_untyped_defs: true,
      warn_redundant_casts: true,
      warn_unused_ignores: true,
    }),
    table("tool.mypy.overrides", { disallow_untyped_defs: false, module: "testing.*" }, true),
    table(
      "tool.mypy.overrides",
      { disallow_untyped_defs: false, module: testsDirs.length > 1 ? testsDirs.map(moduleGlob) : moduleGlob(testsDir) },
      true,
    ),
    ...(generatedDirs.length > 0
      ? [table("tool.mypy.overrides", { ignore_errors: true, module: generatedDirs.map(moduleGlob) }, true)]
      : []),
    ...(generatedDirs.length > 0 ? [table("tool.pyright", { exclude: generatedDirs })] : []),
    // a wheel's `requires-python` gives ruff its target version
    ...(isWheel ? [] : [table("tool.ruff", { "target-version": toxEnv(options.minVersion) })]),
    {
      name: "tool.ruff.lint",
      lines: [
        "extend-select = [",
        '  "A",  # see flake8-builtins',
        '  "B",  # see flake8-bugbear',
        '  "C4",  # see flake8-comprehension',
        '  "I",  # sort imports',
        '  "SIM",  # see flake8-simplify',
        '  "TC",  # see flake8-type-checking',
        '  "UP",  # see pyupgrade',
        "]",
      ],
    },
    table("tool.ruff.lint.isort", {
      "force-single-line": true,
      // 3.14 evaluates annotations lazily (PEP 649), so the import is only needed below it
      ...(Number(options.minVersion.split(".")[1]) < 14 ? { "required-imports": ["from __future__ import annotations"] } : {}),
    }),
    ...(isWheel ? [table("tool.setuptools.packages", { find: {} })] : []),
    // bare local `tox`; CI passes `-e` per matrix entry (pypy, windows, each version), so this skips those
    ...(ci
      ? [
          table("tool.tox", { env_list: ["py", "pre-commit"] }),
          table("tool.tox.env.pre-commit", {
            commands: [["pre-commit", "run", "--all-files", "--show-diff-on-failure"]],
            deps: ["pre-commit-uv"],
            // the lock runner would sync the project and skip `deps`
            ...(consoleScript ? { runner: "uv-venv-runner" } : {}),
            skip_install: true,
          }),
          table("tool.tox.env_run_base", {
            commands: [
              ["coverage", "erase"],
              [
                "coverage",
                "run",
                "-m",
                "pytest",
                // a `{posargs:a b}` default would be one argument
                testsDirs.length > 1 ? { replace: "posargs", default: testsDirs, extend: true } : `{posargs:${testsDir}}`,
              ],
              ["coverage", "report"],
            ],
            ...(isHomeAssistant
              ? { commands_pre: [["python", "-c", HOME_ASSISTANT_INSTALL_REQUIREMENTS]], dependency_groups: ["test"], skip_install: true }
              : { dependency_groups: ["dev"] }),
            ...(consoleScript ? { runner: "uv-venv-lock-runner" } : {}),
          }),
        ]
      : []),
    table("tool.ty.rules", { all: "error" }),
    ...(generatedDirs.length > 0 ? [table("tool.ty.src", { exclude: generatedDirs })] : []),
  ];

  return {
    tables,
    ...(isWheel
      ? {
          projectKeys: {
            // tombi's order, for keys new to `[project]`
            "requires-python": `>=${options.minVersion}`,
            license: options.license,
            "license-files": ["LICENSE"],
            authors: [{ name: "Max R", email: "mxr@users.noreply.github.com" }],
          },
        }
      : {}),
  };
}
