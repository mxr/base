import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { License, TextFile } from "projen";
import { GitHubProject } from "projen/lib/github";
import { BANNER } from "./banner";
import { firstCommitYear } from "./git";
import { readExistingRevs } from "./pre-commit";
import { PreCommitConfigFile } from "./pre-commit-config-file";
import { Stack } from "./stack";
import { applyExistingActionRefs, readExistingActionRefs } from "./workflow-actions";
import type { GitHubProjectOptions } from "projen/lib/github";
import type { ExistingRev } from "./pre-commit";

function readResource(name: string): string {
  return fs.readFileSync(path.join(__dirname, "resources", name), "utf-8");
}

export interface MirrorPreCommitMirrorMakerOptions {
  /**
   * The `pre-commit-mirror` invocation, e.g.
   * `pre-commit-mirror . --language python --package-name ty --id ty --entry 'ty check' --types python`.
   * Rendered verbatim into the workflow's `run: |` block.
   */
  readonly command: string;

  /**
   * A pre-commit-mirror-maker commit sha to pin `pip install` to. Omit to
   * install the latest release unpinned.
   */
  readonly version?: string;
}

// biome-ignore lint/suspicious/noEmptyInterface: marker interface with no members, required by jsii (a type alias isn't a supported public API type)
export interface MirrorCustomOptions {}

export interface MirrorOptions {
  /**
   * Renders `.github/workflows/main.yml` from the pre-commit-mirror-maker
   * template. Mutually exclusive with `custom`.
   */
  readonly preCommitMirrorMaker?: MirrorPreCommitMirrorMakerOptions;

  /**
   * Set for a mirror repo whose `.github/workflows/main.yml` is
   * hand-maintained (e.g. it runs its own test suite rather than
   * pre-commit-mirror-maker) - BaseProject then leaves that file alone
   * instead of overwriting it. Mutually exclusive with `preCommitMirrorMaker`.
   */
  readonly custom?: MirrorCustomOptions;
}

export interface PythonOptions {
  /**
   * Minimum Python version this repo supports, e.g. `"3.11"`. Rendered as
   * `.pre-commit-config.yaml`'s top-level `default_language_version.python`.
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
}

export interface BaseProjectOptions extends GitHubProjectOptions {
  /**
   * Which stacks this repo is for. Drives which pre-commit hooks are added
   * and the LICENSE type (`frontend`/`javascript` get AGPL-3.0-or-later,
   * everything else gets MIT).
   */
  readonly stack: Stack[];

  /**
   * Per-stack options, keyed by stack name. Only stacks that need extra
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
  private readonly renovateDisable: string[];
  private readonly pythonMinVersion?: string;
  private readonly newPreCommitRepoUrls: string[];
  private readonly newWorkflowActions = new Map<string, string[]>();

  constructor(options: BaseProjectOptions) {
    super({ ...options, githubOptions: { pullRequestLint: false, ...options.githubOptions } });

    this.stack = options.stack;
    const isFrontend = this.stack.includes(Stack.FRONTEND);
    const isJavascript = this.stack.includes(Stack.JAVASCRIPT);
    // @vercel/fun (used by the Vercel deploy workflow) transitively pins a
    // deprecated `tar` that npm's own override can't safely be auto-bumped
    // past, so disable it in Renovate for every Next.js repo
    this.renovateDisable = isFrontend ? ["tar"] : [];

    // FileBase's own marker wording is fixed and points at a .projenrc.js
    // that doesn't exist in downstream repos (see banner.ts); .gitignore is
    // projen's own built-in component with no option to swap that wording via
    // its constructor, so shadow the inherited `marker` getter on this
    // instance to ship the custom banner instead
    Object.defineProperty(this.gitignore, "marker", { configurable: true, get: () => BANNER });

    new License(this, {
      spdx: isFrontend || isJavascript ? "AGPL-3.0-or-later" : "MIT",
      copyrightOwner: "Max R",
      copyrightPeriod: String(firstCommitYear(this.outdir)),
    });

    if (this.stack.includes(Stack.PYTHON) && !options.opt?.python) {
      throw new Error("Stack.PYTHON requires opt.python.minVersion to be set");
    }

    this.pythonMinVersion = options.opt?.python?.minVersion;

    // read the downstream repo's current .pre-commit-config.yaml (still on
    // disk from the pre-synth checkout) before PreCommitConfigFile below
    // overwrites it, so an already-pinned hook keeps its existing rev instead
    // of resetting to a placeholder that autoupdate --freeze would re-resolve
    // on every synth
    const existingPreCommitConfigPath = path.join(this.outdir, ".pre-commit-config.yaml");
    const existingRevs = fs.existsSync(existingPreCommitConfigPath)
      ? readExistingRevs(fs.readFileSync(existingPreCommitConfigPath, "utf-8"))
      : new Map<string, ExistingRev>();

    const preCommitConfigFile = new PreCommitConfigFile(this, {
      stack: this.stack,
      pythonMinVersion: this.pythonMinVersion,
      existingRevs: Object.fromEntries(existingRevs),
    });
    this.newPreCommitRepoUrls = preCommitConfigFile.newRepoUrls;

    if (!isJavascript) {
      new TextFile(this, "biome.json", {
        lines: readResource(isFrontend ? "frontend/biome.json" : "default/biome.json").split("\n"),
      });
    }

    if (this.stack.includes(Stack.RUST)) {
      this.addWorkflow("main.yml", readResource("rust/main.yml").trimEnd().split("\n"));
      this.addWorkflow("release.yml", readResource("rust/release.yml").trimEnd().split("\n"));
    }

    if (this.stack.includes(Stack.MIRROR)) {
      const mirror = options.opt?.mirror;
      if (!mirror?.preCommitMirrorMaker && !mirror?.custom) {
        throw new Error("Stack.MIRROR requires opt.mirror.preCommitMirrorMaker or opt.mirror.custom to be set");
      }
      if (mirror.preCommitMirrorMaker) {
        const { command, version } = mirror.preCommitMirrorMaker;
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

    if (this.github) {
      // projen's own Mergify component hardcodes its output to root
      // `.mergify.yml`; write the same shape it would to `.github/mergify.yml`
      // instead, since that's the path this repo's downstream consumers expect.
      // Pre-commit ci won't automerge on its own (see
      // https://github.com/pre-commit-ci/issues/issues/48), hence that rule.
      new TextFile(this, ".github/mergify.yml", {
        marker: false,
        committed: true,
        lines: [
          `# ${BANNER}`,
          "",
          "pull_request_rules:",
          "- name: automatic merge for pre-commit ci updates",
          "  conditions:",
          "  - author=pre-commit-ci[bot]",
          "  - title=[pre-commit.ci] pre-commit autoupdate",
          "  actions:",
          "    merge:",
          "      method: squash",
          "- name: automatic merge for renovate updates",
          "  conditions:",
          "  - author=renovate[bot]",
          "  actions:",
          "    merge:",
          "      method: squash",
          "- name: automatic merge for base updates",
          "  conditions:",
          "  - or:",
          "    - author=mxr-base-sync[bot]",
          "    - author=mxr-base-copier-sync[bot]",
          "  actions:",
          "    merge:",
          "      method: squash",
        ],
      });
    }

    const renovateConfig = {
      $schema: "https://docs.renovatebot.com/renovate-schema.json",
      commitMessageAction: "weekly",
      commitMessagePrefix: "[renovate]",
      extends: ["config:recommended", ":disableDependencyDashboard"],
      groupSingleUpdates: true,
      minimumReleaseAge: "7 days",
      packageRules: [
        ...(this.renovateDisable.length > 0 ? [{ matchPackageNames: this.renovateDisable, enabled: false }] : []),
        { commitMessageExtra: " ", groupName: "update", matchPackageNames: ["*"] },
      ],
      prBodyTemplate: "{{{table}}}",
      schedule: ["* 16-17 * * 1"],
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
   * Adds a generated `.github/workflows/<file>`. A `v0.0.0` placeholder is set for each action version.
   * If the upstream repo has the action already then that version is used. Only versions that remaing as v0.0.0 are updated by pinact.
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

  public postSynthesize() {
    super.postSynthesize();

    if (!isGitRepo(this.outdir)) {
      return;
    }

    // projen marks most generated files readonly to discourage hand-edits
    // between synths, but some pre-commit hooks (e.g. end-of-file-fixer)
    // unconditionally open every file for writing even when no fix is
    // needed, so they'd hard-fail on any readonly file; unlock everything
    // since it's all about to be regenerated on the next synth anyway
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

    // `pre-commit run --all-files` only considers files `git ls-files` knows
    // about, so a freshly generated or renamed file (e.g. this synth renaming
    // renovate.json to renovate.jsonc) would silently skip every hook below
    // until propagate-repo.sh's own `git add -A` runs after synth is done.
    // Add just the files this project actually manages rather than `-A`:
    // propagate-repo.sh's scaffolding (package.json, node_modules, etc.) is
    // still sitting in outdir at this point and .gitignore was just deleted
    // above, so a blanket `-A` would stage all of it.
    const managedFiles = this.files.map((file) => file.path).filter((file) => fs.existsSync(path.join(this.outdir, file)));
    if (managedFiles.length > 0) {
      execFileSync("git", ["add", "--", ...managedFiles], { cwd: this.outdir });
    }

    // propagate-update.yml already installs `pre-commit` (via `uv tool
    // install pre-commit --python <opt.python.minVersion>`) under the
    // interpreter this repo needs before synth runs, so
    // default_language_version.python matches pre-commit's own interpreter
    // without pinning anything here.

    // pins GitHub Actions refs in generated workflows to a full sha with a
    // version comment, scoped to just the files and actions
    // newly added by this synth (see addWorkflow), so already-pinned actions
    // aren't re-bumped on every synth - renovate owns that.
    // one task per file, since an action can be new to one workflow but
    // already pinned in another and must only be resolved in the former.
    // Each touches a different file, so they run in parallel.
    const pinactTasks: (readonly (readonly string[])[])[] = [...this.newWorkflowActions].map(([file, actions]) => [
      ["pinact", "run", "-u", ...actions.flatMap((action) => ["-i", `^${escapeRegExp(action)}$`]), file],
    ]);
    // resolves the placeholder `v0.0.0` rev (see mergeRepos in pre-commit.ts)
    // on just the newly added repos first, so no hook sets up its env against
    // a rev that was never a real ref, without also re-bumping every
    // already-pinned hook on every synth - renovate/pre-commit-ci own that.
    // Then seeds .pre-commit-config.yaml's additional_dependencies via
    // sync-typing-deps before the full run below, otherwise ty/mypy fail with
    // no deps on a fresh render since they'd run before sync-typing-deps
    // touches the file.
    const configTask = [
      ...(this.newPreCommitRepoUrls.length > 0
        ? [["pre-commit", "autoupdate", "--freeze", ...this.newPreCommitRepoUrls.flatMap((repo) => ["--repo", repo])]]
        : []),
      ["pre-commit", "run", "--files", ".pre-commit-config.yaml"],
    ];
    runTasksInParallelIgnoringFailure([...pinactTasks, configTask], this.outdir);

    // first pass may still fail on files that formatters just fixed; a repo
    // that's still broken on the second pass should still get its PR opened
    // so remaining issues can be resolved as part of the base update, rather
    // than synth aborting and dropping the update entirely
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
  try {
    execFileSync(command[0], command.slice(1), { cwd, stdio: "inherit" });
    return true;
  } catch {
    // best-effort: formatters commonly exit non-zero on the run that fixes
    // the file, so this step's failure is expected rather than fatal
    return false;
  }
}

function shQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

// runs each `task` (its steps executed in order) as its own background job,
// like `asyncio.gather`'d futures, then waits for all of them - all inside a
// single `sh -c` invocation so this stays a synchronous call, matching
// postSynthesize()'s (unawaited) signature. Failures are ignored, both a
// step's own and the overall script's.
function runTasksInParallelIgnoringFailure(tasks: readonly (readonly (readonly string[])[])[], cwd: string): void {
  const quote = (command: readonly string[]): string => command.map(shQuote).join(" ");
  const pids = tasks.map((_, i) => `pid${i}`);
  const script = [
    ...tasks.map((task, i) => `{ ${task.length > 0 ? task.map((step) => `${quote(step)} ;`).join(" ") : ": ;"} } & ${pids[i]}=$!`),
    `wait ${pids.map((pid) => `$${pid}`).join(" ")}`,
  ].join("\n");
  runIgnoringFailure(["sh", "-c", script], cwd);
}
