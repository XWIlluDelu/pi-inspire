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
type TaskNotificationOptions = NotificationOptions & { renotify?: boolean };
const notification = (id = "run-one"): TaskNotification => ({
  id,
  sessionId: "session / one",
  outcome: "completed",
  sessionName: "Review results",
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
function fixture(
  history = new Map<string, number>(),
  latest = new Map<string, unknown>(),
) {
  type Event = {
    waitUntil(value: Promise<unknown>): void;
    [key: string]: unknown;
  };
  const listeners = new Map<string, (event: Event) => void>();
  const windows: ReturnType<typeof windowClient>[] = [];
  const visible = new Map<
    string,
    {
      title: string;
      options: TaskNotificationOptions;
      close: ReturnType<typeof vi.fn>;
    }
  >();
  const show = vi.fn(
    async (title: string, options: TaskNotificationOptions) => {
      visible.set(options.tag!, {
        title,
        options,
        close: vi.fn(() => visible.delete(options.tag!)),
      });
    },
  );
  const getNotifications = vi.fn(async () =>
    [...visible].map(([tag, notification]) => ({
      tag,
      data: notification.options.data,
      close: notification.close,
    })),
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
      registration: { showNotification: show, getNotifications },
      clients: { matchAll: async () => windows, openWindow },
    },
    // The platform storage boundary is stubbed; the real worker's queue, display,
    // foreground checks and routing are executed unchanged.
    notificationState: async (store: string, id: string, value?: unknown) => {
      const records = store === "handled" ? history : latest;
      return value === undefined
        ? records.get(id)
        : (records as Map<string, unknown>).set(id, value);
    },
  };
  const storage = context.notificationState;
  runInNewContext(script, context);
  context.notificationState = storage;
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
    visible,
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
    await restarted.local({
      ...notification("next-run"),
      createdAt: Date.now() + 1,
    });
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

  it("displays received pushes but only alerts once per outcome and suppresses late page copies", async () => {
    const worker = fixture();
    worker.windows.push(windowClient("session / one"));
    await worker.push(notification());
    await worker.push(notification());
    expect(worker.show).toHaveBeenCalledTimes(2);
    expect(
      worker.show.mock.calls.map(([title, options]) => [
        title,
        options.tag,
        options.renotify,
      ]),
    ).toEqual([
      [
        "Task completed · Review results",
        "inspire-session:session / one",
        true,
      ],
      [
        "Task completed · Review results",
        "inspire-session:session / one",
        false,
      ],
    ]);
    await worker.local(notification());
    expect(worker.show).toHaveBeenCalledTimes(2);
    await worker.push({
      ...notification("expired-push"),
      sessionId: "expired-session",
      createdAt: Date.now() - 16 * 60_000,
    });
    expect(worker.show.mock.calls.at(-1)![1].renotify).toBe(false);
  });

  it("replaces only the same session, uses its latest name, and keeps delayed results from winning after restart", async () => {
    const history = new Map<string, number>();
    const latest = new Map<string, unknown>();
    const worker = fixture(history, latest);
    const first = { ...notification(), createdAt: Date.now() - 10 };
    const second = {
      ...notification("run-two"),
      sessionName: "Renamed session",
      outcome: "failed" as const,
      createdAt: first.createdAt + 1,
    };
    await worker.local(first);
    await worker.local(second);
    await worker.local({
      ...notification("other"),
      sessionId: "other-session",
      createdAt: first.createdAt,
    });
    expect(worker.visible.size).toBe(2);
    expect(worker.visible.get("inspire-session:session / one")?.title).toBe(
      "Task failed · Renamed session",
    );
    expect(worker.show.mock.calls[1]![1].renotify).toBe(true);
    const restarted = fixture(history, latest);
    await restarted.push(first);
    expect(restarted.show).toHaveBeenLastCalledWith(
      "Task failed · Renamed session",
      expect.objectContaining({
        tag: "inspire-session:session / one",
        renotify: false,
      }),
    );
    await restarted.local(first);
    expect(restarted.show).toHaveBeenCalledOnce();
  });

  it("still displays received pushes when storage reads fail, retaining visible newer content", async () => {
    const history = new Map<string, number>();
    const latest = new Map<string, unknown>();
    const worker = fixture(history, latest);
    const old = { ...notification(), createdAt: Date.now() - 10 };
    await worker.local({
      ...old,
      id: "newer",
      outcome: "failed",
      createdAt: old.createdAt + 1,
    });
    for (const records of [history, latest])
      vi.spyOn(records, "get").mockImplementation(() => {
        throw new Error("Storage unavailable");
      });
    await worker.push(old);
    expect(worker.show).toHaveBeenLastCalledWith(
      "Task failed · Review results",
      expect.objectContaining({ renotify: false }),
    );
  });

  it("remembers a newer viewed outcome and replays its content, not a delayed older push", async () => {
    const worker = fixture();
    const old = { ...notification(), createdAt: Date.now() - 10 };
    await worker.local(old);
    worker.windows.push(windowClient(old.sessionId!));
    await worker.local({
      ...old,
      id: "viewed",
      sessionName: "",
      createdAt: old.createdAt + 1,
    });
    expect(worker.visible.size).toBe(0);
    expect(worker.show).toHaveBeenCalledOnce();
    await worker.push(old);
    expect(worker.show).toHaveBeenLastCalledWith(
      "Task completed · Unnamed session",
      expect.objectContaining({ renotify: false }),
    );
  });

  it("retires this session's legacy notification only after replacement succeeds and keeps tests separate", async () => {
    const worker = fixture();
    await worker.show("Old notification", {
      tag: "inspire-task:legacy",
      data: { sessionId: "session / one" },
    });
    worker.show.mockRejectedValueOnce(new Error("OS refused"));
    expect(await worker.local(notification())).toHaveProperty("error");
    expect(worker.visible.has("inspire-task:legacy")).toBe(true);
    await worker.local(notification());
    expect(worker.visible.has("inspire-task:legacy")).toBe(false);
    await worker.local({
      ...notification("test"),
      sessionId: null,
      test: true,
    });
    expect(worker.visible.size).toBe(2);
    expect(worker.show).toHaveBeenLastCalledWith(
      "Inspire test notification",
      expect.objectContaining({ tag: "inspire-task:test", renotify: false }),
    );
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
