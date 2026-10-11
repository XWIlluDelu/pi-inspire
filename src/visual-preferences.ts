import type { InspirePreferences } from "../shared/contracts";

/** A non-authoritative first-paint cache. The host preference file remains the
 * source of truth after bootstrap. */
export const VISUAL_PREFERENCES_STORAGE_KEY = "inspire.visual-preferences";

/** Overlay chrome continues the themed outer frame. Ordinary tabs retain the
 * neutral browser hint. theme-init.js supplies the pre-CSS counterpart. */
export function applyBrowserTheme(
  theme: "light" | "dark",
  overlay = false,
): void {
  document.documentElement.dataset.theme = theme;
  const themeColor = document.querySelector<HTMLMetaElement>(
    'meta[name="theme-color"]',
  );
  if (themeColor) {
    const frame = overlay
      ? getComputedStyle(document.documentElement)
          .getPropertyValue("--bg-rail")
          .trim()
      : "";
    themeColor.content = frame || (theme === "dark" ? "#14171A" : "#F4F5F6");
  }
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
