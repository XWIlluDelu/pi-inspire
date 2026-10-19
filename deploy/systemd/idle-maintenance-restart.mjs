import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REQUEST_TIMEOUT_MS = 6_000;

function usage() {
  console.error(
    "Use: idle-maintenance-restart --root <path> --state <path> --controller <path>",
  );
}

function parseArguments(arguments_) {
  const values = new Map();
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    if (!flag?.startsWith("--") || !value || values.has(flag)) return null;
    values.set(flag, value);
  }
  if (values.size !== 3 || arguments_.length !== 6) return null;
  const root = values.get("--root");
  const state = values.get("--state");
  const controller = values.get("--controller");
  return root && state && controller ? { root, state, controller } : null;
}

function stateForRoot(value, root) {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof value.root === "string" &&
      resolve(value.root) === root &&
      ["127.0.0.1", "::1", "localhost"].includes(value.host) &&
      Number.isInteger(value.port) &&
      value.port > 0 &&
      value.port <= 65_535 &&
      typeof value.token === "string" &&
      value.token.length > 0,
  );
}

const sourceControl = new URL("../../server/instance-control.mjs", import.meta.url);
const controlModule = existsSync(sourceControl)
  ? sourceControl
  : new URL("../../build/server/instance-control.mjs", import.meta.url);
let control;

export async function requestMaintenance(state, action = "", leaseId) {
  if (
    state.httpControlVersion !== 1 ||
    !["", "commit", "release"].includes(action)
  )
    return null;
  const { requestInstanceControl } = await (control ??= import(controlModule.href));
  return requestInstanceControl(
    state,
    action ? `maintenance-${action}` : "maintenance-prepare",
    leaseId === undefined ? {} : { leaseId },
    REQUEST_TIMEOUT_MS,
  );
}

/** No cached boolean authorization and no commit retries. A timed-out commit
 * is cancellation, never permission to execute its possibly delayed response. */
export async function runIdleMaintenanceRestart(
  state,
  root,
  restart,
  request = requestMaintenance,
) {
  let lease;
  try {
    lease = await request(state);
  } catch {
    return { kind: "skipped", reason: "host-unavailable" };
  }
  if (
    !lease ||
    lease.kind !== "ready" ||
    typeof lease.leaseId !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/u.test(lease.leaseId) ||
    !Number.isInteger(lease.expiresAt)
  )
    return { kind: "skipped", reason: "not-prepared" };

  // The identity is never printed or persisted by the runner. It is the release
  // capability as well as the fence, scoped to this Host incarnation and owner.
  return restart(root, {
    commit: async () => {
      const result = await request(state, "commit", lease.leaseId);
      return result?.kind === "committed" && result.leaseId === lease.leaseId;
    },
    release: async () => {
      const result = await request(state, "release", lease.leaseId);
      return (
        result?.kind === "released" ||
        (result?.kind === "skipped" && result.reason === "lease-invalid")
      );
    },
  });
}

async function main() {
  const arguments_ = parseArguments(process.argv.slice(2));
  if (!arguments_) {
    usage();
    process.exitCode = 64;
    return;
  }
  const root = resolve(arguments_.root);
  let state;
  try {
    state = JSON.parse(await readFile(arguments_.state, "utf8"));
  } catch {
    console.log("INSΠRE idle maintenance restart skipped: no current host state.");
    return;
  }
  if (!stateForRoot(state, root)) {
    console.log(
      "INSΠRE idle maintenance restart skipped: state does not identify this local host.",
    );
    return;
  }
  const { restartIdleHost } = await import(
    pathToFileURL(resolve(arguments_.controller)).href
  );
  if (typeof restartIdleHost !== "function") {
    console.log("INSΠRE idle maintenance restart skipped: controller unsupported.");
    return;
  }
  const result = await runIdleMaintenanceRestart(state, root, restartIdleHost);
  if (result.kind === "recovery-required") {
    console.error(
      "INSΠRE maintenance restart outcome unconfirmed; admission may remain closed. " +
        "Do not release until the runner and any pending restart are ruled out; " +
        "see the Host lifecycle maintenance recovery contract.",
    );
    process.exitCode = 1;
    return;
  }
  console.log(
    result.kind === "restarted"
      ? "INSΠRE idle maintenance restart completed."
      : "INSΠRE idle maintenance restart skipped.",
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main().catch(() => {
    console.error("INSΠRE idle maintenance restart failed.");
    process.exitCode = 1;
  });
}
