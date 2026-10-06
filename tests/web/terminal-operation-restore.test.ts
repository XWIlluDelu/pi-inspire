// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalOperationController } from "../../src/controllers/terminal-operation-controller";

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

beforeEach(() => sessionStorage.clear());

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
