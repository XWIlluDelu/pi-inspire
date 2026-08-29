/** PWA install flow. The browser offers installation through
 * `beforeinstallprompt`; we defer that prompt so Settings can present an
 * explicit, discoverable entry instead of relying on browser chrome alone. */

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

type InstallAvailability = "installed" | "available" | "unavailable";

let deferredPrompt: BeforeInstallPromptEvent | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function readAvailability(): InstallAvailability {
  if (
    window.matchMedia("(display-mode: standalone)").matches ||
    window.matchMedia("(display-mode: window-controls-overlay)").matches
  ) {
    return "installed";
  }
  return deferredPrompt ? "available" : "unavailable";
}

export function subscribeInstallAvailability(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function installAvailability(): InstallAvailability {
  return readAvailability();
}

/** Returns the user's choice, or "unavailable" when the browser has not
 * offered installation (its heuristics require engagement first). */
export async function requestInstall(): Promise<
  "accepted" | "dismissed" | "unavailable"
> {
  const promptEvent = deferredPrompt;
  if (!promptEvent) return "unavailable";
  deferredPrompt = null;
  await promptEvent.prompt();
  const { outcome } = await promptEvent.userChoice;
  emit();
  return outcome;
}

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  deferredPrompt = event as BeforeInstallPromptEvent;
  emit();
});
window.addEventListener("appinstalled", () => {
  deferredPrompt = null;
  emit();
});
