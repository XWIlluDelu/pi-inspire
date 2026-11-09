import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Test driver: moves this Pi within its session tree through Pi's own
 * navigation, as a terminal user choosing another entry would. */
export default function navigateCommand(pi: ExtensionAPI): void {
  pi.registerCommand("test-navigate", {
    description: "Navigate to a session entry (tests only)",
    handler: async (args, ctx) => {
      await ctx.navigateTree(args.trim(), { summarize: false });
    },
  });
}
