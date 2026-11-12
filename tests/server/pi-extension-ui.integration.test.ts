import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { nativeSessionWorkbench } from "./fixtures/native-session-workbench.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.reverse()) await close();
  cleanup.length = 0;
  vi.unstubAllEnvs();
});

it("expires native replies and cancels only the requests already owned by a retained worker", async () => {
  const directory = await mkdtemp(join(tmpdir(), "inspire-native-ui-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const background = join(directory, "background-ui.ts");
  await writeFile(
    background,
    `
    export default pi => {
      pi.registerCommand("fixture-background-ui", { handler: async (_, ctx) => {
        ctx.ui.setTitle("Native extension title");
        ctx.ui.setEditorText("Native extension draft");
        void (async () => {
          const answer = await ctx.ui.confirm("Stop question", "Cancel the actual Pi promise");
          ctx.ui.setStatus("fixture.stop", String(answer));
          await ctx.ui.input("Independent next question");
          ctx.ui.setStatus("fixture.stop", "finished");
        })();
      } });
    }
  `,
  );
  const { id, runtime, workers } = await nativeSessionWorkbench(cleanup, {
    extraExtensions: [resolve("docs/examples/native-ui.ts"), background],
  });
  const events: Array<Record<string, unknown>> = [];
  runtime.on("event", (event: Record<string, unknown>) => events.push(event));
  const snapshot = () => runtime.snapshot(id);
  const send = (message: string) => runtime.prompt({ sessionId: id, message });
  const question = async (title: string) => {
    const read = async () =>
      (await snapshot()).pendingExtensionUiRequests?.find(
        (request) => request.title === title,
      );
    await vi.waitFor(async () => expect(await read()).toBeDefined());
    return (await read())!;
  };
  await vi.waitFor(
    async () =>
      expect((await snapshot()).active?.commands).toContainEqual(
        expect.objectContaining({ name: "fixture-background-ui" }),
      ),
    { timeout: 10_000 },
  );
  const worker = workers[0]!;
  const pid = worker.pid;
  const waiting = send("/ui-demo timeout 1200");
  void waiting.catch(() => {});
  const timed = await question("Timed note");
  expect(timed.expiresAt).toBeGreaterThan(Date.now());
  await waiting;
  await vi.waitFor(async () =>
    expect((await snapshot()).pendingExtensionUiRequests).toEqual([]),
  );
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "extension_ui_remove",
      id: timed.id,
      reason: "expired",
    }),
  );
  await expect(
    runtime.extensionUiResponse({ sessionId: id, id: timed.id, value: "late" }),
  ).rejects.toThrow(/no longer pending/);

  await send("/fixture-background-ui");
  const stopped = await question("Stop question");
  expect(events).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: "extension_ui_request",
        sessionId: id,
        method: "setTitle",
        title: "Native extension title",
      }),
      expect.objectContaining({
        type: "extension_ui_request",
        sessionId: id,
        method: "set_editor_text",
        text: "Native extension draft",
      }),
    ]),
  );
  await runtime.abort(id);
  const next = await question("Independent next question");
  expect(next.id).not.toBe(stopped.id);
  expect((await snapshot()).extensionStatuses).toMatchObject({
    "fixture.stop": "false",
  });
  expect(worker.pid).toBe(pid);
  expect(worker.available).toBe(true);
  await runtime.extensionUiResponse({
    sessionId: id,
    id: next.id,
    cancelled: true,
  });
  await vi.waitFor(async () =>
    expect((await snapshot()).extensionStatuses).toMatchObject({
      "fixture.stop": "finished",
    }),
  );
}, 30_000);
