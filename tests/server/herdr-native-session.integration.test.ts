import { describe, expect, it, vi } from "vitest";
import {
  nativeHerdrAvailable,
  nativeHerdrFixture,
} from "./fixtures/native-herdr.js";

describe.skipIf(!nativeHerdrAvailable)(
  "real Herdr native Pi continuity",
  () => {
    it("keeps one interactive Pi usable from Inspire and its terminal across Host reconnects", async () => {
      const f = await nativeHerdrFixture();
      let runtime = f.makeRuntime();
      const { sessionId, sessionFile, pane } = f;
      try {
        await runtime.openSession(sessionId);
        await runtime.prompt({
          sessionId,
          message: "First instruction from Inspire",
        });
        await vi.waitFor(
          async () => {
            expect(await f.readHistory()).toContain("global physical a reply");
            expect((await runtime.snapshot(sessionId)).runState).toBe("idle");
          },
          { timeout: 15_000, interval: 150 },
        );
        expect(
          JSON.stringify(
            (await runtime.snapshot(sessionId)).active?.transcriptPage.messages,
          ),
        ).toContain("First instruction from Inspire");
        await runtime.close();
        expect(
          (await f.observer.findNativeWriter(sessionId, sessionFile))?.pid,
        ).toBe(f.originalPid);
        await f.client.nativeAgentRequest(
          pane.serverId,
          pane.paneId,
          "agent.prompt",
          {
            text: "Instruction from the original terminal",
          },
        );
        await vi.waitFor(
          async () =>
            expect(await f.readHistory()).toContain(
              "Instruction from the original terminal",
            ),
          { timeout: 10_000 },
        );
        runtime = f.makeRuntime();
        await runtime.openSession(sessionId);
        await runtime.prompt({
          sessionId,
          message: "Continue from Inspire again",
        });
        await vi.waitFor(
          async () =>
            expect(await f.readHistory()).toContain(
              "Continue from Inspire again",
            ),
          { timeout: 10_000 },
        );
        expect(
          (await f.observer.findNativeWriter(sessionId, sessionFile))?.pid,
        ).toBe(f.originalPid);
        expect(
          (await runtime.snapshot(sessionId)).active?.projectionConflict,
        ).toBeNull();
        await vi.waitFor(
          async () =>
            expect((await runtime.snapshot(sessionId)).runState).toBe("idle"),
          { timeout: 5000 },
        );
        await runtime.rename(sessionId, "Native title from Inspire");
        await vi.waitFor(async () =>
          expect(await f.readHistory()).toContain(
            '"name":"Native title from Inspire"',
          ),
        );
        await f.client.nativeAgentRequest(
          pane.serverId,
          pane.paneId,
          "pane.send_text",
          {
            text: "Unsent terminal draft",
          },
        );
        await vi.waitFor(async () => {
          const visible = await f.client.nativeAgentRequest(
            pane.serverId,
            pane.paneId,
            "agent.read",
            { source: "visible", format: "text" },
          );
          expect(JSON.stringify(visible)).toContain("Unsent terminal draft");
        });
        await expect(
          runtime.prompt({
            sessionId,
            message: "Separate browser instruction",
          }),
        ).rejects.toMatchObject({ status: 409 });
        expect(await f.readHistory()).not.toContain(
          "Separate browser instruction",
        );
        const draftView = await f.client.nativeAgentRequest(
          pane.serverId,
          pane.paneId,
          "agent.read",
          {
            source: "detection",
            format: "text",
            lines: 100,
          },
        );
        expect(JSON.stringify(draftView)).toContain("Unsent terminal draft");
      } finally {
        await f.close();
      }
    }, 60_000);
  },
);
