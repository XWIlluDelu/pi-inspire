import { resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  readTaskBoard,
  TASK_BOARD_TYPE,
} from "../../docs/examples/task-board/types.js";
import { nativeSessionWorkbench } from "./fixtures/native-session-workbench.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.reverse()) await close();
  cleanup.length = 0;
  vi.unstubAllEnvs();
});

it("runs native task commands and restores each branch's own task state", async () => {
  const f = await nativeSessionWorkbench(cleanup, {
    extraExtensions: [resolve("docs/examples/task-board/extension.ts")],
  });
  const send = (message: string) =>
    f.runtime.prompt({ sessionId: f.id, message });
  const data = async () => {
    const messages = (await f.runtime.snapshot(f.id)).active!.transcriptPage
      .messages as Array<{
      role: string;
      customType?: string;
      details?: unknown;
    }>;
    const message = [...messages]
      .reverse()
      .find(
        (message) =>
          message.role === "custom" && message.customType === TASK_BOARD_TYPE,
      );
    return readTaskBoard(message?.details)!;
  };
  await vi.waitFor(
    async () =>
      expect((await f.runtime.snapshot(f.id)).active?.commands).toContainEqual(
        expect.objectContaining({ name: "demo-tasks-start" }),
      ),
    { timeout: 10000 },
  );
  await send("/demo-tasks-start");
  expect((await data()).tasks).toHaveLength(3);
  expect((await data()).tasks[0]).toMatchObject({
    status: "running",
    capabilities: { stop: true, retry: false, open: true },
  });
  await send("/demo-tasks-show");
  const native = await f.workers[0]!.request<{
    entries: Array<{ id: string; customType?: string }>;
  }>({ type: "get_entries" });
  const original = native.entries.findLast(
    (entry) => entry.customType === TASK_BOARD_TYPE,
  )!.id;
  await send("/demo-tasks-stop task-1");
  expect((await data()).tasks[0]).toMatchObject({
    status: "stopped",
    capabilities: { stop: false, retry: true },
  });
  await send("/demo-tasks-retry task-1");
  expect((await data()).tasks[0]!.status).toBe("running");
  const opening = send("/demo-tasks-open task-1");
  await vi.waitFor(async () =>
    expect(
      (await f.runtime.snapshot(f.id)).pendingExtensionUiRequests?.[0]?.method,
    ).toBe("editor"),
  );
  const request = (await f.runtime.snapshot(f.id))
    .pendingExtensionUiRequests![0]!;
  await f.runtime.extensionUiResponse({
    sessionId: f.id,
    id: request.id,
    value: "Keep these task notes",
  });
  await opening;
  expect((await data()).tasks[0]!.notes).toBe("Keep these task notes");
  await f.runtime.nativeCommand({ sessionId: f.id, command: "reload" });
  await send("/demo-tasks-show");
  expect((await data()).tasks.every((task) => task.status === "stopped")).toBe(
    true,
  );
  expect((await data()).tasks[0]!.notes).toBe("Keep these task notes");

  const showBranch = async (targetId: string) => {
    const tree = await f.runtime.branchTree(f.id);
    await f.runtime.navigateBranch({
      sessionId: f.id,
      revision: tree.revision,
      targetId,
      mode: "edit",
      summarize: false,
    });
    await send("/demo-tasks-show");
    return (await data()).tasks;
  };
  expect(await showBranch("00000004")).toEqual([]);
  const restored = await showBranch(original);
  expect(restored).toHaveLength(3);
  expect(restored.map(({ status, notes }) => ({ status, notes }))).toEqual(
    Array.from({ length: 3 }, () => ({ status: "stopped", notes: "" })),
  );
});
