import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInspireServer } from "../../../server/app";
import { AttachmentStore } from "../../../server/attachments";
import { MockCatalog, MockRuntime } from "../../../server/mock";
import { PreferencesStore } from "../../../server/preferences";
import { ResourceStore } from "../../../server/resources";

/** A separate ephemeral Host for restart/rotation tests; no launcher state,
 * user token files, services, Pi sessions or production listeners are touched. */
export async function restartableAuthHost(master: string) {
  const directory = await mkdtemp(join(tmpdir(), "inspire-browser-auth-"));
  const create = (token: string) => {
    const attachments = new AttachmentStore(join(directory, "uploads"));
    const runtime = new MockRuntime({ attachments });
    return createInspireServer({
      token,
      runtime,
      catalog: new MockCatalog(),
      attachments,
      preferences: new PreferencesStore(join(directory, "preferences.json")),
      resources: new ResourceStore(),
      git: {
        status: async () => ({ kind: "not-repository" }),
        diff: async () => {
          throw new Error("Unused fixture");
        },
      },
      mock: true,
      version: "0.0.0-fixture",
      piVersion: "fixture",
      distDir: resolve(process.env.INSPIRE_BROWSER_TEST_ROOT ?? ".", "dist"),
    });
  };
  let application = create(master);
  await new Promise<void>((resolve) =>
    application.server.listen(0, "127.0.0.1", resolve),
  );
  const port = (application.server.address() as AddressInfo).port;
  return {
    origin: `http://127.0.0.1:${port}`,
    async restart(token = master) {
      await application.close();
      application = create(token);
      await new Promise<void>((resolve) =>
        application.server.listen(port, "127.0.0.1", resolve),
      );
    },
    async close() {
      await application.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
