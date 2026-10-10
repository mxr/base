export interface ExistingActionRef {
  readonly ref: string;
  readonly comment?: string;
}

export const RUNNER = "ubuntu-26.04";
export const WINDOWS_RUNNER = "windows-2025";

const PLACEHOLDER_REF = "v0.0.0";
const USES_RE = /^(\s*(?:-\s+)?uses:\s+)([^\s@]+)@(\S+)(?:(\s+)#\s*(.*?))?\s*$/;
// Renovate bumps a docker step's tag along with its digest, so the image alone is the key.
// The tag is the last `:` segment before the digest, since a registry can have a port.
const DOCKER_RE = /^(docker:\/\/[^@]+?)((?::[^:/@]+)?@.+)$/;

interface UsesLine {
  prefix: string;
  action: string;
  ref: string;
  comment: string | undefined;
  docker: boolean;
}

function parseUsesLine(line: string): UsesLine | undefined {
  const match = USES_RE.exec(line);
  const [, prefix, action, ref, , comment] = match ?? [];
  if (prefix === undefined || action === undefined || ref === undefined) {
    return undefined;
  }
  const [, image, tagAndDigest] = DOCKER_RE.exec(`${action}@${ref}`) ?? [];
  if (image !== undefined && tagAndDigest !== undefined) {
    return { prefix, action: image, ref: tagAndDigest, comment, docker: true };
  }
  return { prefix, action, ref, comment, docker: false };
}

/**
 * `action` name (e.g. `actions/checkout`) -> `ref` (and its inline comment)
 * from the downstream repo's current workflow file. A `docker://` step maps
 * its image to `:<tag>@<digest>`.
 */
export function readExistingActionRefs(workflowYaml: string): Map<string, ExistingActionRef> {
  const refs = new Map<string, ExistingActionRef>();
  for (const line of workflowYaml.split("\n")) {
    const uses = parseUsesLine(line);
    if (uses && uses.ref !== PLACEHOLDER_REF) {
      refs.set(uses.action, { ref: uses.ref, ...(uses.comment ? { comment: uses.comment } : {}) });
    }
  }
  return refs;
}

/**
 * Swaps the `v0.0.0` placeholder ref on each `uses:` line for that action's
 * existing ref (and comment) when there is one. Refs the template pins itself
 * are left alone, except a `docker://` step's, which pinact can't resolve: the
 * template's pin is a default that an existing tag and digest override. Returns the
 * resulting lines plus the names of actions still on the placeholder, i.e.
 * newly added ones, so the caller can scope `pinact` to just those instead of
 * re-bumping every already-pinned action.
 */
export function applyExistingActionRefs(
  lines: readonly string[],
  existing: ReadonlyMap<string, ExistingActionRef>,
): { lines: string[]; newActions: string[] } {
  const newActions = new Set<string>();
  const out = lines.map((line) => {
    const uses = parseUsesLine(line);
    if (uses?.docker) {
      const found = existing.get(uses.action);
      return found ? `${uses.prefix}${uses.action}${found.ref}${found.comment ? ` # ${found.comment}` : ""}` : line;
    }
    if (!uses || uses.ref !== PLACEHOLDER_REF) {
      return line;
    }
    const found = existing.get(uses.action);
    if (!found) {
      newActions.add(uses.action);
      return line;
    }
    return `${uses.prefix}${uses.action}@${found.ref}${found.comment ? ` # ${found.comment}` : ""}`;
  });
  return { lines: out, newActions: [...newActions] };
}
