// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalOperationController } from "../../src/controllers/terminal-operation-controller";
import { deferred } from "./helpers";

function reply(
  init: RequestInit | undefined,
  body: unknown = { id: "created" },
  outcome = "completed",
  status = 200,
) {
  const identity = JSON.parse(
    (init?.headers as Record<string, string>)["X-Terminal-Operation"]!,
  );
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
  it("keeps uncertainty visible while a same-operation check is pending", async () => {
    const gate = deferred<Response>();
    let sent: RequestInit | undefined;
    let attempts = 0;
    const transport = vi
      .fn<typeof fetch>()
      .mockImplementation(async (path, init) => {
        if (path === "/api/terminal-operations")
          return Response.json({ epoch: "epoch-1" });
        attempts += 1;
        sent = init;
        if (attempts === 1) throw new Error("Synthetic lost reply");
        return gate.promise;
      });
    const controller = new TerminalOperationController(transport);
    await expect(
      controller.run(null, "/api/terminals", "POST", { cwd: "/fixture" }),
    ).rejects.toThrow("outcome is unknown");
    const state = controller.snapshot()[0]!;
    expect(state).toMatchObject({
      label: "Create terminal · /fixture",
      uncertain: true,
      busy: false,
    });
    const result = controller.retry(null, state.key);
    expect(controller.snapshot()[0]).toMatchObject({
      uncertain: true,
      busy: true,
    });
    gate.resolve(reply(sent));
    await result;
    expect(controller.snapshot()).toEqual([]);
  });

  it.each(["POST", "DELETE"])(
    "retains %s unknown delivery across controller reload, and retries the same operation",
    async (method) => {
      const identities: unknown[] = [];
      const transport = vi
        .fn<typeof fetch>()
        .mockImplementation(async (path, init) => {
          if (path === "/api/terminal-operations")
            return Response.json({ epoch: "epoch-1" });
          identities.push(
            JSON.parse(
              (init?.headers as Record<string, string>)[
                "X-Terminal-Operation"
              ]!,
            ),
          );
          if (identities.length === 1)
            throw new Error("Synthetic lost response after commit");
          return reply(init);
        });
      const path =
        method === "POST" ? "/api/terminals" : "/api/terminals/terminal-1";
      const body = method === "POST" ? { cwd: "/fixture" } : undefined;
      const first = new TerminalOperationController(transport);
      await expect(first.run(null, path, method, body)).rejects.toThrow(
        "outcome is unknown",
      );
      expect(first.snapshot()).toHaveLength(1);
      const reloaded = new TerminalOperationController(transport);
      expect(await reloaded.run(null, path, method, body)).toEqual({
        id: "created",
      });
      expect(identities[0]).toEqual(identities[1]);
      expect(reloaded.snapshot()).toEqual([]);
      expect(transport).toHaveBeenCalledTimes(3); // no fresh epoch on retry
    },
  );

  it("joins concurrent same-content deliveries regardless of object key order", async () => {
    const gate = deferred<Response>();
    let sent: RequestInit | undefined;
    const transport = vi
      .fn<typeof fetch>()
      .mockImplementation(async (path, init) => {
        if (path === "/api/terminal-operations")
          return Response.json({ epoch: "epoch-1" });
        sent = init;
        return gate.promise;
      });
    const controller = new TerminalOperationController(transport);
    const first = controller.run(null, "/api/terminals", "POST", {
      cwd: "/fixture",
      profileId: "bash",
    });
    const second = controller.run(null, "/api/terminals", "POST", {
      profileId: "bash",
      cwd: "/fixture",
    });
    expect(first).toBe(second);
    await vi.waitFor(() => expect(sent).toBeDefined());
    gate.resolve(reply(sent));
    await first;
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it("never refreshes an uncertain identity after epoch fencing; unproven proxy refusal is also unknown", async () => {
    const identities: unknown[] = [];
    const transport = vi
      .fn<typeof fetch>()
      .mockImplementation(async (path, init) => {
        if (path === "/api/terminal-operations")
          return Response.json({ epoch: "old-epoch" });
        identities.push(
          JSON.parse(
            (init?.headers as Record<string, string>)["X-Terminal-Operation"]!,
          ),
        );
        return identities.length === 1
          ? Response.json({ error: "Proxy error" }, { status: 409 })
          : reply(init, { error: "Epoch changed" }, "unknown", 409);
      });
    const controller = new TerminalOperationController(transport);
    for (let i = 0; i < 3; i++)
      await expect(
        controller.run(null, "/api/terminals/id/restart", "POST"),
      ).rejects.toThrow("outcome is unknown");
    expect(
      new Set(identities.map((identity) => JSON.stringify(identity))),
    ).toHaveProperty("size", 1);
    expect(controller.snapshot()).toHaveLength(1);
  });

  it("releases definitive refusal for a later new intent, but not malformed success", async () => {
    const identities: unknown[] = [];
    const transport = vi
      .fn<typeof fetch>()
      .mockImplementation(async (path, init) => {
        if (path === "/api/terminal-operations")
          return Response.json({ epoch: "epoch-1" });
        identities.push(
          JSON.parse(
            (init?.headers as Record<string, string>)["X-Terminal-Operation"]!,
          ),
        );
        if (identities.length === 1)
          return reply(init, { error: "Limit" }, "rejected", 409);
        if (identities.length === 2)
          return new Response("broken JSON", { status: 200 });
        return reply(init);
      });
    const controller = new TerminalOperationController(transport);
    await expect(
      controller.run(null, "/api/terminals", "POST", {}),
    ).rejects.toThrow("Limit");
    expect(controller.snapshot()).toEqual([]);
    await expect(
      controller.run(null, "/api/terminals", "POST", {}),
    ).rejects.toThrow("outcome is unknown");
    await controller.run(null, "/api/terminals", "POST", {});
    expect(identities[0]).not.toEqual(identities[1]);
    expect(identities[1]).toEqual(identities[2]);
  });

  it("retains identity if local receipt retirement fails after confirmed commit", async () => {
    const identities: string[] = [];
    const transport = vi
      .fn<typeof fetch>()
      .mockImplementation(async (path, init) => {
        if (path === "/api/terminal-operations")
          return Response.json({ epoch: "epoch-1" });
        identities.push(
          (init?.headers as Record<string, string>)["X-Terminal-Operation"]!,
        );
        return reply(init);
      });
    const storage = {
      getItem: (key: string) => sessionStorage.getItem(key),
      setItem: (key: string, value: string) => {
        if (value === "[]" && identities.length === 1)
          throw new Error("Synthetic retirement failure");
        sessionStorage.setItem(key, value);
      },
    } as Storage;
    const controller = new TerminalOperationController(
      transport,
      () => storage,
    );
    await expect(
      controller.run(null, "/api/terminals", "POST", {}),
    ).rejects.toThrow("outcome is unknown");
    expect(controller.snapshot()).toHaveLength(1);
    await controller.run(null, "/api/terminals", "POST", {});
    expect(identities[0]).toBe(identities[1]);
    expect(controller.snapshot()).toEqual([]);
  });

  it("does not dispatch untracked work when operation storage is unavailable", async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ epoch: "epoch-1" }));
    const controller = new TerminalOperationController(
      transport,
      () =>
        ({
          getItem: () => null,
          setItem: () => {
            throw new Error("Synthetic quota");
          },
        }) as unknown as Storage,
    );
    for (let i = 0; i < 2; i++)
      await expect(
        controller.run(null, "/api/terminals", "POST", {}),
      ).rejects.toThrow("Synthetic quota");
    expect(transport).toHaveBeenCalledTimes(1); // read-only epoch lookup only
  });
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
    await expect(controller.retry(null, prior.key)).rejects.toThrow(
      "storage is invalid",
    );
    await expect(
      controller.run(null, "/api/terminals", "POST", { cwd: "/new-intent" }),
    ).rejects.toThrow("storage is invalid");
    expect(transport).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(STORAGE_KEY)).toBe(raw);
  });

  it("retries the saved bytes and receipt identity without acquiring a new epoch", async () => {
    const entry = saved({ body: '{"cwd":"/fixture","profileId":"bash"}' });
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify([entry]));
    const transport = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, {
        status: 204,
        headers: {
          "X-Terminal-Operation": entry.identity.id,
          "X-Terminal-Outcome": "completed",
        },
      }),
    );
    const controller = new TerminalOperationController(transport);

    await controller.retry(null, entry.key);

    expect(transport).toHaveBeenCalledExactlyOnceWith(
      entry.path,
      expect.objectContaining({
        method: entry.method,
        body: entry.body,
        headers: expect.objectContaining({
          "X-Terminal-Operation": JSON.stringify(entry.identity),
        }),
      }),
    );
    expect(controller.snapshot()).toEqual([]);
    expect(sessionStorage.getItem(STORAGE_KEY)).toBe("[]");
  });

  it("restores all receipt-controlled mutation kinds as uncertain, without sending them", () => {
    const entries = [
      ["/api/terminals", "POST", '{"cwd":"/fixture","profileId":"bash"}'],
      ["/api/terminals/id", "PATCH", '{"title":null}'],
      [
        "/api/terminals/reorder",
        "POST",
        '{"cwd":"/fixture","terminalIds":["id"]}',
      ],
      ["/api/terminals/id/restart", "POST", undefined],
      ["/api/terminals/id", "DELETE", undefined],
      ["/api/terminals/id?force=1", "DELETE", undefined],
      [
        "/api/terminal-settings",
        "PATCH",
        '{"historyRetentionDays":14,"persistOutput":true}',
      ],
      ["/api/terminal-history", "DELETE", undefined],
    ] as const;
    const pending = entries.map(([path, method, body], index) =>
      saved({
        path,
        method,
        body,
        identity: { id: `saved-${index}`, epoch: "epoch-1" },
      }),
    );
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(pending));
    const transport = vi.fn<typeof fetch>();
    const controller = new TerminalOperationController(transport);

    controller.restore();

    expect(controller.snapshot()).toEqual(
      pending.map(({ key, path }) =>
        expect.objectContaining({ key, path, busy: false, uncertain: true }),
      ),
    );
    expect(transport).not.toHaveBeenCalled();
  });

  it("accepts the legitimate cwd, tab-count and identity length boundaries", () => {
    const cwd = `/${"p".repeat(4095)}`;
    const entry = saved({
      path: "/api/terminals/reorder",
      body: JSON.stringify({
        cwd,
        terminalIds: Array.from({ length: 32 }, (_, index) =>
          String(index).padEnd(80, "a"),
        ),
      }),
      identity: { id: "i".repeat(80), epoch: "e".repeat(80) },
    });
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify([entry]));
    const controller = new TerminalOperationController(vi.fn<typeof fetch>());

    controller.restore();

    expect(controller.snapshot()).toEqual([
      {
        key: entry.key,
        path: entry.path,
        label: `Reorder terminals · ${cwd}`,
        busy: false,
        uncertain: true,
      },
    ]);
  });

  it("allows 128 unresolved identities but refuses a larger set", () => {
    const entries = Array.from({ length: 129 }, (_, index) =>
      saved({
        path: `/api/terminals/id-${index}/restart`,
        body: undefined,
        identity: { id: `operation-${index}`, epoch: "epoch-1" },
      }),
    );
    const transport = vi.fn<typeof fetch>();
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(0, 128)));
    const controller = new TerminalOperationController(transport);
    controller.restore();
    expect(controller.snapshot()).toHaveLength(128);

    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
    expect(() => new TerminalOperationController(transport).restore()).toThrow(
      "storage is invalid",
    );
    expect(transport).not.toHaveBeenCalled();
  });
});
describe("stored terminal request validation", () => {
  it.each([
    ["non-record entry", () => null],
    ["unexpected record fields", () => ({ ...saved(), extra: true })],
    [
      "non-receipted attach ticket",
      () => saved({ path: "/api/terminals/id/attach-ticket" }),
    ],
    ["read-only request", () => saved({ method: "GET" })],
    [
      "encoded terminal id",
      () => saved({ path: "/api/terminals/%69d/restart" }),
    ],
    [
      "unsupported force query",
      () => saved({ path: "/api/terminals/id?force=2", method: "DELETE" }),
    ],
    ["invalid JSON body", () => saved({ body: "{" })],
    ["JSON whitespace", () => saved({ body: '{ "cwd": "/fixture" }' })],
    [
      "unsorted JSON keys",
      () => saved({ body: '{"profileId":"bash","cwd":"/fixture"}' }),
    ],
    ["unsorted nested keys", () => saved({ body: '{"extra":{"z":1,"a":2}}' })],
    [
      "oversized body",
      () => saved({ body: JSON.stringify({ cwd: "x".repeat(32 * 1024) }) }),
    ],
    [
      "non-string id",
      () => ({ ...saved(), identity: { id: null, epoch: "epoch-1" } }),
    ],
    [
      "invalid id characters",
      () => saved({ identity: { id: "saved/id", epoch: "epoch-1" } }),
    ],
    [
      "oversized id",
      () => saved({ identity: { id: "a".repeat(81), epoch: "epoch-1" } }),
    ],
    [
      "non-string epoch",
      () => ({ ...saved(), identity: { id: "saved-id", epoch: 1 } }),
    ],
    [
      "invalid epoch characters",
      () => saved({ identity: { id: "saved-id", epoch: "epoch:1" } }),
    ],
    [
      "unexpected identity fields",
      () => ({ ...saved(), identity: { ...saved().identity, extra: true } }),
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
    ["invalid JSON", "{"],
    ["non-array root", "{}"],
  ] as const)("rejects %s storage", (_label, raw) => {
    sessionStorage.setItem(STORAGE_KEY, raw);
    const controller = new TerminalOperationController(vi.fn<typeof fetch>());
    expect(() => controller.restore()).toThrow("storage is invalid");
  });

  it.each([
    ["unsupported mutation", "DELETE", undefined],
    ["oversized body", "POST", { cwd: "x".repeat(32 * 1024) }],
  ] as const)(
    "refuses fresh %s before persistence or epoch lookup",
    async (_label, method, body) => {
      const transport = vi.fn<typeof fetch>();
      const controller = new TerminalOperationController(transport);
      await expect(
        controller.run(null, "/api/terminals", method, body),
      ).rejects.toThrow("operation is invalid");
      expect(controller.snapshot()).toEqual([]);
      expect(transport).not.toHaveBeenCalled();
      expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
    },
  );
});
