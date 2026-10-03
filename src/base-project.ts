import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { License, TextFile } from "projen";
import { GitHubProject } from "projen/lib/github";
import { BANNER } from "./banner";
import { firstCommitYear } from "./git";
import { expandStacks, readExistingRevs } from "./pre-commit";
import { PreCommitConfigFile } from "./pre-commit-config-file";
import { mergePyproject, sqlfluffTables } from "./pyproject";
import { HOME_ASSISTANT_PYTHON, managedPyproject, pythonMainWorkflow, typingWorkflow } from "./python";
import { cargoReleaseWorkflow, homeAssistantReleaseWorkflow, wheelReleaseWorkflow } from "./release";
import { PythonPackaging, Stack } from "./stack";
import { tombiConfigLines, tombiTable } from "./tombi";
import { applyExistingActionRefs, RUNNER, readExistingActionRefs } from "./workflow-actions";
import type { GitHubProjectOptions } from "projen/lib/github";
import type { ExistingRev } from "./pre-commit";
import type { ManagedTable } from "./pyproject";

function readResource(name: string): string {
  return fs.readFileSync(path.join(__dirname, "resources", name), "utf-8");
}

export interface MirrorOptions {
  /**
   * The `pre-commit-mirror` invocation, e.g.
   * `pre-commit-mirror . --language python --package-name ty --id ty --entry 'ty check' --types python`.
   * Rendered verbatim into the `run: |` block of `.github/workflows/main.yml`,
   * which is rendered from the pre-commit-mirror-maker template.
   */
  readonly command: string;

  /**
   * A pre-commit-mirror-maker commit sha to pin `pip install` to. Omit to
   * install the latest release unpinned.
   */
  readonly version?: string;
}

export interface PythonOptions {
  /**
   * Minimum Python version this repo supports, e.g. `"3.11"`. Rendered as
   * `.pre-commit-config.yaml`'s top-level `default_language_version.python`.
   * Required unless `packaging` is `PythonPackaging.HOME_ASSISTANT`, which
   * always uses the only Python Home Assistant runs on and must omit it.
   */
  readonly minVersion?: string;

  /**
   * How the repo is packaged and released. When set, BaseProject renders
   * `.github/workflows/release.yml` and the packaging-specific parts of
   * `pyproject.toml` (lint and tox config is managed either way). Omit for a
   * repo that base shouldn't release (e.g. one with its own release
   * workflow).
   */
  readonly packaging?: PythonPackaging;

  /**
   * Render `.github/workflows/main.yml`, which runs tox in CI, and the tox
   * config in `pyproject.toml`. Turn off for a repo without tests to run.
   *
   * @default true
   */
  readonly ci?: boolean;

  /**
   * Run the type checkers (mypy, pyright, ty) in a GitHub Actions job via
   * mxr/workflows' pre-commit-typing workflow instead of on pre-commit.ci,
   * whose environment is too small for a big project venv. Writes
   * `.github/workflows/typing.yml` and adds the hooks to `ci.skip`.
   *
   * @default false
   */
  readonly runTypeChecksInGithubActions?: boolean;

  /**
   * Required when `packaging` is `PythonPackaging.HOME_ASSISTANT`.
   */
  readonly homeAssistant?: HomeAssistantOptions;

  /**
   * Directory tox runs pytest on and mypy relaxes `disallow_untyped_defs` for.
   *
   * @default "tests"
   */
  readonly testsDir?: string;

  /**
   * Directories beyond the usual layout.
   */
  readonly extras?: PythonExtrasOptions;

  /**
   * File base merges its managed `pyproject.toml` tables into, for a repo
   * whose `pyproject.toml` is itself rendered from a template (e.g. an
   * openapi-generator `pyproject.mustache`).
   *
   * @default "pyproject.toml"
   */
  readonly pyprojectPath?: string;
}

export interface PythonExtrasOptions {
  /**
   * Directories of generated code (e.g. `"pkg/generated"`) that mypy,
   * pyright, and ty skip. Rendered as an `ignore_errors` mypy override and as
   * pyright and ty excludes.
   */
  readonly generated?: string[];

  /**
   * More test directories, run by tox after `testsDir` and relaxed in mypy
   * like it.
   */
  readonly tests?: string[];
}

export interface PreCommitOptions {
  /**
   * Regexes for `.pre-commit-config.yaml`'s top-level `exclude`, e.g.
   * generated code that no hook should touch.
   */
  readonly exclude?: string[];
}

export interface MergifyRule {
  /**
   * The rule's `name`.
   */
  readonly name: string;

  /**
   * The rule's `conditions`, e.g. `author=github-actions[bot]`.
   */
  readonly conditions: string[];
}

export interface MergifyOptions {
  /**
   * Config beyond base's own.
   */
  readonly extras?: MergifyExtrasOptions;
}

export interface MergifyExtrasOptions {
  /**
   * Squash-merge rules added after base's own (pre-commit.ci, renovate, and
   * base updates), e.g. for PRs a repo's own workflows open.
   */
  readonly rules?: MergifyRule[];
}

export interface HomeAssistantOptions {
  /**
   * Integration name shown in HACS, rendered as `hacs.json`'s `name`.
   */
  readonly name: string;

  /**
   * Minimum Home Assistant version, e.g. `"2026.4.0"`, rendered as
   * `hacs.json`'s `homeassistant`.
   */
  readonly minVersion: string;
}

export interface BaseProjectOpt {
  /**
   * Options for `Stack.MIRROR`. Required when that stack is present.
   */
  readonly mirror?: MirrorOptions;

  /**
   * Options for `Stack.PYTHON`. Required when that stack is present.
   */
  readonly python?: PythonOptions;

  /**
   * Options for `.pre-commit-config.yaml`, for any stack.
   */
  readonly preCommit?: PreCommitOptions;

  /**
   * Options for `.github/mergify.yml`, for any stack.
   */
  readonly mergify?: MergifyOptions;
}

export interface BaseProjectOptions extends GitHubProjectOptions {
  /**
   * Which stacks this repo is for. Drives which pre-commit hooks are added
   * and the LICENSE type (`frontend`/`javascript` get AGPL-3.0-or-later,
   * everything else gets MIT).
   */
  readonly stack: Stack[];

  /**
   * Per-stack options, keyed by stack name, plus stack-independent options
   * for individual generated files. Only stacks that need extra
   * configuration to render their files have an entry here.
   */
  readonly opt?: BaseProjectOpt;
}

/**
 * A personal-repo base: stack-appropriate pre-commit hooks, a LICENSE picked
 * by stack, and shared mergify/renovate config.
 *
 * projen external project type — see https://projen.io/docs/custom/custom-projects
 */
export class BaseProject extends GitHubProject {
  public readonly stack: Stack[];
  private readonly pythonMinVersion: string | undefined;
  private readonly pythonPackaging: PythonPackaging | undefined;
  private readonly license: string;
  private readonly pyprojectPath: string;
  private readonly testsDir: string | undefined;
  private readonly extras: PythonExtrasOptions | undefined;
  private readonly ci: boolean;
  private readonly newPreCommitRepoUrls: string[];
  private readonly newWorkflowActions = new Map<string, string[]>();

  constructor(options: BaseProjectOptions) {
    super({ ...options, githubOptions: { pullRequestLint: false, ...options.githubOptions } });

    this.stack = options.stack;
    const isFrontend = this.stack.includes(Stack.FRONTEND);
    const isJavascript = this.stack.includes(Stack.JAVASCRIPT);

    // projen's default marker points at a .projenrc.js downstream repos don't have (see
    // banner.ts), and .gitignore has no option to override it, so shadow the getter
    Object.defineProperty(this.gitignore, "marker", { configurable: true, get: () => BANNER });

    this.license = isFrontend || isJavascript ? "AGPL-3.0-or-later" : "MIT";
    new License(this, {
      spdx: this.license,
      copyrightOwner: "Max R",
      copyrightPeriod: String(firstCommitYear(this.outdir)),
    });

    this.pythonPackaging = options.opt?.python?.packaging;
    const isHomeAssistant = this.pythonPackaging === PythonPackaging.HOME_ASSISTANT;
    if (isHomeAssistant && options.opt?.python?.minVersion) {
      throw new Error(`PythonPackaging.HOME_ASSISTANT always uses python ${HOME_ASSISTANT_PYTHON}; omit opt.python.minVersion`);
    }
    this.pythonMinVersion = isHomeAssistant ? HOME_ASSISTANT_PYTHON : options.opt?.python?.minVersion;
    this.pyprojectPath = options.opt?.python?.pyprojectPath ?? "pyproject.toml";
    this.testsDir = options.opt?.python?.testsDir;
    this.extras = options.opt?.python?.extras;
    this.ci = options.opt?.python?.ci ?? true;
    if (this.stack.includes(Stack.PYTHON) && !this.pythonMinVersion) {
      throw new Error("Stack.PYTHON requires opt.python.minVersion to be set");
    }
    const homeAssistant = options.opt?.python?.homeAssistant;
    const runTypeChecksInGithubActions = this.stack.includes(Stack.PYTHON) && (options.opt?.python?.runTypeChecksInGithubActions ?? false);
    if (isHomeAssistant && !homeAssistant) {
      throw new Error("PythonPackaging.HOME_ASSISTANT requires opt.python.homeAssistant to be set");
    }

    // read before PreCommitConfigFile overwrites it, so already-pinned hooks keep their rev
    const existingPreCommitConfigPath = path.join(this.outdir, ".pre-commit-config.yaml");
    const existingRevs = fs.existsSync(existingPreCommitConfigPath)
      ? readExistingRevs(fs.readFileSync(existingPreCommitConfigPath, "utf-8"))
      : new Map<string, ExistingRev>();

    const preCommitConfigFile = new PreCommitConfigFile(this, {
      stack: this.stack,
      ...(this.pythonMinVersion ? { pythonMinVersion: this.pythonMinVersion } : {}),
      existingRevs: Object.fromEntries(existingRevs),
      typeChecksInGithubActions: runTypeChecksInGithubActions,
      ...(options.opt?.preCommit?.exclude ? { exclude: options.opt.preCommit.exclude } : {}),
    });
    this.newPreCommitRepoUrls = preCommitConfigFile.newRepoUrls;

    if (!isJavascript) {
      new TextFile(this, "biome.json", {
        lines: readResource(isFrontend ? "frontend/biome.json" : "default/biome.json").split("\n"),
      });
    }

    if (this.stack.includes(Stack.RUST)) {
      this.addWorkflow("main.yml", readResource("rust/main.yml").trimEnd().split("\n"));
      this.addWorkflow("release.yml", cargoReleaseWorkflow());
    }

    // python and sql repos keep tombi config in pyproject.toml's `[tool.tombi]` instead
    const stacks = expandStacks(this.stack);
    if (stacks.includes(Stack.TOML) && !stacks.includes(Stack.PYTHON) && !stacks.includes(Stack.SQL)) {
      new TextFile(this, ".config/tombi.toml", {
        marker: false,
        committed: true,
        lines: [`# ${BANNER}`, "", ...tombiConfigLines()],
      });
    }

    if (this.pythonMinVersion && this.ci) {
      this.addWorkflow(
        "main.yml",
        pythonMainWorkflow({
          ...(this.pythonPackaging ? { packaging: this.pythonPackaging } : {}),
          minVersion: this.pythonMinVersion,
          stack: this.stack,
        }),
      );
    }

    if (this.pythonMinVersion && this.pythonPackaging) {
      this.addWorkflow(
        "release.yml",
        this.pythonPackaging === PythonPackaging.WHEEL ? wheelReleaseWorkflow(this.pythonMinVersion) : homeAssistantReleaseWorkflow(),
      );
    }

    if (runTypeChecksInGithubActions) {
      this.addWorkflow("typing.yml", typingWorkflow());
    }

    if (homeAssistant && this.pythonPackaging === PythonPackaging.HOME_ASSISTANT) {
      const hacs = { content_in_root: false, homeassistant: homeAssistant.minVersion, name: homeAssistant.name };
      new TextFile(this, "hacs.json", { marker: false, lines: JSON.stringify(hacs, null, 2).split("\n") });
    }

    if (this.stack.includes(Stack.MIRROR)) {
      const mirror = options.opt?.mirror;
      if (!mirror) {
        throw new Error("Stack.MIRROR requires opt.mirror to be set");
      }
      const { command, version } = mirror;
      const install = version
        ? `pip install git+https://github.com/pre-commit/pre-commit-mirror-maker@${version}`
        : "pip install pre-commit-mirror-maker";
      const commandLines = command
        .trim()
        .split("\n")
        .map((line, i) => (i === 0 ? line.trim() : `          ${line.trim()}`))
        .join("\n");
      this.addWorkflow(
        "main.yml",
        readResource("mirror/main.yml")
          .replace("'{{INSTALL}}'", () => install)
          .replace("{{COMMAND}}", () => commandLines)
          .trimEnd()
          .split("\n"),
      );
    }

    if (isFrontend) {
      this.addWorkflow("main.yml", readResource("frontend/main.yml").trimEnd().split("\n"));
      this.addWorkflow("release.yml", readResource("frontend/release.yml").trimEnd().split("\n"));
      new TextFile(this, "tsconfig.json", { lines: readResource("frontend/tsconfig.json").trimEnd().split("\n") });
      new TextFile(this, "vitest.config.mts", {
        marker: false,
        lines: [`// ${BANNER}`, "", ...readResource("frontend/vitest.config.mts").trimEnd().split("\n")],
      });
      new TextFile(this, "postcss.config.mjs", {
        marker: false,
        lines: [`// ${BANNER}`, "", ...readResource("frontend/postcss.config.mjs").trimEnd().split("\n")],
      });
      new TextFile(this, "next.config.ts", {
        marker: false,
        lines: [`// ${BANNER}`, "", ...readResource("frontend/next.config.ts").trimEnd().split("\n")],
      });
      new TextFile(this, "vercel.json", { lines: readResource("frontend/vercel.json").trimEnd().split("\n") });
    }

    if (expandStacks(this.stack).includes(Stack.GITHUB_ACTIONS)) {
      new TextFile(this, ".github/actionlint.yml", {
        marker: false,
        committed: true,
        lines: [`# ${BANNER}`, "", "# https://github.com/rhysd/actionlint/issues/682", "self-hosted-runner:", "  labels:", `  - ${RUNNER}`],
      });
    }

    if (this.github) {
      // projen's Mergify component only writes root `.mergify.yml`, so write `.github/mergify.yml` directly.
      // pre-commit ci won't automerge on its own: https://github.com/pre-commit-ci/issues/issues/48
      const mergifyRules: MergifyRule[] = [
        {
          name: "automatic merge for pre-commit ci updates",
          conditions: ["author=pre-commit-ci[bot]", "title=[pre-commit.ci] pre-commit autoupdate"],
        },
        { name: "automatic merge for renovate updates", conditions: ["author=renovate[bot]"] },
        { name: "automatic merge for base updates", conditions: ["author=mxr-base-sync[bot]"] },
        ...(options.opt?.mergify?.extras?.rules ?? []),
      ];
      new TextFile(this, ".github/mergify.yml", {
        marker: false,
        committed: true,
        lines: [
          `# ${BANNER}`,
          "",
          "pull_request_rules:",
          ...mergifyRules.flatMap(({ name, conditions }) => [
            `- name: ${name}`,
            "  conditions:",
            ...conditions.map((condition) => `  - ${condition}`),
            "  actions:",
            "    merge:",
            "      method: squash",
          ]),
        ],
      });
    }

    const renovateConfig = {
      $schema: "https://docs.renovatebot.com/renovate-schema.json",
      commitMessageAction: "weekly",
      commitMessagePrefix: "[renovate]",
      // the windows runner is a tox.yml `os` input, not `runs-on`, so the github-actions manager misses it
      ...(this.stack.includes(Stack.PYTHON)
        ? {
            customManagers: [
              {
                customType: "regex",
                managerFilePatterns: ["/^\\.github/workflows/main\\.yml$/"],
                matchStrings: ["\\sos: (?<depName>windows)-(?<currentValue>\\S+)"],
                datasourceTemplate: "github-runners",
                versioningTemplate: "docker",
              },
            ],
          }
        : {}),
      extends: ["config:recommended", ":disableDependencyDashboard"],
      groupSingleUpdates: true,
      minimumReleaseAge: "7 days",
      packageRules: [
        { commitMessageExtra: " ", groupName: "update", matchPackageNames: ["*"] },
        // github-runners has no release timestamps, so minimumReleaseAge would otherwise block every runner update
        { matchDatasources: ["github-runners"], minimumReleaseAgeBehaviour: "timestamp-optional" },
      ],
      prBodyTemplate: "{{{table}}}",
      schedule: ["* 21-22 * * 1"],
      separateMajorMinor: false,
      separateMultipleMajor: false,
    };
    new TextFile(this, ".github/renovate.jsonc", {
      marker: false,
      committed: true,
      lines: [`// ${BANNER}`, ...JSON.stringify(renovateConfig, null, 2).split("\n")],
    });
  }

  /**
   * Adds a generated `.github/workflows/<file>`. Action versions default to a `v0.0.0` placeholder,
   * unless the existing workflow already pins that action. Only placeholders are resolved by pinact.
   */
  private addWorkflow(file: string, body: string[]) {
    const workflowPath = `.github/workflows/${file}`;
    const existingPath = path.join(this.outdir, workflowPath);
    const existing = fs.existsSync(existingPath) ? readExistingActionRefs(fs.readFileSync(existingPath, "utf-8")) : new Map();
    const { lines, newActions } = applyExistingActionRefs(body, existing);
    if (newActions.length > 0) {
      this.newWorkflowActions.set(workflowPath, newActions);
    }
    new TextFile(this, workflowPath, { marker: false, committed: true, lines: [`# ${BANNER}`, "", ...lines] });
  }

  public override postSynthesize() {
    super.postSynthesize();

    if (!isGitRepo(this.outdir)) {
      return;
    }

    // some hooks (e.g. end-of-file-fixer) open every file for writing and fail on projen's readonly ones
    execFileSync("chmod", ["-R", "u+w", this.outdir]);

    // remove projen files that i don't use
    fs.rmSync(path.join(this.outdir, ".gitattributes"), { force: true });
    fs.rmSync(path.join(this.outdir, ".projen"), { recursive: true, force: true });

    const gitignorePath = path.join(this.outdir, ".gitignore");
    if (this.stack.includes(Stack.RUST)) {
      fs.rmSync(gitignorePath, { force: true });
      fs.writeFileSync(gitignorePath, `# ${BANNER}\n/target/\n`);
    } else if (this.stack.includes(Stack.FRONTEND)) {
      fs.chmodSync(gitignorePath, 0o644);
      fs.appendFileSync(
        gitignorePath,
        [
          "/.next/",
          "/out/",
          "/coverage",
          ".DS_Store",
          "*.pem",
          "npm-debug.log*",
          ".env*",
          ".vercel",
          "*.tsbuildinfo",
          "next-env.d.ts",
          "",
        ].join("\n"),
      );
    } else {
      // most repos dont have a prescriptive .gitignore
      fs.rmSync(gitignorePath, { force: true });
    }

    // pyproject.toml (or its template) is otherwise owned by the downstream repo, so only base's tables and keys are managed
    const partiallyManagedFiles: string[] = [];
    const python = this.pythonMinVersion
      ? managedPyproject({
          ...(this.pythonPackaging ? { packaging: this.pythonPackaging } : {}),
          minVersion: this.pythonMinVersion,
          name: this.name,
          license: this.license,
          ...(this.testsDir ? { testsDir: this.testsDir } : {}),
          extraTestsDirs: this.extras?.tests ?? [],
          generatedDirs: this.extras?.generated ?? [],
          ci: this.ci,
        })
      : undefined;
    const isSql = this.stack.includes(Stack.SQL);
    if (python || isSql) {
      const pyprojectPath = path.join(this.outdir, this.pyprojectPath);
      const existing = fs.existsSync(pyprojectPath) ? fs.readFileSync(pyprojectPath, "utf-8") : "";
      const tables: ManagedTable[] = [...(python?.tables ?? []), ...(isSql ? sqlfluffTables() : []), tombiTable()];
      fs.writeFileSync(
        pyprojectPath,
        mergePyproject(existing, {
          tables,
          ...(python?.projectKeys ? { projectKeys: python.projectKeys } : {}),
          ...(isSql ? { ownedPrefixes: ["tool.sqlfluff"] } : {}),
        }),
      );
      partiallyManagedFiles.push(this.pyprojectPath);
    }

    // `pre-commit run --all-files` skips untracked files, so stage new/renamed managed files.
    // Not `-A`: propagate-repo.sh's scaffolding (package.json, node_modules, etc.) is still in outdir.
    const managedFiles = [...this.files.map((file) => file.path), ...partiallyManagedFiles].filter((file) =>
      fs.existsSync(path.join(this.outdir, file)),
    );
    if (managedFiles.length > 0) {
      execFileSync("git", ["add", "--", ...managedFiles], { cwd: this.outdir });
    }

    // pin only actions newly added by this synth (see addWorkflow); renovate owns bumps.
    // One task per file, since an action can be new to one workflow but already pinned in another.
    const pinactTasks: (readonly (readonly string[])[])[] = [...this.newWorkflowActions].map(([file, actions]) => [
      ["pinact", "run", "-u", ...actions.flatMap((action) => ["-i", `^${escapeRegExp(action)}$`]), file],
    ]);
    // resolve placeholder `v0.0.0` revs (see mergeRepos in pre-commit.ts) on new repos only.
    // Then finish generating .pre-commit-config.yaml, for example sync-typing-deps will seed additional_dependencies.
    const configTask = [
      ...(this.newPreCommitRepoUrls.length > 0
        ? [["pre-commit", "autoupdate", "--freeze", ...this.newPreCommitRepoUrls.flatMap((repo) => ["--repo", repo])]]
        : []),
      ["pre-commit", "run", "--files", ".pre-commit-config.yaml"],
    ];
    runTasksInParallelIgnoringFailure([...pinactTasks, configTask], this.outdir);

    // first pass may fail from formatter fixes; still open the PR if the second fails
    if (!runIgnoringFailure(["pre-commit", "run", "--all-files"], this.outdir)) {
      runIgnoringFailure(["pre-commit", "run", "--all-files"], this.outdir);
    }
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isGitRepo(outdir: string): boolean {
  try {
    execFileSync("git", ["-C", outdir, "rev-parse", "--is-inside-work-tree"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function runIgnoringFailure(command: readonly string[], cwd: string): boolean {
  const [file, ...args] = command;
  if (!file) {
    return false;
  }
  try {
    execFileSync(file, args, { cwd, stdio: "inherit" });
    return true;
  } catch {
    // formatters exit non-zero on the run that fixes files
    return false;
  }
}

function shQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

// runs tasks concurrently as background jobs in one `sh -c` (steps within a task run in order).
// Blocks until all finish, since postSynthesize() can't await. Failures are ignored.
function runTasksInParallelIgnoringFailure(tasks: readonly (readonly (readonly string[])[])[], cwd: string): void {
  const quote = (command: readonly string[]): string => command.map(shQuote).join(" ");
  const pids = tasks.map((_, i) => `pid${i}`);
  const script = [
    ...tasks.map((task, i) => `{ ${task.length > 0 ? task.map((step) => `${quote(step)} ;`).join(" ") : ": ;"} } & ${pids[i]}=$!`),
    `wait ${pids.map((pid) => `$${pid}`).join(" ")}`,
  ].join("\n");
  runIgnoringFailure(["sh", "-c", script], cwd);
}
