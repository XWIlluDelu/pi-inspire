import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import supertest from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createTerminalGateway } from "../../server/terminal-gateway.js";
import {
  type TerminalService,
  UnavailableTerminalService,
} from "../../server/terminal-service.js";
import {
  type TerminalHistoryBackend,
  type TerminalPty,
  TerminalSessionManager,
} from "../../server/terminal-session-manager.js";
import type {
  TerminalCatalogResponse,
  TerminalDescriptor,
  TerminalMutationMethod,
  TerminalOperationIdentity,
} from "../../shared/terminal-contracts.js";

class SyntheticPty implements TerminalPty {
  readonly pid = 1234;
  readonly process = "synthetic-shell";
  autoExit = true;
  private readonly exits = new Set<(event: { exitCode: number }) => void>();
  onData() {
    return { dispose() {} };
  }
  onExit(listener: (event: { exitCode: number }) => void) {
    this.exits.add(listener);
    return { dispose: () => this.exits.delete(listener) };
  }
  resize() {}
  write() {}
  kill = vi.fn((_signal?: string) => {
    if (this.autoExit) this.exit();
  });
  exit() {
    for (const listener of this.exits) listener({ exitCode: 0 });
  }
}

function httpFixture(service: TerminalService) {
  const app = express();
  app.use(express.json());
  const gateway = createTerminalGateway(app, service, 60_000);
  app.use(
    (
      error: { status?: number; code?: string; message?: string },
      _request: express.Request,
      response: express.Response,
      _next: express.NextFunction,
    ) => {
      response
        .status(error.status ?? 500)
        .json({ error: error.message, code: error.code });
    },
  );
  // Exercise the browser's identified HTTP protocol without launching a Host,
  // browser, shell or daemon. Supertest owns only ephemeral test sockets.
  const transport = vi.fn<typeof fetch>(async (path, init) => {
    const method = (init?.method ?? "GET").toLowerCase() as
      | "get"
      | "post"
      | "patch"
      | "delete";
    const request = supertest(app)[method](String(path));
    new Headers(init?.headers).forEach((value, name) => {
      request.set(name, value);
    });
    if (typeof init?.body === "string") request.send(init.body);
    const response = await request;
    return new Response(
      response.status === 204 ? null : JSON.stringify(response.body),
      { status: response.status, headers: response.headers },
    );
  });
  return { app, gateway, transport };
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "terminal-inprocess-"));
  const ptys: SyntheticPty[] = [];
  const onChange = vi.fn();
  const history = {
    read: vi.fn(async () => null),
    append: vi.fn(),
    remove: vi.fn(async () => {}),
    clear: vi.fn(async () => {}),
    prune: vi.fn(async () => {}),
    flush: vi.fn(async () => {}),
  } satisfies TerminalHistoryBackend;
  const manager = new TerminalSessionManager({
    profiles: [
      {
        id: "synthetic",
        label: "Synthetic shell",
        shell: "synthetic-shell",
        args: [],
        available: true,
        isDefault: true,
      },
    ],
    env: {},
    ptyFactory: () => {
      const pty = new SyntheticPty();
      ptys.push(pty);
      return pty;
    },
    onChange,
    history,
  });
  const http = httpFixture(manager);
  return {
    ...http,
    directory,
    manager,
    ptys,
    onChange,
    history,
    async close() {
      vi.useRealTimers();
      http.gateway.close();
      for (const pty of ptys) pty.exit();
      await manager.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

describe("in-process terminal receipt owner", () => {
  it.each(["create", "restart"] as const)(
    "recovers identified HTTP %s committed before response loss without another PTY",
    async (method) => {
      const f = await fixture();
      try {
        const original =
          method === "restart"
            ? await f.manager.create({ cwd: f.directory })
            : undefined;
        const path = original
          ? `/api/terminals/${original.id}/restart`
          : "/api/terminals";
        const body = original ? undefined : { cwd: f.directory };
        const mutation = vi.spyOn(f.manager, method);
        const epochResponse = await f.transport("/api/terminal-operations");
        expect(epochResponse.status).toBe(200);
        const { epoch } = (await epochResponse.json()) as { epoch: string };
        const operation = { id: randomUUID(), epoch };
        const init = {
          method: "POST",
          body: JSON.stringify(body),
          headers: {
            "Content-Type": "application/json",
            "X-Terminal-Operation": JSON.stringify(operation),
          },
        };
        const lossy = async () => {
          const response = await f.transport(path, init);
          expect(response.status).toBe(method === "create" ? 201 : 200);
          throw new Error("Synthetic lost response after commit");
        };
        await expect(lossy()).rejects.toThrow("Synthetic lost response");
        const committed = f.manager.list().terminals[0]!;
        if (original)
          expect(committed.outputEpoch).not.toBe(original.outputEpoch);
        // A replacement gateway still reaches the same receipt owner. Separate
        // HTTP deliveries with the retained identity cannot repeat the mutation.
        const replacement = httpFixture(f.manager);
        try {
          const responses = await Promise.all([
            replacement.transport(path, init),
            replacement.transport(path, init),
          ]);
          for (const response of responses) {
            expect(response.headers.get("X-Terminal-Outcome")).toBe(
              "completed",
            );
            expect(response.headers.get("X-Terminal-Operation")).toBe(
              operation.id,
            );
            expect(await response.json()).toEqual(committed);
          }
        } finally {
          replacement.gateway.close();
        }
        expect(mutation).toHaveBeenCalledOnce();
        expect(f.ptys).toHaveLength(method === "create" ? 1 : 2);
        expect(
          f.transport.mock.calls.filter(
            ([url]) => url === "/api/terminal-operations",
          ),
        ).toHaveLength(1);
      } finally {
        await f.close();
      }
    },
  );

  it("joins real in-flight creation and restart while rejecting identity collisions", async () => {
    const f = await fixture();
    try {
      const operation = {
        id: randomUUID(),
        epoch: await f.manager.operationEpoch(),
      };
      const params = { request: { cwd: f.directory, cols: 90 } };
      const first = f.manager.operate<TerminalDescriptor>(
        "create",
        params,
        operation,
      );
      expect(
        f.manager.operate(
          "create",
          { request: { cols: 90, cwd: f.directory } },
          operation,
        ),
      ).toBe(first);
      const terminal = await first;
      expect(f.ptys).toHaveLength(1);
      expect(f.onChange).toHaveBeenCalledOnce();
      await expect(
        f.manager.operate(
          "create",
          { request: { cwd: f.directory, cols: 100 } },
          operation,
        ),
      ).rejects.toMatchObject({ code: "terminal_operation_mismatch" });
      await expect(
        f.manager.operate("restart", { id: terminal.id }, operation),
      ).rejects.toMatchObject({ code: "terminal_operation_mismatch" });
      const restart = { ...operation, id: randomUUID() };
      f.ptys[0]!.autoExit = false;
      const restarting = f.manager.operate<TerminalDescriptor>(
        "restart",
        { id: terminal.id },
        restart,
      );
      expect(f.manager.operate("restart", { id: terminal.id }, restart)).toBe(
        restarting,
      );
      await vi.waitFor(() => expect(f.ptys[0]!.kill).toHaveBeenCalledOnce());
      expect(f.ptys).toHaveLength(1);
      f.ptys[0]!.exit();
      const result = await restarting;
      expect(result.outputEpoch).not.toBe(terminal.outputEpoch);
      expect(f.ptys).toHaveLength(2);
      // Direct compatibility calls remain ordinary new intents/callbacks, and
      // later metadata changes do not mutate the original receipt snapshot.
      await f.manager.rename(terminal.id, { title: "Later direct title" });
      expect(await f.manager.operate("create", params, operation)).toEqual(
        terminal,
      );
      expect(await f.manager.operationEpoch()).toBe(operation.epoch);
    } finally {
      await f.close();
    }
  });

  it("dispatches every identified HTTP mutation exactly once and preserves callbacks", async () => {
    const f = await fixture();
    try {
      const epoch = await f.manager.operationEpoch();
      const mutate = async <Result>(
        mutation: TerminalMutationMethod,
        path: string,
        method: string,
        body?: unknown,
      ): Promise<Result> => {
        const operation = { id: randomUUID(), epoch };
        const dispatch = vi.spyOn(f.manager, mutation);
        const init = {
          method,
          body: JSON.stringify(body),
          headers: {
            "Content-Type": "application/json",
            "X-Terminal-Operation": JSON.stringify(operation),
          },
        };
        const first = await f.transport(path, init);
        expect(first.ok).toBe(true);
        expect(first.headers.get("X-Terminal-Outcome")).toBe("completed");
        expect(first.headers.get("X-Terminal-Operation")).toBe(operation.id);
        const result = first.status === 204 ? undefined : await first.json();
        const changes = f.onChange.mock.calls.length;
        const second = await f.transport(path, init);
        expect(second.status).toBe(first.status);
        expect(second.status === 204 ? undefined : await second.json()).toEqual(
          result,
        );
        expect(dispatch).toHaveBeenCalledOnce();
        expect(f.onChange).toHaveBeenCalledTimes(changes);
        dispatch.mockRestore();
        return result as Result;
      };
      const first = await mutate<TerminalDescriptor>(
        "create",
        "/api/terminals",
        "POST",
        { cwd: f.directory },
      );
      const second = await f.manager.create({ cwd: f.directory });
      expect(f.ptys).toHaveLength(2);
      expect(
        await mutate("rename", `/api/terminals/${first.id}`, "PATCH", {
          title: "Receipt title",
        }),
      ).toMatchObject({ title: "Receipt title", titleSource: "user" });
      const reordered = await mutate<TerminalCatalogResponse>(
        "reorder",
        "/api/terminals/reorder",
        "POST",
        { cwd: f.directory, terminalIds: [second.id, first.id] },
      );
      expect(reordered.terminals.map(({ id }) => id)).toEqual([
        second.id,
        first.id,
      ]);
      const restarted = await mutate<TerminalDescriptor>(
        "restart",
        `/api/terminals/${first.id}/restart`,
        "POST",
      );
      expect(restarted.outputEpoch).not.toBe(first.outputEpoch);
      expect(f.ptys).toHaveLength(3);
      expect(
        await mutate("updateSettings", "/api/terminal-settings", "PATCH", {
          persistOutput: true,
          historyRetentionDays: 14,
        }),
      ).toEqual({ persistOutput: true, historyRetentionDays: 14 });
      expect(f.history.prune).toHaveBeenCalledExactlyOnceWith(14);
      await mutate("clearHistory", "/api/terminal-history", "DELETE");
      expect(f.history.clear).toHaveBeenCalledOnce();
      await mutate("remove", `/api/terminals/${first.id}`, "DELETE");
      await mutate("remove", `/api/terminals/${second.id}?force=1`, "DELETE");
      expect(f.ptys[1]!.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
      expect(f.manager.list().terminals).toEqual([]);
      expect(f.history.remove).toHaveBeenCalledTimes(3);
    } finally {
      await f.close();
    }
  });

  it("retains a definite service refusal even after its cause is repaired", async () => {
    const f = await fixture();
    try {
      const params = { request: { cwd: join(f.directory, "later") } };
      const operation = {
        id: randomUUID(),
        epoch: await f.manager.operationEpoch(),
      };
      const create = vi.spyOn(f.manager, "create");
      await expect(
        f.manager.operate("create", params, operation),
      ).rejects.toMatchObject({ code: "invalid_cwd", status: 400 });
      await mkdir(params.request.cwd);
      await expect(
        f.manager.operate("create", params, operation),
      ).rejects.toMatchObject({ code: "invalid_cwd", status: 400 });
      expect(create).toHaveBeenCalledOnce();
      expect(f.ptys).toHaveLength(0);
      await f.manager.operate("create", params, {
        ...operation,
        id: randomUUID(),
      });
      expect(create).toHaveBeenCalledTimes(2);
      expect(f.ptys).toHaveLength(1);
    } finally {
      await f.close();
    }
  });

  it("retains an unconfirmed restart failure rather than retrying after late exit", async () => {
    const f = await fixture();
    try {
      const terminal = await f.manager.create({ cwd: f.directory });
      const operation = {
        id: randomUUID(),
        epoch: await f.manager.operationEpoch(),
      };
      f.ptys[0]!.autoExit = false;
      const restart = vi.spyOn(f.manager, "restart");
      vi.useFakeTimers();
      const result = f.manager.operate(
        "restart",
        { id: terminal.id },
        operation,
      );
      const rejection = expect(result).rejects.toMatchObject({
        code: "terminal_stop_timeout",
        status: 503,
      });
      await vi.advanceTimersByTimeAsync(7_000);
      await rejection;
      f.ptys[0]!.exit();
      await expect(
        f.manager.operate("restart", { id: terminal.id }, operation),
      ).rejects.toMatchObject({ code: "terminal_stop_timeout" });
      expect(restart).toHaveBeenCalledOnce();
      expect(f.ptys).toHaveLength(1);
      expect(f.manager.list().terminals).toHaveLength(1);
    } finally {
      await f.close();
    }
  });

  it("fences unknown identities on owner replacement and receipt expiry", async () => {
    const first = await fixture();
    const replacement = await fixture();
    try {
      const operation = {
        id: randomUUID(),
        epoch: await first.manager.operationEpoch(),
      };
      const params = { request: { cwd: first.directory } };
      await first.manager.operate("create", params, operation);
      expect(await replacement.manager.operationEpoch()).not.toBe(
        operation.epoch,
      );
      await expect(
        replacement.manager.operate("create", params, operation),
      ).rejects.toMatchObject({ code: "terminal_operation_epoch_changed" });
      expect(replacement.ptys).toHaveLength(0);
      vi.useFakeTimers();
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      await expect(
        first.manager.operate("create", params, operation),
      ).rejects.toMatchObject({ code: "terminal_operation_expired" });
      await vi.advanceTimersByTimeAsync(50 * 60_000);
      await expect(
        first.manager.operate("create", params, operation),
      ).rejects.toMatchObject({ code: "terminal_operation_epoch_changed" });
      expect(first.ptys).toHaveLength(1);
    } finally {
      await first.close();
      await replacement.close();
    }
  });

  it.each([undefined, { id: "bad/id", epoch: "epoch-1" }])(
    "refuses invalid operation identity %j before invoking the owner",
    async (identity) => {
      const f = await fixture();
      try {
        const create = vi.spyOn(f.manager, "create");
        await expect(
          f.manager.operate(
            "create",
            { request: { cwd: f.directory } },
            identity as unknown as TerminalOperationIdentity,
          ),
        ).rejects.toMatchObject({ code: "terminal_operation_required" });
        expect(create).not.toHaveBeenCalled();
        expect(f.ptys).toHaveLength(0);
      } finally {
        await f.close();
      }
    },
  );
});

describe("unsupported terminal receipt services", () => {
  it.each([{}, { operate: true, operationEpoch: "not-callable" }])(
    "never adds local receipts or falls back to arbitrary remote mutations (%j)",
    async (capability) => {
      const service = Object.assign(
        new UnavailableTerminalService("Synthetic remote service"),
        capability,
      );
      const create = vi
        .spyOn(service, "create")
        .mockResolvedValue({ id: "legacy" } as TerminalDescriptor);
      const f = httpFixture(service);
      try {
        await supertest(f.app).get("/api/terminal-operations").expect(503);
        await supertest(f.app)
          .post("/api/terminals")
          .set(
            "X-Terminal-Operation",
            JSON.stringify({ id: randomUUID(), epoch: randomUUID() }),
          )
          .send({ cwd: "/synthetic" })
          .expect(503);
        expect(create).not.toHaveBeenCalled();
        await supertest(f.app)
          .post("/api/terminals")
          .send({ cwd: "/synthetic" })
          .expect(201);
        expect(create).toHaveBeenCalledOnce();
      } finally {
        f.gateway.close();
      }
    },
  );
});
