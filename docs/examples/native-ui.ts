import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Portable Pi UI primitives; no model request or credentials required. */
export default function (pi: ExtensionAPI) {
  pi.registerCommand("ui-demo", {
    description:
      "Try native dialogs, status and text widgets (clear to remove them)",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) return;
      if (args.trim() === "clear") {
        ctx.ui.setStatus("example.ui", undefined);
        ctx.ui.setWidget("example.ui-summary", undefined);
        ctx.ui.setWidget("example.ui-notes", undefined);
        ctx.ui.notify("Demo status and widgets cleared", "info");
        return;
      }
      if (args.startsWith("timeout")) {
        const timeout = Number(args.split(/\s+/)[1] ?? 10_000);
        if (!Number.isFinite(timeout) || timeout <= 0) return;
        const value = await ctx.ui.input("Timed note", "Optional note", {
          timeout,
        });
        ctx.ui.notify(
          value === undefined ? "Timed note closed" : "Timed note received",
          "info",
        );
        return;
      }

      ctx.ui.setStatus("example.ui", "Preparing a review");
      const topic = await ctx.ui.select("Choose a review", [
        "Documentation",
        "Code",
        "Tests",
      ]);
      if (topic === undefined) {
        ctx.ui.setStatus("example.ui", undefined);
        return;
      }
      if (!(await ctx.ui.confirm("Prepare this review?", topic))) {
        ctx.ui.setStatus("example.ui", undefined);
        return;
      }
      const name = await ctx.ui.input("Review name", "A short name");
      if (name === undefined) {
        ctx.ui.setStatus("example.ui", undefined);
        return;
      }
      const notes = await ctx.ui.editor(
        "Review notes",
        "Check the main behavior.\nRecord the outcome.",
      );
      if (notes === undefined) {
        ctx.ui.setStatus("example.ui", undefined);
        return;
      }
      ctx.ui.setStatus("example.ui", `${topic} review ready: ${name}`);
      ctx.ui.setWidget(
        "example.ui-summary",
        [
          `${topic}: ${name}`,
          "Run /ui-demo clear to remove the demo displays.",
        ],
        { placement: "aboveEditor" },
      );
      ctx.ui.setWidget("example.ui-notes", notes.split("\n"), {
        placement: "belowEditor",
      });
      pi.sendMessage({
        customType: "review_prepared",
        content: `**${topic} review:** ${name}\n\n${notes}`,
        display: true,
        details: { topic, name, notes },
      });
      ctx.ui.notify("Review prepared", "info");
    },
  });
}
