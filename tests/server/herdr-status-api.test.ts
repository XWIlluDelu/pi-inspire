import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createInspireServer } from "../../server/app.js";
import { AttachmentStore } from "../../server/attachments.js";
import { MockCatalog, MockRuntime } from "../../server/mock.js";
import { PreferencesStore } from "../../server/preferences.js";
import { ResourceStore } from "../../server/resources.js";
import type { HerdrEnhancementStatus } from "../../shared/herdr.js";

async function fixture(getHerdrStatus?: () => Promise<HerdrEnhancementStatus>) {
  const directory = await mkdtemp(join(tmpdir(), "inspire-herdr-status-"));
  const preferences = new PreferencesStore(join(directory, "preferences.json"));
  const application = createInspireServer({
    token: "fixture-token",
    runtime: new MockRuntime(),
    catalog: new MockCatalog(),
    attachments: new AttachmentStore(join(directory, "uploads")),
    preferences,
    resources: new ResourceStore(),
    git: {
      status: async () => ({ kind: "not-repository" as const }),
      diff: async () => {
        throw new Error("unused");
      },
    },
    mock: true,
    version: "test",
    piVersion: "test",
    getHerdrStatus,
  });
  return {
    api: request(application.app),
    preferences,
    close: async () => {
      await application.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

describe("Herdr enhancement status API", () => {
  it("authenticates its status, reports unavailable integration as 503, and never caches it", async () => {
    const test = await fixture();
    try {
      await test.api.get("/api/host/herdr").expect(401);
      const response = await test.api
        .get("/api/host/herdr")
        .set("Authorization", "Bearer fixture-token")
        .expect(503);
      expect(response.body.error).toMatch(/status is unavailable/);
      expect(response.headers["cache-control"]).toBe("no-store");
    } finally {
      await test.close();
    }
  });

  it("keeps the effective startup value separate from the persisted next-start preference", async () => {
    const status: HerdrEnhancementStatus = {
      enabled: false,
      supported: true,
      installed: true,
      running: false,
      compatible: true,
      version: "0.9.1",
    };
    const test = await fixture(async () => status);
    try {
      await test.api.get("/api/host/herdr").expect(401);
      const before = await test.api
        .get("/api/host/herdr")
        .set("Authorization", "Bearer fixture-token")
        .expect(200);
      expect(before.body).toEqual(status);
      expect(before.headers["cache-control"]).toBe("no-store");
      await test.preferences.patch({ herdrEnabled: true });
      const after = await test.api
        .get("/api/host/herdr")
        .set("Authorization", "Bearer fixture-token")
        .expect(200);
      expect(after.body.enabled).toBe(false);
      expect((await test.preferences.read()).herdrEnabled).toBe(true);
    } finally {
      await test.close();
    }
  });
});
