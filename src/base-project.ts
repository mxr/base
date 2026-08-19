import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { JsonFile, License, TextFile } from "projen";
import { GitHubProject } from "projen/lib/github";
import { BANNER } from "./banner";
import { firstCommitYear } from "./git";
import { PreCommitConfigFile } from "./pre-commit-config-file";
import { Stack } from "./stack";
import type { GitHubProjectOptions } from "projen/lib/github";

const BIOME_JSON = `{
  "$schema": "https://biomejs.dev/schemas/2.5.4/schema.json",
  "assist": {
    "actions": {
      "source": {
        "organizeImports": "on"
      }
    },
    "enabled": true
  },
  "formatter": {
    "enabled": true,
    "indentStyle": "space",
    "indentWidth": 2,
    "lineWidth": 140
  },
  "json": {
    "formatter": {
      "enabled": false
    }
  },
  "linter": {
    "enabled": true,
    "rules": {
      "preset": "recommended"
    }
  },
  "root": false
}
`;

export interface BaseProjectOptions extends GitHubProjectOptions {
  /**
   * Which stacks this repo is for. Drives which pre-commit hooks are added,
   * the LICENSE type (`frontend` gets AGPL-3.0-or-later, everything else
   * gets MIT), and whether a starter `biome.json` is added.
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
}

/**
 * A personal-repo base: stack-appropriate pre-commit hooks, a LICENSE picked
 * by stack, and shared mergify/renovate config.
 *
 * projen external project type — see https://projen.io/docs/custom/custom-projects
 */
export class BaseProject extends GitHubProject {
  public readonly stack: Stack[];
  private readonly renovateIgnoreMajor: string[];

  constructor(options: BaseProjectOptions) {
    super({ ...options, githubOptions: { pullRequestLint: false, ...options.githubOptions } });

    this.stack = options.stack;
    this.renovateIgnoreMajor = options.renovateIgnoreMajor ?? [];
    const isFrontend = this.stack.includes(Stack.FRONTEND);

    new License(this, {
      spdx: isFrontend ? "AGPL-3.0-or-later" : "MIT",
      copyrightOwner: "Max R",
      copyrightPeriod: String(firstCommitYear(this.outdir)),
    });

    new PreCommitConfigFile(this, { stack: this.stack });

    if (isFrontend) {
      new TextFile(this, "biome.json", { lines: BIOME_JSON.split("\n") });
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
          "  - author=mxr-base-sync[bot]",
          "  actions:",
          "    merge:",
          "      method: squash",
        ],
      });
    }

    new JsonFile(this, ".github/renovate.json", {
      marker: false,
      committed: true,
      obj: {
        $schema: "https://docs.renovatebot.com/renovate-schema.json",
        commitMessageAction: "weekly",
        commitMessagePrefix: "[renovate]",
        extends: ["config:recommended", ":disableDependencyDashboard"],
        groupSingleUpdates: true,
        minimumReleaseAge: "7 days",
        packageRules: [
          { commitMessageExtra: " ", groupName: "update", matchPackageNames: ["*"] },
          ...(this.renovateIgnoreMajor.length > 0
            ? [{ matchPackageNames: this.renovateIgnoreMajor, matchUpdateTypes: ["major"], enabled: false }]
            : []),
        ],
        prBodyTemplate: "{{{table}}}",
        schedule: ["* 16-17 * * 1"],
        separateMajorMinor: false,
        separateMultipleMajor: false,
        "//": BANNER,
      },
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
    fs.rmSync(path.join(this.outdir, ".gitignore"), { force: true });
    fs.rmSync(path.join(this.outdir, ".gitattributes"), { force: true });
    fs.rmSync(path.join(this.outdir, ".projen"), { recursive: true, force: true });
    const readmePath = path.join(this.outdir, "README.md");
    if (fs.existsSync(readmePath) && fs.readFileSync(readmePath, "utf-8").trim() === "# replace this") {
      fs.rmSync(readmePath);
    }

    // resolve the placeholder `v0.0.0-<repo>` revs (see mergeRepos in
    // pre-commit.ts) to real pinned revs first, so no hook ever gets its env
    // set up against a rev that was never a real ref
    runIgnoringFailure(["uvx", "pre-commit", "autoupdate", "--freeze"], this.outdir);
    // seed .pre-commit-config.yaml's own additional_dependencies via
    // sync-typing-deps before the real run below, otherwise ty/mypy fail with
    // no deps on a fresh render since they'd otherwise run before
    // sync-typing-deps ever touches the file
    runIgnoringFailure(["uvx", "pre-commit", "run", "--files", ".pre-commit-config.yaml"], this.outdir);
    // first pass may still fail on files that formatters just fixed; a
    // genuinely broken repo should fail loudly on the second pass instead of
    // synth silently swallowing it
    runIgnoringFailure(["uvx", "pre-commit", "run", "--all-files"], this.outdir);
    execFileSync("uvx", ["pre-commit", "run", "--all-files"], { cwd: this.outdir, stdio: "inherit" });
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
