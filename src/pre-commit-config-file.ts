import { FileBase } from "projen";
import { BANNER } from "./banner";
import { buildCiSkip, renderPreCommitConfig } from "./pre-commit";
import type { IConstruct } from "constructs";
import type { FileBaseOptions, IResolver } from "projen";
import type { Stack } from "./stack";

export interface PreCommitConfigFileOptions extends FileBaseOptions {
  readonly stack: Stack[];
  readonly isNextJs: boolean;
}

/**
 * Renders `.pre-commit-config.yaml` from the given stacks.
 */
export class PreCommitConfigFile extends FileBase {
  private readonly stack: Stack[];
  private readonly isNextJs: boolean;

  constructor(scope: IConstruct, options: PreCommitConfigFileOptions) {
    super(scope, ".pre-commit-config.yaml", { ...options, marker: false });
    this.stack = options.stack;
    this.isNextJs = options.isNextJs;
  }

  protected synthesizeContent(_resolver: IResolver): string | undefined {
    const skip = buildCiSkip(this.stack);
    const ciLines = skip.length > 0 ? [`ci:`, `  skip: [${skip.join(", ")}] # runs via GHA to avoid keeping deps in-sync here`, ""] : [];
    return [`# ${BANNER}`, "", ...ciLines, renderPreCommitConfig(this.stack, this.isNextJs)].join("\n");
  }
}
