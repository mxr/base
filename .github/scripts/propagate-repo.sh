#!/usr/bin/env bash
# Scaffolds .projenrc.js from a downstream repo's .github/base.yml and synths it
# against a version of @mxr/base. In a dry run, prints the diff. Otherwise
# pushes the base-update branch and opens or updates its PR.
#
# Required env:
#   REPO                    owner/name of the downstream repo
#   VERSION                 @mxr/base version to synth against, such as 1.2.3, or a tarball path if LOCAL_TARBALL=1
#   GITHUB_TOKEN            token with contents:write and pull-requests:write on REPO, used by gh, git, and
#                           pinact (a dry run needs only read access)
# Optional env:
#   DRY_RUN                 defaults to true, which prints the diff and exits. Set to "false" to push and open a PR
#   LOCAL_TARBALL           if set, VERSION is a path to a local tarball instead of a registry version
#   GH_PACKAGES_READ_TOKEN  auth token for npm.pkg.github.com. Required unless LOCAL_TARBALL is set
#   BASE                    base.yml contents to use instead of the downstream repo's .github/base.yml.
#                           Use it to test config changes before committing them downstream
#
# Example: dry-run a local @mxr/base build against mxr/dotfiles
#   REPO=mxr/dotfiles VERSION="$(pwd)/$(npm pack --silent)" LOCAL_TARBALL=1 GITHUB_TOKEN=$(gh auth token) .github/scripts/propagate-repo.sh
set -euo pipefail

step() {
	echo ""
	echo "::: 🚀 $1 :::"
	echo ""
}

for cmd in git gh jq yq npm pre-commit; do
	command -v "$cmd" >/dev/null || {
		echo "missing required command: $cmd" >&2
		exit 1
	}
done

: "${REPO:?REPO is required}"
: "${VERSION:?VERSION is required}"
: "${GITHUB_TOKEN:?GITHUB_TOKEN is required}"
if [ -z "${LOCAL_TARBALL:-}" ]; then
	: "${GH_PACKAGES_READ_TOKEN:?GH_PACKAGES_READ_TOKEN is required unless LOCAL_TARBALL is set}"
fi

# leave out the tokens (GITHUB_TOKEN, GH_PACKAGES_READ_TOKEN)
step "args"
echo "REPO=${REPO}"
echo "VERSION=${VERSION}"
echo "DRY_RUN=${DRY_RUN:-true}"
echo "LOCAL_TARBALL=${LOCAL_TARBALL:-}"
if [ -n "${BASE:-}" ]; then
	printf 'BASE=\n%s\n' "$BASE"
else
	echo "BASE= (using the repo's .github/base.yml)"
fi

tag="v${VERSION}"
branch="base-update"

workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT

step "cloning ${REPO}"
git clone --quiet "https://x-access-token:${GITHUB_TOKEN}@github.com/${REPO}.git" "$workdir"

git -C "$workdir" config user.name "mxr-base-sync[bot]"
git -C "$workdir" config user.email "306625798+mxr-base-sync[bot]@users.noreply.github.com"

base_yml="$workdir/.github/base.yml"
if [ -n "${BASE:-}" ]; then
	base_yml="$workdir/.base-yml-override.yml"
	printf '%s\n' "$BASE" >"$base_yml"
elif [ ! -f "$base_yml" ]; then
	echo "no .github/base.yml, skipping"
	exit 0
fi

# branch off the freshly cloned main, not a previous base-update branch, so the
# diff is against main
git -C "$workdir" checkout -b "$branch"

# downstream repos commit only .github/base.yml. The rest is scaffolded on each
# run, so a repo never needs a projen dependency between syncs
name="$(basename "$REPO")"
stack_json="$(yq -o=json '.stack' "$base_yml")"
# base.yml's opt keys are kebab-case to match stack names like github-actions,
# but jsii requires camelCase property names, so convert the keys
opt_json="$(
	yq -o=json '.opt // {}' "$base_yml" | jq '
    def to_camel: split("-") as $p | $p[0] + ($p[1:] | map((.[0:1] | ascii_upcase) + .[1:]) | join(""));
    def camelize:
      if type == "object" then with_entries(.key |= to_camel | .value |= camelize)
      elif type == "array" then map(camelize)
      else . end;
    camelize
  '
)"

# BaseProject runs `pinact` for these stacks (see postSynthesize in
# base-project.ts). propagate-update.yml installs pinact on the same condition
needs_pinact="$(yq '((.stack // []) | (contains(["rust"]) or contains(["frontend"]) or contains(["mirror"]))) or (((.stack // []) | contains(["python"])) and ((.opt.python.ci != false) or (.opt.python.packaging != null) or (.opt.python.run-type-checks-in-github-actions == true)))' "$base_yml")"
if [ "$needs_pinact" = "true" ]; then
	command -v pinact >/dev/null || {
		echo "missing required command: pinact" >&2
		exit 1
	}
fi

cat >"$workdir/.projenrc.js" <<EOF
const { BaseProject } = require("@mxr/base");

new BaseProject({
  name: "${name}",
  stack: ${stack_json},
  opt: ${opt_json},
}).synth();
EOF

step "BaseProject args"
cat "$workdir/.projenrc.js"

constructs_version="$(jq -r '.peerDependencies.constructs' package.json)"
projen_version="$(jq -r '.peerDependencies.projen' package.json)"

if [ -n "${LOCAL_TARBALL:-}" ]; then
	base_dep="file:${VERSION}"
else
	base_dep="${VERSION}"
fi

# a downstream repo, such as a Next.js app, can have its own package.json and
# package-lock.json. Stash them so the scaffold doesn't overwrite them, and
# restore them after synth
[ -f "$workdir/package.json" ] && mv "$workdir/package.json" "$workdir/.package.json.orig"
[ -f "$workdir/package-lock.json" ] && mv "$workdir/package-lock.json" "$workdir/.package-lock.json.orig"

cat >"$workdir/package.json" <<EOF
{
  "name": "${name}-base-sync",
  "private": true,
  "devDependencies": {
    "@mxr/base": "${base_dep}",
    "constructs": "${constructs_version}",
    "projen": "${projen_version}"
  }
}
EOF

if [ -z "${LOCAL_TARBALL:-}" ]; then
	cat >"$workdir/.npmrc" <<EOF
@mxr:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GH_PACKAGES_READ_TOKEN}
EOF
fi

# `npx projen` refuses to run without .projen/tasks.json, which a fresh scaffold
# doesn't have. .projenrc.js calls .synth() itself, so run it directly
step "running npm install"
(cd "$workdir" && npm install)

step "synthing via generated .projenrc.js"
(cd "$workdir" && node .projenrc.js)

# remove the scaffold so only .github/base.yml and the generated files get
# committed, and restore the repo's own package.json and package-lock.json
rm -f "$workdir/.npmrc" "$workdir/package.json" "$workdir/package-lock.json" "$workdir/.projenrc.js" "$workdir/.base-yml-override.yml"
rm -rf "$workdir/node_modules"
if [ -f "$workdir/.package.json.orig" ]; then
	mv "$workdir/.package.json.orig" "$workdir/package.json"
fi
if [ -f "$workdir/.package-lock.json.orig" ]; then
	mv "$workdir/.package-lock.json.orig" "$workdir/package-lock.json"
fi

# postSynthesize() staged files before its pre-commit autofixes ran, and those
# fixes can bring the worktree back to HEAD's content. So stage everything and
# check the index, not the worktree. Otherwise `git commit` can fail with
# nothing to commit
step "checking for changes"
git -C "$workdir" add -A
if git -C "$workdir" diff --cached --quiet; then
	echo "no changes"
	exit 0
fi

if [ "${DRY_RUN:-true}" != "false" ]; then
	git -C "$workdir" diff --cached
	exit 0
fi

git -C "$workdir" commit -m "[base] apply ${tag}"

step "pushing ${branch}"
# force-with-lease over an existing base-update branch, since this run rebuilt
# the branch from main
if git -C "$workdir" ls-remote --exit-code --heads origin "$branch" >/dev/null 2>&1; then
	git -C "$workdir" fetch --quiet origin "$branch"
	git -C "$workdir" push --force-with-lease="$branch:refs/remotes/origin/$branch" origin "$branch"
else
	git -C "$workdir" push -u origin "$branch"
fi

step "creating/updating PR"
existing_pr="$(gh pr list --repo "${REPO}" --head "$branch" --json number -q '.[0].number' || true)"
if [ -n "$existing_pr" ]; then
	gh pr edit "$existing_pr" --repo "${REPO}" --title "[base] apply ${tag}"
else
	(cd "$workdir" && gh pr create --repo "${REPO}" --fill --head "$branch")
fi
