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
  grouping: "session",
  groupingUpdatedAt: 0,
  notificationOwner: "current-host",
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
type VisibleNotifications = Map<
  string,
  {
    title: string;
    options: TaskNotificationOptions;
    close: () => void;
  }
>;
function fixture(
  records = new Map<string, Map<string, unknown>>(),
  visible: VisibleNotifications = new Map(),
) {
  type Event = {
    waitUntil(value: Promise<unknown>): void;
    [key: string]: unknown;
  };
  const listeners = new Map<string, (event: Event) => void>();
  const windows: ReturnType<typeof windowClient>[] = [];
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
    fetch: async () => new Response("current metadata"),
    caches: { match: async () => new Response("cached metadata") },
    self: {
      location: new URL(origin + "/service-worker.js"),
      addEventListener: (type: string, listener: (event: Event) => void) =>
        listeners.set(type, listener),
      registration: { showNotification: show, getNotifications },
      clients: { matchAll: async () => windows, openWindow },
    },
    // The platform storage boundary is stubbed; the real worker's queue, display,
    // foreground checks and routing are executed unchanged.
    notificationState: vi.fn(
      async (store: string, id: string, value?: unknown) => {
        const entries = records.get(store) ?? new Map();
        records.set(store, entries);
        if (value === undefined) return entries.get(id);
        entries.set(id, value);
      },
    ),
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
    fetchAsset: async (path: string) => {
      const respondWith = vi.fn<(response: Promise<Response>) => void>();
      await dispatch("fetch", {
        request: new Request(origin + path),
        respondWith,
      });
      return respondWith.mock.calls[0]?.[0];
    },
    show,
    visible,
    storage,
    restart: (existing?: VisibleNotifications) => fixture(records, existing),
    windows,
    openWindow,
    local,
    push: (data: TaskNotification) =>
      dispatch("push", {
        data: { json: () => ({ type: "inspire-task", ...data }) },
      }),
    configure: async (
      grouping: "session" | "project",
      updatedAt = 1,
      owner = "current-host",
    ) => {
      const reply = vi.fn();
      await dispatch("message", {
        data: {
          type: "inspire-notification-settings",
          grouping,
          updatedAt,
          owner,
        },
        source: { url: origin + "/" },
        ports: [{ postMessage: reply }],
      });
      return reply.mock.calls[0]?.[0];
    },
    click: (data: Record<string, unknown>) =>
      dispatch("notificationclick", { notification: { data, close: vi.fn() } }),
  };
}

function projectNotification(
  sequence: number,
  sessionId = "session-one",
  projectId = "project-one",
): TaskNotification {
  return {
    ...notification("project-run-" + sequence),
    sessionId,
    projectId,
    project: "research",
    sessionName: "Review " + sessionId,
    grouping: "project",
    groupingUpdatedAt: 1,
    createdAt: Date.now() + sequence,
  };
}

it("reads mutable PWA metadata from the Host with an installed shell still cached", async () => {
  const worker = fixture();
  for (const path of [
    "/manifest.webmanifest",
    "/favicon.svg",
    "/app-icon-192.png",
    "/app-icon-512.png",
    "/app-icon-maskable-512.png",
    "/apple-touch-icon.png",
  ]) {
    const response = await worker.fetchAsset(path + "?v=fixture");
    expect(await response?.text(), path).toBe("current metadata");
  }
});

describe("project notification grouping", () => {
  it("keeps project alerts through restart and clears members after dismissal or viewing", async () => {
    const worker = fixture();
    const older = projectNotification(1);
    const newer = {
      ...projectNotification(2, "session-two"),
      outcome: "failed" as const,
    };
    await worker.local(newer);
    const restarted = worker.restart(worker.visible);
    const grouped = () => restarted.visible.get("inspire-project:project-one");
    await restarted.push(older);
    expect(grouped()).toMatchObject({
      title: "Task failed · 2 sessions",
      options: {
        renotify: false,
        data: {
          sessionId: "session-two",
          url: "/#inspire-session=session-two",
        },
      },
    });
    // A new run of an already counted session changes the target and result.
    await restarted.local({ ...projectNotification(3), projectId: undefined });
    expect(grouped()).toMatchObject({
      title: "Task completed · 2 sessions",
      options: { renotify: true, data: { sessionId: "session-one" } },
    });
    await restarted.local(
      projectNotification(4, "session-three", "same-label-different-project"),
    );
    expect(restarted.visible.size).toBe(2);
    expect(grouped()?.title).toBe("Task completed · 2 sessions");

    grouped()!.close();
    await restarted.push(older);
    expect(grouped()).toMatchObject({
      title: "Task completed · Review session-one",
      options: { renotify: false },
    });
    await restarted.local(projectNotification(5, "session-four"));
    expect(grouped()?.title).toBe("Task completed · Review session-four");

    await restarted.local(projectNotification(6, "session-two"));
    restarted.windows.push(windowClient("session-two"));
    await restarted.local(projectNotification(7, "session-two"));
    expect(grouped()).toMatchObject({
      title: "Task completed · Review session-four",
      options: { renotify: false, data: { sessionId: "session-four" } },
    });
    restarted.windows[0] = windowClient("session-four");
    await restarted.local(projectNotification(8, "session-four"));
    expect([...restarted.visible.keys()]).toEqual([
      "inspire-project:same-label-different-project",
    ]);
  });

  it("keeps the active grouping through old pushes, mode changes and Host replacement", async () => {
    const worker = fixture();
    const old = projectNotification(1);
    await worker.local(old);
    await worker.local({
      ...notification("test-choice"),
      sessionId: null,
      test: true,
    });
    await worker.configure("session", 2);
    expect([...worker.visible.keys()]).toEqual(["inspire-task:test-choice"]);

    await worker.local(projectNotification(3));
    await worker.push(old);
    expect(
      worker.visible.get("inspire-session:session-one")?.options.renotify,
    ).toBe(false);
    expect(worker.visible.has("inspire-project:project-one")).toBe(false);

    await worker.configure("project", 3);
    const newest = { ...projectNotification(4), groupingUpdatedAt: 3 };
    await worker.local(newest);
    expect(worker.visible.has("inspire-project:project-one")).toBe(true);
    await worker.configure("session", 0, "new-host");
    await worker.push(newest);
    expect(worker.visible.has("inspire-session:session-one")).toBe(true);
    expect(worker.visible.has("inspire-project:project-one")).toBe(false);
  });
});

describe("task notification service worker", () => {
  it("displays received pushes but only alerts once per outcome and suppresses late page copies", async () => {
    const worker = fixture();
    worker.windows.push(windowClient("session / one"));
    await worker.push(notification());
    await worker.push(notification());
    expect(worker.show).toHaveBeenCalledTimes(2);
    expect(
      worker.show.mock.calls.map(([, options]) => options.renotify),
    ).toEqual([true, false]);
    await worker.local(notification());
    expect(worker.show).toHaveBeenCalledTimes(2);
    const expired = {
      ...notification("expired"),
      sessionId: "expired-session",
      createdAt: Date.now() - 16 * 60_000,
    };
    await worker.local(expired);
    expect(worker.show).toHaveBeenCalledTimes(2);
    await worker.push(expired);
    expect(worker.show.mock.calls.at(-1)![1].renotify).toBe(false);
  });

  it("deduplicates windows and keeps the latest session result through restart and storage failure", async () => {
    const worker = fixture();
    const first = { ...notification(), createdAt: Date.now() - 10 };
    const second = {
      ...notification("run-two"),
      sessionName: "Renamed session",
      outcome: "failed" as const,
      createdAt: first.createdAt + 1,
    };
    await Promise.all([worker.local(first), worker.local(first)]);
    expect(worker.show).toHaveBeenCalledOnce();
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
    const restarted = worker.restart();
    await restarted.local(second);
    expect(restarted.show).not.toHaveBeenCalled();
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

    const persist = worker.storage.getMockImplementation()!;
    worker.storage.mockImplementation(async (store, id, value) => {
      if (value === undefined) throw new Error("Storage unavailable");
      return persist(store, id, value);
    });
    await worker.push(first);
    expect(worker.show).toHaveBeenCalledTimes(4);
    expect(worker.show).toHaveBeenLastCalledWith(
      "Task failed · Renamed session",
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
    const restarted = worker.restart();
    await restarted.push(old);
    expect(restarted.show).toHaveBeenLastCalledWith(
      "Task completed · Unnamed session",
      expect.objectContaining({ renotify: false }),
    );
  });

  it("keeps the session notification until its project replacement displays", async () => {
    const worker = fixture();
    await worker.local({ ...projectNotification(1), projectId: undefined });
    const next = projectNotification(2);
    worker.show.mockRejectedValueOnce(new Error("OS refused"));
    expect(await worker.local(next)).toHaveProperty("error");
    expect([...worker.visible.keys()]).toEqual(["inspire-session:session-one"]);
    await worker.local(next);
    expect([...worker.visible.keys()]).toEqual(["inspire-project:project-one"]);
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
