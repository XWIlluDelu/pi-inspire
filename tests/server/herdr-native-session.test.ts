import { afterEach, describe, expect, it, vi } from "vitest";
import type { HerdrClient } from "../../server/herdr-client.js";
import {
  HerdrApiError,
  HerdrServerChangedError,
} from "../../server/herdr-control.js";
import { HerdrNativeSession } from "../../server/herdr-native-session.js";
import { captureHerdrHostIdentity } from "../../server/herdr-process-group.js";
import type { PiNativeActions } from "../../server/pi-native-actions.js";
import { requestError } from "../../server/request-error.js";

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
    async () => ({ type: "agent_info", agent }),
  );
  const inspectPaneProcess = vi.fn(async () => ({
    paneId: "w1:p1",
    foregroundProcessGroupId: 98,
    foregroundProcesses: [{ pid: 101, name: "pi", argv: ["pi"] }],
  }));
  const invoke = vi.fn<PiNativeActions["invoke"]>(
    async (_action, _send, beforeSend) => {
      beforeSend?.();
    },
  );
  const native = new HerdrNativeSession(
    { nativeAgentRequest, inspectPaneProcess },
    { serverId: "server-one", paneId: "w1:p1", pid: 101 },
    "session-one",
    "/sessions/session-one.jsonl",
    undefined,
    { invoke },
  );
  return { native, agent, nativeAgentRequest, inspectPaneProcess, invoke };
}

afterEach(() => vi.restoreAllMocks());

describe("existing native Pi action adapter", () => {
  it.skipIf(process.platform !== "linux")(
    "requires original-process retirement when metadata disappears",
    async () => {
      const f = fixture(),
        identity = await captureHerdrHostIdentity();
      const native = new HerdrNativeSession(
        {
          nativeAgentRequest: f.nativeAgentRequest,
          inspectPaneProcess: f.inspectPaneProcess,
        },
        {
          serverId: "server-one",
          paneId: "w1:p1",
          pid: identity.pid,
          processIdentity: identity,
        },
        "session-one",
        "/sessions/session-one.jsonl",
      );
      f.agent.agent_session.value = "unverified-other-session";
      await expect(native.read()).rejects.toMatchObject({
        code: "SESSION_OWNER_UNAVAILABLE",
      });
      identity.birth = "different-process-birth";
      f.nativeAgentRequest.mockClear();
      await expect(native.read()).resolves.toBeNull();
      expect(f.nativeAgentRequest).not.toHaveBeenCalled();
    },
  );

  it("submits to the identified existing instance and closes only its controller", async () => {
    const f = fixture();
    await expect(f.native.read()).resolves.toEqual({ status: "idle" });
    await f.native.prompt("Continue the analysis.\nKeep the existing context.");
    expect(f.invoke).toHaveBeenLastCalledWith(
      {
        type: "prompt",
        message: "Continue the analysis.\nKeep the existing context.",
        behavior: undefined,
      },
      expect.any(Function),
      expect.any(Function),
    );
    f.native.close();
    await expect(f.native.read()).resolves.toBeNull();
    await expect(f.native.prompt("late input")).rejects.toMatchObject({
      status: 409,
    });
    expect(f.invoke).toHaveBeenCalledOnce();
  });

  it("delegates follow-up, interrupt and rename to native actions instead of keys or slash text", async () => {
    const f = fixture();
    f.agent.agent_status = "working";
    await f.native.prompt("Next task", "followUp");
    expect(f.invoke).toHaveBeenLastCalledWith(
      { type: "prompt", message: "Next task", behavior: "followUp" },
      expect.any(Function),
      expect.any(Function),
    );
    await f.native.abort();
    expect(f.invoke).toHaveBeenLastCalledWith(
      { type: "abort" },
      expect.any(Function),
      expect.any(Function),
    );
    await f.native.rename("Native title");
    expect(f.invoke).toHaveBeenLastCalledWith(
      { type: "rename", name: "Native title" },
      expect.any(Function),
      expect.any(Function),
    );
    expect(
      f.nativeAgentRequest.mock.calls.every(
        ([, , method]) => method === "agent.get",
      ),
    ).toBe(true);
  });

  it.each(["different session", "different process", "different agent"])(
    "does not submit to a %s",
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
      expect(f.invoke).not.toHaveBeenCalled();
    },
  );

  it("leaves a native question untouched and treats message controls only as data", async () => {
    const f = fixture();
    f.agent.agent_status = "blocked";
    await expect(f.native.prompt("ordinary message")).rejects.toMatchObject({
      status: 409,
    });
    expect(f.invoke).not.toHaveBeenCalled();
    await f.native.abort();
    expect(f.invoke).toHaveBeenCalledOnce();
    f.agent.agent_status = "done";
    await f.native.prompt("literal\x1b[13~");
    expect(f.invoke).toHaveBeenLastCalledWith(
      { type: "prompt", message: "literal\x1b[13~", behavior: undefined },
      expect.any(Function),
      expect.any(Function),
    );
  });

  it("rechecks Stop ownership at the action send boundary", async () => {
    const f = fixture();
    await expect(
      f.native.prompt("Stopped input", undefined, () => {
        throw requestError("Stopped", 409);
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      f.nativeAgentRequest.mock.calls.every(
        ([, , method]) => method === "agent.get",
      ),
    ).toBe(true);
  });

  it.each(["agent", "process"] as const)(
    "does not confuse an unavailable server with writer exit during %s inspection",
    async (boundary) => {
      const f = fixture(),
        read =
          boundary === "agent" ? f.nativeAgentRequest : f.inspectPaneProcess;
      read.mockRejectedValueOnce(new Error("Temporary socket failure"));
      await expect(f.native.read()).rejects.toThrow("Temporary socket failure");
      read.mockRejectedValueOnce(new HerdrServerChangedError());
      await expect(f.native.read()).rejects.toMatchObject({
        code: "SESSION_OWNER_UNAVAILABLE",
      });
      read.mockRejectedValueOnce(
        new HerdrApiError("agent_not_found", "Missing"),
      );
      await expect(f.native.read()).rejects.toMatchObject({
        code: "SESSION_OWNER_UNAVAILABLE",
      });
      expect(f.invoke).not.toHaveBeenCalled();
    },
  );

  it("does not retry an uncertain native invocation", async () => {
    const f = fixture();
    f.invoke.mockRejectedValueOnce(
      requestError("Unconfirmed", 504, {
        code: "PI_RPC_OUTCOME_UNKNOWN",
        outcomeUnknown: true,
      }),
    );
    await expect(f.native.prompt("Only once")).rejects.toMatchObject({
      status: 504,
      outcomeUnknown: true,
    });
    expect(f.invoke).toHaveBeenCalledOnce();
  });
});
