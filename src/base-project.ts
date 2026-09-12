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
    - uses: actions/checkout@v0.0.0
      with:
        persist-credentials: false
    - uses: dorny/paths-filter@v0.0.0
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
    - uses: actions/checkout@v0.0.0
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
    - uses: actions/checkout@v0.0.0
      with:
        persist-credentials: false
    - uses: actions-rust-lang/setup-rust-toolchain@166cdcfd11aee3cb47222f9ddb555ce30ddb9659 # v1.17.0
      with:
        components: llvm-tools-preview
    - uses: taiki-e/install-action@v0.0.0
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
    - uses: actions/checkout@v0.0.0
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

const FRONTEND_MAIN_WORKFLOW = `name: main

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
    - name: Checkout
      uses: actions/checkout@v0.0.0
      with:
        persist-credentials: false

    - uses: dorny/paths-filter@v0.0.0
      id: filter
      with:
        filters: |
          project_files:
            - .github/workflows/**
            - app/**
            - lib/**
            - tests/**
            - scripts/**
            - '**/*.css'
            - '**/*.js'
            - '**/*.jsx'
            - '**/*.mjs'
            - '**/*.mts'
            - '**/*.ts'
            - '**/*.tsx'
            - '**/*.json'
            - package.json
            - package-lock.json

  main-real:
    needs: [changes]
    if: needs.changes.outputs.project_files == 'true'
    runs-on: ubuntu-latest
    steps:
    - name: Checkout
      uses: actions/checkout@v0.0.0
      with:
        persist-credentials: false

    - name: Setup Node
      uses: actions/setup-node@v0.0.0
      with:
        node-version-file: package.json
        cache: npm

    - name: Install dependencies
      run: npm ci

    - name: Run tests with coverage
      run: npm run test:coverage

    - name: Upload coverage report
      uses: actions/upload-artifact@v0.0.0
      with:
        name: coverage-report
        path: coverage

  main:
    needs: [changes, main-real]
    if: always()
    runs-on: ubuntu-latest
    steps:
    - env:
        PROJECT_FILES: \${{ needs.changes.outputs.project_files }}
        TEST_REAL_RESULT: \${{ needs.main-real.result }}
      run: |
        if [ "$PROJECT_FILES" != "true" ]; then
          exit 0
        fi
        if [ "$TEST_REAL_RESULT" != "success" ]; then
          exit 1
        fi
`;

const FRONTEND_RELEASE_WORKFLOW = `name: release

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
    uses: mxr/workflows/.github/workflows/github-release.yml@v0.0.0
    permissions:
      contents: write

  deploy:
    runs-on: ubuntu-latest
    environment: production
    env:
      VERCEL_ORG_ID: \${{ secrets.VERCEL_ORG_ID }}
      VERCEL_PROJECT_ID: \${{ secrets.VERCEL_PROJECT_ID }}
    steps:
    - name: Checkout
      uses: actions/checkout@v0.0.0
      with:
        persist-credentials: false

    - name: Setup Node
      uses: actions/setup-node@v0.0.0
      with:
        node-version-file: package.json
        package-manager-cache: false

    - name: Install dependencies
      run: npm ci

    - name: Pull Vercel environment
      run: npx vercel pull --yes --environment=production --token=\${{ secrets.VERCEL_TOKEN }}

    - name: Build
      run: npx vercel build --prod --token=\${{ secrets.VERCEL_TOKEN }}

    - name: Deploy
      run: npx vercel deploy --prebuilt --prod --token=\${{ secrets.VERCEL_TOKEN }}
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
  "linter": {
    "enabled": true,
    "rules": {
      "preset": "recommended"
    }
  }
}
`;

const FRONTEND_BIOME_JSON = `{
  "$schema": "https://biomejs.dev/schemas/2.5.4/schema.json",
  "assist": {
    "actions": {
      "source": {
        "organizeImports": {
          "level": "on",
          "options": {
            "groups": [
              {
                "type": false
              }
            ]
          }
        }
      }
    },
    "enabled": true
  },
  "css": {
    "parser": {
      "tailwindDirectives": true
    }
  },
  "files": {
    "includes": [
      "**",
      "!!**/.next",
      "!!**/build",
      "!!**/coverage",
      "!!**/out",
      "!**/next-env.d.ts",
      "!**/package-lock.json"
    ]
  },
  "formatter": {
    "enabled": true,
    "indentStyle": "space",
    "indentWidth": 2,
    "lineWidth": 140
  },
  "linter": {
    "domains": {
      "next": "recommended",
      "react": "recommended",
      "test": "recommended"
    },
    "enabled": true,
    "rules": {
      "preset": "recommended",
      "style": {
        "useImportType": {
          "level": "on",
          "options": {
            "style": "separatedType"
          }
        }
      }
    }
  }
}
`;

const FRONTEND_TSCONFIG_JSON = `{
  "compilerOptions": {
    "allowJs": true,
    "esModuleInterop": true,
    "incremental": true,
    "isolatedModules": true,
    "jsx": "react-jsx",
    "lib": ["dom", "dom.iterable", "esnext"],
    "module": "esnext",
    "moduleResolution": "bundler",
    "noEmit": true,
    "paths": {
      "@/*": ["./*"]
    },
    "plugins": [
      {
        "name": "next"
      }
    ],
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "strict": true,
    "target": "ES2017"
  },
  "exclude": ["node_modules"],
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts", ".next/dev/types/**/*.ts"]
}
`;

const FRONTEND_VITEST_CONFIG = `import { defineConfig } from "vitest/config";

export default defineConfig({
  css: {
    postcss: {
      plugins: [],
    },
  },
  test: {
    environment: "node",
    include: ["lib/**/*.test.ts", "tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      reportsDirectory: "coverage",
      include: ["lib/**/*.ts"],
      exclude: ["**/*.d.ts"],
      thresholds: {
        lines: 98,
        functions: 100,
        statements: 98,
        branches: 85,
      },
    },
  },
});
`;

const FRONTEND_POSTCSS_CONFIG = `const config = {
  plugins: ["@tailwindcss/postcss"],
};

export default config;
`;

const FRONTEND_NEXT_CONFIG = `import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // TypeScript 7 dropped the JS API Next.js normally uses for type checking,
    // so run the local tsc CLI instead. https://github.com/vercel/next.js/pull/95639
    useTypeScriptCli: true,
  },
};

export default nextConfig;
`;

const FRONTEND_VERCEL_JSON = `{
  "git": {
    "deploymentEnabled": {
      "main": false
    }
  }
}
`;

export interface BaseProjectOptions extends GitHubProjectOptions {
  /**
   * Which stacks this repo is for. Drives which pre-commit hooks are added
   * and the LICENSE type (`frontend` gets AGPL-3.0-or-later, everything else
   * gets MIT).
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

  /**
   * Per-package Renovate enablement, keyed by package name; set a package to
   * `false` to disable it in Renovate entirely (e.g. `tar: false` for a
   * frontend repo whose `@vercel/fun` transitively pins a deprecated `tar`
   * that npm's own override can't safely be auto-bumped past).
   *
   * @default {} - every package left to Renovate's default behavior
   */
  readonly renovate?: { [packageName: string]: boolean };
}

export interface FrontendOptions {
  /**
   * Whether this frontend repo is a Next.js app deployed to Vercel. Controls
   * whether the shared `tsconfig.json`, `vitest.config.mts`,
   * `postcss.config.mjs`, `next.config.ts`, and `vercel.json` starters get
   * written; set to `false` for a frontend repo that isn't a Next.js app
   * (e.g. a userscript).
   *
   * @default true
   */
  readonly nextJs?: boolean;
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
    this.renovateDisable = Object.entries(options.opts?.renovate ?? {})
      .filter(([, enabled]) => !enabled)
      .map(([name]) => name);
    const isFrontend = this.stack.includes(Stack.FRONTEND);
    const isNextJs = isFrontend && (options.opts?.frontend?.nextJs ?? true);
    this.isNextJs = isNextJs;

    // FileBase's own marker wording is fixed and points at a .projenrc.js
    // that doesn't exist in downstream repos (see banner.ts); .gitignore is
    // projen's own built-in component with no option to swap that wording via
    // its constructor, so shadow the inherited `marker` getter on this
    // instance to ship the custom banner instead
    Object.defineProperty(this.gitignore, "marker", { configurable: true, get: () => BANNER });

    new License(this, {
      spdx: isFrontend ? "AGPL-3.0-or-later" : "MIT",
      copyrightOwner: "Max R",
      copyrightPeriod: String(firstCommitYear(this.outdir)),
    });

    new PreCommitConfigFile(this, { stack: this.stack });

    if (isNextJs) {
      this.gitignore.exclude(
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
      );
    }

    if (!isFrontend || isNextJs) {
      new TextFile(this, "biome.json", { lines: (isNextJs ? FRONTEND_BIOME_JSON : BIOME_JSON).split("\n") });
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

    if (isNextJs) {
      new TextFile(this, ".github/workflows/main.yml", {
        marker: false,
        committed: true,
        lines: [`# ${BANNER}`, "", ...FRONTEND_MAIN_WORKFLOW.trimEnd().split("\n")],
      });
      new TextFile(this, ".github/workflows/release.yml", {
        marker: false,
        committed: true,
        lines: [`# ${BANNER}`, "", ...FRONTEND_RELEASE_WORKFLOW.trimEnd().split("\n")],
      });
      new TextFile(this, "tsconfig.json", { lines: FRONTEND_TSCONFIG_JSON.trimEnd().split("\n") });
      new TextFile(this, "vitest.config.mts", {
        marker: false,
        lines: [`// ${BANNER}`, "", ...FRONTEND_VITEST_CONFIG.trimEnd().split("\n")],
      });
      new TextFile(this, "postcss.config.mjs", {
        marker: false,
        lines: [`// ${BANNER}`, "", ...FRONTEND_POSTCSS_CONFIG.trimEnd().split("\n")],
      });
      new TextFile(this, "next.config.ts", {
        marker: false,
        lines: [`// ${BANNER}`, "", ...FRONTEND_NEXT_CONFIG.trimEnd().split("\n")],
      });
      new TextFile(this, "vercel.json", { lines: FRONTEND_VERCEL_JSON.trimEnd().split("\n") });
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
          "  - author=mxr-base-copier-sync[bot]",
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
    if (this.stack.includes(Stack.RUST)) {
      fs.rmSync(path.join(this.outdir, ".gitignore"), { force: true });
      fs.writeFileSync(path.join(this.outdir, ".gitignore"), `# ${BANNER}\n/target/\n`);
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
