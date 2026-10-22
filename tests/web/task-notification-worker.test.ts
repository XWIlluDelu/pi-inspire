// @vitest-environment node
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { MessageChannel, type MessagePort } from "node:worker_threads";
import { describe, expect, it, vi } from "vitest";
import type { TaskNotification } from "../../shared/notifications";

const script = await readFile(
  new URL("../../public/service-worker.js", import.meta.url),
  "utf8",
);
const origin = "https://inspire.test";
const notification = (id = "run-one"): TaskNotification => ({
  id,
  sessionId: "session / one",
  outcome: "completed",
  createdAt: Date.now(),
});
function windowClient(sessionId: string, focused = true) {
  return {
    url: origin + "/",
    visibilityState: "visible",
    focused,
    focus: vi.fn(async () => {}),
    postMessage: vi.fn((_message: unknown, ports?: MessagePort[]) => {
      ports?.[0]?.postMessage({ sessionId, foreground: focused });
      ports?.[0]?.close();
    }),
  };
}
function fixture(history = new Map<string, number>()) {
  type Event = {
    waitUntil(value: Promise<unknown>): void;
    [key: string]: unknown;
  };
  const listeners = new Map<string, (event: Event) => void>();
  const windows: ReturnType<typeof windowClient>[] = [];
  const show = vi.fn(
    async (_title: string, _options: NotificationOptions) => {},
  );
  const openWindow = vi.fn(async (_url: string) => {});
  const context = {
    URL,
    Date,
    MessageChannel,
    setTimeout,
    clearTimeout,
    self: {
      location: new URL(origin + "/service-worker.js"),
      addEventListener: (type: string, listener: (event: Event) => void) =>
        listeners.set(type, listener),
      registration: { showNotification: show },
      clients: { matchAll: async () => windows, openWindow },
    },
    // The platform storage boundary is stubbed; the real worker's queue, display,
    // foreground checks and routing are executed unchanged.
    notificationHistory: async (id: string, time?: number) =>
      time === undefined ? history.get(id) : history.set(id, time),
  };
  const storage = context.notificationHistory;
  runInNewContext(script, context);
  context.notificationHistory = storage;
  async function dispatch(type: string, fields: Record<string, unknown>) {
    let work: Promise<unknown> | undefined;
    listeners.get(type)!({
      ...fields,
      waitUntil: (value) => {
        work = value;
      },
    });
    await work;
  }
  const local = async (data: TaskNotification) => {
    const reply = vi.fn();
    await dispatch("message", {
      data: { type: "inspire-notification-display", notification: data },
      source: { url: origin + "/" },
      ports: [{ postMessage: reply }],
    });
    return reply.mock.calls[0]?.[0];
  };
  return {
    show,
    windows,
    openWindow,
    local,
    push: (data: TaskNotification) =>
      dispatch("push", {
        data: { json: () => ({ type: "inspire-task", ...data }) },
      }),
    click: (data: Record<string, unknown>) =>
      dispatch("notificationclick", { notification: { data, close: vi.fn() } }),
  };
}

describe("task notification service worker", () => {
  it("coordinates simultaneous windows and remembers a displayed outcome across worker restarts", async () => {
    const history = new Map<string, number>();
    const worker = fixture(history);
    await Promise.all([
      worker.local(notification()),
      worker.local(notification()),
    ]);
    expect(worker.show).toHaveBeenCalledOnce();
    const restarted = fixture(history);
    await restarted.local(notification());
    expect(restarted.show).not.toHaveBeenCalled();
    await restarted.local(notification("next-run"));
    expect(restarted.show).toHaveBeenCalledOnce();
  });

  it("consumes viewed work, expires delayed local offers, and leaves a refused display retryable", async () => {
    const worker = fixture();
    worker.windows.push(
      windowClient("elsewhere", false),
      windowClient("session / one"),
    );
    await worker.local(notification());
    expect(worker.show).not.toHaveBeenCalled();
    worker.windows.length = 0;
    await worker.local({
      ...notification("expired"),
      createdAt: Date.now() - 16 * 60_000,
    });
    expect(worker.show).not.toHaveBeenCalled();
    worker.show.mockRejectedValueOnce(new Error("OS refused"));
    expect(await worker.local(notification("retry"))).toHaveProperty("error");
    await worker.local(notification("retry"));
    expect(worker.show).toHaveBeenCalledTimes(2);
  });

  it("displays every received push with stable non-renotifying tags and suppresses late page copies", async () => {
    const worker = fixture();
    worker.windows.push(windowClient("session / one"));
    await worker.push(notification());
    await worker.push(notification());
    expect(worker.show).toHaveBeenCalledTimes(2);
    for (const call of worker.show.mock.calls)
      expect(call).toEqual([
        "Task completed",
        expect.objectContaining({
          tag: "inspire-task:run-one",
          renotify: false,
        }),
      ]);
    await worker.local(notification());
    expect(worker.show).toHaveBeenCalledTimes(2);
  });

  it("routes clicks through a focused window or a credential-free cold launch", async () => {
    const worker = fixture();
    const background = windowClient("other", false),
      foreground = windowClient("current");
    worker.windows.push(background, foreground);
    await worker.click({
      sessionId: "session / one",
      url: "https://untrusted.invalid/",
    });
    expect(foreground.focus).toHaveBeenCalledOnce();
    expect(foreground.postMessage).toHaveBeenCalledWith({
      type: "inspire-notification-open",
      sessionId: "session / one",
    });
    expect(background.focus).not.toHaveBeenCalled();
    expect(worker.openWindow).not.toHaveBeenCalled();
    worker.windows.length = 0;
    await worker.click({ sessionId: "session / one" });
    expect(worker.openWindow).toHaveBeenCalledWith(
      "/#inspire-session=session%20%2F%20one",
    );
  });
});
