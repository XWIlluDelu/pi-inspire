import { vi } from "vitest";

export function mockTouchFirstDevice() {
  const original = window.matchMedia;
  return vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
    ...original(query),
    matches:
      query === "(hover: none) and (pointer: coarse)" ||
      original(query).matches,
  }));
}
