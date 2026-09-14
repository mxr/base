/**
 * A recognized technology stack. Each entry drives which pre-commit hooks
 * get added and, for `frontend`/`javascript`, which license text is used.
 *
 * `frontend` is for a Next.js app deployed to Vercel; `javascript` is for
 * other browser JS/TS (e.g. a Tampermonkey userscript) that doesn't want the
 * Next.js starters or Vercel deploy workflow.
 */
export const Stack = {
  frontend: "frontend",
  githubActions: "github-actions",
  javascript: "javascript",
  python: "python",
  rust: "rust",
  shell: "shell",
  sql: "sql",
  toml: "toml",
} as const;

export type Stack = (typeof Stack)[keyof typeof Stack];
