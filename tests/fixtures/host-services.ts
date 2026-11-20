import { join } from "node:path";
import { AttachmentStore } from "../../server/attachments.js";
import {
  RuntimeController,
  type RuntimeControllerOptions,
} from "../../server/runtime.js";
import { SessionCatalog } from "../../server/session-catalog.js";

/** Actual Host services scoped to a fixture's storage; no user catalog discovery. */
export function hostServices(
  root: string,
  {
    cwd = root,
    attachments = new AttachmentStore(join(root, "uploads")),
    ...options
  }: RuntimeControllerOptions & {
    cwd?: string;
    attachments?: AttachmentStore;
  } = {},
) {
  const catalog = new SessionCatalog(cwd);
  catalog.sessionDirectories = async () => [join(root, "sessions")];
  const runtime = new RuntimeController(catalog, attachments, options);
  return { runtime, catalog, attachments };
}
