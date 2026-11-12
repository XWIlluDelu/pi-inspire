// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalOperationController } from "../../src/controllers/terminal-operation-controller";
import { deferred } from "./helpers";

function operationIdentity(init?: RequestInit): { id: string; epoch: string } {
  return JSON.parse(new Headers(init?.headers).get("X-Terminal-Operation")!);
}

function mutationTransport(handle: typeof fetch, epoch = "epoch-1") {
  return vi.fn<typeof fetch>(async (path, init) =>
    path === "/api/terminal-operations"
      ? Response.json({ epoch })
      : handle(path, init),
  );
}

function reply(
  init: RequestInit | undefined,
  body: unknown = { id: "created" },
  outcome = "completed",
  status = 200,
) {
  const identity = operationIdentity(init);
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "X-Terminal-Operation": identity.id,
      "X-Terminal-Outcome": outcome,
    },
  });
}

beforeEach(() => sessionStorage.clear());

const STORAGE_KEY = "inspire:terminal-operations:v1";
const savedIntent = {
  path: "/api/terminals",
  method: "POST",
  body: '{"cwd":"/fixture"}' as string | undefined,
  identity: { id: "saved-id", epoch: "epoch-1" },
};
function saved(patch: Partial<typeof savedIntent> = {}) {
  const entry = { ...savedIntent, ...patch };
  return {
    ...entry,
    key: JSON.stringify([entry.path, entry.method, entry.body ?? null]),
  };
}

describe("browser terminal operation identity", () => {
  it("joins concurrent same-content deliveries regardless of object key order", async () => {
    const gate = deferred<Response>();
    let sent: RequestInit | undefined;
    const transport = mutationTransport(async (_path, init) => {
      sent = init;
      return gate.promise;
    });
    const controller = new TerminalOperationController(transport);
    const first = controller.run("/api/terminals", "POST", {
      cwd: "/fixture",
      profileId: "bash",
    });
    const second = controller.run("/api/terminals", "POST", {
      profileId: "bash",
      cwd: "/fixture",
    });
    await vi.waitFor(() => expect(sent).toBeDefined());
    gate.resolve(reply(sent));
    expect(await Promise.all([first, second])).toEqual([
      { id: "created" },
      { id: "created" },
    ]);
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it("retries the same bodyless close after reload until the user retires the expired identity", async () => {
    const path = "/api/terminals/id?force=1";
    const deliveries: Array<{
      path: string;
      method?: string;
      body?: BodyInit | null;
      identity: ReturnType<typeof operationIdentity>;
    }> = [];
    const handle: typeof fetch = async (url, init) => {
      const identity = operationIdentity(init);
      deliveries.push({
        path: String(url),
        method: init?.method,
        body: init?.body,
        identity,
      });
      if (deliveries.length === 1)
        return Response.json(
          { error: "Proxy refused the request" },
          { status: 409 },
        );
      if (identity.epoch === "old-epoch")
        return reply(init, { error: "Receipt expired" }, "unknown", 409);
      return new Response(null, {
        status: 204,
        headers: {
          "X-Terminal-Operation": identity.id,
          "X-Terminal-Outcome": "completed",
        },
      });
    };
    const original = new TerminalOperationController(
      mutationTransport(handle, "old-epoch"),
    );
    await expect(original.run(path, "DELETE")).rejects.toThrow(
      "outcome is unknown",
    );

    const reloaded = new TerminalOperationController(
      mutationTransport(handle, "new-epoch"),
    );
    reloaded.restore();
    const [intent] = reloaded.snapshot();
    expect(intent).toMatchObject({ outcome: "unknown", busy: false });
    await expect(reloaded.retry(intent!.key)).rejects.toThrow(
      "Receipt expired",
    );
    await expect(reloaded.run(path, "DELETE")).rejects.toThrow(
      "Receipt expired",
    );
    const [first] = deliveries;
    expect(first).toMatchObject({
      path,
      method: "DELETE",
      body: undefined,
      identity: { epoch: "old-epoch" },
    });
    expect(deliveries).toEqual([first, first, first]);

    reloaded.stopTracking(intent!.key);
    expect(deliveries).toHaveLength(3);
    expect(reloaded.snapshot()).toEqual([]);
    const fresh = new TerminalOperationController(
      mutationTransport(handle, "new-epoch"),
    );
    await expect(fresh.run(path, "DELETE")).resolves.toBeUndefined();
    expect(deliveries[3]).toMatchObject({
      path,
      method: "DELETE",
      body: undefined,
      identity: { epoch: "new-epoch" },
    });
    expect(deliveries[3]!.identity.id).not.toBe(first!.identity.id);
    expect(fresh.snapshot()).toEqual([]);
    expect(sessionStorage.getItem(STORAGE_KEY)).toBe("[]");
  });

  it("blocks unsaved controls and retains a saved intent until its check settles", async () => {
    let storageUnavailable = true;
    const storage = {
      getItem: (key: string) => sessionStorage.getItem(key),
      setItem: (key: string, value: string) => {
        if (storageUnavailable) throw new Error("Storage unavailable");
        sessionStorage.setItem(key, value);
      },
    } as Storage;
    const gate = deferred<void>();
    const dispatch = vi.fn<typeof fetch>(async (_path, init) => {
      await gate.promise;
      return reply(init);
    });
    const transport = mutationTransport(dispatch);
    const controller = new TerminalOperationController(
      transport,
      () => storage,
    );
    await expect(controller.run("/api/terminals", "POST", {})).rejects.toThrow(
      "Storage unavailable",
    );
    expect(dispatch).not.toHaveBeenCalled();

    const entry = saved();
    const raw = JSON.stringify([entry]);
    sessionStorage.setItem(STORAGE_KEY, raw);
    const reloaded = new TerminalOperationController(transport, () => storage);
    expect(() => reloaded.stopTracking(entry.key)).toThrow(
      "Storage unavailable",
    );
    expect(reloaded.snapshot()).toHaveLength(1);
    expect(sessionStorage.getItem(STORAGE_KEY)).toBe(raw);
    expect(dispatch).not.toHaveBeenCalled();

    storageUnavailable = false;
    const check = reloaded.retry(entry.key);
    expect(() => reloaded.stopTracking(entry.key)).toThrow("Wait for");
    gate.resolve();
    await check;
    expect(reloaded.snapshot()).toEqual([]);
  });

  it("releases definitive refusal for a later new intent, but not malformed success", async () => {
    const identities: unknown[] = [];
    const transport = mutationTransport(async (_path, init) => {
      identities.push(operationIdentity(init));
      if (identities.length === 1)
        return reply(init, { error: "Limit" }, "rejected", 409);
      if (identities.length === 2)
        return new Response("broken JSON", { status: 200 });
      return reply(init);
    });
    const controller = new TerminalOperationController(transport);
    await expect(controller.run("/api/terminals", "POST", {})).rejects.toThrow(
      "Limit",
    );
    expect(controller.snapshot()).toEqual([]);
    await expect(controller.run("/api/terminals", "POST", {})).rejects.toThrow(
      "outcome is unknown",
    );
    await controller.run("/api/terminals", "POST", {});
    expect(identities[0]).not.toEqual(identities[1]);
    expect(identities[1]).toEqual(identities[2]);
  });

  it.each(["completed", "rejected"])(
    "keeps the %s result when local receipt cleanup fails",
    async (outcome) => {
      const identities: string[] = [];
      const transport = mutationTransport(async (_path, init) => {
        identities.push(
          (init?.headers as Record<string, string>)["X-Terminal-Operation"]!,
        );
        return reply(
          init,
          outcome === "completed"
            ? { id: "created" }
            : { error: "Definite refusal" },
          outcome,
          outcome === "completed" ? 200 : 409,
        );
      });
      let storageFailure = true;
      const storage = {
        getItem: (key: string) => sessionStorage.getItem(key),
        setItem: (key: string, value: string) => {
          if (value === "[]" && storageFailure)
            throw new Error("Synthetic retirement failure");
          sessionStorage.setItem(key, value);
        },
      } as Storage;
      const controller = new TerminalOperationController(
        transport,
        () => storage,
      );
      const result = controller.run("/api/terminals", "POST", {});
      if (outcome === "completed")
        await expect(result).resolves.toEqual({ id: "created" });
      else await expect(result).rejects.toThrow("Definite refusal");
      expect(controller.snapshot()).toMatchObject([{ outcome }]);
      const key = controller.snapshot()[0]!.key;
      await expect(controller.retry(key)).rejects.toThrow(
        "Synthetic retirement failure",
      );
      expect(identities).toHaveLength(1);
      storageFailure = false;
      await controller.retry(key);
      expect(identities).toHaveLength(1);
      expect(controller.snapshot()).toEqual([]);
    },
  );
});

describe("terminal operation recovery", () => {
  it("quarantines the entire invalid set without dispatching or erasing uncertain intents", async () => {
    const prior = saved();
    const raw = JSON.stringify([prior, { ...saved(), identity: null }]);
    sessionStorage.setItem(STORAGE_KEY, raw);
    const transport = vi.fn<typeof fetch>();
    const controller = new TerminalOperationController(transport);

    expect(() => controller.restore()).toThrow("storage is invalid");
    expect(controller.snapshot()).toEqual([]);
    await expect(controller.retry(prior.key)).rejects.toThrow(
      "storage is invalid",
    );
    await expect(
      controller.run("/api/terminals", "POST", { cwd: "/new-intent" }),
    ).rejects.toThrow("storage is invalid");
    expect(transport).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(STORAGE_KEY)).toBe(raw);
  });

  it("retains the full supported request at the unresolved identity limit", () => {
    const cwd = `/${"p".repeat(4095)}`;
    const reorder = saved({
      path: "/api/terminals/reorder",
      body: JSON.stringify({
        cwd,
        terminalIds: Array.from({ length: 32 }, (_, index) =>
          String(index).padEnd(80, "a"),
        ),
      }),
      identity: { id: "i".repeat(80), epoch: "e".repeat(80) },
    });
    const entries = [
      reorder,
      ...Array.from({ length: 128 }, (_, index) =>
        saved({
          path: `/api/terminals/id-${index}/restart`,
          body: undefined,
          identity: { id: `operation-${index}`, epoch: "epoch-1" },
        }),
      ),
    ];
    const transport = vi.fn<typeof fetch>();
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(0, 128)));
    const controller = new TerminalOperationController(transport);
    controller.restore();
    expect(controller.snapshot()).toHaveLength(128);
    expect(controller.snapshot()[0]).toMatchObject({
      key: reorder.key,
      label: `Reorder terminals · ${cwd}`,
      outcome: "unknown",
    });

    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
    expect(() => new TerminalOperationController(transport).restore()).toThrow(
      "storage is invalid",
    );
    expect(transport).not.toHaveBeenCalled();
  });
});
describe("stored terminal request validation", () => {
  it.each([
    [
      "non-receipted attach ticket",
      () => saved({ path: "/api/terminals/id/attach-ticket" }),
    ],
    [
      "encoded terminal id",
      () => saved({ path: "/api/terminals/%69d/restart" }),
    ],
    [
      "unsupported force query",
      () => saved({ path: "/api/terminals/id?force=2", method: "DELETE" }),
    ],
    ["invalid JSON body", () => saved({ body: "{" })],
    [
      "oversized body",
      () => saved({ body: JSON.stringify({ cwd: "x".repeat(32 * 1024) }) }),
    ],
    [
      "invalid id characters",
      () => saved({ identity: { id: "saved/id", epoch: "epoch-1" } }),
    ],
    [
      "oversized id",
      () => saved({ identity: { id: "a".repeat(81), epoch: "epoch-1" } }),
    ],
  ] satisfies Array<[string, () => unknown]>)(
    "rejects %s",
    (_label, corrupt) => {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify([corrupt()]));
      const controller = new TerminalOperationController(vi.fn<typeof fetch>());
      expect(() => controller.restore()).toThrow("storage is invalid");
    },
  );

  it.each([
    ["path", { path: "/api/terminals/other" }],
    ["method", { method: "DELETE" }],
    ["body", { body: '{"title":"After"}' }],
  ] as const)(
    "rejects a request whose %s no longer agrees with its saved key",
    (_field, patch) => {
      const entry = saved({
        path: "/api/terminals/id",
        method: "PATCH",
        body: '{"title":"Before"}',
      });
      sessionStorage.setItem(
        STORAGE_KEY,
        JSON.stringify([{ ...entry, ...patch }]),
      );
      const controller = new TerminalOperationController(vi.fn<typeof fetch>());
      expect(() => controller.restore()).toThrow("storage is invalid");
    },
  );

  it.each(["request key", "receipt identity"])(
    "rejects a duplicate %s without publishing a partial set",
    (duplicate) => {
      const second =
        duplicate === "request key"
          ? saved({ identity: { id: "other-id", epoch: "epoch-1" } })
          : saved({ body: '{"cwd":"/other"}' });
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify([saved(), second]));
      const controller = new TerminalOperationController(vi.fn<typeof fetch>());
      expect(() => controller.restore()).toThrow("storage is invalid");
      expect(controller.snapshot()).toEqual([]);
    },
  );

  it.each([
    ["unsupported mutation", "DELETE", undefined],
    ["oversized body", "POST", { cwd: "x".repeat(32 * 1024) }],
  ] as const)(
    "refuses fresh %s before persistence or epoch lookup",
    async (_label, method, body) => {
      const transport = vi.fn<typeof fetch>();
      const controller = new TerminalOperationController(transport);
      await expect(
        controller.run("/api/terminals", method, body),
      ).rejects.toThrow("operation is invalid");
      expect(controller.snapshot()).toEqual([]);
      expect(transport).not.toHaveBeenCalled();
      expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
    },
  );
});
