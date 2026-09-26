const SQLFLUFF_TABLE = /^\[tool\.sqlfluff[.\]]/;

/**
 * `[tool.sqlfluff.<table>]` tables written into a sql stack's `pyproject.toml`,
 * keyed by the table name under `tool.sqlfluff`.
 */
const SQLFLUFF_CONFIG: Record<string, Record<string, string | boolean>> = {
  "layout.type.comma": { line_position: "leading", spacing_before: "touch" },
  "layout.type.from_clause": { keyword_line_position: "leading" },
  "layout.type.when_clause": { keyword_line_position: "leading" },
  "rules.capitalisation.functions": { extended_capitalisation_policy: "upper" },
  "rules.capitalisation.identifiers": { extended_capitalisation_policy: "lower" },
  "rules.capitalisation.keywords": { capitalisation_policy: "upper" },
  "rules.capitalisation.literals": { capitalisation_policy: "upper" },
  "rules.convention.not_equal": { preferred_not_equal_style: "c_style" },
  "rules.convention.terminator": { multiline_newline: true, require_final_semicolon: true },
  "rules.references.quoting": { prefer_quoted_keywords: true },
};

/**
 * Renders {@link SQLFLUFF_CONFIG} as TOML tables.
 */
export function renderSqlfluffConfig(): string {
  return Object.entries(SQLFLUFF_CONFIG)
    .map(([table, values]) => {
      const lines = Object.entries(values).map(([key, value]) => `${key} = ${JSON.stringify(value)}`);
      return [`[tool.sqlfluff.${table}]`, ...lines].join("\n");
    })
    .join("\n\n");
}

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
