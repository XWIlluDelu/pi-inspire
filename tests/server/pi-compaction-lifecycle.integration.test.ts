import { readFile } from "node:fs/promises";

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fixture,
  eventsOf,
  disposeOperationFixture,
} from "./fixtures/native-operation.js";

afterEach(disposeOperationFixture);

async function compactThenReturnToEarlierPoint(
  f: Awaited<ReturnType<typeof fixture>>,
) {
  await f.api.nativeCommand({ sessionId: f.sessionId, command: "compact" });
  const tree = await f.api.branchTree(f.sessionId);
  await f.api.navigateBranch({
    sessionId: f.sessionId,
    revision: tree.revision,
    targetId: "00000008",
    mode: "switch",
    summarize: false,
  });
}

describe("native manual compaction cancellation", () => {
  it.each(["current", "earlier"] as const)(
    "cancels manual compaction on the %s branch without replacing its worker or mistaking an old checkpoint for completion",
    async (branch) => {
      const f = await fixture(false, 500);
      const previousCompactions = branch === "earlier" ? 1 : 0;
      if (branch === "earlier") await compactThenReturnToEarlierPoint(f);
      const worker = f.workers[0]!;
      const pid = worker.pid;
      const requests = vi.spyOn(worker, "request");
      const compacting = f.api.nativeCommand({
        sessionId: f.sessionId,
        command: "compact",
      });
      void compacting.catch(() => {});
      await vi.waitFor(() =>
        expect(eventsOf(f.piEvents, "compaction_start")).toHaveLength(
          previousCompactions + 1,
        ),
      );
      expect(await worker.request({ type: "get_state" })).toMatchObject({
        isCompacting: true,
      });
      // An earlier-branch view intentionally has a read-only navigation lease.
      // Current-branch admission additionally verifies Pending recovery.
      const pending =
        branch === "current"
          ? f.api.prompt({
              ...f.delivery("Never resume this pending input."),
              behavior: "followUp",
            })
          : null;
      if (pending) {
        void pending.catch(() => {});
        await vi.waitFor(async () =>
          expect((await f.runtime.snapshot()).pendingQueues?.totalCount).toBe(
            1,
          ),
        );
      }
      expect(await f.api.abort(f.sessionId)).toEqual({
        steering: [],
        followUp: pending ? ["Never resume this pending input."] : [],
      });
      if (pending)
        await expect(pending).rejects.toMatchObject({
          code: "PROMPT_RECOVERED",
        });
      await expect(compacting).resolves.toMatchObject({
        command: "compact",
        outcome: "cancelled",
      });
      const cancelled = await f.runtime.snapshot();
      expect(cancelled.runState).toBe("aborted");
      expect(cancelled.active?.projectionConflict).toBeNull();
      expect(cancelled.pendingQueues?.totalCount).toBe(0);
      expect(
        cancelled.extensionStatuses?.["pi-operation-compaction-count"],
      ).toBe(String(previousCompactions + 1));
      expect(eventsOf(f.runtimeEvents, "compaction_end").at(-1)).toMatchObject({
        aborted: true,
      });
      expect(
        (await readFile(f.sessionFile, "utf8")).match(/"type":"compaction"/g) ??
          [],
      ).toHaveLength(previousCompactions);
      expect(
        requests.mock.calls
          .filter(([command]) =>
            ["clear_queue", "abort"].includes(String(command.type)),
          )
          .map(([command]) => command.type),
      ).toEqual(["clear_queue", "abort"]);
      expect(worker.stop).not.toHaveBeenCalled();
      expect(worker.pid).toBe(pid);
      expect(worker.available).toBe(true);
      await expect(
        f.api.nativeCommand({
          sessionId: f.sessionId,
          command: "compact",
        }),
      ).resolves.toMatchObject({ outcome: "completed" });
      expect(
        (await f.runtime.snapshot()).extensionStatuses?.[
          "pi-operation-compaction-count"
        ],
      ).toBe(String(previousCompactions + 2));
      expect(f.workers).toHaveLength(1);
      expect(worker.pid).toBe(pid);
      expect(worker.stop).not.toHaveBeenCalled();
      expect(
        (await readFile(f.sessionFile, "utf8")).match(/"type":"compaction"/g),
      ).toHaveLength(previousCompactions + 1);
      expect(eventsOf(f.runtimeEvents, "runtime_error")).toEqual([]);
      expect(f.modelRequests).toHaveLength(0);
    },
    20_000,
  );

  it("retires a genuinely unresponsive compaction hook only after native cancellation cannot settle it", async () => {
    const f = await fixture(false, 0);
    const worker = f.workers[0]!;
    const requests = vi.spyOn(worker, "request");
    const compacting = f.api.nativeCommand({
      sessionId: f.sessionId,
      command: "compact",
      argument: "fixture-ignore-cancellation",
    });
    await vi.waitFor(async () =>
      expect(
        (await f.runtime.snapshot()).extensionStatuses?.[
          "pi-operation-compaction-count"
        ],
      ).toBe("1"),
    );
    const abort = f.api.abort(f.sessionId);
    await vi.waitFor(() =>
      expect(
        requests.mock.calls.some(([command]) => command.type === "abort"),
      ).toBe(true),
    );
    expect(worker.stop).not.toHaveBeenCalled();
    await abort;
    await expect(compacting).resolves.toMatchObject({ outcome: "cancelled" });
    expect(worker.stop).toHaveBeenCalledWith("compact");
    expect(worker.available).toBe(false);
    expect(worker.pid).toBeNull();
    expect((await f.runtime.snapshot()).runState).toBe("aborted");
    expect((await f.runtime.snapshot()).active?.projectionConflict).toBeNull();
    expect(await readFile(f.sessionFile, "utf8")).not.toContain(
      '"type":"compaction"',
    );
    expect(f.modelRequests).toHaveLength(0);
  }, 20_000);

  it("reports a committed checkpoint as completed when a later native custom entry and suspended hook race Stop", async () => {
    const f = await fixture(false, 0);
    await compactThenReturnToEarlierPoint(f);
    const worker = f.workers[0]!;
    const compacting = f.api.nativeCommand({
      sessionId: f.sessionId,
      command: "compact",
      argument: "fixture-post-compact",
    });
    void compacting.catch(() => {});
    // Host projection reconciliation may await the still-running compact receipt.
    // Observe the native hook boundary directly, without waiting on that reader.
    await vi.waitFor(() =>
      expect(f.piEvents).toContainEqual(
        expect.objectContaining({
          type: "extension_ui_request",
          method: "setStatus",
          statusKey: "pi-operation-compaction",
          statusText: "persisted-waiting",
        }),
      ),
    );
    await f.api.abort(f.sessionId);
    await expect(compacting).resolves.toMatchObject({ outcome: "completed" });
    expect((await f.runtime.snapshot()).runState).toBe("idle");
    expect(eventsOf(f.runtimeEvents, "compaction_end").at(-1)).toMatchObject({
      result: {},
    });
    expect(
      eventsOf(f.runtimeEvents, "compaction_end").at(-1)!.aborted,
    ).not.toBe(true);
    expect(worker.stop).toHaveBeenCalledWith("compact");
    const entries = (await readFile(f.sessionFile, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line)) as SessionEntry[];
    const compactions = entries.filter((entry) => entry.type === "compaction");
    expect(compactions).toHaveLength(2);
    expect(compactions.at(-1)?.parentId).toBe("00000008");
    expect(entries.at(-1)).toMatchObject({
      type: "custom",
      customType: "fixture-after-compaction",
    });
    expect(f.modelRequests).toHaveLength(0);
  }, 20_000);
});
