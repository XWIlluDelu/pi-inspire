import { describe, expect, it, vi } from "vitest";
import { runIdleMaintenanceRestart } from "../../deploy/systemd/idle-maintenance-restart.mjs";
import { RuntimeController } from "../../server/runtime.js";
import {
  environment,
  invocationId,
  managedProperties,
  root,
  show,
} from "./systemd-fixture.mjs";

const state = { systemdInvocationId: invocationId };
const leaseId = "a".repeat(43);
const ready = { kind: "ready", leaseId, expiresAt: 30_000 };

function fixture({
  request,
  inspect = async () => {},
  issue = async () => ({ code: 0 }),
} = {}) {
  const requests = [];
  const run = vi.fn(async (args) => {
    if (args.includes("restart")) return issue();
    const terminal = args.includes("inspire-terminal.service");
    await inspect(terminal);
    return show(managedProperties())(args);
  });
  return {
    run,
    requests,
    execute: () =>
      runIdleMaintenanceRestart(state, root, {
        environment,
        run,
        request: async (_state, action, owner) => {
          requests.push([action, owner]);
          if (request) return request(action, owner);
          if (!action) return ready;
          if (action === "commit") return { kind: "committed", leaseId: owner };
          return { kind: "released" };
        },
      }),
  };
}

const restarts = (run) =>
  run.mock.calls.filter(([args]) => args.includes("restart"));

describe.runIf(process.platform !== "win32")(
  "fenced maintenance runner",
  () => {
    it.each(["inspection", "lost commit reply", "post-commit"])(
      "keeps the real runtime safe across a delayed %s boundary",
      async (delayAt) => {
        vi.useFakeTimers();
        // These admission-only operations need no catalog, attachment, or Pi access.
        const runtime = new RuntimeController(
          {},
          {},
          {
            createProcess: () => {
              throw new Error("No real worker allowed");
            },
          },
        );
        try {
          let admissionWhileInspecting;
          let commitResult;
          const test = fixture({
            inspect: async (terminal) => {
              if (delayAt === "inspection" && terminal) {
                vi.advanceTimersByTime(31_000);
                admissionWhileInspecting = await runtime.deselectSession();
              }
            },
            issue: async () => {
              vi.advanceTimersByTime(60_000);
              await expect(runtime.newSession(root)).rejects.toMatchObject({
                status: 503,
              });
              return { code: 0 };
            },
            request: async (action, owner) => {
              if (action === "commit") {
                commitResult = runtime.commitMaintenanceRestart(owner);
                return delayAt === "lost commit reply" ? null : commitResult;
              }
              if (action === "release")
                return runtime.releaseMaintenanceRestart(owner);
              return runtime.reserveMaintenanceRestart();
            },
          });
          expect((await test.execute()).kind).toBe(
            delayAt === "post-commit" ? "restarted" : "skipped",
          );
          expect(restarts(test.run)).toHaveLength(
            delayAt === "post-commit" ? 1 : 0,
          );
          if (delayAt === "inspection")
            expect(admissionWhileInspecting).toMatchObject({
              runState: "idle",
            });
          if (delayAt === "post-commit")
            expect(runtime.reserveMaintenanceRestart().kind).toBe("busy");
          if (delayAt === "lost commit reply") {
            expect(commitResult?.kind).toBe("committed");
            expect(test.requests.map(([action]) => action)).toEqual([
              undefined,
              "commit",
              "release",
            ]);
            expect(runtime.reserveMaintenanceRestart().kind).toBe("ready");
          }
        } finally {
          await runtime.close();
          vi.useRealTimers();
        }
      },
    );

    it.each([
      null,
      { kind: "ready", expiresAt: 30_000 },
      { kind: "skipped", reason: "busy" },
    ])(
      "skips unavailable or busy preparation without systemctl: %j",
      async (response) => {
        const test = fixture({ request: async () => response });
        expect((await test.execute()).kind).toBe("skipped");
        expect(test.run).not.toHaveBeenCalled();
      },
    );

    it.each([
      {
        label: "foreign commit",
        commit: { kind: "committed", leaseId: "b".repeat(43) },
        result: { kind: "skipped", reason: "commit-not-authorized" },
        issued: false,
        release: true,
      },
      {
        label: "known failure to spawn",
        issue: { code: 1, issued: false },
        result: { kind: "skipped", reason: "restart-not-issued" },
        issued: true,
        release: true,
      },
      {
        label: "potentially issued restart",
        issue: { code: 1 },
        result: {
          kind: "recovery-required",
          reason: "restart-outcome-unknown",
        },
        issued: true,
        release: false,
      },
      {
        label: "unconfirmed release",
        commit: null,
        released: null,
        result: { kind: "recovery-required", reason: "release-unconfirmed" },
        issued: false,
        release: true,
      },
    ])(
      "keeps the lease identity and reports $label",
      async ({ commit, released, issue, result, issued, release }) => {
        const runner = fixture({
          issue: async () => issue,
          request: async (action, owner) => {
            if (!action) return ready;
            if (action === "commit")
              return commit === undefined
                ? { kind: "committed", leaseId: owner }
                : commit;
            return released === undefined ? { kind: "released" } : released;
          },
        });
        expect(await runner.execute()).toEqual(result);
        expect(restarts(runner.run)).toHaveLength(Number(issued));
        expect(runner.requests).toEqual([
          [undefined, undefined],
          ["commit", leaseId],
          ...(release ? [["release", leaseId]] : []),
        ]);
      },
    );
  },
);
