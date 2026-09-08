import type { InspirePreferences } from "../shared/contracts";

/** A non-authoritative first-paint cache. The host preference file remains the
 * source of truth after bootstrap. */
export const VISUAL_PREFERENCES_STORAGE_KEY = "inspire.visual-preferences";

/** Neutral installed-window chrome, independent of the in-app accent palette.
 * Keep the pre-CSS counterpart in public/theme-init.js in sync. */
export function applyBrowserTheme(theme: "light" | "dark"): void {
  document.documentElement.dataset.theme = theme;
  const themeColor = document.querySelector<HTMLMetaElement>(
    'meta[name="theme-color"]',
  );
  if (themeColor) themeColor.content = theme === "dark" ? "#14171A" : "#F4F5F6";
}

export function cacheVisualPreferences(
  preferences: Pick<
    InspirePreferences,
    "theme" | "palette" | "contentTextSize" | "readingWidth"
  >,
): void {
  try {
    window.localStorage.setItem(
      VISUAL_PREFERENCES_STORAGE_KEY,
      JSON.stringify({
        theme: preferences.theme,
        palette: preferences.palette,
        contentTextSize: preferences.contentTextSize,
        readingWidth: preferences.readingWidth,
      }),
    );
  } catch {
    // Private browsing or a disabled storage policy must not affect theming.
  }
}
