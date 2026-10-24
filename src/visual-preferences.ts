import type { InspirePreferences } from "../shared/contracts";

/** A non-authoritative first-paint cache. The host preference file remains the
 * source of truth after bootstrap. */
export const VISUAL_PREFERENCES_STORAGE_KEY = "inspire.visual-preferences";

/** Overlay chrome continues the themed outer frame. Ordinary tabs retain the
 * neutral browser hint. theme-init.js supplies the pre-CSS counterpart. */
export function applyBrowserTheme(
  theme: "light" | "dark",
  overlay = false,
  backdropDepth = 0,
): void {
  document.documentElement.dataset.theme = theme;
  const themeColor = document.querySelector<HTMLMetaElement>(
    'meta[name="theme-color"]',
  );
  const root = document.documentElement;
  const styles = overlay ? getComputedStyle(root) : null;
  const frame = styles?.getPropertyValue("--bg-rail").trim();
  let color = frame || (theme === "dark" ? "#14171A" : "#F4F5F6");
  if (styles && backdropDepth > 0) {
    const scrim = styles.getPropertyValue("--bg-overlay").trim();
    root.style.setProperty(
      "--window-scrim",
      Array(backdropDepth)
        .fill(`linear-gradient(${scrim}, ${scrim})`)
        .join(", "),
    );
    // Native controls need an opaque theme hint matching the composited strip,
    // not a translucent color that the browser would blend against another base.
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d");
    if (context) {
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      context.fillStyle = scrim;
      for (let i = 0; i < backdropDepth; i++) context.fillRect(0, 0, 1, 1);
      const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
      color = `rgb(${r}, ${g}, ${b})`;
    }
  } else root.style.removeProperty("--window-scrim");
  if (themeColor) themeColor.content = color;
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
