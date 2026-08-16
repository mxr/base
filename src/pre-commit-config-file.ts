import { FileBase } from "projen";
import { BANNER } from "./banner";
import { renderPreCommitConfig } from "./pre-commit";
import type { IConstruct } from "constructs";
import type { FileBaseOptions, IResolver } from "projen";
import type { Stack } from "./stack";

export interface PreCommitConfigFileOptions extends FileBaseOptions {
  readonly stack: Stack[];
}

/**
 * Renders `.pre-commit-config.yaml` from the given stacks.
 */
export class PreCommitConfigFile extends FileBase {
  private readonly stack: Stack[];

  constructor(scope: IConstruct, options: PreCommitConfigFileOptions) {
    super(scope, ".pre-commit-config.yaml", { ...options, marker: false });
    this.stack = options.stack;
  }

  protected synthesizeContent(_resolver: IResolver): string | undefined {
    return [`# ${BANNER}`, "", renderPreCommitConfig(this.stack)].join("\n");
  }
}
