import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import express from "express";
import supertest from "supertest";
import { createTerminalGateway } from "../../server/terminal-gateway.js";
import { TerminalDaemonClient } from "../../server/terminal-daemon-client.js";
import { TerminalDaemonServer } from "../../server/terminal-daemon-server.js";
import { TerminalOperationReceipts } from "../../server/terminal-operation-receipts.js";
import {
  TerminalServiceError,
  UnavailableTerminalService,
} from "../../server/terminal-service.js";
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
  const service = new UnavailableTerminalService("synthetic service");
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

describe("terminal control receipts over isolated IPC", () => {
  it.each(["create", "restart"] as const)(
    "retains %s committed before a lost response, including concurrent retry and Host replacement",
    async (method) => {
      const f = await fixture();
      const committed = deferred<void>();
      const reply = deferred<TerminalDescriptor>();
      const result = {
        id: "synthetic-terminal",
        catalogEpoch: "catalog",
        catalogRevision: 1,
      } as TerminalDescriptor;
      const mutation = vi
        .spyOn(f.service, method)
        .mockImplementation(async () => {
          committed.resolve();
          return reply.promise;
        });
      const operation = {
        id: randomUUID(),
        epoch: await f.client.operationEpoch(),
      };
      const params =
        method === "create"
          ? { request: { cwd: "/synthetic" } }
          : { id: result.id };
      try {
        vi.useFakeTimers();
        const first = f.client
          .operate(method, params, operation)
          .catch((error: unknown) => error);
        await committed.promise;
        await vi.advanceTimersByTimeAsync(method === "create" ? 5_001 : 15_001);
        expect(await first).toMatchObject({ code: "terminal_daemon_timeout" });
        vi.useRealTimers();
        // Neither closing the old Host connection nor two simultaneous delivery
        // attempts may dispatch the daemon mutation again.
        await f.client.close();
        const replacement = new TerminalDaemonClient(
          f.address,
          "synthetic-secret",
        );
        const second = replacement.operate(method, params, operation);
        const concurrent = replacement.operate(method, params, operation);
        reply.resolve(result);
        expect(await second).toEqual(result);
        expect(await concurrent).toEqual(result);
        expect(await replacement.operate(method, params, operation)).toEqual(
          result,
        );
        expect(mutation).toHaveBeenCalledOnce();
        await replacement.close();
      } finally {
        reply.resolve(result);
        await f.close();
      }
    },
  );

  it("rejects mismatched method/params and fails closed after daemon replacement", async () => {
    const f = await fixture();
    const create = vi
      .spyOn(f.service, "create")
      .mockResolvedValue({ id: "created" } as TerminalDescriptor);
    const operation = {
      id: randomUUID(),
      epoch: await f.client.operationEpoch(),
    };
    try {
      await f.client.operate(
        "create",
        { request: { cwd: "/synthetic" } },
        operation,
      );
      await expect(
        f.client.operate("create", { request: { cwd: "/other" } }, operation),
      ).rejects.toMatchObject({ code: "terminal_operation_mismatch" });
      await expect(
        f.client.operate("restart", { id: "created" }, operation),
      ).rejects.toMatchObject({ code: "terminal_operation_mismatch" });
      await f.server.stop();
      const replacement = new TerminalDaemonServer(
        f.address,
        "synthetic-secret",
        f.service,
      );
      await replacement.start();
      try {
        await expect(
          f.client.operate(
            "create",
            { request: { cwd: "/synthetic" } },
            operation,
          ),
        ).rejects.toMatchObject({ code: "terminal_operation_epoch_changed" });
        expect(create).toHaveBeenCalledOnce();
      } finally {
        await replacement.stop();
      }
    } finally {
      await f.close();
    }
  });

  it("replays a definitive refusal but admits a later explicit new identity", async () => {
    const f = await fixture();
    const create = vi
      .spyOn(f.service, "create")
      .mockRejectedValueOnce(
        new TerminalServiceError("terminal_limit", 409, "Synthetic refusal"),
      )
      .mockResolvedValue({ id: "later" } as TerminalDescriptor);
    const operation = {
      id: randomUUID(),
      epoch: await f.client.operationEpoch(),
    };
    try {
      for (let i = 0; i < 2; i++)
        await expect(
          f.client.operate(
            "create",
            { request: { cwd: "/synthetic" } },
            operation,
          ),
        ).rejects.toMatchObject({ code: "terminal_limit" });
      expect(create).toHaveBeenCalledOnce();
      expect(
        await f.client.operate(
          "create",
          { request: { cwd: "/synthetic" } },
          { ...operation, id: randomUUID() },
        ),
      ).toEqual({ id: "later" });
      expect(create).toHaveBeenCalledTimes(2);
    } finally {
      await f.close();
    }
  });
});

describe("terminal HTTP operation forwarding", () => {
  it("forwards immutable identity through Host requests and marks authoritative outcomes", async () => {
    const f = await fixture();
    const create = vi
      .spyOn(f.service, "create")
      .mockResolvedValue({ id: "one" } as TerminalDescriptor);
    const app = express();
    app.use(express.json());
    const gateway = createTerminalGateway(app, f.client, 60_000);
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
    try {
      const epoch = await supertest(app)
        .get("/api/terminal-operations")
        .expect(200);
      const operation = { id: randomUUID(), epoch: epoch.body.epoch as string };
      const invalid = await supertest(app)
        .post("/api/terminals")
        .set(
          "X-Terminal-Operation",
          JSON.stringify({ ...operation, id: randomUUID() }),
        )
        .send({})
        .expect(400);
      expect(invalid.headers["x-terminal-outcome"]).toBe("rejected");
      expect(create).not.toHaveBeenCalled();
      for (let i = 0; i < 2; i++) {
        const response = await supertest(app)
          .post("/api/terminals")
          .set("X-Terminal-Operation", JSON.stringify(operation))
          .send({ cwd: "/fixture" })
          .expect(201);
        expect(response.headers["x-terminal-operation"]).toBe(operation.id);
        expect(response.headers["x-terminal-outcome"]).toBe("completed");
        expect(response.body).toEqual({ id: "one" });
      }
      const mismatch = await supertest(app)
        .post("/api/terminals")
        .set("X-Terminal-Operation", JSON.stringify(operation))
        .send({ cwd: "/other" })
        .expect(409);
      expect(mismatch.headers["x-terminal-outcome"]).toBe("unknown");
      expect(create).toHaveBeenCalledOnce();
      create.mockRejectedValueOnce(
        new TerminalServiceError("terminal_limit", 409, "Synthetic refusal"),
      );
      const refusal = await supertest(app)
        .post("/api/terminals")
        .set(
          "X-Terminal-Operation",
          JSON.stringify({ ...operation, id: randomUUID() }),
        )
        .send({ cwd: "/fixture" })
        .expect(409);
      expect(refusal.headers["x-terminal-outcome"]).toBe("rejected");
      create.mockRejectedValueOnce(
        new TerminalServiceError(
          "terminal_stop_timeout",
          503,
          "Exit unconfirmed",
        ),
      );
      const uncertain = await supertest(app)
        .post("/api/terminals")
        .set(
          "X-Terminal-Operation",
          JSON.stringify({ ...operation, id: randomUUID() }),
        )
        .send({ cwd: "/fixture" })
        .expect(503);
      expect(uncertain.headers["x-terminal-outcome"]).toBe("unknown");
    } finally {
      gateway.close();
      await f.close();
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
