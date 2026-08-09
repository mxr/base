import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { firstCommitYear } from '../src/git';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'base-projen-git-'));
}

function commit(dir: string, message: string, date: string): void {
  execFileSync('git', ['commit', '--allow-empty', '-m', message], {
    cwd: dir,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@test.com',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@test.com',
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
    },
  });
}

describe('firstCommitYear', () => {
  it('reads the root commit date', () => {
    const dir = tmpDir();
    execFileSync('git', ['init', '-q'], { cwd: dir });
    commit(dir, 'commit 0', '2020-01-01T00:00:00');
    expect(firstCommitYear(dir)).toBe(2020);
  });

  it('returns the earliest year across multiple commits', () => {
    const dir = tmpDir();
    execFileSync('git', ['init', '-q'], { cwd: dir });
    commit(dir, 'commit 0', '2020-01-01T00:00:00');
    commit(dir, 'commit 1', '2023-06-15T00:00:00');
    expect(firstCommitYear(dir)).toBe(2020);
  });

  it('falls back to the current year without commits', () => {
    const dir = tmpDir();
    execFileSync('git', ['init', '-q'], { cwd: dir });
    expect(firstCommitYear(dir)).toBe(new Date().getFullYear());
  });

  it('falls back to the current year outside a git repo', () => {
    expect(firstCommitYear(tmpDir())).toBe(new Date().getFullYear());
  });
});
