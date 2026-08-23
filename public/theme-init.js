// Resolve the saved visual preference before React and CSS first paint. The
// server preference remains authoritative after bootstrap; this tiny local
// cache only prevents a stale system/Amber frame during that round trip.
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
  const palette =
    cached?.palette === "amber" || cached?.palette === "teal"
      ? cached.palette
      : "amber";
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
  document.documentElement.dataset.palette = palette;
  document.documentElement.dataset.contentTextSize = contentTextSize;
  document.documentElement.dataset.readingWidth = readingWidth;
})();
