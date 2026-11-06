#!/usr/bin/env bats

# Runs propagate-repo.sh against a local bare repo. git clone is redirected there, so
# pushes are real. gh, npm, node, pre-commit, and pinact are stubs that log their calls.

setup() {
	bats_require_minimum_version 1.5.0
	ROOT="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
	STUBS="$BATS_TEST_TMPDIR/bin"
	LOG="$BATS_TEST_TMPDIR/calls.log"
	REMOTE="$BATS_TEST_TMPDIR/remote.git"
	REAL_GIT="$(command -v git)"
	export LOG REMOTE REAL_GIT

	mkdir -p "$STUBS"
	stub git <<'EOF'
if [ "$1" = clone ]; then
	exec "$REAL_GIT" clone --quiet "$REMOTE" "${@: -1}"
fi
exec "$REAL_GIT" "$@"
EOF
	stub gh <<'EOF'
echo "gh $*" >>"$LOG"
if [ "$1 $2" = "pr list" ]; then
	echo "${EXISTING_PR:-}"
fi
EOF
	stub npm <<'EOF'
echo "npm $*" >>"$LOG"
jq -r '.devDependencies["@mxr/base"]' package.json >>"$LOG"
if [ -e .npmrc ]; then
	echo "has npmrc" >>"$LOG"
fi
EOF
	# synth: keep the generated .projenrc.js, and write a file when SYNTH_OUTPUT is set
	stub node <<'EOF'
cp .projenrc.js "$BATS_TEST_TMPDIR/projenrc.js"
if [ -n "${SYNTH_OUTPUT:-}" ]; then
	echo "$SYNTH_OUTPUT" >generated.txt
fi
EOF
	stub pre-commit <<'EOF'
echo "pre-commit $*" >>"$LOG"
EOF
	stub pinact <<'EOF'
echo "pinact $*" >>"$LOG"
EOF
	PATH="$STUBS:$PATH"
}

# stub <name> writes an executable from the script on stdin
stub() {
	{
		echo '#!/usr/bin/env bash'
		cat
	} >"$STUBS/$1"
	chmod +x "$STUBS/$1"
}

# hides tools installed outside the system dirs, such as a real pinact, keeping jq and yq
isolate_path() {
	ln -sf "$(command -v jq)" "$(command -v yq)" "$STUBS/"
	PATH="$STUBS:/usr/bin:/bin"
}

# make_remote <base.yml contents, or empty for none> [extra file name] [extra file contents]
make_remote() {
	local src="$BATS_TEST_TMPDIR/src"
	rm -rf "$src" "$REMOTE"
	"$REAL_GIT" init -q -b main "$src"
	mkdir -p "$src/.github"
	echo readme >"$src/README.md"
	if [ -n "$1" ]; then
		printf '%s\n' "$1" >"$src/.github/base.yml"
	fi
	if [ -n "${2:-}" ]; then
		printf '%s\n' "$3" >"$src/$2"
	fi
	"$REAL_GIT" -C "$src" add -A
	"$REAL_GIT" -C "$src" -c user.name=test -c user.email=test@example.com commit -q -m init
	"$REAL_GIT" clone -q --bare "$src" "$REMOTE"
}

# runs the script with default env. Pass overrides as NAME=value arguments
propagate() {
	cd "$ROOT" || return 1
	run env REPO=mxr/example VERSION=1.2.3 GITHUB_TOKEN=token GH_PACKAGES_READ_TOKEN=read-token "$@" .github/scripts/propagate-repo.sh
}

@test "requires REPO" {
	propagate REPO=
	[ "$status" -ne 0 ]
	[[ "$output" == *"REPO is required"* ]]
}

@test "requires GH_PACKAGES_READ_TOKEN unless LOCAL_TARBALL is set" {
	propagate GH_PACKAGES_READ_TOKEN=
	[ "$status" -ne 0 ]
	[[ "$output" == *"GH_PACKAGES_READ_TOKEN is required"* ]]
}

@test "requires the commands it runs" {
	rm "$STUBS/pre-commit"
	isolate_path
	propagate
	[ "$status" -eq 1 ]
	[[ "$output" == *"missing required command: pre-commit"* ]]
}

@test "skips a repo without base.yml" {
	make_remote ""
	propagate
	[ "$status" -eq 0 ]
	[[ "$output" == *"no .github/base.yml, skipping"* ]]
	[ ! -e "$LOG" ]
}

@test "renders .projenrc.js with camelCase opt keys" {
	make_remote "$(printf 'stack: [python]\nopt:\n  python:\n    min-version: "3.12"\n    custom-release: true\n    extras:\n      tests: [more-tests]\n  github-actions:\n    custom-managers: [github-actions-versions]')"
	propagate
	[ "$status" -eq 0 ]
	local rc="$BATS_TEST_TMPDIR/projenrc.js"
	grep -qF 'name: "example",' "$rc"
	grep -qF '"minVersion": "3.12"' "$rc"
	grep -qF '"customRelease": true' "$rc"
	grep -qF '"tests": [' "$rc"
	grep -qF '"customManagers": [' "$rc"
	grep -qF '"github-actions-versions"' "$rc"
}

@test "uses BASE instead of the repo's base.yml" {
	make_remote "stack: [rust]"
	propagate BASE="stack: [sql]"
	[ "$status" -eq 0 ]
	grep -qF '"sql"' "$BATS_TEST_TMPDIR/projenrc.js"
	run ! grep -qF '"rust"' "$BATS_TEST_TMPDIR/projenrc.js"
}

@test "installs @mxr/base from GitHub Packages" {
	make_remote "stack: [sql]"
	propagate
	[ "$status" -eq 0 ]
	grep -qx "1.2.3" "$LOG"
	grep -qx "has npmrc" "$LOG"
}

@test "installs @mxr/base from a tarball with LOCAL_TARBALL" {
	make_remote "stack: [sql]"
	propagate LOCAL_TARBALL=1 VERSION=/tmp/base.tgz GH_PACKAGES_READ_TOKEN=
	[ "$status" -eq 0 ]
	grep -qx "file:/tmp/base.tgz" "$LOG"
	run ! grep -q "has npmrc" "$LOG"
}

@test "requires pinact for stacks that render workflows" {
	rm "$STUBS/pinact"
	isolate_path
	for stack in rust frontend mirror shell typescript python; do
		make_remote "stack: [$stack]"
		propagate
		[ "$status" -eq 1 ]
		[[ "$output" == *"missing required command: pinact"* ]]
	done
}

@test "does not require pinact for stacks without workflows" {
	rm "$STUBS/pinact"
	isolate_path
	make_remote "$(printf 'stack: [python]\nopt:\n  python:\n    min-version: "3.12"\n    ci: false')"
	propagate
	[ "$status" -eq 0 ]
}

@test "reports no changes when synth changes nothing" {
	make_remote "stack: [sql]"
	propagate
	[ "$status" -eq 0 ]
	[[ "$output" == *"no changes"* ]]
}

@test "dry run prints the diff without pushing" {
	make_remote "stack: [sql]"
	propagate SYNTH_OUTPUT=synthesized
	[ "$status" -eq 0 ]
	[[ "$output" == *"+synthesized"* ]]
	run ! "$REAL_GIT" -C "$REMOTE" rev-parse --verify -q base-update
	run ! grep -q '^gh' "$LOG"
}

@test "commits only generated files and keeps the repo's package.json" {
	make_remote "stack: [sql]" package.json '{"name": "app"}'
	propagate SYNTH_OUTPUT=synthesized DRY_RUN=false
	[ "$status" -eq 0 ]
	[ "$("$REAL_GIT" -C "$REMOTE" log -1 --format=%s base-update)" = "[base] apply v1.2.3" ]
	[ "$("$REAL_GIT" -C "$REMOTE" log -1 --format=%an base-update)" = "mxr-base-sync[bot]" ]
	[ "$("$REAL_GIT" -C "$REMOTE" diff --name-only main base-update)" = generated.txt ]
}

@test "opens a PR when none exists" {
	make_remote "stack: [sql]"
	propagate SYNTH_OUTPUT=synthesized DRY_RUN=false
	[ "$status" -eq 0 ]
	grep -qx "gh pr create --repo mxr/example --fill --head base-update" "$LOG"
}

@test "force-pushes and retitles an existing PR" {
	make_remote "stack: [sql]"
	propagate SYNTH_OUTPUT=first DRY_RUN=false EXISTING_PR=7
	[ "$status" -eq 0 ]
	propagate SYNTH_OUTPUT=second DRY_RUN=false EXISTING_PR=7 VERSION=1.2.4
	[ "$status" -eq 0 ]
	[ "$("$REAL_GIT" -C "$REMOTE" log -1 --format=%s base-update)" = "[base] apply v1.2.4" ]
	[ "$("$REAL_GIT" -C "$REMOTE" rev-list --count main..base-update)" -eq 1 ]
	grep -qx 'gh pr edit 7 --repo mxr/example --title \[base\] apply v1.2.4' "$LOG"
}
