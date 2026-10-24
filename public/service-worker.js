const BUILD_ID = new URL(self.location.href).searchParams.get("v")?.replace(/[^a-zA-Z0-9._-]/g, "-") || "production";
const CACHE = `inspire-shell-${BUILD_ID}`;
// Notification state is separate from disposable shell caches.
const NOTIFICATION_DB = "inspire-notifications";
const NOTIFICATION_LIFETIME = 15 * 60 * 1000;
let notificationQueue = Promise.resolve();

function notificationState(storeName, id, value) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(NOTIFICATION_DB, 2);
    open.onupgradeneeded = () => {
      for (const name of ["handled", "latest"])
        if (!open.result.objectStoreNames.contains(name)) open.result.createObjectStore(name);
    };
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction(storeName, value === undefined ? "readonly" : "readwrite");
      const store = tx.objectStore(storeName);
      const request = value === undefined ? store.get(id) : store.put(value, id);
      if (value !== undefined) {
        const cursor = store.openCursor();
        cursor.onsuccess = () => {
          const record = cursor.result;
          if (!record) return;
          const time = typeof record.value === "number" ? record.value : record.value.recordedAt;
          if (time < Date.now() - 24 * 60 * 60 * 1000) record.delete();
          record.continue();
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
    if (!pushed && data.createdAt + NOTIFICATION_LIFETIME <= Date.now()) return;
    const grouped = !data.test && Boolean(data.sessionId);
    const displayed = grouped ? (await self.registration.getNotifications()).filter(
      (notification) => notification.data?.sessionId === data.sessionId,
    ) : [];
    const readState = async (store, key) => {
      try { return await notificationState(store, key); }
      catch (error) {
        // Storage failure may trigger page-to-push recovery, but must not make
        // an already received push invisible. Visible metadata still orders it.
        if (!pushed) throw error;
      }
    };
    const handled = await readState("handled", data.id);
    const previous = grouped ? await readState("latest", data.sessionId) : null;
    let current = data;
    for (const candidate of [previous?.notification, ...displayed.map((item) => item.data?.notification)])
      if (candidate && candidate.createdAt >= current.createdAt) current = candidate;
    const repeated = Boolean(handled || previous?.notification.id === data.id ||
      displayed.some((item) => item.data?.notification?.id === data.id));
    // A received push must display under WebKit's contract. Repaint the latest
    // known result silently rather than resurrecting a delayed older result.
    if (!pushed && (repeated || current.id !== data.id)) return;
    const remember = async () => {
      if (grouped) await notificationState("latest", data.sessionId, {
        notification: current, recordedAt: Date.now(),
      });
      await notificationState("handled", data.id, Date.now());
    };
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    if (!pushed && !data.test && (await Promise.all(
      windows.map((client) => viewingSession(client, data.sessionId)),
    )).some(Boolean)) {
      await remember();
      for (const notification of displayed) notification.close();
      return;
    }
    const outcome = current.outcome === "failed"
      ? "Task failed" : current.outcome === "ended" ? "Task ended" : "Task completed";
    const name = typeof current.sessionName === "string"
      ? current.sessionName.replace(/\s+/g, " ").trim().slice(0, 160) : "";
    const title = current.test ? "Inspire test notification"
      : outcome + " · " + (name || "Unnamed session");
    const tag = grouped ? "inspire-session:" + data.sessionId : "inspire-task:" + data.id;
    // Old releases used per-run tags. Retire only this session's legacy slots,
    // and only after the replacement has been accepted by the browser.
    const legacy = displayed.filter((notification) => notification.tag !== tag);
    await self.registration.showNotification(title, {
      body: current.test ? "Task alerts are using this notification channel."
        : typeof current.project === "string" && current.project ? "Project: " + current.project.slice(0, 160) : "Pi task",
      tag,
      renotify: !current.test && !repeated && current.id === data.id &&
        current.createdAt + NOTIFICATION_LIFETIME > Date.now(),
      icon: "/app-icon-192.png",
      badge: "/app-icon-192.png",
      data: { sessionId: current.sessionId, url: notificationTarget(current), notification: current },
    });
    for (const notification of legacy) notification.close();
    await remember();
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
