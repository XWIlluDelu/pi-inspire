const BUILD_ID = new URL(self.location.href).searchParams.get("v")?.replace(/[^a-zA-Z0-9._-]/g, "-") || "production";
const CACHE = `inspire-shell-${BUILD_ID}`;
// Notification state is separate from disposable shell caches.
const NOTIFICATION_DB = "inspire-notifications";
const NOTIFICATION_LIFETIME = 15 * 60 * 1000;
let notificationQueue = Promise.resolve();

function notificationHistory(id, timestamp) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(NOTIFICATION_DB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore("handled");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction("handled", timestamp === undefined ? "readonly" : "readwrite");
      const store = tx.objectStore("handled");
      const request = timestamp === undefined ? store.get(id) : store.put(timestamp, id);
      if (timestamp !== undefined) {
        const cursor = store.openCursor();
        cursor.onsuccess = () => {
          const value = cursor.result;
          if (!value) return;
          if (value.value < Date.now() - 24 * 60 * 60 * 1000) value.delete();
          value.continue();
        };
      }
      tx.oncomplete = () => { db.close(); resolve(request.result); };
      tx.onerror = () => { db.close(); reject(tx.error); };
      tx.onabort = () => { db.close(); reject(tx.error); };
    };
  });
}

function notificationTarget(data) {
  return typeof data.sessionId === "string" && data.sessionId
    ? "/#inspire-session=" + encodeURIComponent(data.sessionId) : "/";
}

async function viewingSession(client, sessionId) {
  if (client.visibilityState !== "visible" || !client.focused) return false;
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timeout = setTimeout(() => { channel.port1.close(); resolve(false); }, 300);
    channel.port1.onmessage = (event) => {
      clearTimeout(timeout);
      channel.port1.close();
      resolve(event.data?.foreground === true && event.data?.sessionId === sessionId);
    };
    client.postMessage({ type: "inspire-notification-view" }, [channel.port2]);
  });
}

function displayTaskNotification(data, pushed) {
  const work = notificationQueue.catch(() => {}).then(async () => {
    if (!data || typeof data.id !== "string" || data.id.length > 256 ||
        !["completed", "failed", "ended"].includes(data.outcome) ||
        !Number.isFinite(data.createdAt) ||
        (data.sessionId !== null && (typeof data.sessionId !== "string" || data.sessionId.length > 4096)))
      throw new Error("Invalid task notification");
    // Every received push must display; the sender TTL enforces its expiry.
    // Stable tags replace retries without renotify. Late or expired local offers
    // can be acknowledged without displaying, including after page suspension.
    if (!pushed && (data.createdAt + NOTIFICATION_LIFETIME <= Date.now() ||
        await notificationHistory(data.id))) return;
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    if (!pushed && !data.test && (await Promise.all(
      windows.map((client) => viewingSession(client, data.sessionId)),
    )).some(Boolean)) {
      await notificationHistory(data.id, Date.now());
      return;
    }
    const title = data.test ? "Inspire test notification" : data.outcome === "failed"
      ? "Task failed" : data.outcome === "ended" ? "Task ended" : "Task completed";
    await self.registration.showNotification(title, {
      body: data.test ? "Task alerts are using this notification channel."
        : typeof data.project === "string" && data.project ? "Project: " + data.project.slice(0, 160) : "Pi task",
      tag: "inspire-task:" + data.id,
      renotify: false,
      icon: "/app-icon-192.png",
      badge: "/app-icon-192.png",
      data: { sessionId: data.sessionId, url: notificationTarget(data) },
    });
    await notificationHistory(data.id, Date.now());
    if (data.test) for (const client of windows)
      client.postMessage({ type: "inspire-notification-shown", test: true });
  });
  notificationQueue = work;
  return work;
}

self.addEventListener("message", (event) => {
  if (event.data?.type !== "inspire-notification-display" ||
      !event.source || new URL(event.source.url).origin !== self.location.origin) return;
  event.waitUntil(displayTaskNotification(event.data.notification, false).then(
    () => event.ports[0]?.postMessage({ ok: true }),
    () => event.ports[0]?.postMessage({ error: "The browser could not display the system notification." }),
  ));
});

self.addEventListener("push", (event) => {
  event.waitUntil((async () => {
    const data = event.data?.json();
    if (data?.type !== "inspire-task") throw new Error("Invalid notification push");
    await displayTaskNotification(data, true);
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const data = event.notification.data;
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const target = windows.find((client) => client.focused) ?? windows[0];
    if (target) {
      await target.focus();
      if (data?.sessionId) target.postMessage({ type: "inspire-notification-open", sessionId: data.sessionId });
    } else {
      await self.clients.openWindow(notificationTarget(data ?? {}));
    }
  })());
});

const SHELL = [
  "/",
  "/theme-init.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(SHELL);
    const shell = await fetch("/");
    if (!shell.ok) return;
    await cache.put("/", shell.clone());
    const html = await shell.text();
    const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"?#]+)"/g)].map((match) => match[1]);
    if (assets.length > 0) await cache.addAll([...new Set(assets)]);
  })());
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith("inspire-shell-") && key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname === "/events") return;

  // Browser/PWA metadata and icons are mutable outside Vite's hashed asset
  // graph. Fetch from the host so tab and installed icons can receive updates.
  if (
    [
      "/manifest.webmanifest",
      "/favicon.svg",
      "/app-icon-192.png",
      "/app-icon-512.png",
      "/app-icon-maskable-512.png",
      "/apple-touch-icon.png",
    ].includes(url.pathname)
  ) {
    event.respondWith(fetch(request));
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            event.waitUntil(caches.open(CACHE).then((cache) => cache.put("/", copy)));
          }
          return response;
        })
        .catch(() => caches.match("/").then((response) => response ?? Response.error())),
    );
    return;
  }

  const cacheKey = new Request(`${url.origin}${url.pathname}`);
  event.respondWith(
    caches.match(cacheKey).then((cached) => cached ?? fetch(request).then((response) => {
      if (response.ok) {
        const copy = response.clone();
        event.waitUntil(caches.open(CACHE).then((cache) => cache.put(cacheKey, copy)));
      }
      return response;
    })),
  );
});
