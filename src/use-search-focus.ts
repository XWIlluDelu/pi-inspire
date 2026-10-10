import { type RefObject, useEffect } from "react";
import { isTouchFirstDevice } from "./input-device";

/** Open searchable surfaces without summoning a touch device’s software keyboard. */
export function useSearchFocus(
  active: boolean,
  input: RefObject<HTMLElement | null>,
  surface: RefObject<HTMLElement | null>,
): void {
  useEffect(() => {
    if (active) {
      const target = isTouchFirstDevice() ? surface.current : input.current;
      target?.focus({ preventScroll: true });
    }
  }, [active, input, surface]);
}
