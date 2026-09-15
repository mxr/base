/**
 * A recognized technology stack. Each entry drives which pre-commit hooks
 * get added and, for `FRONTEND`/`JAVASCRIPT`, which license text is used.
 *
 * `FRONTEND` is for a Next.js app deployed to Vercel; `JAVASCRIPT` is for
 * other browser JS/TS (e.g. a Tampermonkey userscript) that doesn't want the
 * Next.js starters or Vercel deploy workflow.
 */
export enum Stack {
  FRONTEND = "frontend",
  GITHUB_ACTIONS = "github-actions",
  GITIGNORE = "gitignore",
  JAVASCRIPT = "javascript",
  PYTHON = "python",
  RUST = "rust",
  SHELL = "shell",
  SQL = "sql",
  TOML = "toml",
}
