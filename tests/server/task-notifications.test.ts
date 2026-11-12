import { mkdtemp, rm, stat } from "node:fs/promises";
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

function listen(service: TaskNotifications, device = principal) {
  const offers: TaskNotification[] = [];
  const settings = vi.fn();
  service.attach(device, (event) => {
    if (event.type === "task_notification") offers.push(event.notification);
    else settings(event.settings);
    return true;
  });
  return {
    offers,
    settings,
    ready: () => vi.waitFor(() => expect(settings).toHaveBeenCalled()),
  };
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

  it.each([
    ["exited", true, "ended"],
    ["exited", false, null],
    ["left-session", true, null],
    ["left-branch", true, null],
    ["unreachable", true, null],
  ] as const)(
    "reports a released attachment that %s (during work: %s) as %s, never as failed",
    (reason, duringWork, outcome) => {
      const tracker = new TaskOutcomeTracker();
      tracker.observe({ type: "agent_start", sessionId: "s" });
      expect(
        tracker.observe({
          type: "external_attachment_ended",
          sessionId: "s",
          reason,
          duringWork,
          sessionStatus: { runState: "idle" },
        })?.outcome ?? null,
      ).toBe(outcome);
      // The run is closed either way; a later settlement is not attributed to it.
      expect(
        tracker.observe({ type: "agent_settled", sessionId: "s" }),
      ).toBeNull();
    },
  );
});

describe("installation-owned notification delivery", () => {
  it("replays outcomes with the current device grouping and opaque project identities", async () => {
    const { service, path, send } = await fixture(async (id) => ({
      name: "Review",
      cwd: id === "elsewhere" ? "/other/research" : "/private/research",
    }));
    await service.configure(principal, "desktop", subscription);
    await service.configure(other, "title");
    const live = listen(service);
    await live.ready();
    for (const id of ["same-one", "same-two", "elsewhere"]) run(service, id);
    await vi.waitFor(() => expect(live.offers).toHaveLength(3));
    expect(live.offers[0]?.grouping).toBe("session");
    const configured = await service.configure(
      principal,
      undefined,
      undefined,
      "project",
    );

    await service.close();
    const restarted = new TaskNotifications(path, send);
    services.push(restarted);
    const grouped = listen(restarted);
    const independent = listen(restarted, other);
    await grouped.ready();
    await independent.ready();
    expect(grouped.settings).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "desktop",
        subscribed: true,
        grouping: "project",
      }),
    );
    expect(independent.settings).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "title", grouping: "session" }),
    );
    expect(independent.offers).toHaveLength(3);
    expect(
      independent.offers.every((event) => event.grouping === "session"),
    ).toBe(true);
    expect(grouped.offers).toEqual(
      live.offers.map((event) => ({
        ...event,
        grouping: "project",
        groupingUpdatedAt: configured.groupingUpdatedAt,
        notificationOwner: configured.publicKey,
      })),
    );
    const ids = new Map(
      grouped.offers.map(({ sessionId, projectId }) => [sessionId, projectId]),
    );
    expect(ids.get("same-one")).toBeTruthy();
    expect(ids.get("same-one")).toBe(ids.get("same-two"));
    expect(ids.get("same-one")).not.toBe(ids.get("elsewhere"));
    expect(grouped.offers.every((event) => event.project === "research")).toBe(
      true,
    );
    expect(JSON.stringify(grouped.offers)).not.toMatch(/\/(private|other)\//);
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

  it("resolves the current saved name and falls back when optional metadata fails", async () => {
    const name = vi.fn(async () => ({
      name: "  Native\n renamed  ",
      cwd: "/private/research",
    }));
    const { service } = await fixture(name);
    await service.configure(principal, "title");
    const live = listen(service);
    await live.ready();
    run(service);
    await vi.waitFor(() =>
      expect(live.offers[0]?.sessionName).toBe("Native renamed"),
    );

    name.mockRejectedValueOnce(new Error("Temporary metadata read failure"));
    run(service);
    await vi.waitFor(() =>
      expect(live.offers[1]?.sessionName).toBe("Review results"),
    );
  });

  it("replays current results per installation and forgets acknowledged, expired or disabled alerts", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { service, path, send } = await fixture();
    await service.configure(principal, "desktop", subscription);
    await service.configure(other, "title");
    const { offers: live } = listen(service);
    run(service);
    await vi.waitFor(() => expect(live).toHaveLength(1));
    run(service, "s1", true);
    run(service, "s2");
    await vi.waitFor(() => expect(live).toHaveLength(3));
    const [first, latest, independent] = live;
    expect(latest!.id).not.toBe(first!.id);
    expect(latest!.createdAt).toBeGreaterThan(first!.createdAt);

    await service.close();
    const restarted = new TaskNotifications(path, send);
    services.push(restarted);
    const { offers: replay } = listen(restarted);
    await vi.waitFor(() => expect(replay).toHaveLength(2));
    expect(replay).toEqual([latest, independent]);
    expect(
      replay.map(({ sessionId, outcome }) => [sessionId, outcome]),
    ).toEqual([
      ["s1", "failed"],
      ["s2", "completed"],
    ]);

    await restarted.acknowledge(other, latest!.id);
    const { offers: reconnected } = listen(restarted);
    await vi.waitFor(() => expect(reconnected).toEqual(replay));
    await restarted.acknowledge(principal, latest!.id);
    const { offers: remaining } = listen(restarted);
    await vi.waitFor(() => expect(remaining).toEqual([independent]));

    vi.setSystemTime(Date.now() + 16 * 60_000);
    const expired = listen(restarted);
    await expired.ready();
    expect(expired.offers).toEqual([]);
    await restarted.close();
    const reenrolled = new TaskNotifications(path, send);
    services.push(reenrolled);
    const liveAfterExpiry = listen(reenrolled);
    await liveAfterExpiry.ready();
    expect(liveAfterExpiry.offers).toEqual([]);
    run(reenrolled);
    await vi.waitFor(() => expect(liveAfterExpiry.offers).toHaveLength(1));
    await reenrolled.configure(principal, "off", null);
    await reenrolled.configure(principal, "desktop", subscription);
    const afterEnable = listen(reenrolled);
    await afterEnable.ready();
    expect(afterEnable.offers).toEqual([]);
    if (process.platform !== "win32")
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(send).not.toHaveBeenCalled();
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
    await service.configure(other, "title");
    const live = listen(service);
    const unaffected = listen(service, other);
    await live.ready();
    await unaffected.ready();
    run(service);
    await vi.waitFor(() => expect(live.offers).toHaveLength(1));
    await vi.waitFor(() => expect(unaffected.offers).toHaveLength(1));
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
    const retired = listen(service);
    await retired.ready();
    expect(retired.offers).toEqual([]);
    const secondDevice = listen(service, other);
    await secondDevice.ready();
    expect(secondDevice.offers).toEqual(unaffected.offers);
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

  it("keeps a renewed enrollment and its queued results when an old push expires late", async () => {
    const { service, send } = await fixture();
    await service.configure(principal, "desktop", subscription);
    let rejectPush!: (error: unknown) => void;
    send.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectPush = reject;
        }),
    );
    const pendingTest = expect(service.test(principal)).rejects.toThrow(
      "subscription expired",
    );
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    const renewed = {
      ...subscription,
      endpoint: subscription.endpoint + "-renewed",
    };
    await service.configure(principal, undefined, renewed);
    const { offers } = listen(service);
    run(service);
    await vi.waitFor(() => expect(offers).toHaveLength(1));
    rejectPush(Object.assign(new Error("gone"), { statusCode: 410 }));
    await pendingTest;
    expect(await service.settings(principal)).toMatchObject({
      subscribed: true,
      endpoint: renewed.endpoint,
      error: null,
    });
    const replay = listen(service);
    await replay.ready();
    expect(replay.offers).toEqual(offers);
  });

  it("synchronizes settings without replaying old offers or affecting another device", async () => {
    const { service } = await fixture();
    await service.configure(principal, "title");
    await service.configure(other, "desktop", subscription);
    const first = listen(service);
    await first.ready();
    run(service);
    await vi.waitFor(() => expect(first.offers).toHaveLength(1));
    const second = listen(service);
    await second.ready();
    expect(second.offers).toEqual(first.offers);
    expect(first.offers).toHaveLength(1);

    await service.configure(principal, "off", null);
    for (const window of [first, second])
      expect(window.settings).toHaveBeenLastCalledWith(
        expect.objectContaining({ mode: "off" }),
      );
    // Neither delayed enrollment nor a health correction can re-enable intent.
    expect(
      await service.configure(principal, undefined, subscription),
    ).toMatchObject({
      mode: "off",
      subscribed: false,
    });
    const unaffected = listen(service, other);
    await unaffected.ready();
    expect(unaffected.settings).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "desktop", subscribed: true }),
    );
    expect(unaffected.offers.map(({ id }) => id)).toEqual(
      first.offers.map(({ id }) => id),
    );
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
