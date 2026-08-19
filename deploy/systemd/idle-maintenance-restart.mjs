import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
      resolve(value.root) === root &&
      ["127.0.0.1", "::1", "localhost"].includes(value.host) &&
      Number.isInteger(value.port) &&
      value.port > 0 &&
      value.port <= 65_535 &&
      typeof value.token === "string" &&
      value.token.length > 0,
  );
}

function displayHost(host) {
  return host === "::1" ? "[::1]" : host;
}

async function requestLease(state) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(
      `http://${displayHost(state.host)}:${state.port}/api/maintenance/restart`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${state.token}` },
        signal: controller.signal,
      },
    );
    if (!response.ok) return false;
    const body = await response.json().catch(() => null);
    return Boolean(
      body &&
        body.kind === "ready" &&
        Number.isInteger(body.expiresAt) &&
        body.expiresAt > Date.now() + 1_000,
    );
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function restartManagedHost(root, controller) {
  return new Promise((resolveResult) => {
    const child = spawn(process.execPath, [controller, "--root", root, "restart"], {
      stdio: "inherit",
    });
    child.once("error", () => resolveResult(1));
    child.once("exit", (code) => resolveResult(code ?? 1));
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
  if (!(await requestLease(state))) {
    console.log("INSΠRE idle maintenance restart skipped.");
    return;
  }
  console.log(
    "INSΠRE idle maintenance restart approved; restarting the managed host.",
  );
  process.exitCode = await restartManagedHost(root, arguments_.controller);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main().catch(() => {
    console.error("INSΠRE idle maintenance restart failed.");
    process.exitCode = 1;
  });
}
