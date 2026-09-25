import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  HerdrClient,
  HerdrObservedSessions,
  HerdrPaneProcessInfo,
  HerdrWorkerPane,
} from "../../server/herdr-client.js";
import { HerdrWorkerObserver } from "../../server/herdr-worker-observer.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "inspire-herdr-observer-"));
  roots.push(root);
  const sessionFile = join(root, "session.jsonl");
  await writeFile(sessionFile, "");
  return { root, sessionFile };
}

const pane: HerdrWorkerPane = {
  serverId: "server-one",
  paneId: "w1:p1",
  tabId: "w1:t1",
  workspaceId: "w1",
};
function candidate(
  sessionFile: string,
  overrides: Record<string, unknown> = {},
): HerdrObservedSessions {
  return {
    serverId: "server-one",
    panes: [
      {
        paneId: "w1:p1",
        agent: "pi",
        inspireSessionId: null,
        session: {
          agent: "pi",
          source: "herdr:pi",
          kind: "path",
          value: sessionFile,
          ...overrides,
        },
      },
    ],
  } as HerdrObservedSessions;
}
function sibling(sessionId: string): HerdrObservedSessions {
  return {
    serverId: "server-one",
    panes: [
      {
        paneId: "w1:p1",
        agent: "inspire-rpc",
        inspireSessionId: sessionId,
        session: null,
      },
    ],
  };
}
function foreground(): HerdrPaneProcessInfo {
  // The real Pi CLI replaces Node's original argv with just process.title='pi'
  // in both TUI and RPC modes. Only the pane's first-party identity separates them.
  return {
    paneId: "w1:p1",
    foregroundProcessGroupId: 98,
    foregroundProcesses: [{ pid: 101, name: "pi", argv: ["pi"] }],
  };
}
function fakeClient(
  inspected: HerdrObservedSessions | null,
  info: HerdrPaneProcessInfo,
) {
  const inspectSessions = vi.fn(async () => inspected);
  const inspectPaneProcess = vi.fn(async () => info);
  const reportWorker = vi.fn(
    async (
      _pane: HerdrWorkerPane,
      _report: Parameters<HerdrClient["reportWorker"]>[1],
    ) => undefined,
  );
  const client = {
    inspectSessions,
    inspectPaneProcess,
    reportWorker,
  } as unknown as Pick<
    HerdrClient,
    "inspectSessions" | "inspectPaneProcess" | "reportWorker"
  >;
  return { client, inspectSessions, inspectPaneProcess, reportWorker };
}
async function settled() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("HerdrWorkerObserver", () => {
  it("maps Runtime status, including input blocking, and stops reporting without clearing metadata", async () => {
    const fake = fakeClient(null, foreground());
    const observer = new HerdrWorkerObserver({ client: fake.client });
    const projection = observer.observe(() => pane);
    const idle = {
      sessionId: "session-one",
      runState: "idle",
      needsInput: false,
    } as const;
    projection.update(idle);
    await settled();
    expect(fake.reportWorker).toHaveBeenLastCalledWith(
      pane,
      expect.objectContaining({ state: "idle", sessionId: "session-one" }),
    );
    projection.update(idle);
    await settled();
    expect(fake.reportWorker).toHaveBeenCalledOnce();
    projection.update({ ...idle, runState: "running" });
    await settled();
    expect(fake.reportWorker).toHaveBeenLastCalledWith(
      pane,
      expect.objectContaining({ state: "working", sessionId: "session-one" }),
    );
    projection.update({ ...idle, runState: "running", needsInput: true });
    await settled();
    expect(fake.reportWorker).toHaveBeenLastCalledWith(
      pane,
      expect.objectContaining({ state: "blocked", sessionId: "session-one" }),
    );
    projection.update({ ...idle, runState: "compacting" });
    await settled();
    expect(fake.reportWorker).toHaveBeenLastCalledWith(
      pane,
      expect.objectContaining({ state: "working", sessionId: "session-one" }),
    );
    projection.update({ ...idle, sessionId: "session-two" });
    await settled();
    expect(fake.reportWorker).toHaveBeenLastCalledWith(
      pane,
      expect.objectContaining({ state: "idle", sessionId: "session-two" }),
    );
    const count = fake.reportWorker.mock.calls.length;
    await projection.dispose();
    projection.update(idle);
    await settled();
    expect(fake.reportWorker).toHaveBeenCalledTimes(count);
  });

  it("denies native Pi TUI and other Inspire RPC live writers, not unrelated or stale metadata", async () => {
    const { root, sessionFile } = await fixture();
    const alias = join(root, "session-link.jsonl");
    await symlink(sessionFile, alias);
    const fake = fakeClient(candidate(alias), foreground());
    const observer = new HerdrWorkerObserver({ client: fake.client });
    await expect(
      observer.assertWritable("session-one", sessionFile),
    ).rejects.toMatchObject({ status: 409, code: "EXTERNAL_PI_WRITER_ACTIVE" });
    expect(fake.inspectPaneProcess).toHaveBeenCalledWith("server-one", "w1:p1");
    fake.inspectSessions.mockResolvedValue(
      candidate(join(root, "other.jsonl")),
    );
    fake.inspectPaneProcess.mockClear();
    await observer.assertWritable("session-one", sessionFile);
    expect(fake.inspectPaneProcess).not.toHaveBeenCalled();
    fake.inspectSessions.mockResolvedValue(sibling("session-one"));
    await expect(
      observer.assertWritable("session-one", sessionFile),
    ).rejects.toMatchObject({ status: 409 });
    fake.inspectSessions.mockResolvedValue(sibling("other-id"));
    fake.inspectPaneProcess.mockClear();
    await observer.assertWritable("session-one", sessionFile);
    expect(fake.inspectPaneProcess).not.toHaveBeenCalled();
    fake.inspectSessions.mockResolvedValue(candidate(sessionFile));
    fake.inspectPaneProcess.mockResolvedValue({
      ...foreground(),
      foregroundProcesses: [],
    });
    await observer.assertWritable("session-one", sessionFile);
    fake.inspectPaneProcess.mockResolvedValue({
      ...foreground(),
      foregroundProcessGroupId: null,
    });
    await observer.assertWritable("session-one", sessionFile);
    fake.inspectPaneProcess.mockResolvedValue({
      ...foreground(),
      foregroundProcesses: [{ pid: 101, name: "shell", argv: ["zsh"] }],
    });
    await observer.assertWritable("session-one", sessionFile);
    fake.inspectPaneProcess.mockResolvedValue(foreground());
    await expect(
      observer.assertWritable("session-one", sessionFile),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("matches native session ID references but refuses a changed server incarnation", async () => {
    const { sessionFile } = await fixture();
    const fake = fakeClient(
      candidate("session-one", { kind: "id" }),
      foreground(),
    );
    const observer = new HerdrWorkerObserver({ client: fake.client });
    await observer.assertWritable("another-id", sessionFile);
    expect(fake.inspectPaneProcess).not.toHaveBeenCalled();
    await expect(
      observer.assertWritable("session-one", sessionFile),
    ).rejects.toMatchObject({ status: 409 });
    fake.inspectPaneProcess.mockRejectedValue(
      new Error("Herdr server changed during live-writer inspection"),
    );
    await expect(
      observer.assertWritable("session-one", sessionFile),
    ).rejects.toThrow("changed");
  });
});
