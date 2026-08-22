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
set -euo pipefail

step() {
  echo ""
  echo "::: 🚀 $1 :::"
  echo ""
}

for cmd in git gh jq yq npm; do
  command -v "$cmd" > /dev/null || { echo "missing required command: $cmd" >&2; exit 1; }
done

: "${REPO:?REPO is required}"
: "${VERSION:?VERSION is required}"
: "${GH_TOKEN:?GH_TOKEN is required}"
if [ -z "${LOCAL_TARBALL:-}" ]; then
  : "${GH_PACKAGES_READ_TOKEN:?GH_PACKAGES_READ_TOKEN is required unless LOCAL_TARBALL is set}"
fi

tag="v${VERSION}"
branch="base-update"

workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT

step "cloning ${REPO}"
git clone --quiet "https://x-access-token:${GH_TOKEN}@github.com/${REPO}.git" "$workdir"

git -C "$workdir" config user.name "mxr-base-sync[bot]"
git -C "$workdir" config user.email "306625798+mxr-base-sync[bot]@users.noreply.github.com"

if [ ! -f "$workdir/.github/base.yml" ]; then
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
stack_json="$(yq -o=json '.stack' "$workdir/.github/base.yml")"
ignore_json="$(yq -o=json '.renovateIgnoreMajor // []' "$workdir/.github/base.yml")"

cat > "$workdir/.projenrc.js" <<EOF
const { BaseProject } = require("@mxr/base");

new BaseProject({
  name: "${name}",
  stack: ${stack_json},
  renovateIgnoreMajor: ${ignore_json},
}).synth();
EOF

constructs_version="$(jq -r '.peerDependencies.constructs' package.json)"
projen_version="$(jq -r '.peerDependencies.projen' package.json)"

if [ -n "${LOCAL_TARBALL:-}" ]; then
  base_dep="file:${VERSION}"
else
  base_dep="${VERSION}"
fi

cat > "$workdir/package.json" <<EOF
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
  cat > "$workdir/.npmrc" <<EOF
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
# .github/base.yml plus the generated files get committed
rm -f "$workdir/.npmrc" "$workdir/package.json" "$workdir/package-lock.json" "$workdir/.projenrc.js"
rm -rf "$workdir/node_modules"

# `git diff --quiet` only catches modifications to already-tracked files,
# not newly-generated untracked ones; status --porcelain catches both
step "checking for changes"
if [ -z "$(git -C "$workdir" status --porcelain)" ]; then
  echo "no changes"
  exit 0
fi

git -C "$workdir" add -A

if [ "${DRY_RUN:-true}" != "false" ]; then
  git -C "$workdir" diff --cached
  exit 0
fi

git -C "$workdir" commit -m "[base] update to ${tag}"

step "pushing ${branch}"
# force-with-lease over any existing branch of the same name, since we
# deliberately rebuilt it fresh from main above instead of incrementally
# updating whatever was there before
if git -C "$workdir" ls-remote --exit-code --heads origin "$branch" > /dev/null 2>&1; then
  git -C "$workdir" fetch --quiet origin "$branch"
  git -C "$workdir" push --force-with-lease="$branch:refs/remotes/origin/$branch" origin "$branch"
else
  git -C "$workdir" push -u origin "$branch"
fi

step "creating/updating PR"
existing_pr="$(gh pr list --repo "${REPO}" --head "$branch" --json number -q '.[0].number' || true)"
if [ -n "$existing_pr" ]; then
  gh pr edit "$existing_pr" --repo "${REPO}" --title "[base] update to ${tag}"
else
  (cd "$workdir" && gh pr create --repo "${REPO}" --fill --head "$branch")
fi
