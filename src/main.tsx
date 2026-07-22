import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { resolveToken } from "./api";
import { store } from "./store";
import "./styles.css";

// Extract ?token= from the URL, keep it in sessionStorage only, and strip it
// from the address bar before any render or network activity.
void store.init(resolveToken());

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
