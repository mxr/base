/**
 * Tool versions, grouped by Renovate datasource. Renovate bumps each annotated
 * one through its `// renovate:` annotation.
 */

// deb

// renovate: datasource=deb depName=zsh
export const ZSH_VERSION = "5.9-8ubuntu3";

// github-releases

// renovate: datasource=github-releases depName=bats-core/bats-core extractVersion=^v(?<version>.+)$
export const BATS_VERSION = "1.14.0";

// github-tags

/**
 * Newest CPython a wheel is tested against. uv runs a prerelease of that
 * version until it's released. Renovate bumps it at the version's first beta,
 * its feature freeze.
 */
// renovate: datasource=github-tags depName=python/cpython extractVersion=^v(?<version>\d+\.\d+)\.0b1$
export const LATEST_PYTHON = "3.15";

// go

// Only new repos get this version: each repo's renovate bumps the actionlint hook's pin in its `.pre-commit-config.yaml`, and synth keeps it.
export const SHELLCHECK_VERSION = "v0.11.1";

// npm

// Vercel is pinned here instead of as a downstream devDependency, which Vercel ignores and warns about during builds.
// renovate: datasource=npm depName=vercel
export const VERCEL_VERSION = "66.1.0";

// pypi

// renovate: datasource=pypi depName=build
export const BUILD_VERSION = "1.6.1";
// renovate: datasource=pypi depName=pre-commit-mirror-maker
export const MIRROR_MAKER_VERSION = "1.14.0";

// python-version

/**
 * Newest GA CPython, for workflows that need one Python to run tooling.
 */
// renovate: datasource=python-version depName=python
export const STABLE_PYTHON = "3.15";

// rust-version

// renovate: datasource=rust-version depName=rust
export const RUST_TOOLCHAIN = "1.100.0";
