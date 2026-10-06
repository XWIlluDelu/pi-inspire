import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { PiRpcProcess } from "../../server/pi-rpc.js";
import { readWorkerRetryState } from "../../server/runtime-retry-state.js";
import {
  decodeBranchBridgeJson,
  encodeBranchBridgeJson,
  RETRY_STATE_SUFFIX,
} from "../../shared/branch-bridge-protocol.js";

const bridge = {
  command: "inspire_branch_abcdefghijklmnopqrstuvwxyz",
  statusKey: "inspire_status_abcdefghijklmnopqrstuvwxyz",
  workerId: "worker_abcdefghijklmnopqrstuvwxyz",
};
const sessionId = "33333333-3333-4333-8333-333333333333";

function fixture(
  respond: (
    request: Record<string, unknown>,
    emit: (value: unknown) => void,
  ) => void,
) {
  const rpc = new EventEmitter() as EventEmitter & {
    request(command: Record<string, unknown>): Promise<unknown>;
  };
  rpc.request = async (command) => {
    expect(command.type).toBe("prompt");
    expect(String(command.message)).toMatch(
      new RegExp(`^/${bridge.command}${RETRY_STATE_SUFFIX} `),
    );
    const encoded = String(command.message).split(" ")[1];
    const request = decodeBranchBridgeJson(encoded, 16_384) as Record<
      string,
      unknown
    >;
    respond(request, (value) =>
      rpc.emit("event", {
        type: "extension_ui_request",
        method: "setStatus",
        statusKey: `${bridge.statusKey}${RETRY_STATE_SUFFIX}`,
        statusText: encodeBranchBridgeJson(value, 2_048),
      }),
    );
    return { disposition: "handled" };
  };
  return rpc;
}

describe("worker retry state read", () => {
  it("confirms false without treating it as a missing result", async () => {
    const rpc = fixture((request, emit) => {
      emit({ ...request, autoRetryEnabled: false });
    });
    await expect(
      readWorkerRetryState(rpc as unknown as PiRpcProcess, bridge, sessionId),
    ).resolves.toBe(false);
  });

  it.each(["missing", "malformed", "duplicate"])(
    "rejects a %s confirmation rather than inventing a value",
    async (mode) => {
      const rpc = fixture((request, emit) => {
        if (mode === "missing") return;
        emit({
          ...request,
          autoRetryEnabled: mode === "malformed" ? "true" : true,
        });
        if (mode === "duplicate") emit({ ...request, autoRetryEnabled: false });
      });
      await expect(
        readWorkerRetryState(rpc as unknown as PiRpcProcess, bridge, sessionId),
      ).rejects.toThrow(
        mode === "missing" ? "did not confirm" : "Malformed retry state result",
      );
    },
  );
});
