// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  HostRestartOperation,
  HostRestartRequest,
  HostRestartStatus,
} from "../../shared/host-restart";
import { HostRestartClient } from "../../src/controllers/host-restart-controller";

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
  it("persists before POST, keeps lost delivery across reload, and retries the identical request only explicitly", async () => {
    const f = fixture();
    f.api.restartHost.mockImplementation(async () => {
      expect(sessionStorage.getItem("inspire:host-restart:v1")).not.toBeNull();
      throw new Error("lost");
    });
    await f.client.refresh();
    await f.client.start("all", f.status.hostId);
    const request = f.api.restartHost.mock.calls[0]![0];
    const reloaded = new HostRestartClient(f.api);
    await reloaded.refresh();
    await reloaded.refresh();
    expect(f.api.restartHost).toHaveBeenCalledOnce();
    expect(reloaded.snapshot().pending).toEqual(request);
    await reloaded.start("host", f.status.hostId);
    expect(f.api.restartHost).toHaveBeenCalledOnce();
    await reloaded.retry();
    expect(f.api.restartHost.mock.calls[1]![0]).toEqual(request);
  });

  it("persists the work-interruption grant inside a distinct operation and replays only that grant", async () => {
    const f = fixture();
    await f.client.refresh();
    await f.client.start("host", f.status.hostId, true);
    const request = f.api.restartHost.mock.calls[0]![0];
    expect(request).toMatchObject({ scope: "host", interruptWork: true });
    const reloaded = new HostRestartClient(f.api);
    await reloaded.refresh();
    expect(reloaded.snapshot().pending).toEqual(request);
    await reloaded.retry();
    expect(f.api.restartHost.mock.calls[1]![0]).toEqual(request);
    await reloaded.start("host", f.status.hostId);
    expect(f.api.restartHost).toHaveBeenCalledTimes(2);
  });

  it("does not treat an HTTP rejection as proof that a previously delivered restart failed", async () => {
    const f = fixture();
    await f.client.refresh();
    await f.client.start("host", f.status.hostId);
    f.api.restartHost.mockRejectedValue(new Error("401"));
    await f.client.retry();
    expect(f.client.snapshot().pending).not.toBeNull();
    f.status.operation = {
      id: f.client.snapshot().pending!.operationId,
      scope: "host",
      phase: "rejected",
      error: "Build failed",
    };
    await f.client.refresh();
    expect(f.client.snapshot().pending).toBeNull();
    expect(f.client.snapshot().status?.operation?.error).toBe("Build failed");
  });

  it("uses the new Host identity as reconnection evidence and never replays an old operation there", async () => {
    const f = fixture();
    await f.client.refresh();
    await f.client.start("all", f.status.hostId);
    f.status.hostId = crypto.randomUUID();
    await f.client.refresh();
    expect(f.client.snapshot().pending).toBeNull();
    expect(f.client.snapshot().notice).toBe("Host reconnected.");
    await f.client.retry();
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

  it("abandons stale confirmations without sending", async () => {
    const f = fixture();
    await f.client.refresh();
    const old = f.status.hostId;
    f.status.hostId = crypto.randomUUID();
    await f.client.refresh();
    await f.client.start("host", old);
    expect(f.api.restartHost).not.toHaveBeenCalled();
  });

  it("keeps Host observation independent of broken local recovery and unblocks after repair", async () => {
    const f = fixture();
    sessionStorage.setItem("inspire:host-restart:v1", "{broken}");
    await f.client.refresh();
    expect(f.client.snapshot().status).toEqual(f.status);
    expect(f.client.snapshot().blocked).toBe(true);
    expect(f.api.restartHost).not.toHaveBeenCalled();
    sessionStorage.removeItem("inspire:host-restart:v1");
    await f.client.refresh();
    expect(f.client.snapshot().blocked).toBe(false);
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
    sessionStorage.setItem("inspire:host-restart:v1", "{broken}");
    await f.client.refresh();
    await f.client.clearRecovery();
    expect(f.client.snapshot()).toMatchObject({
      blocked: false,
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
    expect(client.snapshot().error).toMatch(/recovery record/);
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

  it("blocks writes when recovery storage is malformed or unavailable", async () => {
    const f = fixture();
    sessionStorage.setItem("inspire:host-restart:v1", "{broken}");
    await f.client.refresh();
    await f.client.start("host", f.status.hostId);
    expect(f.client.snapshot().blocked).toBe(true);
    expect(f.api.restartHost).not.toHaveBeenCalled();
    sessionStorage.clear();
    sessionStorage.setItem(
      "inspire:host-restart:v1",
      JSON.stringify({
        hostId: f.status.hostId,
        operationId: crypto.randomUUID(),
        scope: "host",
        interruptWork: false,
      }),
    );
    const invalidGrant = new HostRestartClient(f.api);
    await invalidGrant.refresh();
    expect(invalidGrant.snapshot().blocked).toBe(true);
    sessionStorage.clear();
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
    expect(f.api.restartHost).not.toHaveBeenCalled();
  });
});
