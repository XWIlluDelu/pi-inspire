import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import supertest from "supertest";
import { describe, expect, it, vi } from "vitest";
import { TerminalDaemonClient } from "../../server/terminal-daemon-client.js";
import { TerminalDaemonServer } from "../../server/terminal-daemon-server.js";
import { createTerminalGateway } from "../../server/terminal-gateway.js";
import { TerminalOperationReceipts } from "../../server/terminal-operation-receipts.js";
import { TerminalServiceError } from "../../server/terminal-service.js";
import { TerminalSessionManager } from "../../server/terminal-session-manager.js";
import type { TerminalDescriptor } from "../../shared/terminal-contracts.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "terminal-operations-"));
  const address =
    process.platform === "win32"
      ? `\\\\.\\pipe\\terminal-operations-${randomUUID()}`
      : join(directory, "terminal.sock");
  const service = new TerminalSessionManager();
  const server = new TerminalDaemonServer(address, "synthetic-secret", service);
  await server.start();
  const client = new TerminalDaemonClient(address, "synthetic-secret");
  return {
    directory,
    address,
    service,
    server,
    client,
    async close() {
      vi.useRealTimers();
      await client.close();
      await server.stop();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

async function httpFixture() {
  const daemon = await fixture();
  const app = express();
  app.use(express.json());
  const gateway = createTerminalGateway(app, daemon.client, 60_000);
  app.use(
    (
      error: {
        status?: number;
        code?: string;
        message?: string;
        name?: string;
      },
      _request: express.Request,
      response: express.Response,
      _next: express.NextFunction,
    ) => {
      response
        .status(error.status ?? (error.name === "ZodError" ? 400 : 500))
        .json({ error: error.message, code: error.code });
    },
  );
  return {
    request: supertest(app),
    service: daemon.service,
    async close() {
      gateway.close();
      await daemon.close();
    },
  };
}

describe("terminal control receipts over isolated IPC", () => {
  it("retains an operation across an IPC timeout, concurrent retries, and Host replacement", async () => {
    const f = await fixture();
    const committed = deferred<void>();
    const reply = deferred<TerminalDescriptor>();
    const result = {
      id: "synthetic-terminal",
      catalogEpoch: "catalog",
      catalogRevision: 1,
    } as TerminalDescriptor;
    const mutation = vi
      .spyOn(f.service, "create")
      .mockImplementation(async () => {
        committed.resolve();
        return reply.promise;
      });
    const operation = {
      id: randomUUID(),
      epoch: await f.client.operationEpoch(),
    };
    const params = { request: { cwd: f.directory, cols: 90 } };
    try {
      vi.useFakeTimers();
      const first = f.client
        .operate("create", params, operation)
        .catch((error: unknown) => error);
      await committed.promise;
      await vi.advanceTimersByTimeAsync(5_001);
      expect(await first).toMatchObject({ code: "terminal_daemon_timeout" });
      vi.useRealTimers();
      // Neither closing the old Host connection nor two simultaneous delivery
      // attempts may dispatch the daemon mutation again.
      await f.client.close();
      const replacement = new TerminalDaemonClient(
        f.address,
        "synthetic-secret",
      );
      const second = replacement.operate("create", params, operation);
      const concurrent = replacement.operate(
        "create",
        { request: { cols: 90, cwd: f.directory } },
        operation,
      );
      reply.resolve(result);
      expect(await second).toEqual(result);
      expect(await concurrent).toEqual(result);
      expect(await replacement.operate("create", params, operation)).toEqual(
        result,
      );
      expect(mutation).toHaveBeenCalledOnce();
      await replacement.close();
    } finally {
      reply.resolve(result);
      await f.close();
    }
  });

  it("refuses an old receipt epoch after daemon replacement", async () => {
    const f = await fixture();
    const params = { request: { cwd: f.directory } };
    const operation = {
      id: randomUUID(),
      epoch: await f.client.operationEpoch(),
    };
    try {
      vi.spyOn(f.service, "create").mockResolvedValue({
        id: "created",
      } as TerminalDescriptor);
      await f.client.operate("create", params, operation);
      await f.server.stop();
      const replacementManager = new TerminalSessionManager();
      const create = vi.spyOn(replacementManager, "create");
      const replacement = new TerminalDaemonServer(
        f.address,
        "synthetic-secret",
        replacementManager,
      );
      await replacement.start();
      try {
        await expect(
          f.client.operate("create", params, operation),
        ).rejects.toMatchObject({ code: "terminal_operation_epoch_changed" });
        expect(create).not.toHaveBeenCalled();
      } finally {
        await replacement.stop();
      }
    } finally {
      await f.close();
    }
  });
});

describe("terminal HTTP operation forwarding", () => {
  const routes: Array<
    [
      method: "post" | "patch" | "delete",
      path: string,
      body?: object,
      invalid?: { path?: string; body?: object },
    ]
  > = [
    ["post", "/api/terminals", { cwd: "/fixture" }, { body: {} }],
    [
      "patch",
      "/api/terminals/tab",
      { title: "Title" },
      { body: { title: 42 } },
    ],
    [
      "post",
      "/api/terminals/reorder",
      { cwd: "/fixture", terminalIds: [] },
      { body: { cwd: "/fixture", terminalIds: ["bad/id"] } },
    ],
    [
      "post",
      "/api/terminals/tab/restart",
      undefined,
      { path: "/api/terminals/bad%20id/restart" },
    ],
    [
      "delete",
      "/api/terminals/tab",
      undefined,
      { path: "/api/terminals/bad%20id" },
    ],
    [
      "patch",
      "/api/terminal-settings",
      { persistOutput: true },
      { body: { historyRetentionDays: 0 } },
    ],
    ["delete", "/api/terminal-history"],
  ];

  it.each(routes)(
    "checks identity and validation before forwarding %s %s",
    async (method, path, body, invalid) => {
      const { request, service, close } = await httpFixture();
      const dispatch = vi.spyOn(service, "operate");
      try {
        const missing = await request[method](path).send(body).expect(400);
        expect(missing.body.code).toBe("terminal_operation_required");
        if (invalid) {
          const operation = {
            id: randomUUID(),
            epoch: await service.operationEpoch(),
          };
          const rejected = await request[method](invalid.path ?? path)
            .set("X-Terminal-Operation", JSON.stringify(operation))
            .send(invalid.body)
            .expect(400);
          expect(rejected.headers["x-terminal-operation"]).toBe(operation.id);
          expect(rejected.headers["x-terminal-outcome"]).toBe("rejected");
        }
        expect(dispatch).not.toHaveBeenCalled();
      } finally {
        await close();
      }
    },
  );

  it("forwards immutable identity through Host requests and marks authoritative outcomes", async () => {
    const { request, service, close } = await httpFixture();
    const create = vi
      .spyOn(service, "create")
      .mockResolvedValue({ id: "one" } as TerminalDescriptor);
    try {
      const epoch = await request.get("/api/terminal-operations").expect(200);
      const operation = { id: randomUUID(), epoch: epoch.body.epoch as string };
      for (let i = 0; i < 2; i++) {
        const response = await request
          .post("/api/terminals")
          .set("X-Terminal-Operation", JSON.stringify(operation))
          .send({ cwd: "/fixture" })
          .expect(201);
        expect(response.headers["x-terminal-operation"]).toBe(operation.id);
        expect(response.headers["x-terminal-outcome"]).toBe("completed");
        expect(response.body).toEqual({ id: "one" });
      }
      const mismatch = await request
        .post("/api/terminals")
        .set("X-Terminal-Operation", JSON.stringify(operation))
        .send({ cwd: "/other" })
        .expect(409);
      expect(mismatch.headers["x-terminal-outcome"]).toBe("unknown");
      expect(create).toHaveBeenCalledOnce();
      create.mockRejectedValueOnce(
        new TerminalServiceError("terminal_limit", 409, "Synthetic refusal"),
      );
      const refusedOperation = { ...operation, id: randomUUID() };
      const refusedRequest = () =>
        request
          .post("/api/terminals")
          .set("X-Terminal-Operation", JSON.stringify(refusedOperation))
          .send({ cwd: "/fixture" })
          .expect(409);
      const refusal = await refusedRequest();
      expect(refusal.headers["x-terminal-outcome"]).toBe("rejected");
      expect((await refusedRequest()).body).toEqual(refusal.body);
      expect(create).toHaveBeenCalledTimes(2);
      create.mockRejectedValueOnce(
        new TerminalServiceError(
          "terminal_stop_timeout",
          503,
          "Exit unconfirmed",
        ),
      );
      const uncertain = await request
        .post("/api/terminals")
        .set(
          "X-Terminal-Operation",
          JSON.stringify({ ...operation, id: randomUUID() }),
        )
        .send({ cwd: "/fixture" })
        .expect(503);
      expect(uncertain.headers["x-terminal-outcome"]).toBe("unknown");
    } finally {
      await close();
    }
  });
});

describe("bounded terminal receipts", () => {
  it("snapshots results and tombstones byte-budget evictions without replaying work", async () => {
    const receipts = new TerminalOperationReceipts();
    const first = { id: randomUUID(), epoch: receipts.getEpoch() };
    const source = { id: "original", payload: "x".repeat(255 * 1024) };
    const execute = vi.fn(async () => source);
    await receipts.run(first, "create", {}, execute);
    source.id = "changed";
    expect(await receipts.run(first, "create", {}, execute)).toMatchObject({
      id: "original",
    });
    for (let index = 0; index < 66; index++)
      await receipts.run(
        { ...first, id: randomUUID() },
        "create",
        {},
        async () => source,
      );
    await expect(
      receipts.run(first, "create", {}, execute),
    ).rejects.toMatchObject({ code: "terminal_operation_expired" });
    expect(execute).toHaveBeenCalledOnce();
  });

  it("tombstones expired results, then fences forgotten identities", async () => {
    let now = 0;
    const receipts = new TerminalOperationReceipts({
      now: () => now,
      resultTtlMs: 10,
      tombstoneTtlMs: 20,
    });
    const operation = { id: randomUUID(), epoch: receipts.getEpoch() };
    const execute = vi.fn(async () => ({ id: "one" }));
    await receipts.run(operation, "create", { a: 1, b: 2 }, execute);
    expect(
      await receipts.run(operation, "create", { b: 2, a: 1 }, execute),
    ).toEqual({ id: "one" });
    now = 10;
    await expect(
      receipts.run(operation, "create", { a: 1, b: 2 }, execute),
    ).rejects.toMatchObject({ code: "terminal_operation_expired" });
    now = 20;
    await expect(
      receipts.run(operation, "create", { a: 1, b: 2 }, execute),
    ).rejects.toMatchObject({ code: "terminal_operation_epoch_changed" });
    expect(execute).toHaveBeenCalledOnce();
  });

  it("capacity reclamation fences old IDs and never evicts in-flight work", async () => {
    const receipts = new TerminalOperationReceipts({ limit: 1 });
    const operation = { id: randomUUID(), epoch: receipts.getEpoch() };
    const gate = deferred<unknown>();
    const execute = vi.fn(() => gate.promise);
    const first = receipts.run(operation, "restart", {}, execute);
    await expect(
      receipts.run({ ...operation, id: randomUUID() }, "restart", {}, execute),
    ).rejects.toMatchObject({ code: "terminal_operation_capacity" });
    const duplicate = receipts.run(operation, "restart", {}, execute);
    gate.resolve("done");
    expect(await first).toBe("done");
    expect(await duplicate).toBe("done");
    expect(execute).toHaveBeenCalledOnce();
  });
});
