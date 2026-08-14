import { cdk, javascript } from "projen";
import { ReleaseTrigger } from "projen/lib/release";

const project = new cdk.JsiiProject({
  author: "Max R",
  authorAddress: "mxr@users.noreply.github.com",
  authorEmail: "mxr@users.noreply.github.com",
  authorName: "Max R",
  biome: true,
  biomeOptions: {
    biomeConfig: {
      assist: {
        actions: {
          source: {
            organizeImports: {
              level: "on",
              options: {
                groups: [{ type: false }],
              },
            },
          },
        },
        enabled: true,
      },
      formatter: {
        enabled: true,
        indentStyle: javascript.biome_config.IndentStyle.SPACE,
        indentWidth: 2,
        lineWidth: 140,
      },
      linter: {
        enabled: true,
        rules: {
          style: {
            useImportType: {
              level: "on",
              options: {
                style: "separatedType",
              },
            },
          },
        },
      },
    },
  },
  description: "projen external project type: stack-appropriate pre-commit config, license and repo metadata for my personal repos",
  devDeps: ["constructs@10.8.1", "projen@0.101.30"],
  docgen: false,
  eslint: false,
  github: true,
  jsiiVersion: "~6.0.0",
  keywords: ["projen", "projen-external-module"],
  license: "MIT",
  name: "@mxr/base",
  npmAccess: javascript.NpmAccess.RESTRICTED,
  npmRegistryUrl: "https://npm.pkg.github.com",
  npmTokenSecret: "GITHUB_TOKEN",
  packageManager: javascript.NodePackageManager.NPM,
  peerDeps: ["constructs", "projen"],
  prettier: false,
  projenrcJson: false,
  projenrcTs: true,
  releaseToNpm: true,
  releaseTrigger: ReleaseTrigger.manual(),
  repository: "https://github.com/mxr/base.git",
  repositoryUrl: "https://github.com/mxr/base.git",
});

const upgradeMain = project.tryFindObjectFile(".github/workflows/upgrade-main.yml");
upgradeMain?.addOverride("jobs.pr.permissions.contents", "write");
upgradeMain?.addOverride("jobs.pr.permissions.pull-requests", "write");

// releases are manual (see releaseTrigger above): `npx projen release` bumps,
// tags and pushes; fold the npm publish in here too so that one command does
// the whole thing. the pushed tag then triggers propagate-update.yml in CI.
project.tasks.tryFind("release")?.exec("npm publish");

project.synth();
