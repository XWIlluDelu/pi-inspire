import { setTimeout as delay } from "node:timers/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Synthetic only: loaded explicitly by pi-operation-lifecycle.integration.test.ts. */
export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setStatus("pi-operation-node", process.version);
  });

  pi.on("session_before_compact", async (event, ctx) => {
    const startedAt = performance.now();
    ctx.ui.setStatus("pi-operation-compaction", `waiting:${event.reason}`);
    // This real child-process timer is the regression witness. Do not shorten
    // it or replace it with fake timers: the former prompt deadline was 30s.
    await delay(35_000, undefined, { signal: event.signal });
    ctx.ui.setStatus("pi-operation-compaction", "completed");
    return {
      compaction: {
        summary:
          "Synthetic earlier turns were compacted; continue the fixture.",
        firstKeptEntryId: event.preparation.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore,
        details: {
          fixture: "pi-operation-lifecycle",
          reason: event.reason,
          elapsedMs: performance.now() - startedAt,
        },
      },
    };
  });

  pi.registerCommand("await", {
    description: "Wait for the synthetic lifecycle test's confirmation",
    handler: async (_args, ctx) => {
      const confirmed = await ctx.ui.confirm(
        "Synthetic preflight confirmation",
        "Answer explicitly or stop this fixture worker.",
      );
      ctx.ui.notify(
        confirmed ? "pi-operation-confirmed" : "pi-operation-declined",
        "info",
      );
    },
  });
}
