/** Browser permission is shared; each feature still owns intent and delivery. */
export function browserNotificationPermission():
  | NotificationPermission
  | "unavailable" {
  return typeof Notification === "undefined"
    ? "unavailable"
    : Notification.permission;
}

/** Invoke the native prompt in the originating gesture, before any Host I/O. */
export async function requestBrowserNotificationPermission() {
  const permission = browserNotificationPermission();
  return permission === "default"
    ? Notification.requestPermission()
    : permission;
}

/** Mobile browsers require the existing service worker to display notifications.
 * Notification delivery is optional and must never interrupt its caller. */
export async function showBrowserNotification(
  title: string,
  options: NotificationOptions,
): Promise<boolean> {
  if (browserNotificationPermission() !== "granted") return false;
  try {
    const registration = await navigator.serviceWorker?.getRegistration();
    if (registration) {
      await registration.showNotification(title, options);
      return true;
    }
  } catch {
    // A desktop browser may still support notifications without a worker.
  }
  try {
    new Notification(title, options);
    return true;
  } catch {
    // Permission alone does not imply constructor support, notably on mobile.
    return false;
  }
}

export function notificationPermissionMessage(
  permission: ReturnType<typeof browserNotificationPermission>,
): string | null {
  switch (permission) {
    case "denied":
      return "Blocked by browser. Allow notifications in this site's browser settings.";
    case "unavailable":
      return "System notifications are unavailable.";
    case "default":
      return "Notification permission is needed.";
    case "granted":
      return null;
  }
}
