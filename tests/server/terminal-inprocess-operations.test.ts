import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import supertest from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createTerminalGateway } from "../../server/terminal-gateway.js";
import type { TerminalService } from "../../server/terminal-service.js";
import {
  type TerminalHistoryBackend,
  TerminalSessionManager,
} from "../../server/terminal-session-manager.js";
import type {
  TerminalCatalogResponse,
  TerminalDescriptor,
  TerminalMutationMethod,
} from "../../shared/terminal-contracts.js";

import { FakePty } from "./fixtures/terminal-pty.js";

class SyntheticPty extends FakePty {
  autoExit = true;
  kill = vi.fn((signal?: string) => {
    if (this.autoExit) super.kill(signal);
  });
  exit() {
    this.emitExit(0);
  }
}

function httpFixture(service: TerminalService) {
  const app = express();
  app.use(express.json());
  const gateway = createTerminalGateway(app, service, 60_000);
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
  return { gateway, transport };
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
});

describe("terminal HTTP mutation admission", () => {
  it.each([
    ["POST", "/api/terminals", { cwd: "/synthetic" }],
    ["PATCH", "/api/terminals/tab", { title: "Title" }],
    ["POST", "/api/terminals/reorder", { cwd: "/synthetic", terminalIds: [] }],
    ["POST", "/api/terminals/tab/restart", undefined],
    ["DELETE", "/api/terminals/tab", undefined],
    ["PATCH", "/api/terminal-settings", { persistOutput: true }],
    ["DELETE", "/api/terminal-history", undefined],
  ])("requires an identity for %s %s", async (method, path, body) => {
    const f = await fixture();
    try {
      const dispatch = vi.spyOn(f.manager, "operate");
      const response = await f.transport(String(path), {
        method: String(method),
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        code: "terminal_operation_required",
      });
      expect(dispatch).not.toHaveBeenCalled();
      expect(f.ptys).toHaveLength(0);
    } finally {
      await f.close();
    }
  });

  it.each([
    ["POST", "/api/terminals", {}],
    ["PATCH", "/api/terminals/tab", { title: 42 }],
    [
      "POST",
      "/api/terminals/reorder",
      { cwd: "/synthetic", terminalIds: ["bad/id"] },
    ],
    ["POST", "/api/terminals/bad%20id/restart", undefined],
    ["DELETE", "/api/terminals/bad%20id", undefined],
    ["PATCH", "/api/terminal-settings", { historyRetentionDays: 0 }],
  ])(
    "receipts validation refusals before dispatch for %s %s",
    async (method, path, body) => {
      const f = await fixture();
      try {
        const dispatch = vi.spyOn(f.manager, "operate");
        const operation = {
          id: randomUUID(),
          epoch: await f.manager.operationEpoch(),
        };
        const response = await f.transport(String(path), {
          method: String(method),
          body: JSON.stringify(body),
          headers: {
            "Content-Type": "application/json",
            "X-Terminal-Operation": JSON.stringify(operation),
          },
        });
        expect(response.status).toBe(400);
        expect(response.headers.get("X-Terminal-Operation")).toBe(operation.id);
        expect(response.headers.get("X-Terminal-Outcome")).toBe("rejected");
        expect(dispatch).not.toHaveBeenCalled();
      } finally {
        await f.close();
      }
    },
  );
});
