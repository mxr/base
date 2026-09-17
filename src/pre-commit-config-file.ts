import { FileBase } from "projen";
import { BANNER } from "./banner";
import { buildCiSkip, renderPreCommitConfig } from "./pre-commit";
import type { IConstruct } from "constructs";
import type { FileBaseOptions, IResolver } from "projen";
import type { Stack } from "./stack";

export interface PreCommitConfigFileOptions extends FileBaseOptions {
  readonly stack: Stack[];

  /**
   * Minimum Python version (e.g. `"3.11"`), rendered as the file's top-level
   * `default_language_version.python`. Required when `stack` includes
   * `Stack.PYTHON`.
   */
  readonly pythonMinVersion?: string;
}

/**
 * Renders `.pre-commit-config.yaml` from the given stacks.
 */
export class PreCommitConfigFile extends FileBase {
  private readonly stack: Stack[];
  private readonly pythonMinVersion?: string;

  constructor(scope: IConstruct, options: PreCommitConfigFileOptions) {
    super(scope, ".pre-commit-config.yaml", { ...options, marker: false });
    this.stack = options.stack;
    this.pythonMinVersion = options.pythonMinVersion;
  }

  protected synthesizeContent(_resolver: IResolver): string | undefined {
    const skip = buildCiSkip(this.stack);
    const ciLines = skip.length > 0 ? [`ci:`, `  skip: [${skip.join(", ")}] # runs via GHA to avoid keeping deps in-sync here`, ""] : [];
    return [`# ${BANNER}`, "", ...ciLines, renderPreCommitConfig(this.stack, this.pythonMinVersion)].join("\n");
  }
}
