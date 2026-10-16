import { afterEach, describe, expect, it, vi } from "vitest";
import type { HerdrClient } from "../../server/herdr-client.js";
import { HerdrNativeSession } from "../../server/herdr-native-session.js";
import { HerdrApiError } from "../../server/herdr-control.js";

function fixture() {
  const agent = {
    agent: "pi",
    pane_id: "w1:p1",
    agent_status: "done",
    agent_session: {
      source: "herdr:pi",
      agent: "pi",
      kind: "id",
      value: "session-one",
    },
  };
  const nativeAgentRequest = vi.fn<HerdrClient["nativeAgentRequest"]>(
    async (_server, _pane, method) =>
      method === "agent.read"
        ? {
            type: "pane_read",
            read: {
              pane_id: "w1:p1",
              text: `Previous reply\n${agent.agent_status === "working" ? "── ⠸ Working ─────" : "─────────"}\n\n─────────\nProject footer`,
            },
          }
        : { type: "agent_info", agent },
  );
  const inspectPaneProcess = vi.fn(async () => ({
    paneId: "w1:p1",
    foregroundProcessGroupId: 98,
    foregroundProcesses: [{ pid: 101, name: "pi", argv: ["pi"] }],
  }));
  const native = new HerdrNativeSession(
    { nativeAgentRequest, inspectPaneProcess },
    { serverId: "server-one", paneId: "w1:p1", pid: 101 },
    "session-one",
    "/sessions/session-one.jsonl",
  );
  return { native, agent, nativeAgentRequest, inspectPaneProcess };
}

afterEach(() => vi.restoreAllMocks());

describe("existing native Pi terminal control", () => {
  it("sends a prompt to the same identified terminal without creating or owning a process", async () => {
    const f = fixture();
    await expect(f.native.read()).resolves.toEqual({ status: "idle" });
    await f.native.prompt("Continue the analysis.\nKeep the existing context.");
    expect(f.nativeAgentRequest).toHaveBeenLastCalledWith(
      "server-one",
      "w1:p1",
      "agent.prompt",
      { text: "Continue the analysis.\nKeep the existing context." },
    );
    f.native.close();
    await expect(f.native.read()).resolves.toBeNull();
    await expect(f.native.prompt("late input")).rejects.toMatchObject({
      status: 409,
    });
    expect(
      f.nativeAgentRequest.mock.calls.filter(
        (args) => args[2] === "agent.prompt",
      ),
    ).toHaveLength(1);
  });

  it("honors native follow-up and interruption keys", async () => {
    const f = fixture();
    f.agent.agent_status = "working";
    await f.native.prompt("Next task", "followUp");
    expect(f.nativeAgentRequest.mock.calls.slice(-2)).toEqual([
      ["server-one", "w1:p1", "pane.send_text", { text: "Next task" }],
      ["server-one", "w1:p1", "agent.send_keys", { keys: ["alt+enter"] }],
    ]);
    await f.native.abort();
    expect(f.nativeAgentRequest).toHaveBeenLastCalledWith(
      "server-one",
      "w1:p1",
      "agent.send_keys",
      { keys: ["esc"] },
    );
  });

  it.each(["different session", "different process", "different agent"])(
    "does not send to a %s",
    async (change) => {
      const f = fixture();
      if (change === "different session")
        f.agent.agent_session.value = "another";
      if (change === "different process")
        f.inspectPaneProcess.mockResolvedValue({
          paneId: "w1:p1",
          foregroundProcessGroupId: 98,
          foregroundProcesses: [{ pid: 102, name: "pi", argv: ["pi"] }],
        });
      if (change === "different agent") f.agent.agent = "inspire-rpc";
      await expect(f.native.prompt("must not send")).rejects.toMatchObject({
        status: 409,
      });
      expect(
        f.nativeAgentRequest.mock.calls.every(
          (args) => args[2] === "agent.get",
        ),
      ).toBe(true);
    },
  );

  it("leaves a native question untouched and rejects terminal control bytes", async () => {
    const f = fixture();
    f.agent.agent_status = "blocked";
    await expect(f.native.prompt("ordinary message")).rejects.toMatchObject({
      status: 409,
    });
    f.agent.agent_status = "done";
    await expect(f.native.prompt("unsafe\x1b[13~")).rejects.toMatchObject({
      status: 400,
    });
    expect(
      f.nativeAgentRequest.mock.calls.every((args) => args[2] === "agent.get"),
    ).toBe(true);
  });

  it("checks Stop ownership again after asynchronous terminal preflight", async () => {
    const f = fixture();
    await expect(
      f.native.prompt("Stopped input", undefined, () => {
        throw Object.assign(new Error("Stopped"), { status: 409 });
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      f.nativeAgentRequest.mock.calls.every(
        (args) => args[2] === "agent.get" || args[2] === "agent.read",
      ),
    ).toBe(true);
  });

  it("keeps uncertain submission distinct from a rejected preflight and never retries input", async () => {
    const f = fixture();
    f.nativeAgentRequest.mockImplementation(async (_server, _pane, method) => {
      if (method === "agent.prompt") throw new Error("socket closed");
      if (method === "agent.read")
        return {
          type: "pane_read",
          read: { pane_id: "w1:p1", text: "─────────\n\n─────────\nFooter" },
        };
      return { type: "agent_info", agent: f.agent };
    });
    await expect(f.native.prompt("one attempt")).rejects.toMatchObject({
      outcomeUnknown: true,
    });
    expect(
      f.nativeAgentRequest.mock.calls.filter(
        (args) => args[2] === "agent.prompt",
      ),
    ).toHaveLength(1);
    f.nativeAgentRequest.mockRejectedValue(
      new HerdrApiError("agent_not_found", "gone"),
    );
    await expect(f.native.read()).resolves.toBeNull();
  });
});
