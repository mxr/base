#!/usr/bin/env bash
# Scaffolds .projenrc.js from a downstream repo's .github/base.yml, synths it
# against a version of @mxr/base, and either prints the resulting diff
# (DRY_RUN set) or pushes a branch + opens/updates a PR.
#
# Required env:
#   REPO                    owner/name of the downstream repo
#   VERSION                 @mxr/base version to synth against (e.g. 1.2.3, or a local tarball path if LOCAL_TARBALL=1)
#   GH_TOKEN                token with contents:write, pull-requests:write on REPO (push/PR skipped in dry run)
# Optional env:
#   DRY_RUN                 defaults to true (print diff, exit before push/PR); set to "false" to push/PR for real
#   LOCAL_TARBALL           if set, VERSION is treated as a path to a local tarball instead of a registry version
#   GH_PACKAGES_READ_TOKEN  auth token for npm.pkg.github.com; required unless LOCAL_TARBALL set
#   BASE                    base.yml contents to use instead of the downstream repo's .github/base.yml
#                           (handy for testing config changes before they're committed downstream)
#
# Example: dry-run a local @mxr/base build against mxr/dotfiles
#   REPO=mxr/dotfiles VERSION="$(pwd)/$(npm pack --silent)" LOCAL_TARBALL=1 GH_TOKEN=$(gh auth token) .github/scripts/propagate-repo.sh
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
: "${GH_TOKEN:?GH_TOKEN is required}"
if [ -z "${LOCAL_TARBALL:-}" ]; then
	: "${GH_PACKAGES_READ_TOKEN:?GH_PACKAGES_READ_TOKEN is required unless LOCAL_TARBALL is set}"
fi

# tokens (GH_TOKEN, GH_PACKAGES_READ_TOKEN) are deliberately left out
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
git clone --quiet "https://x-access-token:${GH_TOKEN}@github.com/${REPO}.git" "$workdir"

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

# branch off main's actual content, never a prior base-update-* PR's state —
# the diff has to be against what's really on main, not whatever a previous
# run left behind
git -C "$workdir" checkout -b "$branch"

# .github/base.yml is the only thing downstream repos check in; the rest of
# this is scaffolded fresh every run so a plain projen dependency never has
# to live in the repo between syncs
name="$(basename "$REPO")"
stack_json="$(yq -o=json '.stack' "$base_yml")"
# base.yml's opt keys are kebab-case (matching stack names like
# github-actions), but BaseProject's TS options are camelCase (jsii forbids
# non-camelCase property names), so convert object keys on the way through
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
# base-project.ts); propagate-update.yml installs it under the same condition
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

# the downstream repo may already have its own package.json/package-lock.json
# (e.g. a Next.js app); stash them so the scaffold below doesn't clobber them,
# and restore them once synth is done scaffolding is torn back out
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

# `npx projen` refuses to run without a pre-existing .projen/tasks.json
# (chicken-and-egg on a from-scratch scaffold like this); .projenrc.js calls
# .synth() itself, so run it directly instead
step "running npm install"
(cd "$workdir" && npm install)

step "synthing via generated .projenrc.js"
(cd "$workdir" && node .projenrc.js)

# scaffolding was only ever a means to synth; strip it back out so only
# .github/base.yml plus the generated files get committed, restoring
# whatever package.json/package-lock.json the downstream repo already had
rm -f "$workdir/.npmrc" "$workdir/package.json" "$workdir/package-lock.json" "$workdir/.projenrc.js" "$workdir/.base-yml-override.yml"
rm -rf "$workdir/node_modules"
if [ -f "$workdir/.package.json.orig" ]; then
	mv "$workdir/.package.json.orig" "$workdir/package.json"
fi
if [ -f "$workdir/.package-lock.json.orig" ]; then
	mv "$workdir/.package-lock.json.orig" "$workdir/package-lock.json"
fi

# synth's own postSynthesize() already ran `git add` mid-way through (see
# base-project.ts), before its own pre-commit autofix passes ran; those
# autofixes can converge the worktree back to content that's already
# identical to HEAD (e.g. a repo whose main already has the fixed-up
# content from a previously merged base-update PR). So check for real
# changes off the index after staging everything, not off the worktree
# beforehand - otherwise `git commit` below fails with nothing to commit
# even though `git status` looked dirty a moment earlier.
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
# force-with-lease over any existing branch of the same name, since we
# deliberately rebuilt it fresh from main above instead of incrementally
# updating whatever was there before
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
