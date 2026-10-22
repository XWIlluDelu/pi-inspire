import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import { nativeSessionWorkbench } from "./fixtures/native-session-workbench.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.reverse()) await close();
  cleanup.length = 0;
  vi.unstubAllEnvs();
});

it("continues a real Pi whose session_start extension persists state and native metadata", async () => {
  const extraExtensions: string[] = [];
  const f = await nativeSessionWorkbench(cleanup, {
    openSource: false,
    extraExtensions,
  });
  const extension = join(f.directory, "startup-state.ts");
  await writeFile(
    extension,
    `export default function(pi) {
      pi.on("session_start", () => {
        pi.appendEntry("startup-state", { text: "x".repeat(32 * 1024) });
        for (let i = 0; i < 20; i++) pi.appendEntry("startup-item", { index: i });
        pi.setSessionName("Extension startup");
        pi.setThinkingLevel("high");
      });
    }`,
  );
  extraExtensions.push(extension);
  const events: Array<Record<string, unknown>> = [];
  f.runtime.on("event", (event) => events.push(event));
  await f.runtime.openSession(f.id);
  await vi.waitFor(
    () =>
      expect(
        events.some(
          (event) =>
            event.type === "runtime_ready" || event.type === "runtime_error",
        ),
      ).toBe(true),
    { timeout: 10_000 },
  );
  const entries: SessionEntry[] = (await readFile(f.path, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(
    entries.find(
      (entry) =>
        entry.type === "custom" && entry.customType === "startup-state",
    ),
  ).toMatchObject({ data: { text: "x".repeat(32 * 1024) } });
  expect(
    entries.filter(
      (entry) => entry.type === "custom" && entry.customType === "startup-item",
    ),
  ).toHaveLength(20);
  expect(
    entries.some(
      (entry) =>
        entry.type === "session_info" && entry.name === "Extension startup",
    ),
  ).toBe(true);
  expect(events.filter((event) => event.type === "runtime_error")).toEqual([]);
  expect(f.workers[0]?.available).toBe(true);
  const snapshot = await f.runtime.snapshot(f.id);
  expect(snapshot.runState).toBe("idle");
  // Pi decides whether this model supports the requested thinking level.
  const state = await f.workers[0]!.request<{ thinkingLevel: string }>({
    type: "get_state",
  });
  expect(snapshot.active?.thinkingLevel).toBe(state.thinkingLevel);
  await expect(f.runtime.setThinkingLevel(f.id, "off")).resolves.toMatchObject({
    thinkingLevel: "off",
  });
  expect(f.workers).toHaveLength(1);
});
