import { join } from "node:path";
import { AttachmentStore } from "../../server/attachments.js";
import { PiRpcProcess } from "../../server/pi-rpc.js";
import { RuntimeController } from "../../server/runtime.js";
import { SessionCatalog } from "../../server/session-catalog.js";
import type { PiRpcOptions } from "../../server/pi-rpc.js";

/** Actual Host services scoped to a fixture's storage; no user catalog discovery. */
export function hostServices(
  root: string,
  options: {
    cwd?: string;
    attachments?: AttachmentStore;
    createProcess?: (
      options: PiRpcOptions,
    ) => PiRpcProcess | Promise<PiRpcProcess>;
  } = {},
) {
  const attachments =
    options.attachments ?? new AttachmentStore(join(root, "uploads"));
  const catalog = new SessionCatalog(options.cwd ?? root);
  catalog.sessionDirectories = async () => [join(root, "sessions")];
  const runtime = new RuntimeController(catalog, attachments, {
    createProcess: options.createProcess,
  });
  return { runtime, catalog, attachments };
}
