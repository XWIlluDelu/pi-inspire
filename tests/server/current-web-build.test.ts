import { once } from "node:events";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliCompressSync, gzipSync } from "node:zlib";
import request from "supertest";
import { expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { CURRENT_WEB_ASSETS_MANIFEST } from "../../server/current-web-build.mjs";
import type { TerminalService } from "../../server/terminal-service.js";
import {
  BROWSER_BUILD_HEADER,
  BROWSER_UPGRADE_CLOSE,
  BROWSER_UPGRADE_REQUIRED,
  DEVELOPMENT_BROWSER_BUILD,
} from "../../shared/browser-build.mjs";
import {
  closeHostApiFixture,
  hostApiFixture,
  pairedBrowser,
  socketAdmission,
} from "./fixtures/host-api.js";

it("serves only the current manifest with validators, ranges and encodings", async () => {
  const dist = await mkdtemp(join(tmpdir(), "inspire-assets-"));
  const source = join(dist, "assets");
  const asset = "/assets/index-current.js";
  const script = 'console.log("current");\n'.repeat(100);
  await mkdir(source);
  await Promise.all([
    writeFile(join(source, "index-current.js"), script),
    writeFile(join(source, "index-current.js.br"), brotliCompressSync(script)),
    writeFile(join(source, "index-current.js.gz"), gzipSync(script)),
    writeFile(join(source, "old.js"), "outgoing but still open on disk"),
    writeFile(join(dist, "index.html"), "<title>Inspire</title>"),
    writeFile(
      join(dist, CURRENT_WEB_ASSETS_MANIFEST),
      JSON.stringify({
        version: 2,
        indexDigest: "a".repeat(64),
        buildId: "index-current.js",
        assets: [
          "index-current.js",
          "index-current.js.br",
          "index-current.js.gz",
        ],
      }),
    ),
  ]);
  const host = await hostApiFixture({ distDir: dist });
  const get = (path: string, init?: RequestInit) =>
    fetch(host.baseUrl + path, init);
  try {
    const br = await get(`${asset}?v=1`, {
      headers: { "Accept-Encoding": "br, gzip" },
    });
    expect(br.status).toBe(200);
    expect(br.headers.get("content-type")).toMatch(/^text\/javascript/);
    expect(br.headers.get("content-encoding")).toBe("br");
    const cacheControl = br.headers.get("cache-control");
    expect(cacheControl).toContain("max-age=31536000");
    expect(cacheControl).toContain("immutable");
    expect(br.headers.get("vary")).toBe("Accept-Encoding");
    expect(await br.text()).toBe(script);

    const head = await get(asset, {
      method: "HEAD",
      headers: { "Accept-Encoding": "gzip, br;q=0.5" },
    });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-encoding")).toBe("gzip");
    expect(head.headers.get("etag")).not.toBe(br.headers.get("etag"));
    await request(host.application.server)
      .get(asset)
      .set("Accept-Encoding", "br")
      .set("If-None-Match", br.headers.get("etag")!)
      .expect(304)
      .expect("Vary", "Accept-Encoding");

    const identity = await get(asset, {
      headers: { "Accept-Encoding": "br;q=0, gzip;q=0" },
    });
    expect(identity.headers.get("content-encoding")).toBeNull();
    expect(identity.headers.get("vary")).toBe("Accept-Encoding");
    expect(await identity.text()).toBe(script);
    const range = await get(asset, {
      headers: { "Accept-Encoding": "br, gzip", Range: "bytes=0-6" },
    });
    expect(range.status).toBe(206);
    expect(range.headers.get("content-encoding")).toBeNull();
    expect(range.headers.get("content-range")).toBe(
      `bytes 0-6/${Buffer.byteLength(script)}`,
    );
    expect(await range.text()).toBe(script.slice(0, 7));

    expect((await get("/assets/old.js")).status).toBe(404);
    expect((await get("/assets/index-current.js.br")).status).toBe(404);
    expect(await (await get("/")).text()).toBe("<title>Inspire</title>");
  } finally {
    await closeHostApiFixture(host);
    await rm(dist, { recursive: true, force: true });
  }
});

it("refuses stale browser mutations and socket adoption before runtime dispatch", async () => {
  const host = await hostApiFixture({
    developmentBrowserBuild: DEVELOPMENT_BROWSER_BUILD,
  });
  try {
    const { server } = host.application;
    const { bearer } = await pairedBrowser(server, host.baseUrl);
    const authorization = {
      Origin: host.baseUrl,
      Authorization: `Bearer ${bearer}`,
    };
    await request(server)
      .post("/api/prompt")
      .set(authorization)
      .set(BROWSER_BUILD_HEADER, "old-browser")
      .send(
        host.promptDelivery({
          sessionId: "fixture-active",
          message: "do not send",
        }),
      )
      .expect(409)
      .expect(BROWSER_BUILD_HEADER, BROWSER_UPGRADE_REQUIRED);
    await request(server)
      .get("/api/bootstrap")
      .set(authorization)
      .set(BROWSER_BUILD_HEADER, DEVELOPMENT_BROWSER_BUILD)
      .expect(200);

    const ticket = await socketAdmission(
      server,
      host.baseUrl,
      bearer,
      "events",
      {
        [BROWSER_BUILD_HEADER]: DEVELOPMENT_BROWSER_BUILD,
      },
    );
    const socket = new WebSocket(
      `${host.baseUrl.replace("http:", "ws:")}/events?ticket=${ticket}&build=old-browser`,
      { origin: host.baseUrl },
    );
    expect((await once(socket, "close"))[0]).toBe(BROWSER_UPGRADE_CLOSE);
  } finally {
    await closeHostApiFixture(host);
  }
});

it("retires an already connected page after a new manifest is published", async () => {
  const dist = await mkdtemp(join(tmpdir(), "inspire-asset-handoff-"));
  const manifest = join(dist, CURRENT_WEB_ASSETS_MANIFEST);
  const publish = async (buildId: string) => {
    const staging = manifest + ".tmp";
    await writeFile(
      staging,
      JSON.stringify({
        version: 2,
        buildId,
        indexDigest: "a".repeat(64),
        assets: [buildId],
      }),
    );
    await rename(staging, manifest);
  };
  await publish("index-first.js");
  const detach = vi.fn();
  const attach = vi.fn(async () => ({
    id: "peer",
    terminalId: "terminal",
    detach,
    writeInput: vi.fn(),
    control: vi.fn(),
  }));
  const host = await hostApiFixture({
    distDir: dist,
    websocketHeartbeatIntervalMs: 30,
    terminal: {
      list: () => ({ terminals: [{ id: "terminal" }] }),
      attach,
      close: async () => {},
    } as unknown as TerminalService,
  });
  let socket: WebSocket | undefined;
  let terminal: WebSocket | undefined;
  try {
    const { server } = host.application;
    const { bearer } = await pairedBrowser(server, host.baseUrl);
    const ticket = await socketAdmission(
      server,
      host.baseUrl,
      bearer,
      "events",
      {
        [BROWSER_BUILD_HEADER]: "index-first.js",
      },
    );
    socket = new WebSocket(
      `${host.baseUrl.replace("http:", "ws:")}/events?ticket=${ticket}&build=index-first.js`,
      { origin: host.baseUrl },
    );
    const closed = once(socket, "close");
    const [first] = await once(socket, "message");
    expect(JSON.parse(String(first)).type).toBe("snapshot");
    const terminalTicket = await socketAdmission(
      server,
      host.baseUrl,
      bearer,
      "terminal",
      {
        [BROWSER_BUILD_HEADER]: "index-first.js",
      },
    );
    const attachTicket = await request(server)
      .post("/api/terminals/terminal/attach-ticket")
      .set({
        Origin: host.baseUrl,
        Authorization: `Bearer ${bearer}`,
        [BROWSER_BUILD_HEADER]: "index-first.js",
      })
      .expect(200);
    terminal = new WebSocket(
      `${host.baseUrl.replace("http:", "ws:")}/terminal?ticket=${terminalTicket}&build=index-first.js`,
      { origin: host.baseUrl },
    );
    const terminalClosed = once(terminal, "close");
    await once(terminal, "open");
    terminal.send(
      JSON.stringify({
        type: "attach",
        ticket: attachTicket.body.ticket,
        clientId: "browser",
        cols: 80,
        rows: 24,
      }),
    );
    await vi.waitFor(() => expect(attach).toHaveBeenCalledOnce());

    await publish("index-next.js");
    expect((await closed)[0]).toBe(BROWSER_UPGRADE_CLOSE);
    expect((await terminalClosed)[0]).toBe(BROWSER_UPGRADE_CLOSE);
    expect(detach).toHaveBeenCalledOnce();

    const staleTicket = await socketAdmission(
      server,
      host.baseUrl,
      bearer,
      "terminal",
      {
        [BROWSER_BUILD_HEADER]: "index-next.js",
      },
    );
    const stale = new WebSocket(
      `${host.baseUrl.replace("http:", "ws:")}/terminal?ticket=${staleTicket}&build=index-first.js`,
      { origin: host.baseUrl },
    );
    expect((await once(stale, "close"))[0]).toBe(BROWSER_UPGRADE_CLOSE);
    expect(attach).toHaveBeenCalledOnce();
  } finally {
    terminal?.terminate();
    socket?.terminate();
    await closeHostApiFixture(host);
    await rm(dist, { recursive: true, force: true });
  }
});
