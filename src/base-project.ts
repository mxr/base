import { execFileSync } from "child_process";
import { JsonFile, License, TextFile } from "projen";
import { GitHubProject, Mergify } from "projen/lib/github";
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
    super(options);

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
      new Mergify(this.github, {
        rules: [
          {
            // pre-commit ci won't automerge (see https://github.com/pre-commit-ci/issues/issues/48)
            name: "automatic merge for pre-commit ci updates",
            conditions: ["author=pre-commit-ci[bot]", "title=[pre-commit.ci] pre-commit autoupdate"],
            actions: { merge: { method: "squash" } },
          },
          {
            name: "automatic merge for renovate updates",
            conditions: ["author=renovate[bot]"],
            actions: { merge: { method: "squash" } },
          },
          {
            name: "automatic merge for base updates",
            conditions: ["author=mxr-base-sync[bot]"],
            actions: { merge: { method: "squash" } },
          },
        ],
      });
    }

    new JsonFile(this, ".github/renovate.json", {
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
      },
    });
  }

  public postSynthesize() {
    super.postSynthesize();

    if (!isGitRepo(this.outdir)) {
      return;
    }

    // seed .pre-commit-config.yaml's own additional_dependencies via
    // sync-typing-deps before the real run below, otherwise ty/mypy fail with
    // no deps on a fresh render since they'd otherwise run before
    // sync-typing-deps ever touches the file
    runIgnoringFailure(["uvx", "pre-commit", "run", "--files", ".pre-commit-config.yaml"], this.outdir);
    runIgnoringFailure(["uvx", "pre-commit", "autoupdate", "--freeze"], this.outdir);
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
