import { applyExistingActionRefs, readExistingActionRefs } from "../src/workflow-actions";

describe("readExistingActionRefs", () => {
  it("maps action to ref and comment, skipping placeholders", () => {
    const refs = readExistingActionRefs(
      [
        "    - uses: actions/checkout@abc123 # v4.1.0",
        "      uses: actions/setup-node@def456",
        "    - uses: taiki-e/install-action@v0.0.0",
        "    uses: mxr/workflows/.github/workflows/github-release.yml@ghi789 # v2",
      ].join("\n"),
    );
    expect([...refs]).toEqual([
      ["actions/checkout", { ref: "abc123", comment: "v4.1.0" }],
      ["actions/setup-node", { ref: "def456", comment: undefined }],
      ["mxr/workflows/.github/workflows/github-release.yml", { ref: "ghi789", comment: "v2" }],
    ]);
  });
});

describe("applyExistingActionRefs", () => {
  it("swaps placeholders for existing refs and reports new actions", () => {
    const existing = new Map([["actions/checkout", { ref: "abc123", comment: "v4.1.0" }]]);
    const result = applyExistingActionRefs(
      ["    - uses: actions/checkout@v0.0.0", "    - uses: taiki-e/install-action@v0.0.0", "    - uses: foo/bar@pinned # v1", "run: x"],
      existing,
    );
    expect(result.lines).toEqual([
      "    - uses: actions/checkout@abc123 # v4.1.0",
      "    - uses: taiki-e/install-action@v0.0.0",
      "    - uses: foo/bar@pinned # v1",
      "run: x",
    ]);
    expect(result.newActions).toEqual(["taiki-e/install-action"]);
  });
});
