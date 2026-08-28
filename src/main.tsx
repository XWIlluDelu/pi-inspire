import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { resolveToken } from "./api";
import { AppErrorBoundary } from "./components/AppErrorBoundary";
import { store } from "./store";
import "./styles.css";

// A launch URL token exists only for this pairing attempt and is stripped
// before render. Ordinary PWA launches authenticate with the host-owned
// HttpOnly pairing cookie.
const initialization = store.init(resolveToken());

// Browser freezes and network changes can strand an apparently open socket
// without promptly delivering `close`. Re-enter through the same bootstrap +
// authoritative-snapshot path instead of creating a parallel resync protocol.
window.addEventListener("online", () => store.recoverConnection("online"));
window.addEventListener("pageshow", (event) => {
  if (event.persisted) store.recoverConnection("pageshow");
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible")
    store.recoverConnection("visible");
});

// The full CJK face registry is large even though the browser ultimately
// fetches only glyph subsets it uses. Keep it off the critical shell path and
// do not let it compete with the authoritative bootstrap on a remote link.
window.addEventListener(
  "load",
  () => {
    void initialization.then(
      () =>
        window.setTimeout(() => {
          void import("./deferred-fonts.css").catch(() => undefined);
        }, 750),
      () => undefined,
    );
  },
  { once: true },
);

// The service worker owns only the static shell. Session APIs and the event
// stream stay network-only because Pi and the local host remain authoritative.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener(
    "load",
    () => {
      const assetPath =
        [...document.scripts]
          .map((script) => script.src)
          .find((source) => source.includes("/assets/index-")) ?? "production";
      const buildId = assetPath.split("/").at(-1) ?? "production";
      void navigator.serviceWorker
        .register(`/service-worker.js?v=${encodeURIComponent(buildId)}`)
        .catch(() => undefined);
    },
    { once: true },
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </StrictMode>,
);
