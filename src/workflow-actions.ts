export interface ExistingActionRef {
  readonly ref: string;
  readonly comment?: string;
}

const PLACEHOLDER_REF = "v0.0.0";
const USES_RE = /^(\s*(?:-\s+)?uses:\s+)([^\s@]+)@(\S+)(?:(\s+)#\s*(.*?))?\s*$/;

interface UsesLine {
  prefix: string;
  action: string;
  ref: string;
  comment: string | undefined;
}

function parseUsesLine(line: string): UsesLine | undefined {
  const match = USES_RE.exec(line);
  const [, prefix, action, ref, , comment] = match ?? [];
  if (prefix === undefined || action === undefined || ref === undefined) {
    return undefined;
  }
  return { prefix, action, ref, comment };
}

/**
 * `action` name (e.g. `actions/checkout`) -> `ref` (and its inline comment)
 * from the downstream repo's current workflow file.
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
    const uses = parseUsesLine(line);
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
