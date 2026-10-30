import { FileBase } from "projen";
import { BANNER } from "./banner";
import { newRepoUrls, renderPreCommitConfig } from "./pre-commit";
import { Stack } from "./stack";
import type { IConstruct } from "constructs";
import type { FileBaseOptions, IResolver } from "projen";
import type { ExistingRev } from "./pre-commit";

export interface PreCommitConfigFileOptions extends FileBaseOptions {
  readonly stack: Stack[];

  /**
   * Minimum Python version, such as `"3.11"`,, rendered as the file's top-level
   * `default_language_version.python`. Required when `stack` includes
   * `Stack.PYTHON`.
   */
  readonly pythonMinVersion?: string;

  /**
   * Maps each `repo` URL to its `rev` and inline comment in the downstream
   * repo's current `.pre-commit-config.yaml`. A re-synth keeps an
   * already-pinned hook at that rev instead of resetting it to the placeholder.
   */
  readonly existingRevs?: Record<string, ExistingRev>;

  /**
   * Skip the type checkers (mypy, pyright, ty) on pre-commit.ci, since they
   * run in a GitHub Actions job instead.
   */
  readonly typeChecksInGithubActions?: boolean;

  /**
   * Regexes for the file's top-level `exclude`.
   */
  readonly exclude?: string[];
}

/**
 * Renders `.pre-commit-config.yaml` from the given stacks.
 */
export class PreCommitConfigFile extends FileBase {
  private readonly stack: Stack[];
  private readonly pythonMinVersion: string | undefined;
  private readonly existingRevs: ReadonlyMap<string, ExistingRev>;
  private readonly typeChecksInGithubActions: boolean;
  private readonly exclude: string[];

  /**
   * Non-local repo URLs that are not in `existingRevs`. The caller runs
   * `pre-commit autoupdate --freeze` on these repos only.
   */
  public readonly newRepoUrls: string[];

  constructor(scope: IConstruct, options: PreCommitConfigFileOptions) {
    super(scope, ".pre-commit-config.yaml", { ...options, marker: false });
    this.stack = options.stack;
    this.pythonMinVersion = options.pythonMinVersion;
    this.existingRevs = new Map(Object.entries(options.existingRevs ?? {}));
    this.typeChecksInGithubActions = options.typeChecksInGithubActions ?? false;
    this.exclude = options.exclude ?? [];
    this.newRepoUrls = newRepoUrls(this.stack, this.existingRevs);
  }

  protected synthesizeContent(_resolver: IResolver): string | undefined {
    const skips = [
      // pre-commit.ci's containers don't keep a project's own crate versions in sync
      ...(this.stack.includes(Stack.RUST) ? [{ hooks: ["clippy"], reason: "runs via GHA to avoid keeping deps in-sync here" }] : []),
      ...(this.typeChecksInGithubActions
        ? [{ hooks: ["mypy", "pyright", "ty"], reason: "venv is too big; runs with github action instead" }]
        : []),
    ];
    const ciLines = [
      `ci:`,
      `  autoupdate_schedule: quarterly # updaed with renovate`,
      ...(skips.length > 0
        ? [`  skip: [${skips.flatMap(({ hooks }) => hooks).join(", ")}] # ${skips.map(({ reason }) => reason).join("; ")}`]
        : []),
      "",
    ];
    return [`# ${BANNER}`, "", ...ciLines, renderPreCommitConfig(this.stack, this.pythonMinVersion, this.existingRevs, this.exclude)].join(
      "\n",
    );
  }
}
