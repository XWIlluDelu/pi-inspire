import type { SessionResourceReference } from "../shared/resource-references";

export interface ResourceRow extends SessionResourceReference {
  /** Basename used for display. */
  name: string;
}

/** Find the nearest RichText-owned file control for delegated click handling. */
export function resourceReferenceFromEventTarget(
  target: EventTarget | null,
): string | null {
  if (!(target instanceof Element)) return null;
  return (
    target.closest<HTMLElement>("[data-file-path]")?.dataset.filePath ?? null
  );
}

export function resourceRows(
  references: readonly SessionResourceReference[],
): ResourceRow[] {
  return references.map((reference) => {
    const displayReference = reference.label
      .replace(/[?#].*$/u, "")
      .replace(/:\d+(?::\d+)?$/, "");
    const rawBasename =
      displayReference.split(/[\\/]/).pop() || displayReference;
    let basename = rawBasename;
    try {
      basename = decodeURIComponent(rawBasename);
    } catch {
      // Keep the literal reference when it contains malformed URL escapes.
    }
    return {
      ...reference,
      name: reference.source === "embedded" ? reference.label : basename,
    };
  });
}
