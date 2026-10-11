/**
 * A technology stack. Each stack decides which hooks, workflows, and config
 * files base generates. `FRONTEND` and `JAVASCRIPT` also switch the license
 * to AGPL-3.0-or-later.
 *
 * `FRONTEND` is a Next.js app deployed to Vercel. `JAVASCRIPT` is other
 * browser JavaScript or TypeScript, such as a Tampermonkey userscript, that
 * doesn't want the Next.js starters or the Vercel deploy workflow.
 * `TYPESCRIPT` is a jsii library built with npm, like this repo.
 */
export enum Stack {
  FRONTEND = "frontend",
  GITHUB_ACTIONS = "github-actions",
  GITIGNORE = "gitignore",
  JAVASCRIPT = "javascript",
  MIRROR = "mirror",
  PYTHON = "python",
  RUST = "rust",
  SHELL = "shell",
  SQL = "sql",
  TOML = "toml",
  TYPESCRIPT = "typescript",
}

/**
 * How a `Stack.PYTHON` repo is packaged and released.
 *
 * `WHEEL` builds an sdist and a wheel and publishes them to PyPI.
 * `HOME_ASSISTANT` is a Home Assistant custom integration that HACS installs
 * from GitHub releases.
 */
export enum PythonPackaging {
  HOME_ASSISTANT = "home-assistant",
  WHEEL = "wheel",
}

/**
 * A built-in Renovate custom manager preset that a `Stack.GITHUB_ACTIONS` repo
 * can opt into.
 *
 * `GITHUB_ACTIONS_VERSIONS` updates `*_VERSION` env vars in workflow files
 * annotated with a `# renovate: datasource=... depName=...` comment.
 */
export enum RenovateCustomManager {
  GITHUB_ACTIONS_VERSIONS = "github-actions-versions",
}
