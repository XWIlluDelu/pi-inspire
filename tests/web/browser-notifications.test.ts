import { afterEach, describe, expect, it, vi } from "vitest";
import { showBrowserNotification } from "../../src/browser-notifications";

const title = "Terminal finished";
const options: NotificationOptions = {
  body: "7s · Succeeded",
  tag: "inspire-terminal-command-test",
};

function notificationConstructor(
  permission: NotificationPermission = "granted",
) {
  const constructor = vi.fn(function NotificationStub() {});
  vi.stubGlobal("Notification", Object.assign(constructor, { permission }));
  return constructor;
}

afterEach(() => vi.unstubAllGlobals());

describe("browser notification delivery", () => {
  it.each(["default", "denied"] as const)(
    "does not deliver or inspect registration when permission is %s",
    async (permission) => {
      const constructor = notificationConstructor(permission);
      const getRegistration = vi.fn();
      vi.stubGlobal("navigator", { serviceWorker: { getRegistration } });

      await expect(showBrowserNotification(title, options)).resolves.toBe(
        false,
      );

      expect(getRegistration).not.toHaveBeenCalled();
      expect(constructor).not.toHaveBeenCalled();
    },
  );

  it("returns false when notifications are unavailable", async () => {
    vi.stubGlobal("Notification", undefined);
    const getRegistration = vi.fn();
    vi.stubGlobal("navigator", { serviceWorker: { getRegistration } });

    await expect(showBrowserNotification(title, options)).resolves.toBe(false);

    expect(getRegistration).not.toHaveBeenCalled();
  });

  it("uses the registered service worker without constructing a notification", async () => {
    const constructor = notificationConstructor();
    const showNotification = vi.fn().mockResolvedValue(undefined);
    const getRegistration = vi.fn().mockResolvedValue({ showNotification });
    vi.stubGlobal("navigator", { serviceWorker: { getRegistration } });

    await expect(showBrowserNotification(title, options)).resolves.toBe(true);

    expect(getRegistration).toHaveBeenCalledOnce();
    expect(showNotification).toHaveBeenCalledExactlyOnceWith(title, options);
    expect(constructor).not.toHaveBeenCalled();
  });

  it("preserves desktop delivery when no registration exists", async () => {
    const constructor = notificationConstructor();
    const getRegistration = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { serviceWorker: { getRegistration } });

    await expect(showBrowserNotification(title, options)).resolves.toBe(true);

    expect(constructor).toHaveBeenCalledExactlyOnceWith(title, options);
  });

  it("preserves desktop delivery without service worker support", async () => {
    const constructor = notificationConstructor();
    vi.stubGlobal("navigator", {});

    await expect(showBrowserNotification(title, options)).resolves.toBe(true);

    expect(constructor).toHaveBeenCalledExactlyOnceWith(title, options);
  });

  it.each(["lookup", "display"] as const)(
    "tries desktop delivery after service worker %s rejects",
    async (failure) => {
      const constructor = notificationConstructor();
      const showNotification = vi
        .fn()
        .mockRejectedValue(new Error("Unavailable"));
      const getRegistration =
        failure === "lookup"
          ? vi.fn().mockRejectedValue(new Error("Unavailable"))
          : vi.fn().mockResolvedValue({ showNotification });
      vi.stubGlobal("navigator", { serviceWorker: { getRegistration } });

      await expect(showBrowserNotification(title, options)).resolves.toBe(true);

      expect(constructor).toHaveBeenCalledExactlyOnceWith(title, options);
    },
  );

  it.each(["lookup", "display"] as const)(
    "contains service worker %s rejection and a mobile constructor failure",
    async (failure) => {
      const constructor = notificationConstructor();
      constructor.mockImplementation(function NotificationStub() {
        throw new TypeError("Use ServiceWorkerRegistration.showNotification()");
      });
      const showNotification = vi
        .fn()
        .mockRejectedValue(new Error("Unavailable"));
      const getRegistration =
        failure === "lookup"
          ? vi.fn().mockRejectedValue(new Error("Unavailable"))
          : vi.fn().mockResolvedValue({ showNotification });
      vi.stubGlobal("navigator", { serviceWorker: { getRegistration } });

      await expect(showBrowserNotification(title, options)).resolves.toBe(
        false,
      );

      expect(constructor).toHaveBeenCalledExactlyOnceWith(title, options);
    },
  );

  it("contains a mobile constructor failure when no registration exists", async () => {
    const constructor = notificationConstructor();
    constructor.mockImplementation(function NotificationStub() {
      throw new TypeError("Use ServiceWorkerRegistration.showNotification()");
    });
    vi.stubGlobal("navigator", {
      serviceWorker: { getRegistration: vi.fn().mockResolvedValue(undefined) },
    });

    await expect(showBrowserNotification(title, options)).resolves.toBe(false);
  });
});
