import { applyExistingActionRefs, readExistingActionRefs } from "../src/workflow-actions";

describe("readExistingActionRefs", () => {
  it("maps action to ref and comment, skipping placeholders", () => {
    const refs = readExistingActionRefs(
      [
        "    - uses: actions/checkout@abc123 # v4.1.0",
        "      uses: actions/setup-node@def456",
        "    - uses: taiki-e/install-action@v0.0.0",
        "    uses: mxr/workflows/.github/workflows/pre-commit-typing.yml@ghi789 # v0.3.2",
        "    - uses: docker://ghcr.io/foo/bar:1.2.3@sha256:aaa",
      ].join("\n"),
    );
    expect([...refs]).toEqual([
      ["actions/checkout", { ref: "abc123", comment: "v4.1.0" }],
      ["actions/setup-node", { ref: "def456", comment: undefined }],
      ["mxr/workflows/.github/workflows/pre-commit-typing.yml", { ref: "ghi789", comment: "v0.3.2" }],
      ["docker://ghcr.io/foo/bar", { ref: ":1.2.3@sha256:aaa", comment: undefined }],
    ]);
  });

  it.each([
    { name: "drops a pin older than the minimum", comment: " # v0.3.1", kept: false },
    { name: "drops a pin without a version comment", comment: "", kept: false },
    { name: "keeps a pin at the minimum", comment: " # v0.3.2", kept: true },
    { name: "keeps a newer minor pin", comment: " # v0.4.0", kept: true },
    { name: "keeps a newer major pin", comment: " # v1.0.0", kept: true },
    { name: "keeps a pin with a two-digit part", comment: " # v0.10.0", kept: true },
  ])("$name", ({ comment, kept }) => {
    const refs = readExistingActionRefs(`    uses: mxr/workflows/.github/workflows/tox-uv.yml@abc123${comment}`);
    expect(refs.has("mxr/workflows/.github/workflows/tox-uv.yml")).toBe(kept);
  });
});

describe("applyExistingActionRefs", () => {
  it("swaps placeholders for existing refs and reports new actions", () => {
    const existing = new Map([
      ["actions/checkout", { ref: "abc123", comment: "v4.1.0" }],
      ["actions/setup-node", { ref: "def456" }],
    ]);
    const result = applyExistingActionRefs(
      [
        "    - uses: actions/checkout@v0.0.0",
        "    - uses: actions/setup-node@v0.0.0",
        "    - uses: taiki-e/install-action@v0.0.0",
        "    - uses: foo/bar@pinned # v1",
        "run: x",
      ],
      existing,
    );
    expect(result.lines).toEqual([
      "    - uses: actions/checkout@abc123 # v4.1.0",
      "    - uses: actions/setup-node@def456",
      "    - uses: taiki-e/install-action@v0.0.0",
      "    - uses: foo/bar@pinned # v1",
      "run: x",
    ]);
    expect(result.newActions).toEqual(["taiki-e/install-action"]);
  });

  it.each([
    {
      name: "keeps an existing docker tag and digest",
      existing: new Map([["docker://ghcr.io/foo/bar", { ref: ":2.0.0@sha256:bbb" }]]),
      expected: "    - uses: docker://ghcr.io/foo/bar:2.0.0@sha256:bbb",
    },
    {
      name: "keeps the template's docker pin for a new step",
      existing: new Map(),
      expected: "    - uses: docker://ghcr.io/foo/bar:1.2.3@sha256:aaa",
    },
  ])("$name", ({ existing, expected }) => {
    const result = applyExistingActionRefs(["    - uses: docker://ghcr.io/foo/bar:1.2.3@sha256:aaa"], existing);
    expect(result).toEqual({ lines: [expected], newActions: [] });
  });

  it.each([
    {
      name: "a registry with a port",
      line: "    - uses: docker://host:5000/foo/bar:2.0.0@sha256:bbb",
      image: "docker://host:5000/foo/bar",
      ref: ":2.0.0@sha256:bbb",
      comment: undefined,
    },
    {
      name: "a digest without a tag",
      line: "    - uses: docker://ghcr.io/foo/bar@sha256:bbb",
      image: "docker://ghcr.io/foo/bar",
      ref: "@sha256:bbb",
      comment: undefined,
    },
    {
      name: "an inline comment",
      line: "    - uses: docker://ghcr.io/foo/bar:2.0.0@sha256:bbb # pinned",
      image: "docker://ghcr.io/foo/bar",
      ref: ":2.0.0@sha256:bbb",
      comment: "pinned",
    },
  ])("keys a docker step by its image and keeps its pin with $name", ({ line, image, ref, comment }) => {
    const existing = readExistingActionRefs(line);
    expect([...existing]).toEqual([[image, { ref, comment }]]);
    const template = `    - uses: ${image}:1.2.3@sha256:aaa`;
    expect(applyExistingActionRefs([template], existing).lines).toEqual([line]);
  });
});
