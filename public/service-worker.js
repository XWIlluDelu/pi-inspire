const BUILD_ID = new URL(self.location.href).searchParams.get("v")?.replace(/[^a-zA-Z0-9._-]/g, "-") || "production";
const CACHE = `inspire-shell-${BUILD_ID}`;
const SHELL = [
  "/",
  "/manifest.webmanifest",
  "/favicon.svg",
  "/app-icon.svg",
  "/app-icon-192.png",
  "/app-icon-512.png",
  "/app-icon-maskable-512.png",
  "/apple-touch-icon.png",
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
