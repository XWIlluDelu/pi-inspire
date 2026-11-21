import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, vi } from "vitest";
import type { AttachmentStore } from "../../../server/attachments.js";
import type { DiagnosticLogger } from "../../../server/diagnostics.js";
import {
  type PiRpcOptions,
  type PiRpcProcess,
} from "../../../server/pi-rpc.js";
import { RuntimeController } from "../../../server/runtime.js";
import type { RuntimeSlot } from "../../../server/runtime-slot.js";
import type { SessionRecord } from "../../../server/session-catalog.js";

import { nativePiWorkspace, stubNativePiEnvironment } from "./native-pi.js";
import { catalog, FakeRpc, workerAttachmentStore } from "./runtime.js";
import { jsonl } from "./session-jsonl.js";

const directories: string[] = [];
const stores: AttachmentStore[] = [];
const runtimes: RuntimeController[] = [];

export function runtimeProjection(runtime: RuntimeController) {
  const internals = runtime as unknown as {
    slots: Map<string, RuntimeSlot>;
  };
  const slot = internals.slots.get("session-a")!;
  return {
    slot,
    reconcile: () => slot.projection!.reconcile(true),
  };
}

class ProjectionRpc extends FakeRpc {
  declare readonly sessionPath: string;
  onStop: (() => void) | null = null;
  onStart: (() => Promise<void>) | null = null;
  startupEntries: unknown[] = [];
  startupLeafId: string | null | undefined;
  stateThinkingLevel = "off";

  constructor(
    options: PiRpcOptions,
    private readonly sequence: string[],
  ) {
    super(options);
    this.sessionId = "session-a";
    this.responseOverrides.set("get_state", () => ({
      sessionId: "session-a",
      sessionFile: this.sessionPath,
      model: null,
      thinkingLevel: this.stateThinkingLevel,
      isStreaming: false,
      isCompacting: false,
    }));
    this.responseOverrides.set(
      "get_entries",
      (command: Record<string, unknown>) => ({
        entries: this.startupEntries,
        leafId:
          this.startupLeafId === undefined
            ? (command.since ?? null)
            : this.startupLeafId,
      }),
    );
  }
  override async start() {
    this.sequence.push("start");
    await this.onStart?.();
  }
  override async stop() {
    await super.stop();
    this.sequence.push("stop");
    this.onStop?.();
  }
  override async request<T>(command: Record<string, unknown>): Promise<T> {
    this.sequence.push(String(command.type));
    return super.request<T>(command);
  }
  override sendExtensionUiResponse(response: Record<string, unknown>) {
    this.commands.push({ type: "extension_ui_response", ...response });
  }
}

export async function setup(
  extraEntries: unknown[] = [],
  configure?: (worker: ProjectionRpc) => void,
  includeUser = true,
  trailingBytes = "",
  expectWorker = true,
  diagnostics?: DiagnosticLogger,
) {
  const directory = await mkdtemp(
    join(tmpdir(), "inspire-runtime-projection-"),
  );
  directories.push(directory);
  const path = join(directory, "session.jsonl");
  const header = {
    type: "session",
    version: 3,
    id: "session-a",
    timestamp: "2026-08-01T00:00:00.000Z",
    cwd: directory,
  };
  const user = {
    type: "message",
    id: "u1",
    parentId: null,
    timestamp: "2026-08-01T00:00:01.000Z",
    message: { role: "user", content: "original", timestamp: 1 },
  };
  await writeFile(
    path,
    jsonl(header, ...(includeUser ? [user] : []), ...extraEntries) +
      trailingBytes,
  );
  const record: SessionRecord = {
    id: "session-a",
    cwd: directory,
    path,
    source: null,
    created: new Date(),
    modified: new Date(),
    messageCount: includeUser ? 1 : 0,
    firstMessage: "original",
  };
  const source = catalog([record]);
  const attachments = workerAttachmentStore(join(directory, "uploads"));
  stores.push(attachments);
  const workers: ProjectionRpc[] = [];
  const sequence: string[] = [];
  const runtime = new RuntimeController(source, attachments, {
    createProcess: (options) => {
      const worker = new ProjectionRpc(options, sequence);
      configure?.(worker);
      workers.push(worker);
      return worker as unknown as PiRpcProcess;
    },
    diagnostics,
  });
  runtimes.push(runtime);
  const opened = await runtime.openSession("session-a");
  const startup = expectWorker
    ? runtime.setRuntimeSetting("session-a", {
        key: "steeringMode",
        value: "one-at-a-time",
      })
    : null;
  void startup?.catch(() => undefined);
  if (expectWorker) await vi.waitFor(() => expect(workers).toHaveLength(1));
  return { runtime, workers, sequence, path, opened, startup };
}

export async function initializeProjectionFixture() {
  const pi = await nativePiWorkspace("inspire-projection-pi-", {
    defaultProjectTrust: "never",
  });
  directories.push(pi.root);
  stubNativePiEnvironment(pi.env);
}

export async function disposeProjectionFixture() {
  try {
    await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  } finally {
    vi.unstubAllEnvs();
    await Promise.all(stores.splice(0).map((store) => store.close()));
    for (const directory of directories.splice(0).reverse())
      await rm(directory, { recursive: true, force: true, maxRetries: 3 });
  }
}
