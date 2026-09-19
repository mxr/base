export interface ExistingActionRef {
  readonly ref: string;
  readonly comment?: string;
}

const PLACEHOLDER_REF = "v0.0.0";
const USES_RE = /^(\s*(?:-\s+)?uses:\s+)([^\s@]+)@(\S+)(?:(\s+)#\s*(.*?))?\s*$/;

/**
 * `action` name (e.g. `actions/checkout`) -> `ref` (and its inline comment)
 * from the downstream repo's current workflow file.
 */
export function readExistingActionRefs(workflowYaml: string): Map<string, ExistingActionRef> {
  const refs = new Map<string, ExistingActionRef>();
  for (const line of workflowYaml.split("\n")) {
    const match = USES_RE.exec(line);
    if (match && match[3] !== PLACEHOLDER_REF) {
      refs.set(match[2], { ref: match[3], comment: match[5] || undefined });
    }
  }
  return refs;
}

/**
 * Swaps the `v0.0.0` placeholder ref on each `uses:` line for that action's
 * existing ref (and comment) when there is one. Refs the template pins itself
 * are left alone. Returns the resulting lines plus the names of actions still
 * on the placeholder, i.e. newly added ones, so the caller can scope `pinact`
 * to just those instead of re-bumping every already-pinned action.
 */
export function applyExistingActionRefs(
  lines: readonly string[],
  existing: ReadonlyMap<string, ExistingActionRef>,
): { lines: string[]; newActions: string[] } {
  const newActions = new Set<string>();
  const out = lines.map((line) => {
    const match = USES_RE.exec(line);
    if (!match || match[3] !== PLACEHOLDER_REF) {
      return line;
    }
    const found = existing.get(match[2]);
    if (!found) {
      newActions.add(match[2]);
      return line;
    }
    return `${match[1]}${match[2]}@${found.ref}${found.comment ? ` # ${found.comment}` : ""}`;
  });
  return { lines: out, newActions: [...newActions] };
}
