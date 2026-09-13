import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { License, TextFile } from "projen";
import { GitHubProject } from "projen/lib/github";
import { BANNER } from "./banner";
import { firstCommitYear } from "./git";
import { PreCommitConfigFile } from "./pre-commit-config-file";
import { Stack } from "./stack";
import type { GitHubProjectOptions } from "projen/lib/github";

function readResource(name: string): string {
  return fs.readFileSync(path.join(__dirname, "resources", name), "utf-8");
}

export interface BaseProjectOptions extends GitHubProjectOptions {
  /**
   * Which stacks this repo is for. Drives which pre-commit hooks are added
   * and the LICENSE type (`frontend`/`javascript` get AGPL-3.0-or-later,
   * everything else gets MIT).
   */
  readonly stack: Stack[];

  /**
   * Package names to exclude from Renovate major-version updates (e.g.
   * `["typescript"]` for a jsii project, since jsii pins its own typescript
   * compiler version and a major bump breaks its compile step).
   *
   * @default [] - no packages excluded
   */
  readonly renovateIgnoreMajor?: string[];

  /**
   * Per-stack options.
   */
  readonly opts?: StackOptions;
}

export interface StackOptions {
  /**
   * Per-package Renovate enablement, keyed by package name; set a package to
   * `false` to disable it in Renovate entirely.
   *
   * @default {} - every package left to Renovate's default behavior
   */
  readonly renovate?: { [packageName: string]: boolean };
}

/**
 * A personal-repo base: stack-appropriate pre-commit hooks, a LICENSE picked
 * by stack, and shared mergify/renovate config.
 *
 * projen external project type — see https://projen.io/docs/custom/custom-projects
 */
export class BaseProject extends GitHubProject {
  public readonly stack: Stack[];
  private readonly isNextJs: boolean;
  private readonly renovateIgnoreMajor: string[];
  private readonly renovateDisable: string[];

  constructor(options: BaseProjectOptions) {
    super({ ...options, githubOptions: { pullRequestLint: false, ...options.githubOptions } });

    this.stack = options.stack;
    this.renovateIgnoreMajor = options.renovateIgnoreMajor ?? [];
    const isNextJs = this.stack.includes(Stack.FRONTEND);
    const isFrontendLike = isNextJs || this.stack.includes(Stack.JAVASCRIPT);
    this.isNextJs = isNextJs;
    const explicitRenovateDisable = Object.entries(options.opts?.renovate ?? {})
      .filter(([, enabled]) => !enabled)
      .map(([name]) => name);
    // @vercel/fun (used by the Vercel deploy workflow) transitively pins a
    // deprecated `tar` that npm's own override can't safely be auto-bumped
    // past, so disable it in Renovate for every Next.js repo rather than
    // making each one opt in via `opts.renovate.tar: false`
    this.renovateDisable = [...new Set([...explicitRenovateDisable, ...(isNextJs ? ["tar"] : [])])];

    // FileBase's own marker wording is fixed and points at a .projenrc.js
    // that doesn't exist in downstream repos (see banner.ts); .gitignore is
    // projen's own built-in component with no option to swap that wording via
    // its constructor, so shadow the inherited `marker` getter on this
    // instance to ship the custom banner instead
    Object.defineProperty(this.gitignore, "marker", { configurable: true, get: () => BANNER });

    new License(this, {
      spdx: isFrontendLike ? "AGPL-3.0-or-later" : "MIT",
      copyrightOwner: "Max R",
      copyrightPeriod: String(firstCommitYear(this.outdir)),
    });

    new PreCommitConfigFile(this, { stack: this.stack, isNextJs });

    if (!isFrontendLike || isNextJs) {
      new TextFile(this, "biome.json", {
        lines: readResource(isNextJs ? "frontend/biome.json" : "default/biome.json").split("\n"),
      });
    }

    if (this.stack.includes(Stack.RUST)) {
      new TextFile(this, ".github/workflows/main.yml", {
        marker: false,
        committed: true,
        lines: [`# ${BANNER}`, "", ...readResource("rust/main.yml").trimEnd().split("\n")],
      });
      new TextFile(this, ".github/workflows/release.yml", {
        marker: false,
        committed: true,
        lines: [`# ${BANNER}`, "", ...readResource("rust/release.yml").trimEnd().split("\n")],
      });
    }

    if (isNextJs) {
      new TextFile(this, ".github/workflows/main.yml", {
        marker: false,
        committed: true,
        lines: [`# ${BANNER}`, "", ...readResource("frontend/main.yml").trimEnd().split("\n")],
      });
      new TextFile(this, ".github/workflows/release.yml", {
        marker: false,
        committed: true,
        lines: [`# ${BANNER}`, "", ...readResource("frontend/release.yml").trimEnd().split("\n")],
      });
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
        ...(this.renovateIgnoreMajor.length > 0
          ? [{ matchPackageNames: this.renovateIgnoreMajor, matchUpdateTypes: ["major"], enabled: false }]
          : []),
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

    // BaseProject only manages a handful of files; strip projen's own
    // default scaffolding that it insists on creating regardless of options,
    // since downstream repos aren't full projen-managed projects
    fs.rmSync(path.join(this.outdir, ".gitattributes"), { force: true });
    fs.rmSync(path.join(this.outdir, ".projen"), { recursive: true, force: true });
    const gitignorePath = path.join(this.outdir, ".gitignore");
    if (this.stack.includes(Stack.RUST)) {
      fs.rmSync(gitignorePath, { force: true });
      fs.writeFileSync(gitignorePath, `# ${BANNER}\n/target/\n`);
    } else if (this.stack.includes(Stack.JAVASCRIPT)) {
      // a javascript-stack repo (e.g. a Tampermonkey script) has nothing
      // Next.js-specific to ignore, so don't manage a .gitignore at all
      // rather than shipping projen's generic default
      fs.rmSync(gitignorePath, { force: true });
    } else if (this.isNextJs) {
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
    }
    const readmePath = path.join(this.outdir, "README.md");
    if (fs.existsSync(readmePath) && fs.readFileSync(readmePath, "utf-8").trim() === "# replace this") {
      fs.rmSync(readmePath);
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

    // resolve the placeholder `v0.0.0-<repo>` revs (see mergeRepos in
    // pre-commit.ts) to real pinned revs first, so no hook ever gets its env
    // set up against a rev that was never a real ref
    runIgnoringFailure(["uvx", "pre-commit", "autoupdate", "--freeze"], this.outdir);
    if (this.stack.includes(Stack.RUST) || this.isNextJs) {
      // pins the GitHub Actions refs in the generated workflow files to a
      // full sha with a version comment; scoped to just those files so it
      // never touches workflows this project doesn't manage
      runIgnoringFailure(["pinact", "run", "-u", ".github/workflows/main.yml", ".github/workflows/release.yml"], this.outdir);
    }
    // seed .pre-commit-config.yaml's own additional_dependencies via
    // sync-typing-deps before the real run below, otherwise ty/mypy fail with
    // no deps on a fresh render since they'd otherwise run before
    // sync-typing-deps ever touches the file
    runIgnoringFailure(["uvx", "pre-commit", "run", "--files", ".pre-commit-config.yaml"], this.outdir);
    // first pass may still fail on files that formatters just fixed; a repo
    // that's still broken on the second pass should still get its PR opened
    // so remaining issues can be resolved as part of the base update, rather
    // than synth aborting and dropping the update entirely
    runIgnoringFailure(["uvx", "pre-commit", "run", "--all-files"], this.outdir);
    runIgnoringFailure(["uvx", "pre-commit", "run", "--all-files"], this.outdir);
  }
}

function isGitRepo(outdir: string): boolean {
  try {
    execFileSync("git", ["-C", outdir, "rev-parse", "--is-inside-work-tree"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function runIgnoringFailure(command: readonly string[], cwd: string): void {
  try {
    execFileSync(command[0], command.slice(1), { cwd, stdio: "inherit" });
  } catch {
    // best-effort: formatters commonly exit non-zero on the run that fixes
    // the file, so this step's failure is expected rather than fatal
  }
}
