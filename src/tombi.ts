import { tomlEntries } from "./pyproject";
import type { ManagedTable, TomlValue } from "./pyproject";

/**
 * tombi config, so tombi run outside pre-commit (e.g. an editor) formats the
 * same way as the `tombi-format` hook. Lives in `[tool.tombi]` when there's a
 * `pyproject.toml`, and in `.config/tombi.toml` for rust repos.
 */
const TOMBI_CONFIG: Readonly<Record<string, TomlValue>> = { offline: true, "string-quote-style": "double" };

/**
 * `.config/tombi.toml` contents, minus the banner.
 */
export function tombiConfigLines(): string[] {
  return tomlEntries(TOMBI_CONFIG);
}

/**
 * `[tool.tombi]` for `pyproject.toml`.
 */
export function tombiTable(): ManagedTable {
  return { name: "tool.tombi", lines: tombiConfigLines() };
}
