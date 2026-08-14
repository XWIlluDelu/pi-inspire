import { afterEach, describe, expect, it, vi } from "vitest";
import inspireBranchBridge from "../../server/extensions/inspire-branch-bridge.js";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

const command = "inspire_branch_abcdefghijklmnopqrstuvwxyz123456";
const statusKey = "inspire_status_abcdefghijklmnopqrstuvwxyz123456";
const workerId = "worker_abcdefghijklmnopqrstuvwxyz123456";
const sessionId = "33333333-3333-4333-8333-333333333333";

afterEach(() => vi.unstubAllEnvs());

function setup(
  navigateTree: (
    target: string,
    options: unknown,
  ) => Promise<{ cancelled: boolean }> = vi.fn(async () => ({
    cancelled: false,
  })),
) {
  vi.stubEnv("INSPIRE_BRANCH_COMMAND", command);
  vi.stubEnv("INSPIRE_BRANCH_STATUS_KEY", statusKey);
  vi.stubEnv("INSPIRE_BRANCH_WORKER_ID", workerId);
  let handler!: (
    argument: string,
    context: ExtensionCommandContext,
  ) => Promise<void>;
  const api = {
    registerCommand(name: string, value: { handler: typeof handler }) {
      expect(name).toBe(command);
      handler = value.handler;
    },
  } as unknown as ExtensionAPI;
  inspireBranchBridge(api);
  const statuses: Array<[string, string | undefined]> = [];
  let leaf: string | null = "old-leaf";
  const context = {
    mode: "rpc",
    isIdle: () => true,
    hasPendingMessages: () => false,
    sessionManager: {
      getSessionId: () => sessionId,
      getLeafId: () => leaf,
      getEntry: (id: string) => (id === "target" ? { id } : undefined),
    },
    navigateTree: vi.fn(async (target: string, options: unknown) => {
      const result = await navigateTree(target, options);
      if (!result.cancelled) leaf = target;
      return result;
    }),
    ui: {
      setStatus: (key: string, text: string | undefined) =>
        statuses.push([key, text]),
    },
  } as unknown as ExtensionCommandContext;
  return { handler, context, statuses, navigateTree };
}

function argument(nonce = "nonce_abcdefghijklmnopqrstuvwxyz123456") {
  return Buffer.from(
    JSON.stringify({
      v: 1,
      nonce,
      workerId,
      sessionId,
      operation: "navigate",
      targetId: "target",
    }),
  ).toString("base64url");
}

function decoded(statuses: Array<[string, string | undefined]>) {
  return JSON.parse(
    Buffer.from(statuses[0]![1]!, "base64url").toString("utf8"),
  ) as Record<string, unknown>;
}

describe("inspire branch extension", () => {
  it("uses public unsummarized navigation and emits one bounded final nonce result", async () => {
    const fixture = setup();
    await fixture.handler(argument(), fixture.context);
    expect(fixture.context.navigateTree).toHaveBeenCalledWith("target", {
      summarize: false,
    });
    expect(fixture.statuses).toHaveLength(1);
    expect(fixture.statuses[0]![0]).toBe(statusKey);
    expect(fixture.statuses[0]![1]!.length).toBeLessThan(2_048);
    expect(decoded(fixture.statuses)).toMatchObject({
      v: 1,
      nonce: "nonce_abcdefghijklmnopqrstuvwxyz123456",
      workerId,
      sessionId,
      ok: true,
      cancelled: false,
      beforeLeaf: "old-leaf",
      effectiveLeaf: "target",
    });
  });

  it.each(["%%%", "a".repeat(4_100)])(
    "catches malformed input and still emits exactly one small error result",
    async (input) => {
      const fixture = setup();
      await expect(
        fixture.handler(input, fixture.context),
      ).resolves.toBeUndefined();
      expect(fixture.statuses).toHaveLength(1);
      expect(decoded(fixture.statuses)).toMatchObject({
        ok: false,
        cancelled: false,
        error: expect.any(String),
      });
      expect(fixture.context.navigateTree).not.toHaveBeenCalled();
    },
  );

  it("catches navigation errors and reports them instead of relying on prompt success", async () => {
    const fixture = setup(
      vi.fn(async () => {
        throw new Error("tree hook failed");
      }),
    );
    await expect(
      fixture.handler(argument(), fixture.context),
    ).resolves.toBeUndefined();
    expect(fixture.statuses).toHaveLength(1);
    expect(decoded(fixture.statuses)).toMatchObject({
      ok: false,
      error: "tree hook failed",
      beforeLeaf: "old-leaf",
    });
  });
});
