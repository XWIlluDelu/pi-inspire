import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type RequestListener, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createInstanceControlRequest,
  InstanceHttpControl,
  requestInstanceControl,
  verifyInstanceControlResponse,
} from "../../server/instance-control.mjs";
import {
  type InstanceState,
  inspectInstance,
  instanceLaunchUrl,
  processStartIdentity,
  stopManagedInstance,
  writeInstanceState,
} from "../../server/instance-state.mjs";
import {
  closeHostApiFixture,
  hostApiFixture,
  token,
} from "./fixtures/host-api.js";

const servers: Server[] = [];
const directories: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

function state(): InstanceState {
  return {
    schemaVersion: 1,
    root: process.cwd(),
    host: "127.0.0.1",
    port: 1234,
    pid: process.pid,
    processStartTime: "fixture-birth",
    startedAt: "2026-10-19T00:00:00.000Z",
    mock: true,
    token: randomBytes(64).toString("base64url"),
    httpControlVersion: 1,
  };
}

describe("local HTTP peer proofs", () => {
  it("authenticates one fresh action and its result without a reusable credential", () => {
    const owner = state();
    const control = new InstanceHttpControl();
    const message = createInstanceControlRequest(owner, "readiness");
    expect(JSON.stringify(message)).not.toContain(owner.token);
    const grant = control.accept(owner, message)!;
    expect(grant).not.toBeNull();
    const response = control.reply(grant, { appName: "inspire", mock: true });
    expect(JSON.stringify(response)).not.toContain(owner.token);
    expect(verifyInstanceControlResponse(owner, message, response)).toBe(true);
    expect(control.accept(owner, message)).toBeNull();
    expect(
      verifyInstanceControlResponse(owner, message, {
        ...response,
        proof: message.proof,
      }),
    ).toBe(false);
    expect(
      verifyInstanceControlResponse(owner, message, {
        ...response,
        result: { kind: "committed" },
      }),
    ).toBe(false);
    expect(
      verifyInstanceControlResponse(
        owner,
        createInstanceControlRequest(owner, "readiness"),
        response,
      ),
    ).toBe(false);
  });

  it.each([
    "pid",
    "processStartTime",
    "startedAt",
    "root",
    "host",
    "port",
    "mock",
    "token",
  ] as const)("binds client and server proofs to the owner's %s", (field) => {
    const owner = state();
    const message = createInstanceControlRequest(owner, "readiness");
    const control = new InstanceHttpControl();
    const response = control.reply(control.accept(owner, message)!, {
      appName: "inspire",
    });
    const value = owner[field];
    const changed = {
      ...owner,
      [field]:
        typeof value === "number"
          ? value + 1
          : typeof value === "boolean"
            ? !value
            : value + "-changed",
    };
    expect(new InstanceHttpControl().accept(changed, message)).toBeNull();
    expect(verifyInstanceControlResponse(changed, message, response)).toBe(
      false,
    );
  });

  it("does not allow changing a maintenance action, lease, or deadline", () => {
    const owner = state();
    const message = createInstanceControlRequest(owner, "maintenance-commit", {
      leaseId: "a".repeat(43),
    });
    const control = new InstanceHttpControl();
    for (const mutation of [
      { action: "maintenance-release" },
      { payload: { leaseId: "b".repeat(43) } },
      { expiresAt: message.expiresAt + 1 },
      { version: 2 },
      { proof: "malformed" },
    ])
      expect(control.accept(owner, { ...message, ...mutation })).toBeNull();
    expect(control.accept(owner, message)).not.toBeNull();
  });

  it("expires requests and bounds live replay records without evicting them", () => {
    vi.useFakeTimers();
    const owner = state();
    const control = new InstanceHttpControl();
    const first = createInstanceControlRequest(owner, "readiness");
    expect(control.accept(owner, first)).not.toBeNull();
    for (let index = 1; index < 1024; index++)
      expect(
        control.accept(owner, createInstanceControlRequest(owner, "readiness")),
      ).not.toBeNull();
    expect(
      control.accept(owner, createInstanceControlRequest(owner, "readiness")),
    ).toBeNull();
    expect(control.accept(owner, first)).toBeNull();
    vi.advanceTimersByTime(15_001);
    expect(control.accept(owner, first)).toBeNull();
    expect(
      control.accept(owner, createInstanceControlRequest(owner, "readiness")),
    ).not.toBeNull();
  });

  it("rejects a genuinely signed late commit even before an overdue timer callback runs", async () => {
    vi.useFakeTimers();
    const owner = state();
    const control = new InstanceHttpControl();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, options) => {
        const message = JSON.parse(options.body);
        const reply = control.reply(control.accept(owner, message)!, {
          kind: "committed",
          leaseId: "a".repeat(43),
        });
        // Move the wall clock without executing the abort timer. A delayed
        // event loop must not turn an expired reply into restart authority.
        vi.setSystemTime(Date.now() + 6_001);
        return {
          ok: true,
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(JSON.stringify(reply)),
              );
              controller.close();
            },
          }),
        };
      }),
    );
    await expect(
      requestInstanceControl(
        owner,
        "maintenance-commit",
        { leaseId: "a".repeat(43) },
        6_000,
      ),
    ).resolves.toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds authenticated request bodies before sending or accepting them", async () => {
    const owner = state();
    const payload = { oversized: "x".repeat(2048) };
    expect(
      new InstanceHttpControl().accept(
        owner,
        createInstanceControlRequest(owner, "readiness", payload),
      ),
    ).toBeNull();
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(
      requestInstanceControl(owner, "readiness", payload),
    ).resolves.toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses legacy HTTP without sending even an initial probe", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const owner = state();
    delete owner.httpControlVersion;
    await expect(
      requestInstanceControl(owner, "readiness"),
    ).resolves.toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("readiness at an untrusted port", () => {
  async function listener(callback: RequestListener) {
    const server = createServer(callback);
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    return (server.address() as { port: number }).port;
  }

  it("rejects a Host-shaped fake for live and departed owners and never discloses its key", async () => {
    const received: { authorization?: string; body: string }[] = [];
    const port = await listener(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      received.push({
        authorization: req.headers.authorization,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ appName: "inspire", mock: true }));
    });
    const directory = await mkdtemp(join(tmpdir(), "inspire-untrusted-port-"));
    directories.push(directory);
    const path = join(directory, "instance.json");
    const owner = {
      ...state(),
      port,
      processStartTime: await processStartIdentity(process.pid),
    };
    const expected = { root: owner.root, host: owner.host, port };
    await writeInstanceState(path, owner);
    await expect(
      inspectInstance(path, expected, { processMarker: process.argv[0] }),
    ).resolves.toMatchObject({ kind: "unavailable" });
    expect(received).toHaveLength(1);
    expect(received[0]!.authorization).toBeUndefined();
    expect(received[0]!.body).not.toContain(owner.token);
    expect(JSON.parse(received[0]!.body).action).toBe("readiness");
    await expect(
      stopManagedInstance(path, expected, {
        processMarker: "never-signal-the-fixture-parent",
      }),
    ).resolves.toMatchObject({ kind: "unavailable" });
    expect(received).toHaveLength(1);
    // The largest signed PID is not allocated on any supported test platform.
    await writeInstanceState(path, { ...owner, pid: 2_147_483_647 });
    await expect(inspectInstance(path, expected)).resolves.toEqual({
      kind: "stale",
    });
    expect(received).toHaveLength(1);
  }, 45_000);

  it("accepts only a signed exact-origin bootstrap fragment for browser launch", async () => {
    const owner = state();
    const control = new InstanceHttpControl();
    let url = "";
    owner.port = await listener(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk);
      const grant = control.accept(
        owner,
        JSON.parse(Buffer.concat(chunks).toString("utf8")),
      )!;
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify(control.reply(grant, { url })));
    });
    const origin = "http://127.0.0.1:" + owner.port;
    const fragment = "#inspire-bootstrap=" + "a".repeat(43);
    for (url of [
      "https://foreign.invalid/" + fragment,
      origin + "/other" + fragment,
      origin + "/?token=forbidden" + fragment,
      origin + "/#inspire-bootstrap=malformed",
      origin.replace("http://", "http://user:pass@") + "/" + fragment,
    ])
      await expect(instanceLaunchUrl(owner)).resolves.toBeNull();
    url = origin + "/" + fragment;
    await expect(instanceLaunchUrl(owner)).resolves.toBe(url);
  });

  it("cancels a rejected peer's unfinished body instead of leaving its socket active", async () => {
    let closed!: () => void;
    const disconnected = new Promise<void>((resolve) => {
      closed = resolve;
    });
    const port = await listener((_req, response) => {
      response.on("close", closed);
      response.writeHead(401);
      response.flushHeaders();
      response.write("not an authenticated peer");
      // Deliberately leave the body open; rejecting headers must close it.
    });
    await expect(
      requestInstanceControl({ ...state(), port }, "readiness"),
    ).resolves.toBeNull();
    await disconnected;
  });

  it("does not follow redirects or read an unbounded response", async () => {
    const destination = vi.fn<RequestListener>((_req, res) => {
      res.end("{}");
    });
    const target = await listener(destination);
    const redirect = await listener((_req, res) => {
      res.writeHead(302, {
        Location: "http://127.0.0.1:" + target + "/captured",
      });
      res.end();
    });
    await expect(
      requestInstanceControl({ ...state(), port: redirect }, "readiness"),
    ).resolves.toBeNull();
    expect(destination).not.toHaveBeenCalled();
    const oversized = await listener((_req, res) => res.end(" ".repeat(2049)));
    await expect(
      requestInstanceControl({ ...state(), port: oversized }, "readiness"),
    ).resolves.toBeNull();
  });
});

describe("Host local-control ingress", () => {
  it("uses only current owned identity, authenticates actions once, and preserves API/origin gates", async () => {
    let owner: InstanceState | null = null;
    const leaseId = "a".repeat(43);
    const maintenance = {
      reserve: vi.fn(async () => ({
        kind: "ready" as const,
        leaseId,
        expiresAt: Date.now() + 30_000,
        updates: ["inspire" as const],
      })),
      commit: vi.fn((leaseId: string) => ({
        kind: "committed" as const,
        leaseId,
      })),
      release: vi.fn((_leaseId: string) => ({ kind: "released" as const })),
    };
    const f = await hostApiFixture({
      instanceState: () => owner,
      maintenanceRestart: maintenance,
    });
    try {
      await request(f.application.server)
        .post("/api/host/local-control")
        .send({})
        .expect(503);
      owner = {
        ...state(),
        token,
        port: Number(new URL(f.baseUrl).port),
      };
      await request(f.application.server)
        .post("/api/host/local-control")
        .send({})
        .expect(401);
      await request(f.application.server).get("/api/health").expect(401);
      const ready = createInstanceControlRequest(owner, "readiness");
      await request(f.application.server)
        .post("/api/host/local-control")
        .set("Origin", "https://foreign.invalid")
        .send(ready)
        .expect(403);
      const response = await request(f.application.server)
        .post("/api/host/local-control")
        .send(ready)
        .expect(200);
      expect(response.body.result).toEqual({ appName: "inspire", mock: true });
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(verifyInstanceControlResponse(owner, ready, response.body)).toBe(
        true,
      );
      expect(Object.keys(response.body).sort()).toEqual([
        "nonce",
        "proof",
        "result",
        "version",
      ]);
      await request(f.application.server)
        .post("/api/host/local-control")
        .send(ready)
        .expect(401);
      const link = await instanceLaunchUrl(owner);
      expect(link).not.toBeNull();
      expect(link).not.toContain(owner.token);
      const pairing = new URL(link!);
      expect(pairing.origin).toBe(f.baseUrl);
      expect(pairing.search).toBe("");
      const bootstrap = new URLSearchParams(pairing.hash.slice(1)).get(
        "inspire-bootstrap",
      );
      const publicKey = generateKeyPairSync("ec", {
        namedCurve: "prime256v1",
      }).publicKey.export({ format: "jwk" });
      const registration = () =>
        request(f.application.server)
          .post("/api/auth/pair")
          .set("Origin", f.baseUrl)
          .send({ bootstrap, publicKey });
      await registration().expect(200);
      await registration().expect(401);
      // A private signed caller may pair an owned loopback development proxy.
      // The grant belongs to that exact browser origin, not the backend port.
      const devOrigin = "http://127.0.0.1:5173";
      const devLink = await instanceLaunchUrl(owner, devOrigin);
      expect(devLink).not.toBeNull();
      expect(new URL(devLink!).origin).toBe(devOrigin);
      expect(devLink).not.toContain(token);
      const devBootstrap = new URLSearchParams(
        new URL(devLink!).hash.slice(1),
      ).get("inspire-bootstrap");
      const pairDev = () =>
        request(f.application.server)
          .post("/api/auth/pair")
          .set("Host", new URL(devOrigin).host)
          .set("Origin", devOrigin)
          .send({ bootstrap: devBootstrap, publicKey });
      await pairDev().expect(200);
      await pairDev().expect(401);
      expect(
        await instanceLaunchUrl(owner, "https://foreign.invalid"),
      ).toBeNull();
      const prepare = createInstanceControlRequest(
        owner,
        "maintenance-prepare",
      );
      const prepared = await request(f.application.server)
        .post("/api/host/local-control")
        .send(prepare)
        .expect(200);
      expect(verifyInstanceControlResponse(owner, prepare, prepared.body)).toBe(
        true,
      );
      expect(prepared.body.result.leaseId).toBe(leaseId);
      const commit = createInstanceControlRequest(owner, "maintenance-commit", {
        leaseId,
      });
      const committed = await request(f.application.server)
        .post("/api/host/local-control")
        .send(commit)
        .expect(200);
      expect(verifyInstanceControlResponse(owner, commit, committed.body)).toBe(
        true,
      );
      expect(committed.body.result).toEqual({ kind: "committed", leaseId });
      await request(f.application.server)
        .post("/api/host/local-control")
        .send(commit)
        .expect(401);
      expect(maintenance.reserve).toHaveBeenCalledOnce();
      expect(maintenance.commit).toHaveBeenCalledExactlyOnceWith(leaseId);
      const release = createInstanceControlRequest(
        owner,
        "maintenance-release",
        { leaseId },
      );
      expect(
        (
          await request(f.application.server)
            .post("/api/host/local-control")
            .send(release)
            .expect(200)
        ).body.result.kind,
      ).toBe("released");
      expect(maintenance.release).toHaveBeenCalledExactlyOnceWith(leaseId);
      owner = null;
      await request(f.application.server)
        .post("/api/host/local-control")
        .send(release)
        .expect(503);
    } finally {
      await closeHostApiFixture(f);
    }
  });
});
