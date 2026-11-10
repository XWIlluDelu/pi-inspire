import { access, appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

async function gate(cwd: string, name: string): Promise<void> {
  await writeFile(join(cwd, `${name}.entered`), "");
  const release = join(cwd, `${name}.release`);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (
      await access(release).then(
        () => true,
        () => false,
      )
    )
      return;
    await setTimeout(20);
  }
}

export default function attachPromptFixture(pi: ExtensionAPI) {
  pi.on("input", async (event, ctx) => {
    if (
      event.source !== "extension" ||
      (event.text !== "gated input" && event.text !== "lost auth")
    )
      return;
    await gate(ctx.cwd, event.text);
    if (event.text === "lost auth") {
      delete process.env.INSPIRE_TEST_ATTACH_API_KEY;
      await ctx.modelRegistry.refresh();
    }
  });
  pi.on("before_agent_start", async (event, ctx) => {
    if (event.messageType === "user" && event.prompt === "gated run")
      await gate(ctx.cwd, event.prompt);
  });
  pi.on("before_provider_request", async (_event, ctx) => {
    await appendFile(join(ctx.cwd, "provider-requests"), "request\n");
  });
}
