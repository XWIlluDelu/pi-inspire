import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import inspireBranchBridge from "../../server/extensions/inspire-branch-bridge.js";
import {
  decodeBranchBridgeJson,
  encodeBranchBridgeJson,
  RETRY_STATE_SUFFIX,
} from "../../shared/branch-bridge-protocol.js";

const command = "inspire_branch_abcdefghijklmnopqrstuvwxyz123456";
const statusKey = "inspire_status_abcdefghijklmnopqrstuvwxyz123456";
const workerId = "worker_abcdefghijklmnopqrstuvwxyz123456";
const sessionId = "session-a";

afterEach(() => vi.unstubAllEnvs());

function setup(navigateTree = async () => ({ cancelled: false })) {
  vi.stubEnv("INSPIRE_BRANCH_COMMAND", command);
  vi.stubEnv("INSPIRE_BRANCH_STATUS_KEY", statusKey);
  vi.stubEnv("INSPIRE_BRANCH_WORKER_ID", workerId);
  type Handler = (
    argument: string,
    context: ExtensionCommandContext,
  ) => Promise<void>;
  const handlers = new Map<string, Handler>();
  const getSettings = vi.fn();
  const api = {
    on: vi.fn(),
    getSettings,
    registerCommand(name: string, value: { handler: Handler }) {
      handlers.set(name, value.handler);
    },
  } as unknown as ExtensionAPI;
  inspireBranchBridge(api);
  const statuses: Array<[string, string | undefined]> = [];
  const context = {
    mode: "rpc",
    isIdle: () => true,
    hasPendingMessages: () => false,
    sessionManager: {
      getSessionId: () => sessionId,
      getLeafId: () => "old-leaf",
      getEntries: () => [],
      getEntry: (id: string) => (id === "target" ? { id } : undefined),
    },
    navigateTree: vi.fn(navigateTree),
    ui: {
      setStatus: (key: string, text: string | undefined) =>
        statuses.push([key, text]),
    },
  } as unknown as ExtensionCommandContext;
  return { handlers, getSettings, context, statuses };
}

function argument() {
  return Buffer.from(
    JSON.stringify({
      v: 1,
      nonce: "nonce_abcdefghijklmnopqrstuvwxyz123456",
      workerId,
      sessionId,
      operation: "navigate",
      targetId: "target",
    }),
  ).toString("base64url");
}

function decoded(statuses: Array<[string, string | undefined]>) {
  return decodeBranchBridgeJson(statuses[0]![1], 2_048);
}

describe("inspire branch extension", () => {
  it("rejects a settings read for another session before reading settings", async () => {
    const fixture = setup();
    const request = {
      v: 1,
      nonce: "nonce_abcdefghijklmnopqrstuvwxyz123456",
      workerId,
      sessionId: "another-session",
    };
    await expect(
      fixture.handlers.get(`${command}${RETRY_STATE_SUFFIX}`)!(
        Buffer.from(JSON.stringify(request)).toString("base64url"),
        fixture.context,
      ),
    ).rejects.toThrow("invalid retry state owner");
    expect(fixture.getSettings).not.toHaveBeenCalled();
    expect(fixture.statuses).toHaveLength(0);
  });
  it("independently enforces decoded bytes and encoded characters", () => {
    // Twelve decoded JSON bytes fit, but their sixteen base64url characters do not.
    expect(() => encodeBranchBridgeJson("1234567890", 12)).toThrow(
      /encoded character/,
    );
    const encoded = Buffer.from(JSON.stringify("1234567890"), "utf8").toString(
      "base64url",
    );
    expect(Buffer.from(encoded, "base64url")).toHaveLength(12);
    expect(() => decodeBranchBridgeJson(encoded, 12)).toThrow(/encoding/);
  });

  it("rejects non-canonical and malformed UTF-8 framing", () => {
    expect(() => decodeBranchBridgeJson("YWJj=", 32)).toThrow(/encoding/);
    expect(() =>
      decodeBranchBridgeJson(Buffer.from([0xff]).toString("base64url"), 32),
    ).toThrow();
  });

  it("returns a bounded error without navigating on oversized input", async () => {
    const fixture = setup();
    await fixture.handlers.get(command)!("a".repeat(4_100), fixture.context);
    expect(fixture.statuses).toHaveLength(1);
    expect(decoded(fixture.statuses)).toMatchObject({
      ok: false,
      cancelled: false,
      error: expect.any(String),
    });
    expect(fixture.context.navigateTree).not.toHaveBeenCalled();
  });

  it("catches navigation errors and reports them instead of relying on prompt success", async () => {
    const fixture = setup(async () => {
      throw new Error("tree hook failed");
    });
    await fixture.handlers.get(command)!(argument(), fixture.context);
    expect(fixture.statuses).toHaveLength(1);
    expect(decoded(fixture.statuses)).toMatchObject({
      ok: false,
      error: "tree hook failed",
      beforeLeaf: "old-leaf",
      effectiveLeaf: "old-leaf",
    });
  });
});
