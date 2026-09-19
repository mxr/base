import { FileBase } from "projen";
import { BANNER } from "./banner";
import { buildCiSkip, newRepoUrls, renderPreCommitConfig } from "./pre-commit";
import type { IConstruct } from "constructs";
import type { FileBaseOptions, IResolver } from "projen";
import type { ExistingRev } from "./pre-commit";
import type { Stack } from "./stack";

export interface PreCommitConfigFileOptions extends FileBaseOptions {
  readonly stack: Stack[];

  /**
   * Minimum Python version (e.g. `"3.11"`), rendered as the file's top-level
   * `default_language_version.python`. Required when `stack` includes
   * `Stack.PYTHON`.
   */
  readonly pythonMinVersion?: string;

  /**
   * `repo` url -> `rev` (and its inline comment) from the downstream repo's current
   * `.pre-commit-config.yaml`, so re-synthing keeps an already-pinned hook at
   * its existing rev instead of resetting it to a placeholder that
   * `pre-commit autoupdate --freeze` would then re-resolve on every synth.
   */
  readonly existingRevs?: Record<string, ExistingRev>;
}

/**
 * Renders `.pre-commit-config.yaml` from the given stacks.
 */
export class PreCommitConfigFile extends FileBase {
  private readonly stack: Stack[];
  private readonly pythonMinVersion?: string;
  private readonly existingRevs: ReadonlyMap<string, ExistingRev>;

  /**
   * Non-local repo urls newly added by this synth (i.e. not present in
   * `existingRevs`), so the caller can scope `pre-commit autoupdate --freeze`
   * to just these instead of every repo.
   */
  public readonly newRepoUrls: string[];

  constructor(scope: IConstruct, options: PreCommitConfigFileOptions) {
    super(scope, ".pre-commit-config.yaml", { ...options, marker: false });
    this.stack = options.stack;
    this.pythonMinVersion = options.pythonMinVersion;
    this.existingRevs = new Map(Object.entries(options.existingRevs ?? {}));
    this.newRepoUrls = newRepoUrls(this.stack, this.existingRevs);
  }

  protected synthesizeContent(_resolver: IResolver): string | undefined {
    const skip = buildCiSkip(this.stack);
    const ciLines = skip.length > 0 ? [`ci:`, `  skip: [${skip.join(", ")}] # runs via GHA to avoid keeping deps in-sync here`, ""] : [];
    return [`# ${BANNER}`, "", ...ciLines, renderPreCommitConfig(this.stack, this.pythonMinVersion, this.existingRevs)].join("\n");
  }
}
