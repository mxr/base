import { MANAGED_MARKER, mergePyproject, renderTomlValue, sqlfluffTables } from "../src/pyproject";

const M = MANAGED_MARKER;
const RUFF = { name: "tool.ruff", lines: ['target-version = "py312"'] };
const RUFF_RENDERED = `[tool.ruff]  ${M}\ntarget-version = "py312"\n`;

describe("mergePyproject", () => {
  it.each([
    { name: "empty file", existing: "", managed: { tables: [RUFF] }, expected: RUFF_RENDERED },
    {
      name: "no managed tables yet",
      existing: '[project]\nname = "x"\n',
      managed: { tables: [RUFF] },
      expected: `[project]\nname = "x"\n\n${RUFF_RENDERED}`,
    },
    {
      name: "unmarked managed table",
      existing: '[tool.ruff]\ntarget-version = "py39"\n\n[tool.tox]\nenv_list = ["py"]\n',
      managed: { tables: [RUFF] },
      expected: `[tool.tox]\nenv_list = ["py"]\n\n${RUFF_RENDERED}`,
    },
    {
      name: "marked table no longer managed",
      existing: `[tool.mypy]  ${M}\nstrict = true\n\n[tool.tox]\nenv_list = ["py"]\n`,
      managed: { tables: [RUFF] },
      expected: `[tool.tox]\nenv_list = ["py"]\n\n${RUFF_RENDERED}`,
    },
    {
      name: "every array-of-tables entry",
      existing: '[[tool.mypy.overrides]]\nmodule = "a"\n\n[[tool.mypy.overrides]]\nmodule = "b"\n\n[tool.mypy]\nstrict = true\n',
      managed: { tables: [{ name: "tool.mypy.overrides", array: true, lines: ['module = "c"'] }] },
      expected: `[tool.mypy]\nstrict = true\n\n[[tool.mypy.overrides]]  ${M}\nmodule = "c"\n`,
    },
    {
      name: "stale tables under an owned prefix",
      existing:
        '[tool.sqlfluff]\ndialect = "ansi"\n\n[tool.sqlfluff.layout.type.comma]\nline_position = "trailing"\n\n[tool.sqlfluffish]\na = 1\n',
      managed: { tables: [RUFF], ownedPrefixes: ["tool.sqlfluff"] },
      expected: `[tool.sqlfluffish]\na = 1\n\n${RUFF_RENDERED}`,
    },
  ])("replaces managed tables for $name", ({ existing, managed, expected }) => {
    expect(mergePyproject(existing, managed)).toBe(expected);
  });

  it.each([
    {
      name: "no [project] table",
      existing: "[tool.tox]\na = 1\n",
      expected: `[tool.tox]\na = 1\n\n[project]\nlicense = "MIT"  ${M}\n`,
    },
    {
      name: "unmarked single-line key",
      existing: '[project]\nlicense = "GPL"\nname = "x"\n',
      expected: `[project]\nlicense = "MIT"  ${M}\nname = "x"\n`,
    },
    {
      name: "unmarked multi-line key",
      existing: '[project]\nlicense = {\n  text = "GPL",\n}\nname = "x"\n',
      expected: `[project]\nlicense = "MIT"  ${M}\nname = "x"\n`,
    },
    {
      name: "marked key no longer managed",
      existing: `[project]\nreadme = "README.md"  ${M}\nname = "x"\n`,
      expected: `[project]\nlicense = "MIT"  ${M}\nname = "x"\n`,
    },
    {
      name: "same key in another table",
      existing: '[project]\nname = "x"\n\n[tool.other]\nlicense = "GPL"\n',
      expected: `[project]\nlicense = "MIT"  ${M}\nname = "x"\n\n[tool.other]\nlicense = "GPL"\n`,
    },
  ])("replaces [project] keys for $name", ({ existing, expected }) => {
    expect(mergePyproject(existing, { tables: [], projectKeys: { license: "MIT" } })).toBe(expected);
  });
});

describe("renderTomlValue", () => {
  it.each([
    { name: "string", value: 'a"b', expected: '"a\\"b"' },
    { name: "multi-line string", value: "a\nb\n", expected: "'''\na\nb\n'''" },
    { name: "boolean", value: true, expected: "true" },
    { name: "flat array", value: ["a", "b"], expected: '["a", "b"]' },
    { name: "single nested array", value: [["a", "b"]], expected: '[["a", "b"]]' },
    { name: "nested array", value: [["a"], ["b", "c"]], expected: '[\n  ["a"],\n  ["b", "c"],\n]' },
    { name: "array with a multi-line string", value: [["a", "b\n"]], expected: `[\n  [\n    "a",\n    '''\nb\n''',\n  ],\n]` },
    { name: "inline table", value: { name: "x", n: false }, expected: '{ name = "x", n = false }' },
    { name: "empty inline table", value: {}, expected: "{}" },
  ])("renders a $name", ({ value, expected }) => {
    expect(renderTomlValue(value)).toBe(expected);
  });
});

describe("sqlfluffTables", () => {
  it("renders each table with quoted strings and bare booleans", () => {
    const tables = sqlfluffTables();
    expect(tables[0]).toEqual({
      name: "tool.sqlfluff.layout.type.comma",
      lines: ['line_position = "leading"', 'spacing_before = "touch"'],
    });
    expect(tables).toContainEqual({
      name: "tool.sqlfluff.rules.convention.terminator",
      lines: ["multiline_newline = true", "require_final_semicolon = true"],
    });
  });
});
