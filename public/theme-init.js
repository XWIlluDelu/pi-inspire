// Resolve the system theme before first paint so the workbench never flashes
// the wrong theme; explicit user choices are applied by the app at bootstrap.
// External file (not inline) so the host CSP (script-src 'self') accepts it.
document.documentElement.dataset.theme = matchMedia("(prefers-color-scheme: dark)").matches
  ? "dark"
  : "light";
