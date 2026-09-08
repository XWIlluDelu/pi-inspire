// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalOperationController } from "../../src/controllers/terminal-operation-controller";

const STORAGE_KEY = "inspire:terminal-operations:v1";

function saved() {
  const path = "/api/terminals";
  const method = "POST";
  const body: string | undefined = '{"cwd":"/fixture"}';
  return {
    key: JSON.stringify([path, method, body ?? null]),
    path,
    method,
    body,
    identity: { id: "saved-id", epoch: "epoch-1" },
  };
}

type Saved = ReturnType<typeof saved>;
function changed(patch: Partial<Saved>) {
  const value = { ...saved(), ...patch };
  value.key = JSON.stringify([value.path, value.method, value.body ?? null]);
  return value;
}

beforeEach(() => sessionStorage.clear());

describe("terminal operation restore validation", () => {
  const corruptions: Array<[string, () => unknown]> = [
    ["null record", () => null],
    ["array record", () => []],
    ["non-string key", () => ({ ...saved(), key: 1 })],
    ["arbitrary key", () => ({ ...saved(), key: "unknown-old-key" })],
    ["oversized key", () => ({ ...saved(), key: "x".repeat(66_000) })],
    [
      "path/key disagreement",
      () => ({ ...saved(), path: "/api/terminal-history" }),
    ],
    ["method/key disagreement", () => ({ ...saved(), method: "DELETE" })],
    ["body/key disagreement", () => ({ ...saved(), body: '{"cwd":"/other"}' })],
    ["missing body/key disagreement", () => ({ ...saved(), body: undefined })],
    [
      "null versus absent body key",
      () => ({
        ...changed({ body: "null" }),
        key: JSON.stringify(["/api/terminals", "POST", null]),
      }),
    ],
    ["non-string path", () => ({ ...saved(), path: 1 })],
    [
      "oversized path",
      () => changed({ path: `/api/terminals/${"a".repeat(200)}` }),
    ],
    [
      "terminal prefix lookalike",
      () => changed({ path: "/api/terminals-unsafe" }),
    ],
    [
      "read-only operation endpoint",
      () => changed({ path: "/api/terminal-operations", method: "GET" }),
    ],
    ["read-only catalog", () => changed({ method: "GET" })],
    ["nonexistent collection delete", () => changed({ method: "DELETE" })],
    ["non-string method", () => ({ ...saved(), method: null })],
    ["noncanonical method", () => changed({ method: "post" })],
    [
      "attach ticket outside receipt controls",
      () => changed({ path: "/api/terminals/id/attach-ticket" }),
    ],
    [
      "unknown suffix",
      () => changed({ path: "/api/terminals/id/restart/extra" }),
    ],
    [
      "noncanonical query",
      () => changed({ path: "/api/terminals/id?force=2", method: "DELETE" }),
    ],
    [
      "duplicate force query",
      () =>
        changed({
          path: "/api/terminals/id?force=1&force=1",
          method: "DELETE",
        }),
    ],
    [
      "encoded terminal id",
      () => changed({ path: "/api/terminals/%69d/restart" }),
    ],
    [
      "oversized terminal id",
      () => changed({ path: `/api/terminals/${"a".repeat(81)}/restart` }),
    ],
    [
      "body object instead of serialized JSON",
      () => ({ ...saved(), body: {} }),
    ],
    [
      "null body instead of serialized JSON",
      () => ({ ...saved(), body: null }),
    ],
    ["non-JSON body", () => changed({ body: "{" })],
    [
      "noncanonical JSON whitespace",
      () => changed({ body: '{ "cwd": "/fixture" }' }),
    ],
    [
      "noncanonical JSON key order",
      () => changed({ body: '{"profileId":"bash","cwd":"/fixture"}' }),
    ],
    [
      "noncanonical nested key order",
      () => changed({ body: '{"extra":{"z":1,"a":2}}' }),
    ],
    [
      "duplicate JSON body keys",
      () => changed({ body: '{"cwd":"/old","cwd":"/fixture"}' }),
    ],
    [
      "noncanonical JSON escape",
      () => changed({ body: '{"cwd":"\\u002ffixture"}' }),
    ],
    [
      "noncanonical JSON number",
      () => changed({ body: '{"cols":1e2,"cwd":"/fixture"}' }),
    ],
    [
      "oversized serialized body",
      () => changed({ body: JSON.stringify({ cwd: "x".repeat(32 * 1024) }) }),
    ],
    ["missing identity", () => ({ ...saved(), identity: undefined })],
    ["array identity", () => ({ ...saved(), identity: [] })],
    [
      "non-string identity id",
      () => ({ ...saved(), identity: { id: null, epoch: "epoch-1" } }),
    ],
    [
      "empty identity id",
      () => changed({ identity: { id: "", epoch: "epoch-1" } }),
    ],
    [
      "oversized identity id",
      () => changed({ identity: { id: "a".repeat(81), epoch: "epoch-1" } }),
    ],
    [
      "invalid identity id",
      () => changed({ identity: { id: "saved/id", epoch: "epoch-1" } }),
    ],
    ["missing epoch", () => ({ ...saved(), identity: { id: "saved-id" } })],
    ["empty epoch", () => changed({ identity: { id: "saved-id", epoch: "" } })],
    [
      "oversized epoch",
      () => changed({ identity: { id: "saved-id", epoch: "a".repeat(81) } }),
    ],
    [
      "invalid epoch",
      () => changed({ identity: { id: "saved-id", epoch: "epoch:1" } }),
    ],
    ["extra record fields", () => ({ ...saved(), extra: true })],
    [
      "extra identity fields",
      () => ({ ...saved(), identity: { ...saved().identity, extra: true } }),
    ],
    [
      "duplicate key",
      () =>
        changed({
          path: "/api/terminals/prior/restart",
          body: undefined,
          identity: { id: "other-id", epoch: "epoch-1" },
        }),
    ],
    [
      "duplicate identity with different content",
      () => changed({ identity: { id: "prior-id", epoch: "epoch-1" } }),
    ],
  ];

  it.each(corruptions)(
    "blocks retries and fresh dispatch atomically for %s",
    async (_name, corrupt) => {
      const prior = changed({
        path: "/api/terminals/prior/restart",
        body: undefined,
        identity: { id: "prior-id", epoch: "epoch-1" },
      });
      const raw = JSON.stringify([prior, corrupt()]);
      sessionStorage.setItem(STORAGE_KEY, raw);
      const transport = vi.fn<typeof fetch>();
      const controller = new TerminalOperationController(transport);
      expect(() => controller.restore()).toThrow("storage is invalid");
      expect(controller.snapshot()).toEqual([]);
      await expect(controller.retry(null, prior.key)).rejects.toThrow(
        "storage is invalid",
      );
      await expect(controller.retry(null, "unknown-old-key")).rejects.toThrow(
        "storage is invalid",
      );
      await expect(
        controller.run(null, "/api/terminals", "POST", { cwd: "/new-intent" }),
      ).rejects.toThrow("storage is invalid");
      expect(transport).not.toHaveBeenCalled(); // Not even a fresh epoch lookup.
      expect(sessionStorage.getItem(STORAGE_KEY)).toBe(raw);
    },
  );

  it.each([
    ["invalid JSON", "{"],
    ["empty string", ""],
    ["null root", "null"],
    ["object root", "{}"],
    [
      "too many entries",
      JSON.stringify(
        Array.from({ length: 129 }, (_, index) =>
          changed({
            path: `/api/terminals/id-${index}/restart`,
            body: undefined,
            identity: { id: `operation-${index}`, epoch: "epoch-1" },
          }),
        ),
      ),
    ],
  ])("rejects %s storage before transport", async (_label, raw) => {
    sessionStorage.setItem(STORAGE_KEY, raw!);
    const transport = vi.fn<typeof fetch>();
    const controller = new TerminalOperationController(transport);
    await expect(
      controller.run(null, "/api/terminals", "POST", { cwd: "/fixture" }),
    ).rejects.toThrow("storage is invalid");
    expect(transport).not.toHaveBeenCalled();
  });

  it("bounds serialized storage before parsing it", async () => {
    const transport = vi.fn<typeof fetch>();
    const raw = " ".repeat(26 * 1024 * 1024);
    const storage = {
      getItem: () => raw,
      setItem: vi.fn(),
    } as unknown as Storage;
    const parse = vi.spyOn(JSON, "parse");
    const controller = new TerminalOperationController(
      transport,
      () => storage,
    );
    expect(() => controller.restore()).toThrow("storage is invalid");
    expect(parse).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it.each([
    ["/api/terminals", "POST", '{"cwd":"/fixture","profileId":"bash"}'],
    ["/api/terminals/id", "PATCH", '{"title":"Saved title"}'],
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
  ] as const)(
    "restores existing %s %s content without canonicalizing a new identity",
    async (path, method, body) => {
      const entry = changed({ path, method, body });
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify([entry]));
      const transport = vi.fn<typeof fetch>(async (url, init) => {
        expect(url).toBe(path);
        expect(init?.method).toBe(method);
        expect(init?.body).toBe(body);
        expect(
          (init?.headers as Record<string, string>)["X-Terminal-Operation"],
        ).toBe(JSON.stringify(entry.identity));
        return new Response(null, {
          status: 204,
          headers: {
            "X-Terminal-Operation": entry.identity.id,
            "X-Terminal-Outcome": "completed",
          },
        });
      });
      const controller = new TerminalOperationController(transport);
      await controller.retry(null, entry.key);
      expect(transport).toHaveBeenCalledOnce();
      expect(controller.snapshot()).toEqual([]);
      expect(sessionStorage.getItem(STORAGE_KEY)).toBe("[]");
    },
  );

  it("accepts bounded synthetic ids/epochs and maximum-length legitimate fields", () => {
    const entry = changed({
      body: JSON.stringify({
        cwd: `/${"p".repeat(4095)}`,
        terminalIds: Array.from({ length: 32 }, (_, index) =>
          `${index}`.padEnd(80, "a"),
        ),
      }),
      path: "/api/terminals/reorder",
      identity: { id: "i".repeat(80), epoch: "e".repeat(80) },
    });
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify([entry]));
    const transport = vi.fn<typeof fetch>();
    const controller = new TerminalOperationController(transport);
    controller.restore();
    expect(controller.snapshot()).toEqual([
      {
        key: entry.key,
        path: entry.path,
        label: `Reorder terminals · /${"p".repeat(4095)}`,
        busy: false,
        uncertain: true,
      },
    ]);
    expect(transport).not.toHaveBeenCalled();
  });

  it("does not store fresh content that cannot safely be restored", async () => {
    const transport = vi.fn<typeof fetch>();
    const controller = new TerminalOperationController(transport);
    await expect(
      controller.run(null, "/api/terminals", "DELETE"),
    ).rejects.toThrow("operation is invalid");
    await expect(
      controller.run(null, "/api/terminals", "POST", {
        cwd: "x".repeat(32 * 1024),
      }),
    ).rejects.toThrow("operation is invalid");
    expect(controller.snapshot()).toEqual([]);
    expect(transport).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });
});
