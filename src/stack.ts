/**
 * A recognized technology stack. Each entry drives which pre-commit hooks
 * get added and, for `FRONTEND`/`JAVASCRIPT`, which license text is used.
 *
 * `FRONTEND` is for a Next.js app deployed to Vercel; `JAVASCRIPT` is for
 * other browser JS/TS (e.g. a Tampermonkey userscript) that doesn't want the
 * Next.js starters or Vercel deploy workflow. `TYPESCRIPT` is for a
 * TypeScript/jsii library built with npm, like this repo.
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
 * `WHEEL` builds an sdist and wheel and publishes them to PyPI; `HOME_ASSISTANT`
 * is a Home Assistant custom integration distributed through HACS via GitHub
 * releases.
 */
export enum PythonPackaging {
  HOME_ASSISTANT = "home-assistant",
  WHEEL = "wheel",
}
