import type { AttachmentStore } from "../../server/attachments.js";
import { PiRpcProcess } from "../../server/pi-rpc.js";
import { hostServices } from "./host-services.js";
import {
  prepareWorkbenchEnvironment,
  type WorkbenchEnvironmentOptions,
} from "./workbench-environment.js";

/** Construct fixture-owned services only for tests that drive them directly. */
export async function workbenchFixture(
  root: string,
  options: WorkbenchEnvironmentOptions & { attachments?: AttachmentStore } = {},
) {
  const fixture = await prepareWorkbenchEnvironment(root, options);
  const services = hostServices(root, {
    cwd: fixture.cwd,
    attachments: options.attachments,
    createProcess: (options) =>
      new PiRpcProcess({
        ...options,
        env: { ...fixture.env, ...options.env },
        args: [
          "--no-skills",
          "--no-context-files",
          "--no-prompt-templates",
          "--no-themes",
          "--no-tools",
          "--no-approve",
          ...(options.args ?? []),
        ],
      }),
  });
  return { ...fixture, ...services };
}
