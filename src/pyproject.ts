const SQLFLUFF_TABLE = /^\[tool\.sqlfluff[.\]]/;

/**
 * Replaces every `[tool.sqlfluff...]` table in an existing `pyproject.toml`
 * with `sqlfluffConfig`, leaving the rest of the file alone. The file is
 * otherwise owned by the downstream repo (e.g. a python stack's project
 * metadata), so it's edited in place rather than generated wholesale.
 */
export function mergeSqlfluffConfig(existing: string, sqlfluffConfig: string): string {
  const kept: string[] = [];
  let inSqlfluffTable = false;
  for (const line of existing.split("\n")) {
    if (line.startsWith("[")) {
      inSqlfluffTable = SQLFLUFF_TABLE.test(line);
    }
    if (!inSqlfluffTable) {
      kept.push(line);
    }
  }
  const rest = kept.join("\n").trim();
  return `${rest ? `${rest}\n\n` : ""}${sqlfluffConfig.trim()}\n`;
}
