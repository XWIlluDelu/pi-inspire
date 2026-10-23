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
