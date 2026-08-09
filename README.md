# base

A [projen](https://github.com/projen/projen) external project type for my
personal repos: stack-appropriate `.pre-commit-config.yaml` hooks, a LICENSE
chosen by stack, and shared `.mergify.yml` / `.github/renovate.json`.

## Usage

```ts
import { BaseProject, Stack } from 'base';

const project = new BaseProject({
  name: 'my-repo',
  stack: [Stack.PYTHON, Stack.TOML],
});

project.synth();
```

Or via the CLI, pointing `--from` at this repo (a local path, git URL, or npm
package once published):

```sh
npx projen new base --from /path/to/base --stack python --stack toml
```

## Releasing

Releases are manual, not triggered by pushing to `main`:

```sh
npx projen release   # bumps version, tags, and pushes the tag to origin
npm publish           # publishes @mxr/base to GitHub Packages
```

Pushing the tag fires `.github/workflows/propagate-update.yml`, which bumps
`@mxr/base` in downstream repos and opens a PR.

## `stack`

`stack` is a plain, declared list — not something re-detected from the
repo's contents. It drives:

- which pre-commit hooks get added (see `src/pre-commit.ts` for the mapping)
- the LICENSE: `Stack.FRONTEND` gets AGPL-3.0-or-later, everything else gets
  MIT
- whether a starter `biome.json` is added (only for `Stack.FRONTEND`)
