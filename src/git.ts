import { execFileSync } from "node:child_process";

/**
 * Returns the year of the repo's first commit, so the LICENSE year reflects
 * when the project actually started rather than when it happens to synth.
 * Falls back to the current year outside a git repo, or one with no commits.
 */
export function firstCommitYear(outdir: string): number {
  try {
    const root = execFileSync("git", ["-C", outdir, "rev-list", "--max-parents=0", "HEAD"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .trim()
      .split("\n")[0];

    /* v8 ignore next 3 - defensive: rev-list only succeeds when a root commit exists */
    if (!root) {
      throw new Error("no root commit");
    }

    const year = execFileSync("git", ["-C", outdir, "log", "-1", "--format=%ad", "--date=format:%Y", root], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();

    const parsed = Number.parseInt(year, 10);
    /* v8 ignore next 3 - defensive: --date=format:%Y always produces digits */
    if (Number.isNaN(parsed)) {
      throw new Error(`unparseable year: ${year}`);
    }
    return parsed;
  } catch {
    return new Date().getFullYear();
  }
}
