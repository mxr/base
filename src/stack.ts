/**
 * A recognized technology stack. Each entry drives which pre-commit hooks
 * get added and, for `FRONTEND`, which license text is used.
 */
export enum Stack {
  FRONTEND = 'frontend',
  GITHUB_ACTIONS = 'github-actions',
  JSON = 'json',
  PYTHON = 'python',
  RUST = 'rust',
  SHELL = 'shell',
  SQL = 'sql',
  TOML = 'toml',
}
