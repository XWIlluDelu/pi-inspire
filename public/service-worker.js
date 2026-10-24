const BUILD_ID = new URL(self.location.href).searchParams.get("v")?.replace(/[^a-zA-Z0-9._-]/g, "-") || "production";
const CACHE = `inspire-shell-${BUILD_ID}`;
// Notification state is separate from disposable shell caches.
const NOTIFICATION_DB = "inspire-notifications";
const NOTIFICATION_LIFETIME = 15 * 60 * 1000;
let notificationQueue = Promise.resolve();

function notificationState(storeName, id, value) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(NOTIFICATION_DB, 3);
    open.onupgradeneeded = () => {
      for (const name of ["handled", "latest", "groups", "settings"])
        if (!open.result.objectStoreNames.contains(name)) open.result.createObjectStore(name);
    };
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction(storeName, value === undefined ? "readonly" : "readwrite");
      const store = tx.objectStore(storeName);
      const request = value === undefined ? store.get(id) : store.put(value, id);
      if (value !== undefined && storeName !== "settings") {
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

function notificationWork(operation) {
  const work = notificationQueue.catch(() => {}).then(operation);
  notificationQueue = work;
  return work;
}

async function readNotificationState(store, key, pushed) {
  try { return await notificationState(store, key); }
  catch (error) {
    // A received push must display even when storage is temporarily unavailable.
    // Visible notification metadata still protects grouping and ordering.
    if (!pushed) throw error;
  }
}

function taskNotification(notification) {
  return !notification.data?.notification?.test &&
    typeof notification.data?.sessionId === "string" &&
    /^inspire-(task|session|project):/.test(notification.tag);
}

function notificationMembers(notification) {
  const members = notification.data?.members;
  if (Array.isArray(members)) return members.filter((item) => typeof item?.sessionId === "string");
  const current = notification.data?.notification;
  return current && !current.test && typeof current.sessionId === "string" ? [current] : [];
}

function validPolicy(value) {
  return value && ["session", "project"].includes(value.grouping) &&
    Number.isSafeInteger(value.updatedAt) && value.updatedAt >= 0;
}

async function notificationPolicy(incoming, displayed, pushed, authoritative = false) {
  const saved = await readNotificationState("settings", "grouping", pushed);
  let known = validPolicy(saved) ? saved : null;
  for (const notification of displayed) {
    const policy = notification.data?.policy;
    if (validPolicy(policy) && (!known ||
        policy.owner === known.owner && policy.updatedAt > known.updatedAt)) known = policy;
  }
  const accepted = validPolicy(incoming) && (!known || !known.owner && incoming.owner ||
    authoritative && incoming.owner !== known.owner ||
    incoming.owner === known.owner && incoming.updatedAt > known.updatedAt);
  const policy = accepted ? incoming : known || { grouping: "session", updatedAt: 0, owner: "" };
  const changed = accepted && (known
    ? policy.grouping !== known.grouping || known.owner && policy.owner !== known.owner ||
      policy.updatedAt > known.updatedAt
    : policy.grouping !== "session");
  if (!saved || policy.owner !== saved.owner || policy.updatedAt !== saved.updatedAt) {
    try { await notificationState("settings", "grouping", policy); }
    catch (error) { if (!pushed) throw error; }
  }
  if (changed) for (const notification of displayed)
    if (taskNotification(notification)) notification.close();
  return { policy, displayed: changed ? displayed.filter((item) => !taskNotification(item)) : displayed };
}

function latestNotification(values) {
  return values.reduce((latest, candidate) =>
    candidate && (!latest || candidate.createdAt > latest.createdAt) ? candidate : latest, null);
}

function displayTaskNotification(data, pushed) {
  return notificationWork(async () => {
    if (!data || typeof data.id !== "string" || data.id.length > 256 ||
        !["completed", "failed", "ended"].includes(data.outcome) ||
        !Number.isFinite(data.createdAt) ||
        (data.sessionId !== null && (typeof data.sessionId !== "string" || data.sessionId.length > 4096)))
      throw new Error("Invalid task notification");
    if (!pushed && data.createdAt + NOTIFICATION_LIFETIME <= Date.now()) return;
    const incoming = data.grouping ? { grouping: data.grouping,
      updatedAt: data.groupingUpdatedAt ?? 0, owner: data.notificationOwner ?? "" } : null;
    const { policy, displayed: all } = await notificationPolicy(
      incoming, await self.registration.getNotifications(), pushed,
    );
    const previous = !data.test && data.sessionId
      ? await readNotificationState("latest", data.sessionId, pushed) : null;
    // Keep confirmed project identity during an optional metadata read failure.
    const knownIdentity = [previous?.notification, ...all.flatMap(notificationMembers)].find(
      (item) => item?.sessionId === data.sessionId && item.projectId &&
        item.notificationOwner === data.notificationOwner,
    );
    if (!data.projectId && knownIdentity) data = { ...data,
      projectId: knownIdentity.projectId, project: data.project || knownIdentity.project };
    const project = !data.test && policy.grouping === "project" &&
      typeof data.projectId === "string" && data.projectId.length > 0 && data.projectId.length <= 256;
    const grouped = !data.test && Boolean(data.sessionId);
    const tag = project ? "inspire-project:" + data.projectId
      : grouped ? "inspire-session:" + data.sessionId : "inspire-task:" + data.id;
    const displayed = grouped ? all.filter((item) => taskNotification(item) &&
      (item.tag === tag || item.data?.sessionId === data.sessionId ||
        project && notificationMembers(item).some((member) => member.projectId === data.projectId))) : [];
    const members = new Map();
    for (const notification of displayed) for (const member of notificationMembers(notification)) {
      if (!project && member.sessionId !== data.sessionId) continue;
      const previous = members.get(member.sessionId);
      if (!previous || member.createdAt > previous.createdAt) members.set(member.sessionId, member);
    }
    const sessionCurrent = latestNotification([previous?.notification, members.get(data.sessionId), data]);
    const handled = await readNotificationState("handled", data.id, pushed);
    const repeated = Boolean(handled || previous?.notification.id === data.id ||
      [...members.values()].some((item) => item.id === data.id));
    if (!pushed && (repeated || sessionCurrent.id !== data.id)) return;
    const previousGroup = project ? await readNotificationState("groups", data.projectId, pushed) : null;
    const scopeLatest = latestNotification([
      previousGroup?.notification, sessionCurrent, ...members.values(), data,
    ]);
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const viewed = !pushed && !data.test && (await Promise.all(
      windows.map((client) => viewingSession(client, data.sessionId)),
    )).some(Boolean);
    const eligible = !data.test && !viewed && !repeated && sessionCurrent.id === data.id &&
      (members.size > 0 || data.createdAt >= scopeLatest.createdAt);
    let changed = false;
    if (viewed) changed = members.delete(data.sessionId);
    else if (eligible) {
      members.set(data.sessionId, data);
      changed = true;
    }
    const remember = async () => {
      if (grouped && (!previous || data.createdAt >= previous.notification.createdAt))
        await notificationState("latest", data.sessionId, {
          notification: sessionCurrent, recordedAt: Date.now(),
        });
      if (project) await notificationState("groups", data.projectId, {
        notification: scopeLatest, recordedAt: Date.now(),
      });
      await notificationState("handled", data.id, Date.now());
    };
    // Viewing removes only this session. Dismissed project notifications do not
    // seed the next cycle with old members, even when a push must be repainted.
    if (!pushed && (!members.size && viewed || !changed && !data.test)) {
      await remember();
      if (viewed && !members.size) for (const item of displayed) item.close();
      return;
    }
    const current = latestNotification([...members.values()]) || scopeLatest;
    const outcome = current.outcome === "failed"
      ? "Task failed" : current.outcome === "ended" ? "Task ended" : "Task completed";
    const name = typeof current.sessionName === "string"
      ? current.sessionName.replace(/\s+/g, " ").trim().slice(0, 160) : "";
    const label = project && members.size > 1 ? members.size + " sessions" : name || "Unnamed session";
    const title = current.test ? "Inspire test notification" : outcome + " · " + label;
    await self.registration.showNotification(title, {
      body: current.test ? "Task alerts are using this notification channel."
        : typeof current.project === "string" && current.project ? "Project: " + current.project.slice(0, 160) : "Pi task",
      tag,
      renotify: !current.test && eligible && current.id === data.id &&
        current.createdAt + NOTIFICATION_LIFETIME > Date.now(),
      icon: "/app-icon-192.png",
      badge: "/app-icon-192.png",
      data: { sessionId: current.sessionId, url: notificationTarget(current),
        notification: current, members: [...members.values()], policy },
    });
    // Retire legacy/fallback slots only after their replacement was accepted.
    for (const notification of displayed) if (notification.tag !== tag) notification.close();
    await remember();
    if (data.test) for (const client of windows)
      client.postMessage({ type: "inspire-notification-shown", test: true });
  });
}

self.addEventListener("message", (event) => {
  if (!event.source || new URL(event.source.url).origin !== self.location.origin) return;
  let work;
  if (event.data?.type === "inspire-notification-display")
    work = displayTaskNotification(event.data.notification, false);
  else if (event.data?.type === "inspire-notification-settings")
    work = notificationWork(async () => {
      if (!validPolicy(event.data)) throw new Error("Invalid notification grouping");
      await notificationPolicy({ grouping: event.data.grouping,
        updatedAt: event.data.updatedAt, owner: event.data.owner ?? "" },
        await self.registration.getNotifications(), false, true);
    });
  else return;
  event.waitUntil(work.then(
    () => event.ports[0]?.postMessage({ ok: true }),
    () => event.ports[0]?.postMessage({ error: "The browser could not update the system notifications." }),
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
