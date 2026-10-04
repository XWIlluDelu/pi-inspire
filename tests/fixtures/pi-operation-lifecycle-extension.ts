import { setTimeout as delay } from "node:timers/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Synthetic only: loaded explicitly by pi-operation-lifecycle.integration.test.ts. */
export default function (pi: ExtensionAPI) {
  let compactionCount = 0;
  let suspendAfterCompaction = false;
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setStatus("pi-operation-node", process.version);
  });

  pi.on("user_bash", async (event, ctx) => {
    if (event.command === "fixture-await-bash") {
      await ctx.ui.confirm(
        "Synthetic Bash hook",
        "Answer or stop the suspended user_bash hook.",
      );
      return {
        result: {
          output: "HOOK_CONFIRMED",
          exitCode: 0,
          cancelled: false,
          truncated: false,
        },
      };
    }
    if (event.command === "fixture-hook") {
      ctx.ui.setStatus(
        "fixture-user-bash",
        `${event.excludeFromContext}:${event.cwd}`,
      );
      return {
        result: {
          output: "EXTENSION_BASH_RESULT",
          exitCode: 7,
          cancelled: false,
          truncated: false,
        },
      };
    }
    if (event.command === "fixture-ops") {
      return {
        operations: {
          async exec(_command, _cwd, { onData }) {
            onData(Buffer.from("EXTENSION_CUSTOM_OPERATIONS\n"));
            return { exitCode: 0 };
          },
        },
      };
    }
  });

  pi.on("input", (event) => {
    if (event.text === "Replace pending image bytes." && event.images?.length)
      return {
        action: "transform",
        text: event.text,
        images: [
          {
            type: "image",
            mimeType: "image/gif",
            data: "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
          },
        ],
      };
    return {
      action: event.text.startsWith("Handled without a model turn.")
        ? "handled"
        : "continue",
    };
  });

  pi.on("message_start", async (event, ctx) => {
    if (event.message.role !== "user") return;
    const content = event.message.content;
    const text =
      typeof content === "string"
        ? content
        : content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("");
    if (text === "Delay unchanged image start.")
      await ctx.ui.confirm(
        "Delayed image message_start",
        "Release the unchanged consumed image event.",
      );
  });

  pi.on("session_before_compact", async (event, ctx) => {
    const startedAt = performance.now();
    suspendAfterCompaction =
      event.customInstructions === "fixture-post-compact";
    ctx.ui.setStatus("pi-operation-compaction", `waiting:${event.reason}`);
    ctx.ui.setStatus(
      "pi-operation-compaction-count",
      String(++compactionCount),
    );
    if (event.customInstructions === "fixture-ignore-cancellation") {
      // Deliberately unresponsive: proves explicit Stop's retirement boundary.
      await new Promise<void>(() => {});
    }
    // Share the native hook with the slow preflight and manual Stop regressions.
    try {
      await delay(
        Number(process.env.PI_FIXTURE_COMPACT_DELAY_MS ?? 35_000),
        undefined,
        { signal: event.signal },
      );
    } catch (error) {
      if (!event.signal.aborted) throw error;
      ctx.ui.setStatus("pi-operation-compaction", "cancelled");
      return { cancel: true };
    }
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

  pi.on("session_compact", async (_event, ctx) => {
    if (!suspendAfterCompaction) return;
    pi.appendEntry("fixture-after-compaction", { checkpointCommitted: true });
    ctx.ui.setStatus("pi-operation-compaction", "persisted-waiting");
    await new Promise<void>(() => {});
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
