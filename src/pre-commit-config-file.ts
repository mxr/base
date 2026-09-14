import { FileBase } from "projen";
import { BANNER } from "./banner.ts";
import { buildCiSkip, renderPreCommitConfig } from "./pre-commit.ts";
import type { IConstruct } from "constructs";
import type { FileBaseOptions, IResolver } from "projen";
import type { Stack } from "./stack.ts";

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
    const skip = buildCiSkip(this.stack);
    let ciLines: string[] = [];
    if (skip.length > 0) {
      ciLines = ["ci:", `  skip: [${skip.join(", ")}] # runs via GHA to avoid keeping deps in-sync here`, ""];
    }
    return [`# ${BANNER}`, "", ...ciLines, renderPreCommitConfig(this.stack)].join("\n");
  }
}
