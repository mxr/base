import * as fs from "node:fs";
import * as path from "node:path";
import { pythonMainWorkflow, STABLE_PYTHON } from "./python";
import { Stack } from "./stack";
import { RUNNER } from "./workflow-actions";
import type { PythonPackaging } from "./stack";

export function readResource(name: string): string {
  return fs.readFileSync(path.join(__dirname, "resources", name), "utf-8");
}

export interface MainWorkflowOptions {
  readonly stack: Stack[];
  /**
   * Set when the repo runs tox in CI.
   */
  readonly python?: { readonly envs: string[]; readonly packaging?: PythonPackaging };
  readonly mirror?: { readonly command: string; readonly version?: string };
}

const HEADER = `name: main

on:
  pull_request:
  push:
    branches: [main]

permissions: {}

jobs:`;

const BATS_JOB = `  bats:
    runs-on: ${RUNNER}
    timeout-minutes: 10
    steps:
    - uses: actions/checkout@v0.0.0
      with:
        persist-credentials: false
    - run: sudo apt-get update && sudo apt-get install -y bats zsh
    - run: git ls-files -z '*.bats' | xargs -0 bats`;

function mirrorMainWorkflow({ command, version }: { readonly command: string; readonly version?: string }): string {
  const install = version
    ? `pip install git+https://github.com/pre-commit/pre-commit-mirror-maker@${version}`
    : "pip install pre-commit-mirror-maker";
  const commandLines = command
    .trim()
    .split("\n")
    .map((line, i) => (i === 0 ? line.trim() : `          ${line.trim()}`))
    .join("\n");
  return readResource("mirror/main.yml.tpl")
    .replace("'{{INSTALL}}'", () => install)
    .replace("{{PYTHON}}", STABLE_PYTHON)
    .replace("{{COMMAND}}", () => commandLines);
}

function stackMainWorkflow(options: MainWorkflowOptions): string | undefined {
  const { stack } = options;
  if (stack.includes(Stack.RUST)) {
    return readResource("rust/main.yml");
  }
  if (options.python) {
    return pythonMainWorkflow({ ...options.python, stack }).join("\n");
  }
  if (options.mirror) {
    return mirrorMainWorkflow(options.mirror);
  }
  if (stack.includes(Stack.FRONTEND)) {
    return readResource("frontend/main.yml");
  }
  if (stack.includes(Stack.TYPESCRIPT)) {
    return readResource("typescript/main.yml");
  }
  return undefined;
}

/**
 * `.github/workflows/main.yml` for the repo's stacks, or `undefined` when none
 * of them runs CI. Each workflow ends with its `jobs:` block, so a shell stack
 * appends a job that runs every tracked bats file.
 */
export function mainWorkflow(options: MainWorkflowOptions): string[] | undefined {
  const body = stackMainWorkflow(options)?.trimEnd();
  if (!options.stack.includes(Stack.SHELL)) {
    return body?.split("\n");
  }
  return `${body ? `${body}\n` : HEADER}\n${BATS_JOB}`.split("\n");
}
