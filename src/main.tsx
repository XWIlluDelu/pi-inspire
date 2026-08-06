import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { resolveToken } from "./api";
import { store } from "./store";
import "./styles.css";

// Extract ?token= from the URL, keep it in sessionStorage only, and strip it
// from the address bar before any render or network activity.
void store.init(resolveToken());

// The service worker owns only the static shell. Session APIs and the event
// stream stay network-only because Pi and the local host remain authoritative.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    const assetPath = [...document.scripts]
      .map((script) => script.src)
      .find((source) => source.includes("/assets/index-")) ?? "production";
    const buildId = assetPath.split("/").at(-1) ?? "production";
    void navigator.serviceWorker.register(`/service-worker.js?v=${encodeURIComponent(buildId)}`).catch(() => undefined);
  }, { once: true });
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
