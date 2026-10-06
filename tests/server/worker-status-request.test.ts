import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { PiRpcProcess } from "../../server/pi-rpc.js";
import { requestWorkerAuth } from "../../server/provider-auth-bridge.js";
import { readPendingImageEvidence } from "../../server/runtime-pending-image-evidence.js";
import { requestWorkerStatus } from "../../server/worker-status-request.js";
import {
  BRANCH_BRIDGE_VERSION,
  decodeBranchBridgeJson,
  encodeBranchBridgeJson,
  PENDING_IMAGE_SUFFIX,
} from "../../shared/branch-bridge-protocol.js";

const bridge = { command: "command", statusKey: "status", workerId: "worker" };
const sessionId = "session";
function fixture(
  respond: (
    owner: Record<string, unknown>,
    emit: (packet: object, event?: object) => void,
  ) => Promise<void> | void,
) {
  const events = new EventEmitter();
  const request = vi.fn(async (command: Record<string, unknown>) => {
    expect(command.type).toBe("prompt");
    const [name, argument] = String(command.message).split(" ");
    const owner = decodeBranchBridgeJson(argument, 4_096) as Record<
      string,
      unknown
    >;
    await respond(owner, (packet, event) =>
      events.emit("event", {
        type: "extension_ui_request",
        method: "setStatus",
        statusKey: `${bridge.statusKey}${name!.slice(bridge.command.length + 1)}`,
        statusText: encodeBranchBridgeJson(packet, 4_096),
        ...event,
      }),
    );
    return { disposition: "handled" };
  });
  return Object.assign(events, { request }) as unknown as PiRpcProcess;
}
const options = {
  suffix: "_query",
  maxArgumentBytes: 4_096,
  maxResultBytes: 4_096,
  malformedError: new Error("Malformed query result"),
};

describe("hidden worker status correlation", () => {
  it("subscribes before dispatch, filters every owner and waits for the prompt fence", async () => {
    let release!: () => void;
    const fence = new Promise<void>((resolve) => {
      release = resolve;
    });
    const receive = vi.fn();
    const retained = vi.fn();
    const rpc = fixture(async (owner, emit) => {
      for (const key of ["nonce", "workerId", "sessionId"])
        emit({ ...owner, [key]: "other" });
      for (const event of [
        { type: "notify" },
        { method: "notify" },
        { statusKey: "other" },
      ])
        emit(owner, event);
      emit({ ...owner, result: false });
      await fence;
    });
    rpc.on("event", retained);
    let finished = false;
    const pending = requestWorkerStatus(
      rpc,
      bridge,
      sessionId,
      options,
      receive,
    ).then(() => {
      finished = true;
    });
    expect(receive).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ result: false }),
    );
    expect(finished).toBe(false);
    release();
    await pending;
    expect(rpc.listeners("event")).toEqual([retained]);
    expect(rpc.request).toHaveBeenCalledWith(expect.any(Object), 30_000);
  });

  it.each(["request", "packet", "argument"])(
    "cleans up on %s failure without swallowing RPC errors",
    async (failure) => {
      const error = new Error("Request failed");
      const rpc = fixture((owner, emit) => {
        if (failure === "request") throw error;
        emit(owner, { statusText: "not-encoded-json" });
        emit(owner); // a later valid packet cannot erase malformed evidence
      });
      const query = {
        ...options,
        ...(failure === "argument" ? { maxArgumentBytes: 1 } : {}),
      };
      await expect(
        requestWorkerStatus(rpc, bridge, sessionId, query, () => {}),
      ).rejects.toThrow(
        failure === "request"
          ? error
          : failure === "packet"
            ? options.malformedError
            : /exceeds.*limit/,
      );
      expect(rpc.listenerCount("event")).toBe(0);
    },
  );

  it.each(["missing result", "duplicate result"])(
    "rejects an authentication %s instead of returning an apparent success",
    async (failure) => {
      const rpc = fixture((owner, emit) => {
        if (failure === "missing result") emit(owner);
        else {
          emit({ ...owner, result: null });
          emit({ ...owner, result: [] });
        }
      });
      await expect(
        requestWorkerAuth(rpc, bridge, sessionId, { operation: "providers" }),
      ).rejects.toMatchObject({
        status: 409,
        message: "Pi returned an invalid authentication response",
      });
    },
  );

  it("preserves repeated image evidence packets and requires their final cursor", async () => {
    const message = {
      identity: "a".repeat(64),
      fingerprint: "b".repeat(64),
      textFingerprint: "c".repeat(64),
      imageCount: 2,
    };
    const rpc = fixture((owner, emit) => {
      expect(owner).toMatchObject({ v: BRANCH_BRIDGE_VERSION, since: null });
      emit({ ...owner, message });
      emit({ ...owner, message });
      emit({ ...owner, cursor: "tail" });
    });
    await expect(
      readPendingImageEvidence(rpc, bridge, sessionId, null),
    ).resolves.toEqual({ messages: [message, message], cursor: "tail" });
    expect(rpc.request).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining(PENDING_IMAGE_SUFFIX),
      }),
      30_000,
    );
    const late = fixture((owner, emit) => {
      emit({ ...owner, cursor: null });
      emit({ ...owner, message });
    });
    await expect(
      readPendingImageEvidence(late, bridge, sessionId),
    ).rejects.toThrow("Malformed pending image evidence");
  });
});
