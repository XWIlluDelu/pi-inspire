import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Native resource reload, without model traffic or an application control API. */
export default function (pi: ExtensionAPI) {
  pi.registerCommand("fixture-reload", {
    description: "Reload the isolated fixture's resources",
    handler: async (_args, ctx) => {
      await ctx.reload();
    },
  });
}
