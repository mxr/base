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
   * Minimum Python version (e.g. `"3.11"`), rendered as the file's top-level
   * `default_language_version.python`. Required when `stack` includes
   * `Stack.PYTHON`.
   */
  readonly pythonVersion?: string;

  /**
   * `repo` url -> `rev` (and its inline comment) from the downstream repo's current
   * `.pre-commit-config.yaml`, so re-synthing keeps an already-pinned hook at
   * its existing rev instead of resetting it to a placeholder that
   * `pre-commit autoupdate --freeze` would then re-resolve on every synth.
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
  private readonly pythonVersion: string | undefined;
  private readonly existingRevs: ReadonlyMap<string, ExistingRev>;
  private readonly typeChecksInGithubActions: boolean;
  private readonly exclude: string[];

  /**
   * Non-local repo urls newly added by this synth (i.e. not present in
   * `existingRevs`), so the caller can scope `pre-commit autoupdate --freeze`
   * to just these instead of every repo.
   */
  public readonly newRepoUrls: string[];

  constructor(scope: IConstruct, options: PreCommitConfigFileOptions) {
    super(scope, ".pre-commit-config.yaml", { ...options, marker: false });
    this.stack = options.stack;
    this.pythonVersion = options.pythonVersion;
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
    const ciLines =
      skips.length > 0
        ? [`ci:`, `  skip: [${skips.flatMap(({ hooks }) => hooks).join(", ")}] # ${skips.map(({ reason }) => reason).join("; ")}`, ""]
        : [];
    return [`# ${BANNER}`, "", ...ciLines, renderPreCommitConfig(this.stack, this.pythonVersion, this.existingRevs, this.exclude)].join(
      "\n",
    );
  }
}
