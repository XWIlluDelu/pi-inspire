import type { ResourceDescriptor } from "../../../shared/contracts";

export function fakeResourceDescriptor(
  reference: string,
  overrides: Partial<ResourceDescriptor> = {},
): ResourceDescriptor {
  return {
    id: reference,
    sessionId: "s1",
    viewId: "view-s1",
    reference,
    name: reference.split("/").at(-1)!,
    size: 5,
    kind: "text",
    mimeType: "text/plain",
    ...overrides,
  };
}
