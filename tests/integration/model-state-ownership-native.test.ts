// @vitest-environment jsdom
import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { AttachmentStore } from "../../server/attachments";
import { RuntimeController } from "../../server/runtime";
import { SessionCatalog } from "../../server/session-catalog";
import {
  nativePiWorkspace,
  stubNativePiEnvironment,
} from "../server/fixtures/native-pi";
import {
  bootstrapPayload,
  deferred,
  installFakeWebSocket,
  installFetch,
  jsonBody,
} from "../web/helpers";
import { initStore } from "../web/store-fixture";

it("keeps a confirmed native thinking change when an earlier snapshot arrives late in an empty session", async () => {
  const fixture = await nativePiWorkspace("inspire-model-state-owner-", {
    defaultProjectTrust: "never",
    defaultProvider: "global-native",
    defaultModel: "a",
    defaultThinkingLevel: "medium",
    compaction: { enabled: false },
    retry: { enabled: false },
    cacheWarming: "off",
    extensions: [resolve("tests/fixtures/pi-model-workflow-extension.ts")],
  });
  stubNativePiEnvironment(fixture.env);
  const attachments = new AttachmentStore(join(fixture.root, "uploads"));
  const runtime = new RuntimeController(
    new SessionCatalog(fixture.cwd),
    attachments,
  );
  const firstDelivery = deferred<void>();
  const snapshotRead = deferred<void>();
  const snapshotDelivery = deferred<void>();
  let delaySnapshot = false;
  let store: Awaited<ReturnType<typeof initStore>>["store"] | undefined;
  try {
    const initial = await runtime.newSession(fixture.cwd);
    const sessionId = initial.active!.sessionId;
    installFakeWebSocket();
    installFetch(async (url, init) => {
      if (url.startsWith("/api/bootstrap"))
        return {
          body: bootstrapPayload({
            snapshot: await runtime.snapshot(sessionId),
          }),
        };
      if (url === "/api/control/thinking") {
        const level = String(jsonBody(init).level);
        const result = await runtime.setThinkingLevel(sessionId, level);
        if (level === "high") await firstDelivery.promise;
        return { body: result };
      }
      if (url.startsWith("/api/snapshot")) {
        const snapshot = await runtime.snapshot(sessionId);
        if (delaySnapshot) {
          delaySnapshot = false;
          snapshotRead.resolve();
          await snapshotDelivery.promise;
        }
        return { body: snapshot };
      }
      return undefined;
    });
    const initialized = await initStore();
    store = initialized.store;
    const events: unknown[] = [];
    runtime.on("event", (event) => {
      events.push(event);
      initialized.socket.emit(event);
    });

    const first = store.setThinkingLevel("high");
    await vi.waitFor(async () =>
      expect((await runtime.snapshot(sessionId)).active?.thinkingLevel).toBe(
        "high",
      ),
    );
    // A real refresh advances the browser snapshot generation while the first
    // successful mutation receipt is still in transit.
    await store.refreshSession();
    delaySnapshot = true;
    firstDelivery.resolve();
    await snapshotRead.promise;

    await expect(store.setThinkingLevel("low")).resolves.toBe(true);
    expect(store.getState().thinkingLevel).toBe("low");
    expect((await runtime.snapshot(sessionId)).active?.thinkingLevel).toBe(
      "low",
    );
    // Empty native sessions have no persisted conversation yet. These setters
    // do not advance its projection or produce a corrective snapshot event.
    expect(events).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "session_projection_changed" }),
      ]),
    );
    snapshotDelivery.resolve();
    await expect(first).resolves.toBe(false);
    expect(store.getState().thinkingLevel).toBe("low");
  } finally {
    firstDelivery.resolve();
    snapshotDelivery.resolve();
    (
      store as unknown as { connectionController: { stop(): void } } | undefined
    )?.connectionController.stop();
    await runtime.close();
    await attachments.close();
    await rm(fixture.root, { recursive: true, force: true });
    vi.unstubAllEnvs();
  }
}, 30_000);
