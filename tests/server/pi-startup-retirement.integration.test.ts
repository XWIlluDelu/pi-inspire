import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AttachmentStore } from "../../server/attachments.js";
import { PiRpcProcess } from "../../server/pi-rpc.js";
import { RuntimeController } from "../../server/runtime.js";
import type { RuntimeSlot } from "../../server/runtime-slot.js";
import type {
  SessionCatalogLike,
  SessionRecord,
} from "../../server/session-catalog.js";

const SESSION_ID = "33333333-3333-4333-8333-333333333333";

describe("installed Pi startup retirement and idle restart", () => {
  it.each(["idle", "missing-extension", "startup-dialog"])(
    "admits ordinary restart after %s without a model request",
    async (scenario) => {
      const directory = await mkdtemp(
        join(tmpdir(), "inspire-startup-retirement-"),
      );
      const config = join(directory, "config");
      const sessionDir = join(directory, "sessions");
      await mkdir(config);
      await mkdir(sessionDir);
      const sessionFile = join(sessionDir, "fixture.jsonl");
      const timestamp = "2026-09-01T00:00:00.000Z";
      await writeFile(
        sessionFile,
        [
          {
            type: "session",
            version: 3,
            id: SESSION_ID,
            timestamp,
            cwd: directory,
          },
          {
            type: "message",
            id: "u1",
            parentId: null,
            timestamp,
            message: { role: "user", content: "startup fixture", timestamp: 1 },
          },
        ]
          .map((entry) => JSON.stringify(entry))
          .join("\n") + "\n",
      );
      const extraArgs: string[] = [];
      if (scenario === "missing-extension")
        extraArgs.push("--extension", join(directory, "not-present.ts"));
      if (scenario === "startup-dialog") {
        const extension = join(directory, "startup-dialog.ts");
        await writeFile(
          extension,
          `export default function(pi) {
  pi.on("session_start", async (_event, ctx) => {
    await ctx.ui.confirm("Fixture", "Startup confirmation");
  });
}\n`,
        );
        extraArgs.push("--extension", extension);
      }
      const record: SessionRecord = {
        id: SESSION_ID,
        cwd: directory,
        path: sessionFile,
        source: null,
        created: new Date(timestamp),
        modified: new Date(timestamp),
        messageCount: 1,
        firstMessage: "startup fixture",
        searchText: "fixture",
      };
      const catalog: SessionCatalogLike = {
        refresh: async () => [record],
        get: async (id) => (id === SESSION_ID ? record : undefined),
        list: async () => ({ sessions: [], total: 0, offset: 0, limit: 40 }),
        listByIds: async () => [],
        listByCwds: async () => [],
        invalidate() {},
      };
      const attachments = new AttachmentStore(join(directory, "uploads"));
      let worker!: PiRpcProcess;
      const runtime = new RuntimeController(catalog, attachments, (options) => {
        worker = new PiRpcProcess({
          ...options,
          args: [
            "--no-extensions",
            "--session-dir",
            sessionDir,
            ...(options.args ?? []),
            ...extraArgs,
          ],
          env: {
            ...options.env,
            PI_CODING_AGENT_DIR: config,
            PI_CODING_AGENT_SESSION_DIR: sessionDir,
            PI_OFFLINE: "1",
          },
        });
        return worker;
      });
      try {
        await runtime.openSession(SESSION_ID);
        const slot = (
          runtime as unknown as { slots: Map<string, RuntimeSlot> }
        ).slots.get(SESSION_ID)!;
        await vi.waitFor(
          () => {
            expect(slot.runState).toBe(scenario === "idle" ? "idle" : "failed");
            expect(slot.activeOperations).toBe(0);
            expect(slot.stopping).toBeNull();
          },
          { timeout: 10_000 },
        );
        expect(worker.available).toBe(scenario === "idle");
        expect(slot.startupPhase).toBe(
          scenario === "idle" ? "complete" : "idle",
        );
        const lease = runtime.reserveMaintenanceRestart();
        expect(lease.kind).toBe("ready");
        if (lease.kind !== "ready")
          throw new Error("Expected idle restart lease");
        expect(runtime.commitMaintenanceRestart(lease.leaseId).kind).toBe(
          "committed",
        );
      } finally {
        await runtime.close();
        await attachments.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
    15_000,
  );
});
