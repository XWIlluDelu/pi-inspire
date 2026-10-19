import { readFile, writeFile } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Hold a later shutdown hook, then persist its final entry before replacement. */
export default function (pi: ExtensionAPI) {
  pi.on("session_shutdown", async (event, ctx) => {
    const entered = process.env.INSPIRE_FIXTURE_SHUTDOWN_ENTERED;
    const proceed = process.env.INSPIRE_FIXTURE_SHUTDOWN_PROCEED;
    if (event.reason !== "resume" || !entered || !proceed) return;
    await writeFile(entered, ctx.sessionManager.getSessionId());
    const deadline = Date.now() + 30_000;
    for (;;) {
      try {
        await readFile(proceed);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        if (Date.now() >= deadline)
          throw new Error("Fixture shutdown gate timed out");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    pi.appendEntry("fixture-shutdown-completed", { reason: event.reason });
  });
}
