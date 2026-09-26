import { mergeSqlfluffConfig } from "../src/pyproject";

const SQLFLUFF = '[tool.sqlfluff.rules.capitalisation.keywords]\ncapitalisation_policy = "upper"\n';

describe("mergeSqlfluffConfig", () => {
  it.each([
    { name: "empty file", existing: "", expected: SQLFLUFF },
    {
      name: "no sqlfluff tables",
      existing: '[project]\nname = "x"\n',
      expected: `[project]\nname = "x"\n\n${SQLFLUFF}`,
    },
    {
      name: "stale sqlfluff tables",
      existing:
        '[project]\nname = "x"\n\n[tool.sqlfluff]\ndialect = "ansi"\n\n[tool.sqlfluff.layout.type.comma]\nline_position = "trailing"\n\n[tool.ruff]\nline-length = 150\n',
      expected: `[project]\nname = "x"\n\n[tool.ruff]\nline-length = 150\n\n${SQLFLUFF}`,
    },
    {
      name: "similarly named table",
      existing: "[tool.sqlfluffish]\na = 1\n",
      expected: `[tool.sqlfluffish]\na = 1\n\n${SQLFLUFF}`,
    },
  ])("replaces sqlfluff tables for $name", ({ existing, expected }) => {
    expect(mergeSqlfluffConfig(existing, SQLFLUFF)).toBe(expected);
  });
});
