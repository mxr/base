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

const RUST_MAIN_WORKFLOW = `name: main

on:
  pull_request:
  push:
    branches: [main]

permissions: {}

jobs:
  changes:
    runs-on: ubuntu-latest
    outputs:
      project_files: \${{ steps.filter.outputs.project_files }}
    steps:
    - uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0
      with:
        persist-credentials: false
    - uses: dorny/paths-filter@7b450fff21473bca461d4b92ce414b9d0420d706 # v4.0.2
      id: filter
      with:
        filters: |
          project_files:
            - .github/workflows/main.yml
            - '**/*.rs'
            - Cargo.toml
            - Cargo.lock

  lint-real:
    needs: [changes]
    if: needs.changes.outputs.project_files == 'true'
    runs-on: ubuntu-latest
    steps:
    - uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0
      with:
        persist-credentials: false
    - uses: actions-rust-lang/setup-rust-toolchain@166cdcfd11aee3cb47222f9ddb555ce30ddb9659 # v1.17.0
      with:
        components: clippy
    - run: cargo clippy --all-targets --locked -- -D warnings -D clippy::pedantic -D clippy::nursery -D clippy::cargo

  test-real:
    needs: [changes]
    if: needs.changes.outputs.project_files == 'true'
    runs-on: ubuntu-latest
    steps:
    - uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0
      with:
        persist-credentials: false
    - uses: actions-rust-lang/setup-rust-toolchain@166cdcfd11aee3cb47222f9ddb555ce30ddb9659 # v1.17.0
      with:
        components: llvm-tools-preview
    - uses: taiki-e/install-action@07b4745e0c39a41822af610387492e3e53aa222b # v2.83.4
      with:
        tool: cargo-llvm-cov
    - run: cargo llvm-cov --locked --fail-under-lines 100

  main:
    needs: [changes, lint-real, test-real]
    if: always()
    runs-on: ubuntu-latest
    steps:
    - env:
        PROJECT_FILES: \${{ needs.changes.outputs.project_files }}
        LINT_REAL_RESULT: \${{ needs.lint-real.result }}
        TEST_REAL_RESULT: \${{ needs.test-real.result }}
      run: |
        if [ "$PROJECT_FILES" != "true" ]; then
          exit 0
        fi
        if [ "$LINT_REAL_RESULT" != "success" ]; then
          exit 1
        fi
        if [ "$TEST_REAL_RESULT" != "success" ]; then
          exit 1
        fi
`;

const RUST_RELEASE_WORKFLOW = `name: release

on:
  push:
    tags:
    - '**'

permissions: {}

concurrency:
  group: release-\${{ github.ref }}
  cancel-in-progress: false

jobs:
  release:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    environment:
      name: crates-io
    permissions:
      contents: write
      id-token: write
    steps:
    - uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0
      with:
        persist-credentials: false
    - uses: actions-rust-lang/setup-rust-toolchain@166cdcfd11aee3cb47222f9ddb555ce30ddb9659 # v1.17.0
      with:
        cache: false
    - uses: rust-lang/crates-io-auth-action@c6f97d42243bad5fab37ca0427f495c86d5b1a18 # v1.0.5
      id: auth
    - name: Publish to crates.io
      env:
        CARGO_REGISTRY_TOKEN: \${{ steps.auth.outputs.token }}
      run: cargo publish
    - name: Create GitHub release
      env:
        GH_TOKEN: \${{ github.token }}
      run: gh release create "$GITHUB_REF_NAME" --verify-tag --generate-notes
`;

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

  /**
   * Per-stack options.
   */
  readonly opts?: StackOptions;
}

export interface StackOptions {
  readonly frontend?: FrontendOptions;
}

export interface FrontendOptions {
  /**
   * Skip writing the starter `biome.json` even for a `frontend` stack, for a
   * repo that already has its own biome config it doesn't want overwritten.
   * `frontend`'s other effects (pre-commit hooks, AGPL license) still apply.
   *
   * @default false
   */
  readonly skipBiomeJson?: boolean;
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

    if (isFrontend && !options.opts?.frontend?.skipBiomeJson) {
      new TextFile(this, "biome.json", { lines: BIOME_JSON.split("\n") });
    }

    if (this.stack.includes(Stack.RUST)) {
      new TextFile(this, ".github/workflows/main.yml", {
        marker: false,
        committed: true,
        lines: [`# ${BANNER}`, "", ...RUST_MAIN_WORKFLOW.trimEnd().split("\n")],
      });
      new TextFile(this, ".github/workflows/release.yml", {
        marker: false,
        committed: true,
        lines: [`# ${BANNER}`, "", ...RUST_RELEASE_WORKFLOW.trimEnd().split("\n")],
      });
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
          // mxr-base-sync is a custom GitHub App; Mergify resolves its
          // `author` attribute to the GraphQL bot login without the
          // `[bot]` suffix, unlike well-known apps like renovate/pre-commit-ci.
          "  - author=mxr-base-sync",
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
    if (this.stack.includes(Stack.RUST)) {
      fs.writeFileSync(path.join(this.outdir, ".gitignore"), "/target/\n");
    }
    const readmePath = path.join(this.outdir, "README.md");
    if (fs.existsSync(readmePath) && fs.readFileSync(readmePath, "utf-8").trim() === "# replace this") {
      fs.rmSync(readmePath);
    }

    // resolve the placeholder `v0.0.0-<repo>` revs (see mergeRepos in
    // pre-commit.ts) to real pinned revs first, so no hook ever gets its env
    // set up against a rev that was never a real ref
    runIgnoringFailure(["uvx", "pre-commit", "autoupdate", "--freeze"], this.outdir);
    if (this.stack.includes(Stack.RUST)) {
      // pins the GitHub Actions refs in the rust stack's generated workflow
      // files to a full sha with a version comment; scoped to just those
      // files so it never touches workflows this project doesn't manage
      runIgnoringFailure(["pinact", "run", ".github/workflows/main.yml", ".github/workflows/release.yml"], this.outdir);
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
