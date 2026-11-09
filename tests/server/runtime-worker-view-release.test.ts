import { expect, it, vi } from "vitest";
import { emptyPendingQueues } from "../../shared/contracts.js";
import { nullDiagnosticLogger } from "../../server/diagnostics.js";
import type { PendingImageRecovery } from "../../server/runtime-pending-images.js";
import { createRuntimeSlot } from "../../server/runtime-slot.js";
import { RuntimeWorkerLifecycle } from "../../server/runtime-worker-lifecycle.js";
import { deferredSignal } from "./fixtures/runtime.js";

it("releases the previous worker's view without letting its disposal clear a replacement's state", async () => {
  const clear = vi.fn();
  const lifecycle = new RuntimeWorkerLifecycle(
    {} as ConstructorParameters<typeof RuntimeWorkerLifecycle>[0],
    nullDiagnosticLogger(),
    {
      extensionUi: { clear },
    } as unknown as ConstructorParameters<typeof RuntimeWorkerLifecycle>[2],
  );
  const slot = createRuntimeSlot({
    id: "a",
    cwd: "/tmp",
    sessionPath: "/sessions/a.jsonl",
    process: null,
    preview: null,
    projection: null,
    bridge: null,
    branchRevision: 1,
    incarnationId: "slot-a",
    viewId: "view-a",
  });
  const disposed = deferredSignal();
  const previous = {
    dispose: vi.fn(() => disposed.promise),
  } as unknown as PendingImageRecovery;
  slot.pendingImages = previous;
  slot.piPendingInput = { steering: ["held"], followUp: [] };
  slot.extensionStatuses = { usage: "37%" };
  slot.pendingQueues = { ...emptyPendingQueues(), revision: 4 };

  const released = lifecycle.releaseWorkerView(slot, "replaced");
  expect(clear).toHaveBeenCalledWith(slot, "replaced");
  expect(slot.pendingImages).toBeNull();
  expect(slot.piPendingInput).toEqual({ steering: [], followUp: [] });
  expect(slot.extensionStatuses).toEqual({});
  expect(slot.pendingQueues.revision).toBe(5);

  // The replacement worker takes ownership while old disposal is pending.
  const replacement = { dispose: vi.fn() } as unknown as PendingImageRecovery;
  slot.pendingImages = replacement;
  disposed.resolve();
  await released;
  expect(previous.dispose).toHaveBeenCalledOnce();
  expect(slot.pendingImages).toBe(replacement);
  expect(replacement.dispose).not.toHaveBeenCalled();
});
