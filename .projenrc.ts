import { cdk, javascript } from 'projen';
const project = new cdk.JsiiProject({
  author: 'Max R',
  authorAddress: 'mxr@users.noreply.github.com',
  authorEmail: 'mxr@users.noreply.github.com',
  authorName: 'Max R',
  description: 'projen external project type: stack-appropriate pre-commit config, license and repo metadata for my personal repos',
  devDeps: ['constructs@10.8.1', 'projen@0.101.30'],
  docgen: false,
  github: true,
  jsiiVersion: '~6.0.0',
  keywords: ['projen', 'projen-external-module'],
  license: 'MIT',
  name: '@mxr/base',
  npmAccess: javascript.NpmAccess.RESTRICTED,
  npmRegistryUrl: 'https://npm.pkg.github.com',
  npmTokenSecret: 'GITHUB_TOKEN',
  packageManager: javascript.NodePackageManager.NPM,
  peerDeps: ['constructs', 'projen'],
  prettier: false,
  projenrcJson: false,
  projenrcTs: true,
  releaseToNpm: true,
  repository: 'https://github.com/mxr/base.git',
  repositoryUrl: 'https://github.com/mxr/base.git',
});

const upgradeMain = project.tryFindObjectFile('.github/workflows/upgrade-main.yml');
upgradeMain?.addOverride('jobs.pr.permissions.contents', 'write');
upgradeMain?.addOverride('jobs.pr.permissions.pull-requests', 'write');
project.synth();