// Resolve the saved visual preference before React and CSS first paint. The
// server preference remains authoritative after bootstrap; this tiny local
// cache only prevents a stale system/default-palette frame during that round trip.
// External file (not inline) so the host CSP (script-src 'self') accepts it.
(() => {
  const systemTheme = matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
  let cached = null;
  try {
    cached = JSON.parse(
      localStorage.getItem("inspire.visual-preferences") || "null",
    );
  } catch {
    // Storage can be unavailable in private or policy-restricted contexts.
  }
  const theme =
    cached?.theme === "light" ||
    cached?.theme === "dark" ||
    cached?.theme === "system"
      ? cached.theme
      : "system";
  // Mirror the Host's legacy identifier migration, without owning persistence.
  const savedPalette =
    cached?.palette === "amber"
      ? "chimonanthus"
      : cached?.palette === "teal"
        ? "hydrangea"
        : cached?.palette;
  const palette = [
    "wisteria",
    "hydrangea",
    "lycoris",
    "chimonanthus",
    "classic-jade",
    "classic-amber",
  ].includes(savedPalette)
    ? savedPalette
    : "chimonanthus";
  const contentTextSize = ["compact", "comfortable", "large"].includes(
    cached?.contentTextSize,
  )
    ? cached.contentTextSize
    : "comfortable";
  const readingWidth = ["narrow", "comfortable", "wide"].includes(
    cached?.readingWidth,
  )
    ? cached.readingWidth
    : "comfortable";
  document.documentElement.dataset.theme =
    theme === "system" ? systemTheme : theme;
  // Before CSS is available, mirror the outer-frame tokens for Overlay only.
  // Runtime applyBrowserTheme reads the actual CSS role after bootstrap.
  const frameColors = {
    chimonanthus: ["#EFECE4", "#12100E"],
    wisteria: ["#ECEAF2", "#111017"],
    hydrangea: ["#EAECE7", "#101412"],
    lycoris: ["#EFE9E6", "#141010"],
    "classic-amber": ["#EFEEEB", "#13161A"],
    "classic-jade": ["#EDF1EF", "#131815"],
  };
  const themeColor = document.querySelector('meta[name="theme-color"]');
  if (themeColor) {
    const dark = document.documentElement.dataset.theme === "dark";
    themeColor.content = matchMedia("(display-mode: window-controls-overlay)")
      .matches
      ? frameColors[palette][dark ? 1 : 0]
      : dark
        ? "#14171A"
        : "#F4F5F6";
  }
  document.documentElement.dataset.palette = palette;
  document.documentElement.dataset.contentTextSize = contentTextSize;
  document.documentElement.dataset.readingWidth = readingWidth;
})();
