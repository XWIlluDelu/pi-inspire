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

it("restores task state from the selected native branch instead of publishing another branch's work", async () => {
  const f = await nativeSessionWorkbench(cleanup, {
    extraExtensions: [resolve("docs/examples/task-board/extension.ts")],
  });
  await vi.waitFor(
    async () =>
      expect((await f.runtime.snapshot(f.id)).active?.commands).toContainEqual(
        expect.objectContaining({ name: "demo-tasks-start" }),
      ),
    { timeout: 10000 },
  );
  const send = (message: string) =>
    f.runtime.prompt({ sessionId: f.id, message });
  const board = async () => {
    const messages = (await f.runtime.snapshot(f.id)).active!.transcriptPage
      .messages as Array<{ customType?: string; details?: unknown }>;
    return readTaskBoard(
      [...messages]
        .reverse()
        .find((message) => message.customType === TASK_BOARD_TYPE)?.details,
    );
  };
  await send("/demo-tasks-start");
  // A second snapshot lets native Edit from here return before this display
  // while retaining the preceding saved task state on the original branch.
  await send("/demo-tasks-show");
  const native = await f.workers[0]!.request<{
    entries: Array<{ id: string; type: string; customType?: string }>;
  }>({ type: "get_entries" });
  const original = [...native.entries]
    .reverse()
    .find((entry) => entry.customType === TASK_BOARD_TYPE)!.id;
  const navigate = async (targetId: string, mode: "edit" | "switch") => {
    const tree = await f.runtime.branchTree(f.id);
    await f.runtime.navigateBranch({
      sessionId: f.id,
      revision: tree.revision,
      targetId,
      mode,
      summarize: false,
    });
  };
  await navigate("00000004", "edit");
  await send("/demo-tasks-show");
  expect((await board())?.tasks).toEqual([]);
  await navigate(original, "edit");
  await send("/demo-tasks-show");
  expect((await board())?.tasks).toHaveLength(3);
  expect(
    (await board())?.tasks.every((task) => task.status === "stopped"),
  ).toBe(true);
});

it("runs the source DIY example's real commands, notes dialog and session-scoped reload", async () => {
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
});
