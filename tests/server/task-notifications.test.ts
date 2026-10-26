import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type webPush from "web-push";
import {
  pushSubscriptionSchema,
  TaskNotifications,
  TaskOutcomeTracker,
} from "../../server/task-notifications.js";
import type { TaskNotification } from "../../shared/notifications.js";

const directories: string[] = [];
const services: TaskNotifications[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
  await Promise.all(
    directories
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
  vi.useRealTimers();
});
const principal = { id: "browser-one", origin: "https://inspire.test" };
const other = { id: "browser-two", origin: "https://inspire.test" };
const subscription = {
  endpoint: "https://fcm.googleapis.com/fcm/send/test",
  keys: { p256dh: "B".repeat(87), auth: "A".repeat(22) },
};
async function fixture(
  sessionName?: (
    id: string,
  ) => Promise<{ name?: string; cwd: string } | undefined>,
) {
  const directory = await mkdtemp(join(tmpdir(), "inspire-notifications-"));
  directories.push(directory);
  const path = join(directory, "notifications.json");
  const send = vi.fn<typeof webPush.sendNotification>(async () => ({
    statusCode: 201,
    headers: {},
    body: "",
  }));
  const service = new TaskNotifications(path, send, sessionName);
  services.push(service);
  return { path, service, send };
}
function run(service: TaskNotifications, id = "s1", failed = false) {
  service.observe({ type: "agent_start", sessionId: id });
  service.observe({
    type: "agent_settled",
    sessionId: id,
    taskProject: "research",
    taskSessionName: "Review results",
    sessionStatus: { runState: failed ? "failed" : "idle" },
    title: "PRIVATE PROMPT",
  });
}

describe("Host task outcome ownership", () => {
  it("owns one result across retry and nested compaction, ignores history and explicit cancellation", () => {
    const tracker = new TaskOutcomeTracker();
    const observe = (type: string, extra = {}) =>
      tracker.observe({ type, sessionId: "s", ...extra });
    expect(observe("agent_settled")).toBeNull();
    expect(observe("agent_start")).toBeNull();
    expect(observe("auto_retry_start")).toBeNull();
    expect(observe("compaction_start", { reason: "auto" })).toBeNull();
    expect(observe("compaction_end", { result: {} })).toBeNull();
    const result = observe("agent_settled", {
      sessionStatus: { runState: "failed" },
      taskProject: "project",
      taskSessionName: "  Review\n results  ",
      title: "PRIVATE",
    });
    expect(result).toMatchObject({
      outcome: "failed",
      project: "project",
      sessionName: "Review results",
      sessionId: "s",
    });
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
    expect(observe("agent_settled")).toBeNull();
    observe("agent_start");
    expect(
      observe("agent_settled", {
        aborted: true,
        sessionStatus: { runState: "aborted" },
      }),
    ).toBeNull();
    observe("compaction_start", { reason: "manual" });
    expect(
      observe("compaction_end", { errorMessage: "Timed out" })?.outcome,
    ).toBe("failed");
    observe("agent_start");
    expect(observe("runtime_error")?.outcome).toBe("failed");
  });

  it("orders results even when the clock does not advance", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const tracker = new TaskOutcomeTracker();
    tracker.observe({ type: "agent_start", sessionId: "s" });
    const first = tracker.observe({ type: "agent_settled", sessionId: "s" })!;
    tracker.observe({ type: "agent_start", sessionId: "s" });
    const second = tracker.observe({ type: "agent_settled", sessionId: "s" })!;
    expect(second.createdAt).toBeGreaterThan(first.createdAt);
  });

  it("retains unknown native endings and deduplicates explicit reporter evidence", () => {
    const tracker = new TaskOutcomeTracker();
    tracker.observe({ type: "agent_start", sessionId: "s" });
    expect(
      tracker.observe({
        type: "agent_settled",
        sessionId: "s",
        outcomeUnknown: true,
        sessionStatus: { runState: "failed" },
      })?.outcome,
    ).toBe("ended");
    const event = {
      type: "native_task_outcome",
      sessionId: "s",
      outcomeId: "receiver:run",
      outcome: "failed",
    };
    expect(tracker.observe(event)?.outcome).toBe("failed");
    expect(tracker.observe(event)).toBeNull();
  });
});

describe("installation-owned notification delivery", () => {
  it("persists grouping independently of mode/enrollment and decorates delivery with current device policy", async () => {
    const { service, path, send } = await fixture(async () => ({
      name: "Review",
      cwd: "/private/research",
    }));
    expect(await service.settings(principal)).toMatchObject({
      grouping: "session",
      groupingUpdatedAt: 0,
    });
    await service.configure(principal, "desktop", subscription);
    await service.configure(other, "title");
    const configured = await service.configure(
      principal,
      undefined,
      undefined,
      "project",
    );
    expect(configured).toMatchObject({
      mode: "desktop",
      subscribed: true,
      grouping: "project",
    });
    expect(configured.groupingUpdatedAt).toBeGreaterThan(0);
    expect(await service.settings(other)).toMatchObject({
      mode: "title",
      grouping: "session",
    });
    run(service);
    await vi.waitFor(async () =>
      expect(JSON.parse(await readFile(path, "utf8")).pending).toHaveLength(2),
    );
    await service.configure(other, undefined, undefined, "project");
    expect(JSON.parse(await readFile(path, "utf8")).pending).toHaveLength(2);
    await service.close();
    const restarted = new TaskNotifications(path, send);
    services.push(restarted);
    expect(await restarted.settings(principal)).toMatchObject({
      grouping: "project",
      subscribed: true,
    });
    const events: TaskNotification[] = [];
    restarted.attach(principal, (event) => {
      if (event.type === "task_notification") events.push(event.notification);
      return true;
    });
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]).toMatchObject({
      grouping: "project",
      groupingUpdatedAt: configured.groupingUpdatedAt,
    });
    expect(events[0]?.notificationOwner).toBe(configured.publicKey);
    expect(JSON.stringify(events)).not.toContain("/private/");
    const changed = await restarted.configure(
      principal,
      undefined,
      undefined,
      "session",
    );
    expect(changed.groupingUpdatedAt).toBeGreaterThan(
      configured.groupingUpdatedAt,
    );
    expect(changed).toMatchObject({ mode: "desktop", subscribed: true });
  });

  it("uses stable private project identities instead of colliding cwd labels", async () => {
    const { service, path } = await fixture(async (id) => ({
      cwd: id === "elsewhere" ? "/other/research" : "/private/research",
    }));
    await service.configure(principal, "title");
    for (const id of ["same-one", "same-two", "elsewhere"]) run(service, id);
    await vi.waitFor(async () =>
      expect(JSON.parse(await readFile(path, "utf8")).pending).toHaveLength(3),
    );
    const events = JSON.parse(await readFile(path, "utf8")).pending.map(
      (item: { event: TaskNotification }) => item.event,
    );
    const bySession = new Map<string, TaskNotification>(
      events.map((event: TaskNotification) => [event.sessionId, event]),
    );
    expect(bySession.get("same-one")?.projectId).toBe(
      bySession.get("same-two")?.projectId,
    );
    expect(bySession.get("same-one")?.projectId).not.toBe(
      bySession.get("elsewhere")?.projectId,
    );
    expect(
      events.every((event: TaskNotification) => event.project === "research"),
    ).toBe(true);
    expect(JSON.stringify(events)).not.toContain("/private/");
    expect(JSON.stringify(events)).not.toContain("/other/");
  });

  it("retains an outcome across browser and Host reconnect, with device-bound acknowledgment", async () => {
    const { path, service, send } = await fixture();
    await service.configure(principal, "desktop");
    await service.configure(other, "title");
    run(service);
    await vi.waitFor(async () =>
      expect(JSON.parse(await readFile(path, "utf8")).pending).toHaveLength(2),
    );
    await service.close();
    const replacement = new TaskNotifications(path, send);
    services.push(replacement);
    const received: TaskNotification[] = [];
    replacement.attach(principal, (event) => {
      if (event.type === "task_notification") received.push(event.notification);
      return true;
    });
    await vi.waitFor(() => expect(received).toHaveLength(1));
    await replacement.acknowledge(other, received[0]!.id);
    const again: TaskNotification[] = [];
    replacement.attach(principal, (event) => {
      if (event.type === "task_notification") again.push(event.notification);
      return true;
    });
    await vi.waitFor(() => expect(again).toHaveLength(1));
    await replacement.acknowledge(principal, received[0]!.id);
    expect(JSON.parse(await readFile(path, "utf8")).pending).toEqual([]);
    if (process.platform !== "win32")
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(send).not.toHaveBeenCalled();
  });

  it("pushes after a missing live acknowledgment but not after viewed acknowledgment", async () => {
    const { service, send } = await fixture();
    await service.configure(principal, "desktop", subscription);
    const received: TaskNotification[] = [];
    service.attach(principal, (event) => {
      if (event.type === "task_notification") received.push(event.notification);
      return true;
    });
    run(service);
    await vi.waitFor(() => expect(received).toHaveLength(1));
    await service.acknowledge(principal, received[0]!.id);
    run(service, "s2", true);
    await vi.waitFor(() => expect(received).toHaveLength(2));
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce(), {
      timeout: 4_000,
    });
    expect(JSON.parse(String(send.mock.calls[0]![1]))).toMatchObject({
      type: "inspire-task",
      outcome: "failed",
      sessionId: "s2",
      sessionName: "Review results",
    });
    expect(send.mock.calls[0]![1]).not.toContain("PRIVATE PROMPT");
    await service.configure(principal, "off", null);
    expect((await service.settings(principal)).subscribed).toBe(false);
  });

  it("resolves current saved names without relying on a live browser or transcript", async () => {
    const name = vi.fn(async () => ({
      name: "  Native\n renamed  ",
      cwd: "/private/research",
    }));
    const { service, path } = await fixture(name);
    run(service);
    await service.settings(principal);
    expect(name).not.toHaveBeenCalled();
    await service.configure(principal, "desktop", subscription);
    run(service);
    await vi.waitFor(async () =>
      expect(
        JSON.parse(await readFile(path, "utf8")).pending[0]?.event.sessionName,
      ).toBe("Native renamed"),
    );
    expect(name).toHaveBeenCalledWith("s1");
    name.mockRejectedValueOnce(new Error("Temporary metadata read failure"));
    run(service);
    await vi.waitFor(async () =>
      expect(
        JSON.parse(await readFile(path, "utf8")).pending[0]?.event.sessionName,
      ).toBe("Review results"),
    );
  });

  it("retains only the latest undelivered result per device/session across restart", async () => {
    const { service, path, send } = await fixture();
    await service.configure(principal, "desktop", subscription);
    run(service);
    await vi.waitFor(async () =>
      expect(JSON.parse(await readFile(path, "utf8")).pending).toHaveLength(1),
    );
    run(service, "s1", true);
    await vi.waitFor(async () =>
      expect(
        JSON.parse(await readFile(path, "utf8")).pending[0].event.outcome,
      ).toBe("failed"),
    );
    run(service, "s2");
    await vi.waitFor(async () =>
      expect(JSON.parse(await readFile(path, "utf8")).pending).toHaveLength(2),
    );
    await service.close();
    const restarted = new TaskNotifications(path, send);
    services.push(restarted);
    const received: TaskNotification[] = [];
    restarted.attach(principal, (event) => {
      if (event.type === "task_notification") received.push(event.notification);
      return true;
    });
    await vi.waitFor(() => expect(received).toHaveLength(2));
    expect(
      received.map(({ sessionId, outcome }) => [sessionId, outcome]),
    ).toEqual([
      ["s1", "failed"],
      ["s2", "completed"],
    ]);
  });

  it("retains known transport failures through refresh, recovers, and retires expired subscriptions", async () => {
    const { service, send } = await fixture();
    await service.configure(principal, "desktop", subscription);
    send.mockRejectedValueOnce(new Error("PRIVATE ENDPOINT"));
    await expect(service.test(principal)).rejects.toThrow("push service");
    await service.configure(principal, "desktop", subscription);
    expect((await service.settings(principal)).error).toContain("push service");
    await service.test(principal);
    expect((await service.settings(principal)).error).toBeNull();
    send.mockRejectedValueOnce(
      Object.assign(new Error("PRIVATE ENDPOINT"), { statusCode: 410 }),
    );
    await expect(service.test(principal)).rejects.toThrow(
      "subscription expired",
    );
    expect(await service.settings(principal)).toMatchObject({
      subscribed: false,
      endpoint: subscription.endpoint,
      error: expect.stringContaining("expired"),
    });
    // A refresh must not resurrect an endpoint already rejected by the vendor.
    await expect(
      service.configure(principal, undefined, subscription),
    ).rejects.toThrow("subscription expired");
    expect(await service.configure(principal, "desktop")).toMatchObject({
      subscribed: false,
      endpoint: subscription.endpoint,
    });
    await service.configure(principal, undefined, {
      ...subscription,
      endpoint: subscription.endpoint + "-renewed",
    });
    await service.test(principal);
    expect(await service.settings(principal)).toMatchObject({
      subscribed: true,
      error: null,
    });
  });

  it("synchronizes device settings without replaying old offers to existing windows", async () => {
    const { service, path } = await fixture();
    await service.configure(principal, "title");
    await service.configure(other, "desktop", subscription);
    const first = vi.fn(() => true),
      second = vi.fn(() => true);
    service.attach(principal, first);
    await vi.waitFor(() =>
      expect(first).toHaveBeenCalledWith(
        expect.objectContaining({ type: "task_alert_settings" }),
      ),
    );
    run(service);
    await vi.waitFor(() => expect(first).toHaveBeenCalledTimes(2));
    service.attach(principal, second);
    await vi.waitFor(() => expect(second).toHaveBeenCalledTimes(2));
    expect(first).toHaveBeenCalledTimes(2);
    await service.configure(principal, "off", null);
    for (const window of [first, second])
      expect(window).toHaveBeenLastCalledWith(
        expect.objectContaining({
          type: "task_alert_settings",
          settings: expect.objectContaining({ mode: "off" }),
        }),
      );
    // Neither delayed enrollment nor a health correction can re-enable intent.
    expect(
      await service.configure(principal, undefined, subscription),
    ).toMatchObject({ mode: "off", subscribed: false });
    expect((await service.configure(principal, undefined, null)).mode).toBe(
      "off",
    );
    expect((await service.settings(other)).subscribed).toBe(true);
    expect(
      JSON.parse(await readFile(path, "utf8")).pending.every(
        (item: { deviceId: string }) => item.deviceId === other.id,
      ),
    ).toBe(true);
  });

  it("expires pending outcomes and does not revive them when system alerts are re-enabled", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { service, path, send } = await fixture();
    await service.configure(principal, "desktop", subscription);
    run(service);
    await vi.waitFor(async () =>
      expect(JSON.parse(await readFile(path, "utf8")).pending).toHaveLength(1),
    );
    vi.setSystemTime(Date.now() + 16 * 60_000);
    const received = vi.fn(() => true);
    service.attach(principal, received);
    await vi.waitFor(() => expect(received).toHaveBeenCalledOnce());
    expect(received.mock.calls[0]).toEqual([
      expect.objectContaining({ type: "task_alert_settings" }),
    ]);
    await service.close();
    const replacement = new TaskNotifications(path, send);
    services.push(replacement);
    await replacement.configure(principal, "desktop", subscription);
    expect(JSON.parse(await readFile(path, "utf8")).pending).toEqual([]);
    run(replacement);
    await vi.waitFor(async () =>
      expect(JSON.parse(await readFile(path, "utf8")).pending).toHaveLength(1),
    );
    await replacement.configure(principal, "title");
    await replacement.configure(principal, "desktop", subscription);
    expect(JSON.parse(await readFile(path, "utf8")).pending).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects arbitrary outbound endpoints and private targets", () => {
    for (const endpoint of [
      "https://127.0.0.1/secret",
      "https://fcm.googleapis.com.evil.test/x",
      "http://fcm.googleapis.com/x",
      "https://user:password@fcm.googleapis.com/x",
    ]) {
      expect(
        pushSubscriptionSchema.safeParse({ ...subscription, endpoint }).success,
      ).toBe(false);
    }
    expect(pushSubscriptionSchema.safeParse(subscription).success).toBe(true);
  });
});
