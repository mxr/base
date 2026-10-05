import { RUNNER } from "./workflow-actions";

/**
 * `.github/workflows/release.yml` bodies, one per publishing target. Each runs
 * on a pushed tag; action refs are `v0.0.0` placeholders (see addWorkflow in
 * base-project.ts).
 */

function releaseWorkflow(job: string): string[] {
  const header = `name: release

on:
  push:
    tags:
    - '**'

permissions: {}

concurrency:
  group: release-\${{ github.ref }}
  cancel-in-progress: false

jobs:
  release:
`;
  return `${header}${job}`.trimEnd().split("\n");
}

function githubReleaseStep(assets?: string): string {
  return `    - name: Create GitHub release
      env:
        GH_TOKEN: \${{ github.token }}
      run: gh release create "$GITHUB_REF_NAME"${assets ? ` ${assets}` : ""} --verify-tag --generate-notes
`;
}

/**
 * Publishes a crate to crates.io, then creates a GitHub release.
 */
export function cargoReleaseWorkflow(): string[] {
  return releaseWorkflow(`    runs-on: ${RUNNER}
    timeout-minutes: 10
    environment:
      name: crates-io
    permissions:
      contents: write
      id-token: write
    steps:
    - uses: actions/checkout@v0.0.0
      with:
        persist-credentials: false
    - uses: actions-rust-lang/setup-rust-toolchain@v0.0.0
      with:
        cache: false
    - uses: rust-lang/crates-io-auth-action@v0.0.0
      id: auth
    - name: Publish to crates.io
      env:
        CARGO_REGISTRY_TOKEN: \${{ steps.auth.outputs.token }}
      run: cargo publish
${githubReleaseStep()}`);
}

/**
 * Builds an sdist and wheel, publishes them to PyPI, then attaches them to a
 * GitHub release.
 */
export function wheelReleaseWorkflow(pythonVersion: string): string[] {
  return releaseWorkflow(`    runs-on: ${RUNNER}
    timeout-minutes: 10
    environment:
      name: pypi
    permissions:
      contents: write
      id-token: write
    steps:
    - uses: actions/checkout@v0.0.0
      with:
        persist-credentials: false
    - uses: actions/setup-python@v0.0.0
      with:
        python-version: '${pythonVersion}'
    - name: Install build tooling
      run: python -m pip install build
    - name: Build distributions
      run: python -m build
    - name: Publish package distributions to PyPI
      uses: pypa/gh-action-pypi-publish@v0.0.0
      with:
        packages-dir: dist/
${githubReleaseStep("dist/*")}`);
}

/**
 * HACS installs a Home Assistant integration straight from its GitHub
 * releases, so a release is all there is to publish.
 */
export function homeAssistantReleaseWorkflow(): string[] {
  return releaseWorkflow(`    runs-on: ${RUNNER}
    timeout-minutes: 10
    permissions:
      contents: write
    steps:
    - uses: actions/checkout@v0.0.0
      with:
        persist-credentials: false
${githubReleaseStep()}`);
}
