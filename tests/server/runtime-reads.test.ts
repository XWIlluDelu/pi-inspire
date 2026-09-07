import { describe, expect, it, vi } from "vitest";
import { RuntimeReadController } from "../../server/runtime-reads.js";
import type { RuntimeSlot } from "../../server/runtime-slot.js";

function fixture() {
  const slot = {
    id: "a",
    cwd: "/A",
    viewId: "view-a",
    projection: { revision: 1, viewMessages: () => ["message-a"] },
  } as unknown as RuntimeSlot;
  let registered = slot;
  const host = {
    assertAvailable: () => {},
    selectedSlot: () => null,
    selectedSessionId: () => "b",
    sessionStatuses: () => ({}),
    requireSlot: () => registered,
    useSlot: <T>(_slot: RuntimeSlot, operation: () => Promise<T>) =>
      operation(),
    snapshotSlot: vi.fn(),
    reconcileSlot: vi.fn(async () => {}),
    effectiveLeaf: () => null,
    promptFileName: () => null,
  };
  return {
    slot,
    host,
    reads: new RuntimeReadController(host),
    replace: () => {
      registered = { ...slot };
    },
  };
}

describe("addressed resource read lifecycle", () => {
  it.each(["before", "during"])(
    "rejects a slot replaced %s context reconciliation",
    async (when) => {
      const f = fixture();
      if (when === "before")
        f.host.requireSlot = vi
          .fn()
          .mockReturnValueOnce(f.slot)
          .mockImplementation(() => ({ ...f.slot }));
      else f.host.reconcileSlot.mockImplementation(async () => f.replace());
      await expect(f.reads.resourceContext("a")).rejects.toMatchObject({
        status: 409,
      });
    },
  );

  it.each(["slot", "view", "revision"])(
    "rejects a lazy read after its %s changes during reconciliation",
    async (change) => {
      const f = fixture();
      const context = await f.reads.resourceContext("a");
      f.host.reconcileSlot.mockImplementation(async () => {
        if (change === "slot") f.replace();
        if (change === "view") f.slot.viewId = "new-view";
        if (change === "revision")
          Object.assign(f.slot.projection!, { revision: 2 });
      });
      await expect(context.loadMessages!()).rejects.toMatchObject({
        status: 409,
      });
    },
  );

  it("does not consult global selection for either context or lazy messages", async () => {
    const f = fixture();
    f.host.selectedSessionId = vi.fn(() => {
      throw new Error("selection must not be read");
    });
    const context = await f.reads.resourceContext("a");
    await expect(context.loadMessages!()).resolves.toEqual(["message-a"]);
  });
});
