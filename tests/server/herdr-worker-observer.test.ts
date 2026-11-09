import { describe, expect, it, vi } from "vitest";
import type {
  HerdrClient,
  HerdrWorkerPane,
} from "../../server/herdr-client.js";
import { HerdrWorkerObserver } from "../../server/herdr-worker-observer.js";

const pane: HerdrWorkerPane = {
  serverId: "server-one",
  paneId: "w1:p1",
  tabId: "w1:t1",
  workspaceId: "w1",
};
function fakeClient() {
  const reportWorker = vi.fn(
    async (
      _pane: HerdrWorkerPane,
      _report: Parameters<HerdrClient["reportWorker"]>[1],
    ) => undefined,
  );
  const client = { reportWorker } as unknown as Pick<
    HerdrClient,
    "reportWorker"
  >;
  return { client, reportWorker };
}
async function settled() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("HerdrWorkerObserver", () => {
  it("maps Runtime status, including input blocking, and stops reporting without clearing metadata", async () => {
    const fake = fakeClient();
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
});
