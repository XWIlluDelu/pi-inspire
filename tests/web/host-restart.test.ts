// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HostRestartClient } from "../../src/controllers/host-restart-controller";
import type { HostRestartStatus } from "../../shared/host-restart";

beforeEach(() => sessionStorage.clear());
function fixture() {
  const status: HostRestartStatus = {
    hostId: crypto.randomUUID(),
    available: true,
    operation: null,
  };
  const api = {
    hostRestartStatus: vi.fn(async () => structuredClone(status)),
    restartHost: vi.fn(async (request) => ({
      id: request.operationId,
      scope: request.scope,
      phase: "preparing" as const,
    })),
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

  it("abandons stale confirmations without sending", async () => {
    const f = fixture();
    await f.client.refresh();
    const old = f.status.hostId;
    f.status.hostId = crypto.randomUUID();
    await f.client.refresh();
    await f.client.start("host", old);
    expect(f.api.restartHost).not.toHaveBeenCalled();
  });

  it("blocks writes when recovery storage is malformed or unavailable", async () => {
    const f = fixture();
    sessionStorage.setItem("inspire:host-restart:v1", "{broken}");
    await f.client.refresh();
    await f.client.start("host", f.status.hostId);
    expect(f.client.snapshot().blocked).toBe(true);
    expect(f.api.restartHost).not.toHaveBeenCalled();
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
