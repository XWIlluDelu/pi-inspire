import {
  resourceReferenceLabel,
  type SessionResourceReference,
} from "../shared/resource-references";

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
    const displayReference = reference.reference
      ? resourceReferenceLabel(reference.reference)
      : reference.label;
    const basename = displayReference.split(/[\\/]/).pop() || displayReference;
    return {
      ...reference,
      name: reference.source === "embedded" ? reference.label : basename,
    };
  });
}

/** A list page plus the view's written files that fell outside it. */
export function withProducedResources(page: {
  resources: readonly SessionResourceReference[];
  produced?: readonly SessionResourceReference[];
}): readonly SessionResourceReference[] {
  if (!page.produced?.length) return page.resources;
  const listed = new Set(page.resources.map((resource) => resource.key));
  return [
    ...page.resources,
    ...page.produced.filter((resource) => !listed.has(resource.key)),
  ];
}
