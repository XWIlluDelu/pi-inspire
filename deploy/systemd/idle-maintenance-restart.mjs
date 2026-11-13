import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { submitSystemdRestart } from "./control.mjs";

const source = new URL("../../server/instance-control.mjs", import.meta.url);
const support = existsSync(source) ? "../../server/" : "../../build/server/";
const [{ requestInstanceControl }, { readInstanceState }] = await Promise.all(
  ["instance-control.mjs", "instance-state.mjs"].map((module) =>
    import(new URL(support + module, import.meta.url).href),
  ),
);

export function requestMaintenance(state, action = "", leaseId) {
  return requestInstanceControl(
    state,
    action ? `maintenance-${action}` : "maintenance-prepare",
    leaseId === undefined ? {} : { leaseId },
    6_000,
  );
}

/** One lease, one commit. The plan releases only when it proved no issuance. */
export async function runIdleMaintenanceRestart(
  state,
  root,
  { request = requestMaintenance, ...systemd } = {},
) {
  if (!/^[a-f0-9]{32}$/u.test(state.systemdInvocationId ?? ""))
    return { kind: "skipped", reason: "unsupported" };
  const lease = await request(state);
  if (
    lease?.kind !== "ready" ||
    !/^[A-Za-z0-9_-]{43}$/u.test(lease.leaseId ?? "") ||
    !Number.isInteger(lease.expiresAt)
  )
    return { kind: "skipped", reason: "not-prepared" };

  const result = await submitSystemdRestart(root, {
    invocationId: state.systemdInvocationId,
    commit: async () => {
      const reply = await request(state, "commit", lease.leaseId);
      return reply?.kind === "committed" && reply.leaseId === lease.leaseId;
    },
  }, systemd);
  if (result.kind === "issued") return { kind: "restarted" };
  if (result.kind === "unconfirmed")
    return { kind: "recovery-required", reason: "restart-outcome-unknown" };
  try {
    const released = await request(state, "release", lease.leaseId);
    if (
      released?.kind === "released" ||
      (released?.kind === "skipped" && released.reason === "lease-invalid")
    )
      return { kind: "skipped", reason: result.reason };
  } catch {
    // A lost release response cannot prove that admission reopened.
  }
  return { kind: "recovery-required", reason: "release-unconfirmed" };
}

export async function runScheduledRestart(root, statePath) {
  const state = await readInstanceState(statePath).catch(() => null);
  if (
    !state ||
    resolve(state.root) !== root ||
    !["127.0.0.1", "::1", "localhost"].includes(state.host)
  ) {
    console.log("INSΠRE idle maintenance restart skipped: state does not identify this local host.");
    return 0;
  }
  const result = await runIdleMaintenanceRestart(state, root);
  if (result.kind === "recovery-required") {
    console.error(
      "INSΠRE maintenance restart outcome unconfirmed; admission may remain closed. " +
        "Do not release until the runner and any pending restart are ruled out; " +
        "see the Host lifecycle maintenance recovery contract.",
    );
    return 1;
  }
  console.log(
    result.kind === "restarted"
      ? "INSΠRE idle maintenance restart completed."
      : "INSΠRE idle maintenance restart skipped.",
  );
  return 0;
}
