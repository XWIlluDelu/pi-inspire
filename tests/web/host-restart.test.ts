// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  HostRestartOperation,
  HostRestartRequest,
  HostRestartStatus,
} from "../../shared/host-restart";
import { HostRestartClient } from "../../src/controllers/host-restart-controller";
import { deferred } from "./helpers";

beforeEach(() => sessionStorage.clear());
function fixture() {
  const status: HostRestartStatus = {
    hostId: crypto.randomUUID(),
    available: true,
    allAvailable: true,
    operation: null,
  };
  const api = {
    hostRestartStatus: vi.fn(async () => structuredClone(status)),
    restartHost: vi.fn(
      async (request: HostRestartRequest): Promise<HostRestartOperation> => ({
        id: request.operationId,
        scope: request.scope,
        phase: "preparing",
      }),
    ),
  };
  return { status, api, client: new HostRestartClient(api) };
}

describe("browser restart delivery", () => {
  it("shows the accepted receipt while an older status read is still pending", async () => {
    const f = fixture();
    f.status.operation = {
      id: crypto.randomUUID(),
      scope: "host",
      phase: "rejected",
      busyReason: "active-work",
    };
    await f.client.refresh();
    const staleStatus = structuredClone(f.status);
    const stale = deferred<HostRestartStatus>();
    f.api.hostRestartStatus.mockReturnValueOnce(stale.promise);
    void f.client.refresh();
    const observed: Array<ReturnType<HostRestartClient["snapshot"]>> = [];
    f.client.subscribe(() => observed.push(f.client.snapshot()));
    f.api.restartHost.mockImplementation(async (request) => {
      f.status.operation = {
        id: request.operationId,
        scope: request.scope,
        phase: "preparing",
      };
      return f.status.operation;
    });

    const sending = f.client.start("host", f.status.hostId);
    expect(observed.find((state) => state.pending)?.sending).toBe(true);
    await vi.waitFor(() =>
      expect(f.client.snapshot().status?.operation).toEqual(f.status.operation),
    );
    observed.length = 0;
    stale.resolve(staleStatus);
    await sending;
    expect(observed.map((state) => state.status?.operation)).not.toContainEqual(
      staleStatus.operation,
    );
    expect(f.client.snapshot().status?.operation).toEqual(f.status.operation);
  });

  it("keeps a later observed phase when the initial receipt arrives late", async () => {
    const f = fixture();
    await f.client.refresh();
    const receipt = deferred<HostRestartOperation>();
    f.api.restartHost.mockReturnValueOnce(receipt.promise);
    const sending = f.client.start("host", f.status.hostId);
    const request = f.api.restartHost.mock.calls[0]![0];
    const operation = { id: request.operationId, scope: request.scope };
    f.status.operation = { ...operation, phase: "submitted" };
    await f.client.refresh();
    const observed: Array<HostRestartOperation["phase"] | undefined> = [];
    f.client.subscribe(() =>
      observed.push(f.client.snapshot().status?.operation?.phase),
    );
    receipt.resolve({ ...operation, phase: "preparing" });
    await sending;
    expect(observed).not.toContain("preparing");
    expect(f.client.snapshot().status?.operation?.phase).toBe("submitted");
  });

  it.each([
    { scope: "all", interruptWork: undefined, initial: "lost" },
    { scope: "host", interruptWork: true, initial: "accepted" },
  ] as const)(
    "recovers $initial $scope delivery by retrying only the persisted identity and grant",
    async ({ scope, interruptWork, initial }) => {
      const f = fixture();
      f.api.restartHost.mockImplementationOnce(async (request) => {
        expect(
          JSON.parse(sessionStorage.getItem("inspire:host-restart:v1")!),
        ).toEqual(request);
        if (initial === "lost") throw new Error("lost");
        return {
          id: request.operationId,
          scope,
          phase: "preparing",
          interruptWork,
        };
      });
      await f.client.refresh();
      await f.client.start(scope, f.status.hostId, interruptWork);
      const request = f.api.restartHost.mock.calls[0]![0];
      expect(request.scope).toBe(scope);
      expect(request.interruptWork).toBe(interruptWork);

      const reloaded = new HostRestartClient(f.api);
      await reloaded.refresh();
      await reloaded.refresh();
      await reloaded.start("host", f.status.hostId);
      expect(f.api.restartHost).toHaveBeenCalledOnce();
      expect(reloaded.snapshot().pending).toEqual(request);

      f.api.restartHost.mockRejectedValueOnce(new Error("401"));
      await reloaded.retry();
      expect(f.api.restartHost.mock.calls[1]![0]).toEqual(request);
      expect(reloaded.snapshot().pending).toEqual(request);

      const rejection = {
        id: request.operationId,
        scope,
        phase: "rejected" as const,
        error: "Build failed",
      };
      if (interruptWork) {
        f.status.operation = rejection;
        await reloaded.refresh();
        expect(reloaded.snapshot().pending).toEqual(request);
      }
      f.status.operation = { ...rejection, interruptWork };
      await reloaded.refresh();
      expect(reloaded.snapshot().pending).toBeNull();
      expect(reloaded.snapshot().status?.operation?.error).toBe("Build failed");
    },
  );

  it("uses the new Host identity as reconnection evidence and never replays an old operation there", async () => {
    const f = fixture();
    await f.client.refresh();
    const oldHostId = f.status.hostId;
    await f.client.start("all", oldHostId);
    f.status.hostId = crypto.randomUUID();
    await f.client.refresh();
    expect(f.client.snapshot().pending).toBeNull();
    expect(f.client.snapshot().notice).toBe("Host reconnected.");
    await f.client.retry();
    await f.client.start("host", oldHostId);
    expect(f.api.restartHost).toHaveBeenCalledOnce();
  });

  it("does not dispatch an unavailable scope while ordinary restart is supported", async () => {
    const f = fixture();
    f.status.allAvailable = false;
    await f.client.refresh();
    await f.client.start("all", f.status.hostId);
    expect(f.api.restartHost).not.toHaveBeenCalled();
    expect(f.client.snapshot().pending).toBeNull();
    await f.client.start("host", f.status.hostId);
    expect(f.api.restartHost).toHaveBeenCalledOnce();
  });

  it("keeps Host observation independent of broken local recovery and unblocks after repair", async () => {
    const f = fixture();
    sessionStorage.setItem("inspire:host-restart:v1", "{broken}");
    await f.client.refresh();
    expect(f.client.snapshot().status).toEqual(f.status);
    expect(f.client.snapshot().blocked).toBe(true);
    expect(f.client.snapshot().recoveryInvalid).toBe(true);
    await f.client.start("host", f.status.hostId);
    expect(f.api.restartHost).not.toHaveBeenCalled();
    sessionStorage.removeItem("inspire:host-restart:v1");
    await f.client.refresh();
    expect(f.client.snapshot().blocked).toBe(false);
    expect(f.client.snapshot().recoveryInvalid).toBe(false);
    await f.client.start("host", f.status.hostId);
    expect(f.api.restartHost).toHaveBeenCalledOnce();
  });

  it("clears broken browser tracking explicitly without sending or clearing a running Host operation", async () => {
    const f = fixture();
    f.status.operation = {
      id: crypto.randomUUID(),
      scope: "all",
      phase: "submitted",
    };
    sessionStorage.setItem(
      "inspire:host-restart:v1",
      JSON.stringify({
        hostId: f.status.hostId,
        operationId: f.status.operation.id,
        scope: f.status.operation.scope,
        interruptWork: false,
      }),
    );
    await f.client.refresh();
    expect(f.client.snapshot().recoveryInvalid).toBe(true);
    await f.client.clearRecovery();
    expect(f.client.snapshot()).toMatchObject({
      blocked: false,
      recoveryInvalid: false,
      pending: null,
      status: f.status,
    });
    expect(sessionStorage.getItem("inspire:host-restart:v1")).toBeNull();
    expect(f.api.restartHost).not.toHaveBeenCalled();
  });

  it("recovers local cleanup after a confirmed rejection without misreporting the operation", async () => {
    const f = fixture();
    let canRemove = false;
    const storage = {
      getItem: (key: string) => sessionStorage.getItem(key),
      setItem: (key: string, value: string) =>
        sessionStorage.setItem(key, value),
      removeItem: (key: string) => {
        if (!canRemove) throw new Error("storage unavailable");
        sessionStorage.removeItem(key);
      },
    } as Storage;
    const client = new HostRestartClient(f.api, () => storage);
    f.api.restartHost.mockImplementation(async (request) => {
      f.status.operation = {
        id: request.operationId,
        scope: request.scope,
        phase: "rejected",
        error: "Build failed",
      };
      return f.status.operation;
    });
    await client.refresh();
    await client.start("host", f.status.hostId);
    expect(client.snapshot()).toMatchObject({
      blocked: true,
      status: { operation: { phase: "rejected", error: "Build failed" } },
    });
    expect(client.snapshot().error).toMatch(/saved restart status/);
    await client.clearRecovery();
    expect(client.snapshot().pending).not.toBeNull();
    expect(f.api.restartHost).toHaveBeenCalledOnce();
    canRemove = true;
    await client.refresh();
    expect(client.snapshot()).toMatchObject({
      blocked: false,
      pending: null,
      error: null,
    });
    expect(f.api.restartHost).toHaveBeenCalledOnce();
  });

  it("retries unavailable storage automatically without treating it as invalid data", async () => {
    const f = fixture();
    let unavailable = true;
    const client = new HostRestartClient(f.api, () => {
      if (unavailable) throw new Error("storage unavailable");
      return sessionStorage;
    });
    await client.refresh();
    expect(client.snapshot()).toMatchObject({
      blocked: true,
      recoveryInvalid: false,
      status: f.status,
    });
    unavailable = false;
    await client.refresh();
    expect(client.snapshot()).toMatchObject({
      blocked: false,
      recoveryInvalid: false,
      error: null,
    });
    expect(f.api.restartHost).not.toHaveBeenCalled();
  });

  it("does not dispatch when it cannot persist the request", async () => {
    const f = fixture();
    const client = new HostRestartClient(
      f.api,
      () =>
        ({
          getItem: () => null,
          setItem: () => {
            throw new Error("quota");
          },
        }) as unknown as Storage,
    );
    await client.refresh();
    await client.start("all", f.status.hostId);
    expect(client.snapshot().blocked).toBe(true);
    expect(client.snapshot().recoveryInvalid).toBe(false);
    expect(f.api.restartHost).not.toHaveBeenCalled();
  });
});
