// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  HostRestartOperation,
  HostRestartRequest,
  HostRestartStatus,
} from "../../shared/host-restart";
import { HostRestartClient } from "../../src/controllers/host-restart-controller";
import { deferred } from "./helpers";

const recoveryKey = "inspire:host-restart:v1";
beforeEach(() => sessionStorage.clear());

function fixture() {
  const status: HostRestartStatus = {
    hostId: crypto.randomUUID(),
    available: true,
    allPiAvailable: true,
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
  const client = new HostRestartClient(api);
  const observe = async () => {
    await client.refresh();
    return client.snapshot();
  };
  return { status, api, client, observe };
}

describe("browser restart delivery", () => {
  it.each(["status", "receipt"] as const)(
    "keeps newer restart evidence when %s arrives late",
    async (delayed) => {
      const { status, api, client, observe } = fixture();
      const historical: HostRestartOperation = {
        id: crypto.randomUUID(),
        scope: "host",
        phase: "rejected",
        busyReason: "active-work",
      };
      status.operation = historical;
      await observe();
      const pendingStatus = deferred<HostRestartStatus>();
      const pendingReceipt = deferred<HostRestartOperation>();
      let reading: Promise<unknown> | undefined;
      if (delayed === "status") {
        api.hostRestartStatus.mockReturnValueOnce(pendingStatus.promise);
        reading = observe();
      } else api.restartHost.mockReturnValueOnce(pendingReceipt.promise);

      const seen: Array<HostRestartOperation | null | undefined> = [];
      const unsubscribe = client.subscribe(() =>
        seen.push(client.snapshot().status?.operation),
      );
      const sending = client.start("host", status.hostId);
      const request = api.restartHost.mock.calls[0]![0];
      expect(client.snapshot().sending).toBe(true);
      const operation = { id: request.operationId, scope: request.scope };
      const accepted = { ...operation, phase: "preparing" as const };
      const newer =
        delayed === "status"
          ? accepted
          : { ...operation, phase: "submitted" as const };
      status.operation = newer;
      if (delayed === "status") {
        await vi.waitFor(() =>
          expect(client.snapshot().status?.operation).toEqual(accepted),
        );
        seen.length = 0;
        pendingStatus.resolve({ ...status, operation: historical });
      } else {
        await observe();
        seen.length = 0;
        pendingReceipt.resolve(accepted);
      }
      await Promise.all([sending, reading]);
      expect(seen).not.toContainEqual(
        delayed === "status" ? historical : accepted,
      );
      expect(client.snapshot().status?.operation).toEqual(status.operation);
      unsubscribe();
    },
  );

  it("requires all-Pi authority, observes ordinary restart reconnection and rejects a retired address", async () => {
    const f = fixture();
    await f.client.refresh();
    await f.client.start("all-pi", f.status.hostId);
    f.status.allPiAvailable = false;
    await f.client.refresh();
    await f.client.start("all-pi", f.status.hostId, true);
    expect(f.api.restartHost).not.toHaveBeenCalled();
    expect(f.client.snapshot().pending).toBeNull();
    const oldHostId = f.status.hostId;
    await f.client.start("host", oldHostId);
    f.status.hostId = crypto.randomUUID();
    await f.client.refresh();
    expect(f.client.snapshot()).toMatchObject({
      pending: null,
      notice: "Host reconnected.",
    });
    await f.client.retry();
    await f.client.start("host", oldHostId);
    expect(f.api.restartHost).toHaveBeenCalledOnce();
  });

  it("clears broken browser tracking automatically without sending or clearing a running Host operation", async () => {
    const f = fixture();
    f.status.operation = {
      id: crypto.randomUUID(),
      scope: "host",
      phase: "submitted",
    };
    sessionStorage.setItem(
      recoveryKey,
      JSON.stringify({
        hostId: f.status.hostId,
        operationId: f.status.operation.id,
        scope: f.status.operation.scope,
        interruptWork: false,
      }),
    );
    await f.client.refresh();
    expect(f.client.snapshot()).toMatchObject({
      blocked: false,
      pending: null,
      status: f.status,
    });
    await f.client.start("host", f.status.hostId);
    expect(sessionStorage.getItem(recoveryKey)).toBeNull();
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

  it.each(["read", "write"] as const)(
    "observes Host while storage %s failure blocks dispatch",
    async (failure) => {
      const { status, api } = fixture();
      let available = false;
      const storage = {
        getItem: (key: string) => sessionStorage.getItem(key),
        setItem: (key: string, value: string) => {
          if (failure === "write" && !available) throw new Error("quota");
          sessionStorage.setItem(key, value);
        },
      } as Storage;
      const client = new HostRestartClient(api, () => {
        if (failure === "read" && !available)
          throw new Error("storage unavailable");
        return storage;
      });
      await client.refresh();
      await client.start("host", status.hostId);
      expect(client.snapshot()).toMatchObject({ blocked: true, status });
      expect(api.restartHost).not.toHaveBeenCalled();
      available = true;
      await client.refresh();
      expect(client.snapshot()).toMatchObject({ blocked: false, error: null });
      await client.start("host", status.hostId);
      expect(api.restartHost).toHaveBeenCalledOnce();
    },
  );
});
