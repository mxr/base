import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { License, TextFile } from "projen";
import { GitHubProject } from "projen/lib/github";
import { BANNER } from "./banner";
import { firstCommitYear } from "./git";
import { expandStacks, readExistingRevs } from "./pre-commit";
import { PreCommitConfigFile } from "./pre-commit-config-file";
import { mergePyproject, sqlfluffTables } from "./pyproject";
import {
  HOME_ASSISTANT_PYTHON,
  homeAssistantValidateWorkflow,
  managedPyproject,
  pythonMainWorkflow,
  pythonToxEnvs,
  STABLE_PYTHON,
  toxEnv,
  typingWorkflow,
} from "./python";
import { cargoReleaseWorkflow, homeAssistantReleaseWorkflow, wheelReleaseWorkflow } from "./release";
import { PythonPackaging, RenovateCustomManager, Stack } from "./stack";
import { applyExistingActionRefs, RUNNER, readExistingActionRefs } from "./workflow-actions";
import type { GitHubProjectOptions } from "projen/lib/github";
import type { ExistingRev } from "./pre-commit";
import type { ManagedTable } from "./pyproject";

function readResource(name: string): string {
  return fs.readFileSync(path.join(__dirname, "resources", name), "utf-8");
}

// pinned here instead of as a downstream devDependency, which Vercel ignores and warns about during builds.
// Only new repos get this version: renovate bumps release.yml downstream, and synth keeps that version.
// renovate: datasource=npm depName=vercel
const VERCEL_VERSION = "65.8.0";
const VERCEL_VERSION_RE = /^\s+VERCEL_VERSION: (\S+)$/m;

const RENOVATE_CUSTOM_MANAGER_PRESETS: Record<RenovateCustomManager, string> = {
  [RenovateCustomManager.GITHUB_ACTIONS_VERSIONS]: "customManagers:githubActionsVersions",
};

export interface MirrorOptions {
  /**
   * The `pre-commit-mirror` command, such as
   * `pre-commit-mirror . --language python --package-name ty --id ty --entry 'ty check' --types python`.
   * Rendered verbatim into the `run: |` block of `.github/workflows/main.yml`,
   * which comes from the pre-commit-mirror-maker template.
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
   * Minimum Python version this repo supports, such as `"3.11"`. Rendered as
   * `.pre-commit-config.yaml`'s top-level `default_language_version.python`.
   * Required unless `packaging` is `PythonPackaging.HOME_ASSISTANT`. A Home
   * Assistant integration always uses the one Python that Home Assistant runs
   * on, so it must omit this.
   */
  readonly minVersion?: string;

  /**
   * How the repo is packaged and released. When set, BaseProject renders
   * `.github/workflows/release.yml` and the packaging-specific parts of
   * `pyproject.toml`. Lint and tox config is managed either way. Omit for a
   * repo that isn't packaged.
   */
  readonly packaging?: PythonPackaging;

  /**
   * Leave `.github/workflows/release.yml` to a repo that has its own release
   * workflow. Base still manages the packaging-specific parts of
   * `pyproject.toml`.
   *
   * @default false
   */
  readonly customRelease?: boolean;

  /**
   * Render `.github/workflows/main.yml`, which runs tox in CI, and the tox
   * config in `pyproject.toml`. Turn off for a repo without tests to run.
   *
   * @default true
   */
  readonly ci?: boolean;

  /**
   * The repo ships a console script named after the repo, at
   * `<module>._main:main`, rendered as `[project.scripts]`. For example,
   * `foo-bar = "foo_bar._main:main"`. The repo also commits a `uv.lock` that
   * tox installs from with tox-uv's `uv-venv-lock-runner`. BaseProject runs
   * `uv lock` to create or update the lockfile.
   *
   * @default false
   */
  readonly consoleScript?: boolean;

  /**
   * Run the type checkers (mypy, pyright, ty) in a GitHub Actions job with
   * mxr/workflows' pre-commit-typing workflow instead of on pre-commit.ci,
   * whose environment is too small for a big project venv. Writes
   * `.github/workflows/typing.yml` and adds the hooks to `ci.skip`.
   *
   * @default false
   */
  readonly runTypeChecksInGithubActions?: boolean;

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
   * File that base merges its managed `pyproject.toml` tables into. Set it when
   * `pyproject.toml` is itself rendered from a template, such as an
   * openapi-generator `pyproject.mustache`.
   *
   * @default "pyproject.toml"
   */
  readonly pyprojectPath?: string;
}

export interface PythonExtrasOptions {
  /**
   * Directories of generated code, such as `"pkg/generated"`, that mypy,
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

export interface GithubActionsOptions {
  /**
   * Renovate built-in custom manager presets added to `.github/renovate.jsonc`'s
   * `extends`.
   */
  readonly customManagers?: RenovateCustomManager[];
}

export interface PreCommitOptions {
  /**
   * Regexes for `.pre-commit-config.yaml`'s top-level `exclude`, such as
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
   * The rule's `conditions`, such as `author=github-actions[bot]`.
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
   * Squash-merge rules added after base's own rules for pre-commit.ci,
   * renovate, and base updates. Use them for PRs that the repo's own workflows
   * open.
   */
  readonly rules?: MergifyRule[];
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
   * Options for `Stack.GITHUB_ACTIONS`.
   */
  readonly githubActions?: GithubActionsOptions;

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
   * Stacks this repo uses. They decide which files base generates and the
   * LICENSE: `frontend` and `javascript` get AGPL-3.0-or-later, and every
   * other stack gets MIT.
   */
  readonly stack: Stack[];

  /**
   * Per-stack options keyed by stack name, plus options for individual
   * generated files that apply to any stack. Only stacks that need extra
   * configuration have an entry.
   */
  readonly opt?: BaseProjectOpt;
}

/**
 * Projen external project type for mxr's personal repos. Generates
 * pre-commit hooks, workflows, and tool config for each stack, a LICENSE
 * picked by stack, and shared mergify and renovate config.
 *
 * See https://projen.io/docs/custom/custom-projects.
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
  private readonly consoleScript: boolean;
  private readonly customRelease: boolean;
  private readonly newPreCommitRepoUrls: string[];
  private readonly newWorkflowActions = new Map<string, string[]>();

  constructor(options: BaseProjectOptions) {
    super({ ...options, githubOptions: { pullRequestLint: false, ...options.githubOptions } });

    this.stack = options.stack;
    const isFrontend = this.stack.includes(Stack.FRONTEND);
    const isJavascript = this.stack.includes(Stack.JAVASCRIPT);

    // projen's default marker points at a .projenrc.js that downstream repos don't have
    // (see banner.ts). .gitignore has no option to override the marker, so shadow the getter.
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
    this.consoleScript = options.opt?.python?.consoleScript ?? false;
    this.customRelease = options.opt?.python?.customRelease ?? false;
    if (this.stack.includes(Stack.PYTHON) && !this.pythonMinVersion) {
      throw new Error("Stack.PYTHON requires opt.python.minVersion to be set");
    }
    const runTypeChecksInGithubActions = this.stack.includes(Stack.PYTHON) && (options.opt?.python?.runTypeChecksInGithubActions ?? false);

    // read the current config before PreCommitConfigFile overwrites it, so already-pinned hooks keep their rev
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
      const biomeResource = isFrontend
        ? "frontend/biome.json"
        : this.stack.includes(Stack.TYPESCRIPT)
          ? "typescript/biome.json"
          : "default/biome.json";
      new TextFile(this, "biome.json", { lines: readResource(biomeResource).split("\n") });
    }

    if (this.stack.includes(Stack.RUST)) {
      this.addWorkflow("main.yml", readResource("rust/main.yml").trimEnd().split("\n"));
      this.addWorkflow("release.yml", cargoReleaseWorkflow());
    }

    if (this.pythonMinVersion && this.ci) {
      this.addWorkflow(
        "main.yml",
        pythonMainWorkflow({
          ...(this.pythonPackaging ? { packaging: this.pythonPackaging } : {}),
          envs: isHomeAssistant ? [toxEnv(HOME_ASSISTANT_PYTHON)] : pythonToxEnvs(this.pythonMinVersion),
          stack: this.stack,
        }),
      );
    }

    if (this.pythonMinVersion && this.pythonPackaging && !this.customRelease) {
      this.addWorkflow(
        "release.yml",
        this.pythonPackaging === PythonPackaging.WHEEL ? wheelReleaseWorkflow() : homeAssistantReleaseWorkflow(),
      );
    }

    if (runTypeChecksInGithubActions) {
      this.addWorkflow("typing.yml", typingWorkflow());
    }

    if (isHomeAssistant) {
      this.addWorkflow("validate-home-assistant.yml", homeAssistantValidateWorkflow());
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
        readResource("mirror/main.yml.tpl")
          .replace("'{{INSTALL}}'", () => install)
          .replace("{{PYTHON}}", STABLE_PYTHON)
          .replace("{{COMMAND}}", () => commandLines)
          .trimEnd()
          .split("\n"),
      );
    }

    if (isFrontend) {
      this.addWorkflow("main.yml", readResource("frontend/main.yml").trimEnd().split("\n"));
      const releasePath = path.join(this.outdir, ".github/workflows/release.yml");
      const existingRelease = fs.existsSync(releasePath) ? fs.readFileSync(releasePath, "utf-8") : "";
      const vercelVersion = VERCEL_VERSION_RE.exec(existingRelease)?.[1] ?? VERCEL_VERSION;
      this.addWorkflow(
        "release.yml",
        readResource("frontend/release.yml").replace("VERCEL_VERSION: 0.0.0", `VERCEL_VERSION: ${vercelVersion}`).trimEnd().split("\n"),
      );
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
        lines: [
          `# ${BANNER}`,
          "",
          "# https://github.com/rhysd/actionlint/issues/682",
          "self-hosted-runner:",
          "  labels:",
          `  - ${RUNNER}`,
          "",
          "# https://github.com/rhysd/actionlint/issues/711",
          "paths:",
          "  .github/workflows/**/*.{yaml,yml}:",
          "    ignore:",
          '    - reusable workflow call "\\$/.+" at "uses" is not following the format',
          '    - specifying action "\\$/.+" in invalid format because ref is missing',
        ],
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

    const customManagers = options.opt?.githubActions?.customManagers ?? [];
    if (customManagers.length > 0 && !expandStacks(this.stack).includes(Stack.GITHUB_ACTIONS)) {
      throw new Error("opt.githubActions requires Stack.GITHUB_ACTIONS");
    }
    const renovateRegexManagers = [
      // the windows runner is tox-uv.yml's `os` input, not `runs-on`, so the github-actions manager misses it
      ...(this.stack.includes(Stack.PYTHON)
        ? [
            {
              customType: "regex",
              managerFilePatterns: ["/^\\.github/workflows/main\\.yml$/"],
              matchStrings: ["\\sos: (?<depName>windows)-(?<currentValue>\\S+)"],
              datasourceTemplate: "github-runners",
              versioningTemplate: "docker",
            },
          ]
        : []),
      // string constants annotated with a `// renovate: datasource=... depName=...` comment, like the githubActionsVersions preset
      ...(this.stack.includes(Stack.TYPESCRIPT)
        ? [
            {
              customType: "regex",
              managerFilePatterns: ["/^src/.+\\.ts$/"],
              matchStrings: [
                '// renovate: datasource=(?<datasource>[a-zA-Z0-9-._]+?) depName=(?<depName>[^\\s]+?)(?: versioning=(?<versioning>[^\\s]+?))?(?: extractVersion=(?<extractVersion>[^\\s]+?))?\\s+(?:export )?const [A-Za-z0-9_]+ = "(?<currentValue>[^"]+)"',
              ],
            },
          ]
        : []),
    ];
    const renovateConfig = {
      $schema: "https://docs.renovatebot.com/renovate-schema.json",
      commitMessageAction: "weekly",
      commitMessagePrefix: "[renovate]",
      ...(renovateRegexManagers.length > 0 ? { customManagers: renovateRegexManagers } : {}),
      extends: [
        "config:recommended",
        ":disableDependencyDashboard",
        // frontend release.yml pins the Vercel CLI as an annotated `VERCEL_VERSION` env var
        ...new Set(
          [...customManagers, ...(isFrontend ? [RenovateCustomManager.GITHUB_ACTIONS_VERSIONS] : [])].map(
            (manager) => RENOVATE_CUSTOM_MANAGER_PRESETS[manager],
          ),
        ),
      ],
      groupSingleUpdates: true,
      minimumReleaseAge: "7 days",
      // npm 12 refuses registry tarballs of packages with bundleDependencies, such as projen and tailwind oxide, unless remote fetches are allowed
      ...([Stack.FRONTEND, Stack.TYPESCRIPT].some((s) => this.stack.includes(s)) ? { npmrc: "allow-remote=all" } : {}),
      packageRules: [
        { commitMessageExtra: " ", groupName: "update", matchPackageNames: ["*"] },
        // github-runners has no release timestamps, so minimumReleaseAge would otherwise block every runner update
        { matchDatasources: ["github-runners"], minimumReleaseAgeBehaviour: "timestamp-optional" },
        // ghcr has no release timestamps either, for validate-home-assistant.yml's hassfest image
        ...(this.pythonPackaging === PythonPackaging.HOME_ASSISTANT
          ? [{ matchDepNames: ["ghcr.io/home-assistant/hassfest"], minimumReleaseAgeBehaviour: "timestamp-optional" }]
          : []),
        // jsii pins the typescript major it supports
        ...(this.stack.includes(Stack.TYPESCRIPT)
          ? [
              { enabled: false, matchPackageNames: ["typescript"], matchUpdateTypes: ["major"] },
              // the default widen strategy leaves peer ranges behind the devDependency pins, and chains `||` ranges on 0.x
              { matchDepTypes: ["peerDependencies"], rangeStrategy: "bump" },
            ]
          : []),
      ],
      prBodyTemplate: "{{{table}}}",
      "pre-commit": { enabled: true },
      schedule: ["* 19-20 * * 1"],
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
   * Adds `.github/workflows/<file>`. Each action ref is a `v0.0.0` placeholder unless the existing
   * workflow already pins that action. pinact resolves only the placeholders.
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

    // drop projen files these repos don't use. typescript repos get base's own .gitattributes
    const gitattributesPath = path.join(this.outdir, ".gitattributes");
    fs.rmSync(gitattributesPath, { force: true });
    fs.rmSync(path.join(this.outdir, ".projen"), { recursive: true, force: true });
    if (this.stack.includes(Stack.TYPESCRIPT)) {
      fs.writeFileSync(gitattributesPath, `# ${BANNER}\n* text=auto eol=lf\n`);
    }

    const gitignorePath = path.join(this.outdir, ".gitignore");
    const ignores = [
      ...(this.stack.includes(Stack.RUST) ? ["/target/"] : []),
      ...(this.stack.includes(Stack.PYTHON)
        ? [
            "*.egg-info/",
            "*.pyc",
            ".coverage",
            ".mypy_cache/",
            ".pytest_cache/",
            ".ruff_cache/",
            ".tox/",
            ".venv/",
            "/build/",
            "/dist/",
            "__pycache__/",
          ]
        : []),
    ].sort();
    if (ignores.length > 0) {
      fs.rmSync(gitignorePath, { force: true });
      fs.writeFileSync(gitignorePath, [`# ${BANNER}`, ...ignores, ""].join("\n"));
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
    } else if (this.stack.includes(Stack.TYPESCRIPT)) {
      fs.rmSync(gitignorePath, { force: true });
      fs.writeFileSync(
        gitignorePath,
        [
          `# ${BANNER}`,
          "*.log",
          "*.tgz",
          "*.tsbuildinfo",
          ".DS_Store",
          ".jsii",
          "/coverage/",
          "/dist/",
          "/lib/",
          "/test-reports/",
          "node_modules/",
          "",
        ].join("\n"),
      );
    } else {
      // other stacks don't get a managed .gitignore
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
          consoleScript: this.consoleScript,
        })
      : undefined;
    const isSql = this.stack.includes(Stack.SQL);
    if (python || isSql) {
      const pyprojectPath = path.join(this.outdir, this.pyprojectPath);
      const existing = fs.existsSync(pyprojectPath) ? fs.readFileSync(pyprojectPath, "utf-8") : "";
      const tables: ManagedTable[] = [...(python?.tables ?? []), ...(isSql ? sqlfluffTables() : [])];
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
    if (python && this.consoleScript) {
      execFileSync("uv", ["lock"], { cwd: this.outdir, stdio: "inherit" });
      partiallyManagedFiles.push("uv.lock");
    }

    // `pre-commit run --all-files` skips untracked files, so stage new and renamed managed files.
    // Not `-A`, since propagate-repo.sh's scaffolding, such as package.json and node_modules, is still in outdir.
    const managedFiles = [...this.files.map((file) => file.path), ...partiallyManagedFiles].filter((file) =>
      fs.existsSync(path.join(this.outdir, file)),
    );
    if (managedFiles.length > 0) {
      execFileSync("git", ["add", "--", ...managedFiles], { cwd: this.outdir });
    }

    // pin only actions that this synth added (see addWorkflow). Renovate owns bumps.
    // One task per file, since an action can be new to one workflow and already pinned in another.
    const pinactTasks: (readonly (readonly string[])[])[] = [...this.newWorkflowActions].map(([file, actions]) => [
      ["pinact", "run", "-u", ...actions.flatMap((action) => ["-i", `^${escapeRegExp(action)}$`]), file],
    ]);
    // resolve the `v0.0.0` placeholder revs (see mergeRepos in pre-commit.ts) on new repos only.
    // Then run the hooks on .pre-commit-config.yaml to finish it. For example, sync-typing-deps seeds additional_dependencies.
    const configTask = [
      ...(this.newPreCommitRepoUrls.length > 0
        ? [["pre-commit", "autoupdate", "--freeze", ...this.newPreCommitRepoUrls.flatMap((repo) => ["--repo", repo])]]
        : []),
      ["pre-commit", "run", "--files", ".pre-commit-config.yaml"],
    ];
    runTasksInParallelIgnoringFailure([...pinactTasks, configTask], this.outdir);

    // the first pass can fail because formatters fixed files, so rerun. Stage those fixes first:
    // if the second pass fails and leaves the worktree clean, the failure is real, not formatter churn
    if (!runIgnoringFailure("pre-commit", ["run", "--all-files"], this.outdir)) {
      execFileSync("git", ["add", "-u"], { cwd: this.outdir });
      if (
        !runIgnoringFailure("pre-commit", ["run", "--all-files"], this.outdir) &&
        runIgnoringFailure("git", ["diff", "--quiet"], this.outdir)
      ) {
        throw new Error("pre-commit failed without changing any files");
      }
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

function runIgnoringFailure(file: string, args: readonly string[], cwd: string): boolean {
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

// runs each task as a background job in one `sh -c`. Steps within a task run in order.
// Blocks until every task finishes, since postSynthesize() can't await. Ignores failures.
function runTasksInParallelIgnoringFailure(tasks: readonly (readonly (readonly string[])[])[], cwd: string): void {
  const quote = (command: readonly string[]): string => command.map(shQuote).join(" ");
  const pids = tasks.map((_, i) => `pid${i}`);
  const script = [
    ...tasks.map((task, i) => `{ ${task.map((step) => `${quote(step)} ;`).join(" ")} } & ${pids[i]}=$!`),
    `wait ${pids.map((pid) => `$${pid}`).join(" ")}`,
  ].join("\n");
  runIgnoringFailure("sh", ["-c", script], cwd);
}
