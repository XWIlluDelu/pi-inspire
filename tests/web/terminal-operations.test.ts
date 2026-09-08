// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalOperationController } from "../../src/controllers/terminal-operation-controller";

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
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
beforeEach(() => sessionStorage.clear());

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
