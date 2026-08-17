import type { InspirePreferences } from "../shared/contracts";

/** A non-authoritative first-paint cache. The host preference file remains the
 * source of truth after bootstrap. */
export const VISUAL_PREFERENCES_STORAGE_KEY = "inspire.visual-preferences";

export function cacheVisualPreferences(
  preferences: Pick<InspirePreferences, "theme" | "palette">,
): void {
  try {
    window.localStorage.setItem(
      VISUAL_PREFERENCES_STORAGE_KEY,
      JSON.stringify({
        theme: preferences.theme,
        palette: preferences.palette,
      }),
    );
  } catch {
    // Private browsing or a disabled storage policy must not affect theming.
  }
}
