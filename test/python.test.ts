import { managedPyproject, pythonMainWorkflow, pythonToxEnvs, supportedToxEnvs, typingWorkflow } from "../src/python";
import { PythonPackaging, Stack } from "../src/stack";

describe("supportedToxEnvs", () => {
  it.each([
    { minVersion: "3.12", expected: ["py312", "py313", "py314", "py315"] },
    { minVersion: "3.15", expected: ["py315"] },
  ])("lists $minVersion through the latest", ({ minVersion, expected }) => {
    expect(supportedToxEnvs(minVersion)).toEqual(expected);
  });

  it.each(["3.16", "3"])("throws for %s", (minVersion) => {
    expect(() => supportedToxEnvs(minVersion)).toThrow(`unsupported python version: ${minVersion}`);
  });
});

describe("pythonMainWorkflow", () => {
  it.each([
    { minVersion: "3.12", envs: '["py312", "py313", "py314", "py315", "pypy312"]' },
    { minVersion: "3.13", envs: '["py313", "py314", "py315"]' },
  ])("tests a $minVersion wheel on every supported version, pypy if it supports $minVersion, and windows", ({ minVersion, envs }) => {
    const workflow = pythonMainWorkflow({
      packaging: PythonPackaging.WHEEL,
      envs: pythonToxEnvs(minVersion),
      stack: [Stack.PYTHON],
    }).join("\n");
    expect(workflow).toContain(
      `    uses: mxr/workflows/.github/workflows/tox-uv.yml@v0.0.0\n    with:\n      env: '${envs}'\n      os: ubuntu-26.04\n`,
    );
    expect(workflow).toContain("            - uv.lock\n");
    expect(workflow).toContain(`      env: '["${`py${minVersion.replace(".", "")}`}"]'\n      os: windows-2025\n`);
    expect(workflow).toContain(`        MAIN_WIN_REAL_RESULT: \${{ needs.main-win-real.result }}\n`);
    expect(workflow).not.toContain("'**/*.sql'");
    expect(workflow).not.toContain("manifest.json");
    expect(workflow).not.toContain("typing");
  });

  it("tests a home assistant integration on its envs without windows", () => {
    const workflow = pythonMainWorkflow({
      packaging: PythonPackaging.HOME_ASSISTANT,
      envs: ["py314"],
      stack: [Stack.PYTHON, Stack.SQL],
    }).join("\n");
    expect(workflow).toContain(`      env: '["py314"]'\n`);
    expect(workflow).not.toContain("windows-2025");
    expect(workflow).toContain("            - '**/*.sql'\n");
    expect(workflow).toContain("            - custom_components/*/manifest.json");
  });
});

describe("typingWorkflow", () => {
  it("runs the gated typing job when python or pre-commit config changes", () => {
    const workflow = typingWorkflow().join("\n");
    expect(workflow).toMatch(/^name: typing\n/);
    expect(workflow).toContain(`      typing_linting_files: \${{ steps.filter.outputs.typing_linting_files }}\n`);
    expect(workflow).toContain(
      "          typing_linting_files:\n            - .github/workflows/typing.yml\n            - '**/*.py'\n            - .pre-commit-config.yaml\n",
    );
    expect(workflow).toContain(
      "  typing-real:\n    needs: [changes]\n    if: needs.changes.outputs.typing_linting_files == 'true'\n    uses: mxr/workflows/.github/workflows/pre-commit-typing.yml@v0.0.0\n",
    );
    expect(workflow).toContain('        if [ "$TYPING_REAL_RESULT" != "success" ]; then\n');
  });
});

describe("managedPyproject", () => {
  it("manages PyPI metadata and build config for a wheel", () => {
    const pyproject = managedPyproject({ packaging: PythonPackaging.WHEEL, minVersion: "3.12", name: "foo-bar", license: "MIT" });
    const names = pyproject.tables.map(({ name }) => name);
    expect(names).toEqual(expect.arrayContaining(["build-system", "project.urls", "tool.setuptools.packages"]));
    expect(pyproject.tables).toContainEqual({ name: "project.urls", lines: ['Homepage = "https://github.com/mxr/foo-bar"'] });
    expect(names).not.toContain("tool.ruff");
    expect(pyproject.tables).toContainEqual({ name: "tool.tox", lines: ['env_list = ["py", "pre-commit"]'] });
    expect(pyproject.projectKeys).toEqual({
      authors: [{ name: "Max R", email: "mxr@users.noreply.github.com" }],
      license: "MIT",
      "license-files": ["LICENSE"],
      "requires-python": ">=3.12",
    });
  });

  it("installs manifest requirements and skips PyPI metadata for a home assistant integration", () => {
    const pyproject = managedPyproject({
      packaging: PythonPackaging.HOME_ASSISTANT,
      minVersion: "3.14",
      name: "ha-foo",
      license: "MIT",
    });
    const names = pyproject.tables.map(({ name }) => name);
    expect(names).not.toContain("build-system");
    expect(names).not.toContain("project.urls");
    expect(pyproject.projectKeys).toBeUndefined();
    const runBase = pyproject.tables.find(({ name }) => name === "tool.tox.env_run_base");
    expect(runBase?.lines).toContainEqual(
      expect.stringMatching(/^commands_pre = \[\n {2}\[\n {4}"python",\n {4}"-c",\n {4}'''\nimport json\n.*manifest\["requirements"\]/s),
    );
    expect(runBase?.lines).toContainEqual(
      expect.stringContaining('subprocess.check_call(["uv", "pip", "install", "--python", sys.executable, *manifest["requirements"]])'),
    );
    expect(runBase?.lines).toContain('dependency_groups = ["test"]');
    expect(runBase?.lines).toContain("skip_install = true");
  });

  it("manages only lint and tox config without packaging", () => {
    const pyproject = managedPyproject({ minVersion: "3.11", name: "mirrors-foo", license: "MIT" });
    expect(pyproject.tables.map(({ name }) => name)).toEqual([
      "tool.coverage.run",
      "tool.mypy",
      "tool.mypy.overrides",
      "tool.mypy.overrides",
      "tool.ruff",
      "tool.ruff.lint",
      "tool.ruff.lint.isort",
      "tool.tox",
      "tool.tox.env.pre-commit",
      "tool.tox.env_run_base",
      "tool.ty.rules",
    ]);
    expect(pyproject.tables).toContainEqual({ name: "tool.ruff", lines: ['target-version = "py311"'] });
    expect(pyproject.tables).toContainEqual({ name: "tool.tox", lines: ['env_list = ["py", "pre-commit"]'] });
    expect(pyproject.tables).toContainEqual({
      name: "tool.ruff.lint.isort",
      lines: ["force-single-line = true", 'required-imports = ["from __future__ import annotations"]'],
    });
    expect(pyproject.projectKeys).toBeUndefined();
  });

  it("omits the tox config with ci off", () => {
    const pyproject = managedPyproject({ minVersion: "3.11", name: "foo", license: "MIT", ci: false });
    expect(pyproject.tables.map(({ name }) => name).filter((name) => name.startsWith("tool.tox"))).toEqual([]);
  });

  it("skips generated dirs in mypy, pyright, and ty", () => {
    const pyproject = managedPyproject({ minVersion: "3.11", name: "foo", license: "MIT", generatedDirs: ["foo/gen", "test"] });
    expect(pyproject.tables).toContainEqual({
      name: "tool.mypy.overrides",
      array: true,
      lines: ["ignore_errors = true", 'module = ["foo.gen.*", "test.*"]'],
    });
    expect(pyproject.tables).toContainEqual({ name: "tool.pyright", lines: ['exclude = ["foo/gen", "test"]'] });
    expect(pyproject.tables).toContainEqual({ name: "tool.ty.src", lines: ['exclude = ["foo/gen", "test"]'] });
  });

  it.each([
    {
      name: "default tests dir",
      options: {},
      module: '"tests.*"',
      pytest: '["coverage", "run", "-m", "pytest", "{posargs:tests}"]',
    },
    {
      name: "custom tests dir",
      options: { testsDir: "test" },
      module: '"test.*"',
      pytest: '["coverage", "run", "-m", "pytest", "{posargs:test}"]',
    },
    {
      name: "extra tests dirs",
      options: { testsDir: "test", extraTestsDirs: ["test_custom"] },
      module: '["test.*", "test_custom.*"]',
      pytest: '["coverage", "run", "-m", "pytest", { replace = "posargs", default = ["test", "test_custom"], extend = true }]',
    },
  ])("tests and relaxes typing for $name", ({ options, module, pytest }) => {
    const pyproject = managedPyproject({ minVersion: "3.11", name: "foo", license: "MIT", ...options });
    expect(pyproject.tables).toContainEqual({
      name: "tool.mypy.overrides",
      array: true,
      lines: ["disallow_untyped_defs = false", `module = ${module}`],
    });
    const runBase = pyproject.tables.find(({ name }) => name === "tool.tox.env_run_base");
    expect(runBase?.lines[0]).toBe(`commands = [\n  ["coverage", "erase"],\n  ${pytest},\n  ["coverage", "report"],\n]`);
  });

  it.each([
    { minVersion: "3.13", expected: ["force-single-line = true", 'required-imports = ["from __future__ import annotations"]'] },
    { minVersion: "3.14", expected: ["force-single-line = true"] },
  ])("requires the __future__ annotations import only below 3.14 ($minVersion)", ({ minVersion, expected }) => {
    const pyproject = managedPyproject({ minVersion, name: "foo", license: "MIT" });
    expect(pyproject.tables).toContainEqual({ name: "tool.ruff.lint.isort", lines: expected });
  });

  it.each([
    {
      name: "renders the console script and installs from uv.lock for a console script",
      consoleScript: true,
      scripts: [{ name: "project.scripts", lines: ['foo-bar = "foo_bar._main:main"'] }],
      runBaseRunner: ['runner = "uv-venv-lock-runner"'],
      preCommitRunner: ['runner = "uv-venv-runner"'],
    },
    {
      name: "uses tox-uv's default runner without a console script",
      consoleScript: false,
      scripts: [],
      runBaseRunner: [],
      preCommitRunner: [],
    },
  ])("$name", ({ consoleScript, scripts, runBaseRunner, preCommitRunner }) => {
    const pyproject = managedPyproject({ minVersion: "3.11", name: "foo-bar", license: "MIT", consoleScript });
    const lines = (table: string): string[] => pyproject.tables.find(({ name }) => name === table)?.lines ?? [];
    expect(pyproject.tables.filter(({ name }) => name === "project.scripts")).toEqual(scripts);
    expect(lines("tool.tox.env_run_base").filter((line) => line.startsWith("runner = "))).toEqual(runBaseRunner);
    expect(lines("tool.tox.env.pre-commit").filter((line) => line.startsWith("runner = "))).toEqual(preCommitRunner);
  });
});
