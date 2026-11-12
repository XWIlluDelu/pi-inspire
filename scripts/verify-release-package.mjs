import assert from "node:assert/strict";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { npmInvocation } from "../server/npm-command.mjs";
import {
  isolatedProcessOptions,
  signalProcessTree,
} from "../server/process-tree.mjs";
import {
  npmPackageRecord,
  parseNpmJsonOutput,
} from "./npm-package-manifest.mjs";

const execFile = promisify(execFileCallback);
const root = resolve(import.meta.dirname, "..");
const plexSansManifestDigest =
  "012a329e2e373c4aba5c81e46eb6df3bc78252fc65d97e2207a5c12ce286e6c6";
const fluxSumsDigest =
  "3d2eb1c72f167c502e9809c4f08d9ab9e5d37ba880e5281775a5ec5bcb788c7a";

async function execNpm(args, options = {}) {
  const invocation = npmInvocation(args, {
    environment: options.env ?? process.env,
    cwd: options.cwd ?? root,
  });
  return execFile(invocation.command, invocation.args, {
    ...options,
    env: invocation.environment,
  });
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function reviewedText(value, label) {
  if (value.includes(0x0d))
    throw new Error(`${label} contains unsupported carriage returns`);
  return value;
}

function parseSha256Sums(value, label) {
  const entries = new Map();
  for (const line of value.trimEnd().split("\n")) {
    const match = line.match(/^([a-f0-9]{64})  ([A-Za-z0-9.-]+)$/u);
    if (!match || entries.has(match[2]))
      throw new Error(`${label} has an invalid checksum manifest`);
    entries.set(match[2], match[1]);
  }
  return entries;
}

async function verifyFontFiles(directory, manifestDigest, label) {
  const manifest = await readFile(join(directory, "SHA256SUMS"));
  if (sha256(manifest) !== manifestDigest)
    throw new Error(
      `${label} checksum manifest differs from the reviewed release`,
    );
  const entries = parseSha256Sums(manifest.toString("ascii"), label);
  const files = (await readdir(directory)).filter(
    (name) => name !== "SHA256SUMS",
  );
  if (files.length !== entries.size || files.some((name) => !entries.has(name)))
    throw new Error(`${label} source directory and checksum manifest disagree`);
  for (const [filename, digest] of entries) {
    const value = await readFile(join(directory, filename));
    if (sha256(value) !== digest)
      throw new Error(`${label} provenance mismatch: ${filename}`);
  }
  return [...entries]
    .filter(([filename]) => filename.endsWith(".woff2"))
    .map(([, digest]) => digest);
}

async function verifySourceFonts() {
  const fontRoot = join(root, "src/assets/fonts");
  const digests = await Promise.all([
    verifyFontFiles(
      join(fontRoot, "ibm-plex-sans-sc"),
      plexSansManifestDigest,
      "IBM Plex Sans SC",
    ),
    verifyFontFiles(
      join(fontRoot, "flux-mono-sc"),
      fluxSumsDigest,
      "Flux Mono SC",
    ),
  ]);
  return new Set(digests.flat());
}

async function verifyInstalledFonts(installedRoot, expectedFonts) {
  const assets = join(installedRoot, "dist/assets");
  const installedDigests = new Set();
  let css = "";
  for (const filename of await readdir(assets)) {
    if (!/\.(?:woff2|css)$/u.test(filename)) continue;
    const value = await readFile(join(assets, filename));
    if (filename.endsWith(".woff2")) installedDigests.add(sha256(value));
    if (filename.endsWith(".css")) css += value.toString("utf8");
  }
  for (const match of css.matchAll(/data:[^;,]+;base64,([A-Za-z0-9+/=]+)/gu)) {
    installedDigests.add(sha256(Buffer.from(match[1], "base64")));
  }
  const missing = [...expectedFonts].filter(
    (digest) => !installedDigests.has(digest),
  );
  if (missing.length > 0)
    throw new Error(
      `Installed bundle is missing ${missing.length} verified font assets`,
    );
}

async function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Unable to allocate a release-smoke port"));
        return;
      }
      server.close((error) =>
        error ? reject(error) : resolvePort(address.port),
      );
    });
  });
}

async function waitFor(description, read, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function waitForExit(child, timeoutMs = 10_000) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolveExit, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      child.off("exit", exited);
      child.off("error", failed);
    };
    const exited = () => {
      cleanup();
      resolveExit();
    };
    const failed = (error) => {
      cleanup();
      reject(error);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Packaged host did not stop"));
    }, timeoutMs);
    child.once("exit", exited);
    child.once("error", failed);
  });
}

function startProcess(bin, args, options) {
  const child = spawn(process.execPath, [bin, ...args], {
    ...options,
    ...isolatedProcessOptions(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const fixture = { child, output: "" };
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (chunk) => {
      fixture.output = (fixture.output + String(chunk)).slice(-8192);
    });
  return fixture;
}

async function stopProcess(fixture) {
  if (!fixture) return;
  const { child } = fixture;
  for (const signal of ["SIGTERM", "SIGKILL"]) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await signalProcessTree(child, signal, { isolated: true });
    await waitForExit(child, 5_000).catch(() => undefined);
  }
}

const temporary = await realpath(
  await mkdtemp(join(tmpdir(), "inspire-release-smoke-")),
);
let host = null;
let terminalOwner = null;
let terminalClient = null;
let terminalControl = null;
try {
  const packDirectory = join(temporary, "pack");
  const installDirectory = join(temporary, "install");
  const stateDirectory = join(temporary, "state");
  const homeDirectory = join(temporary, "home");
  const agentDirectory = join(temporary, "pi-agent");
  await Promise.all([
    mkdir(packDirectory),
    mkdir(installDirectory),
    mkdir(stateDirectory, { mode: 0o700 }),
    mkdir(homeDirectory, { mode: 0o700 }),
    mkdir(agentDirectory, { mode: 0o700 }),
  ]);
  await Promise.all([
    mkdir(join(homeDirectory, "AppData", "Roaming"), { recursive: true }),
    mkdir(join(homeDirectory, "AppData", "Local"), { recursive: true }),
  ]);
  // Keep the release smoke independent of the runner's Pi credentials and
  // provide one no-network model that is sufficient for RPC startup.
  await writeFile(
    join(agentDirectory, "models.json"),
    `${JSON.stringify({
      providers: {
        "release-smoke": {
          baseUrl: "http://127.0.0.1:9/v1",
          api: "openai-completions",
          apiKey: "release-smoke",
          models: [{ id: "release-smoke" }],
        },
      },
    })}\n`,
    { mode: 0o600 },
  );

  const sourcePackage = JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  );
  const expectedFonts = await verifySourceFonts();
  if (sourcePackage.bin?.inspire !== "inspire.mjs") {
    throw new Error(
      "Release package must use npm's canonical inspire bin path",
    );
  }
  const packed = await execNpm(
    ["pack", "--silent", "--json", "--pack-destination", packDirectory],
    {
      cwd: root,
      maxBuffer: 10 * 1024 * 1024,
    },
  );
  const manifest = parseNpmJsonOutput(packed.stdout, "npm pack");
  const record = npmPackageRecord(manifest, "npm pack");
  if (typeof record.filename !== "string" || record.filename.length === 0) {
    throw new Error("npm pack did not report a tarball");
  }
  // The installed smoke exercises the Host, launcher, recovery, fork and PTY
  // module graph. Keep a contents check for optional entries it cannot load.
  const required = [
    "build/server/pi-worker-keeper.mjs",
    "build/server/pi-rpc-ui-relay.mjs",
    "build/server/host-restart-systemd.js",
    "connections/dispatch.mjs",
    "connections/ssh-reverse/manifest.json",
    "connections/ssh-reverse/runner.mjs",
    "connections/ssh-reverse/systemd/inspire-connection-ssh-reverse.service.in",
    "deploy/systemd/control.mjs",
    "deploy/systemd/inspire-host.service.in",
    "docs/ssh-reverse.md",
    "docs/examples/native-ui.ts",
    "docs/examples/session-activity.ts",
    "extensions/attach-control.ts",
    "build/extensions/attach-control.js",
    "extensions/inspire-session-bridge.ts",
    "build/extensions/inspire-session-bridge.js",
    "dist/index.html",
    "inspire",
  ];
  const packedPaths = new Set(
    (record.files ?? []).map((file) => file.path ?? ""),
  );
  const missing = required.filter((path) => !packedPaths.has(path));
  if (missing.length > 0)
    throw new Error(
      `Release tarball is missing required files: ${missing.join(", ")}`,
    );
  const forbidden = [...packedPaths].filter(
    (path) =>
      path.startsWith("tests/") ||
      path.startsWith("server/") ||
      (/\.(?:[cm]?ts|tsx)$/u.test(path) &&
        path !== "docs/examples/native-ui.ts" &&
        path !== "docs/examples/session-activity.ts" &&
        path !== "extensions/attach-control.ts" &&
        path !== "extensions/inspire-session-bridge.ts"),
  );
  if (forbidden.length > 0)
    throw new Error(
      `Release tarball contains source-only files: ${forbidden.join(", ")}`,
    );

  const tarball = join(packDirectory, record.filename);
  const publishDryRun = await execNpm(
    ["publish", tarball, "--dry-run", "--json"],
    {
      cwd: root,
      maxBuffer: 10 * 1024 * 1024,
    },
  );
  if (
    /auto-corrected|errors corrected|invalid and removed/iu.test(
      publishDryRun.stderr,
    )
  ) {
    throw new Error(
      `npm publish would rewrite release metadata:\n${publishDryRun.stderr}`,
    );
  }
  const publishManifest = parseNpmJsonOutput(
    publishDryRun.stdout,
    "npm publish dry-run",
  );
  const publishRecord = npmPackageRecord(
    publishManifest,
    "npm publish dry-run",
  );
  if (publishRecord.id !== `${sourcePackage.name}@${sourcePackage.version}`) {
    throw new Error("npm publish dry-run reported the wrong package identity");
  }

  await execNpm(
    [
      "install",
      "--prefix",
      installDirectory,
      "--omit=dev",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      tarball,
    ],
    { cwd: root, maxBuffer: 10 * 1024 * 1024 },
  );

  const installedRoot = join(
    installDirectory,
    "node_modules",
    sourcePackage.name,
  );
  const installedPackage = JSON.parse(
    await readFile(join(installedRoot, "package.json"), "utf8"),
  );
  if (
    installedPackage.name !== sourcePackage.name ||
    installedPackage.version !== sourcePackage.version
  ) {
    throw new Error("Installed release package identity is wrong");
  }
  if (installedPackage.license !== "MIT")
    throw new Error("Installed release package must declare MIT");
  if (installedPackage.bin?.inspire !== "inspire.mjs")
    throw new Error("Installed release package has the wrong inspire bin path");
  const shimHelp = await execNpm(
    ["--prefix", installDirectory, "exec", "--", "inspire", "--help"],
    { cwd: temporary, maxBuffer: 1024 * 1024 },
  );
  if (!shimHelp.stdout.includes("Usage:"))
    throw new Error("Installed npm inspire shim did not execute the CLI");
  const projectLicense = reviewedText(
    await readFile(join(installedRoot, "LICENSE")),
    "Installed project license",
  ).toString("utf8");
  if (
    !projectLicense.startsWith("MIT License\n") ||
    !projectLicense.includes("Copyright (c) 2026 XWIlluDelu")
  ) {
    throw new Error("Installed release package has the wrong project license");
  }
  const fontLicenses = `${await readFile(join(installedRoot, "src/assets/licenses/ibm-plex-LICENSE.txt"), "utf8")}\n${await readFile(join(installedRoot, "src/assets/licenses/ibm-plex-sans-sc-LICENSE.txt"), "utf8")}\n${await readFile(join(installedRoot, "src/assets/licenses/flux-mono-LICENSE.txt"), "utf8")}\n${await readFile(join(installedRoot, "src/assets/licenses/flux-mono-NOTICE.md"), "utf8")}`;
  for (const witness of [
    "SIL OPEN FONT LICENSE Version 1.1",
    'Reserved Font Name "Plex"',
    "IBM Corp.",
    "Flux Mono SC",
    "Modifications are copyright © 2026 XWIlluDelu",
  ]) {
    if (!fontLicenses.includes(witness))
      throw new Error(`Bundled font licenses are missing ${witness}`);
  }
  await verifyInstalledFonts(installedRoot, expectedFonts);
  const thirdPartyNotices = await readFile(
    join(installedRoot, "dist/THIRD_PARTY_NOTICES.txt"),
    "utf8",
  );
  for (const identity of [
    `@earendil-works/pi-tui@${sourcePackage.devDependencies["@earendil-works/pi-tui"]}`,
    "katex@",
    "react@",
    "rehype-katex@",
  ]) {
    if (!thirdPartyNotices.includes(identity))
      throw new Error(`Bundled notice is missing ${identity}`);
  }
  if (installedPackage.pi !== undefined)
    throw new Error(
      "Standalone INSΠRE must not declare a Pi resource manifest",
    );
  if (installedPackage.keywords?.includes("pi-package"))
    throw new Error(
      "Standalone INSΠRE must not use the Pi resource-package keyword",
    );
  if (installedPackage.dependencies?.["@earendil-works/pi-coding-agent"])
    throw new Error("Installed INSΠRE must not bundle a second Pi runtime");
  const bundledPiManifest = join(
    installDirectory,
    "node_modules/@earendil-works/pi-coding-agent/package.json",
  );
  if (
    await readFile(bundledPiManifest).then(
      () => true,
      () => false,
    )
  )
    throw new Error("Production installation unexpectedly contains Pi");
  const externalPiRoot = join(
    root,
    "node_modules/@earendil-works/pi-coding-agent",
  );
  const externalPi = JSON.parse(
    await readFile(join(externalPiRoot, "package.json"), "utf8"),
  );
  if (typeof externalPi.bin?.pi !== "string")
    throw new Error("Development Pi package has no CLI entry");
  const externalPiCommand = join(externalPiRoot, externalPi.bin.pi);

  const installed = (path) =>
    import(pathToFileURL(join(installedRoot, path)).href);

  // This worker has a separate compiled entry point and loads the external SDK.
  const forkSourcePath = join(temporary, "source.jsonl");
  const sourceId = randomUUID();
  const parentId = randomUUID();
  const targetId = randomUUID();
  const timestamp = new Date().toISOString();
  const message = (id, parentId) => ({
    type: "message",
    id,
    parentId,
    timestamp,
    message: { role: "user", content: id, timestamp: Date.now() },
  });
  const forkSource =
    [
      { type: "session", version: 3, id: sourceId, timestamp, cwd: temporary },
      message(parentId, null),
      message(targetId, parentId),
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n";
  await writeFile(forkSourcePath, forkSource, { mode: 0o600 });
  const previousPiCommand = process.env.INSPIRE_PI_COMMAND;
  process.env.INSPIRE_PI_COMMAND = externalPiCommand;
  const forkModule = await installed("build/server/session-fork.js").finally(
    () => {
      if (previousPiCommand === undefined)
        delete process.env.INSPIRE_PI_COMMAND;
      else process.env.INSPIRE_PI_COMMAND = previousPiCommand;
    },
  );
  const stagedFork = await forkModule.stageSessionFork({
    sourcePath: forkSourcePath,
    sourceSessionId: sourceId,
    sourceCommittedBytes: Buffer.byteLength(forkSource),
    sourceFingerprint: sha256(forkSource),
    targetId,
    targetParentId: parentId,
  });
  assert.equal(stagedFork.destinationLeafId, parentId);
  await forkModule.discardStagedSessionFork(stagedFork);

  const port = await freePort();
  const token = "inspire-release-smoke-token";
  const loopback = "127.0.0.1";
  const bin = join(installedRoot, "inspire.mjs");
  const workspace = join(temporary, "workspace");
  await mkdir(join(workspace, ".pi"), { recursive: true });
  const canonicalWorkspace = await realpath(workspace);
  await writeFile(
    join(workspace, ".pi", "settings.json"),
    JSON.stringify({
      defaultProvider: "release-smoke",
      defaultModel: "release-smoke",
      enabledModels: ["release-smoke/release-smoke"],
    }),
    { mode: 0o600 },
  );
  const statePath = join(stateDirectory, "instance.json");
  const environment = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !key.startsWith("INSPIRE_"),
      ),
    ),
    INSPIRE_HOST: loopback,
    INSPIRE_PORT: String(port),
    INSPIRE_TOKEN: token,
    INSPIRE_OPEN: "0",
    INSPIRE_ENVIRONMENT: "inherit",
    INSPIRE_STATE_PATH: statePath,
    INSPIRE_PREFERENCES_PATH: join(stateDirectory, "preferences.json"),
    INSPIRE_LOG_PATH: join(stateDirectory, "diagnostics.jsonl"),
    HOME: homeDirectory,
    USERPROFILE: homeDirectory,
    APPDATA: join(homeDirectory, "AppData", "Roaming"),
    LOCALAPPDATA: join(homeDirectory, "AppData", "Local"),
    XDG_CONFIG_HOME: join(homeDirectory, ".config"),
    XDG_DATA_HOME: join(homeDirectory, ".local", "share"),
    XDG_STATE_HOME: join(homeDirectory, ".local", "state"),
    XDG_CACHE_HOME: join(homeDirectory, ".cache"),
    XDG_RUNTIME_DIR: stateDirectory,
    PI_CODING_AGENT_DIR: agentDirectory,
    PI_OFFLINE: "1",
    INSPIRE_PI_COMMAND: externalPiCommand,
    // Keep fixture daemons independent of the user's service manager.
    DBUS_SESSION_BUS_ADDRESS: "unix:path=" + join(temporary, "no-user-bus"),
    NOTIFY_SOCKET: undefined,
    INVOCATION_ID: undefined,
  };
  const processOptions = { cwd: canonicalWorkspace, env: environment };
  const cli = (args) =>
    execFile(process.execPath, [bin, ...args], {
      ...processOptions,
      timeout: 40_000,
    });

  // Cover the compiled recovery entry point with one real bundle.
  const bundle = join(canonicalWorkspace, "recovery bundle");
  await mkdir(bundle);
  const recoveredPath = join(canonicalWorkspace, "recovered.jsonl");
  const payload = join(bundle, "recovered.jsonl");
  await writeFile(payload, forkSource);
  const { prepareSessionRecovery } = await installed(
    "build/server/session-recovery.js",
  );
  await prepareSessionRecovery(payload, recoveredPath);
  await cli(["recover-session", "recovery bundle"]);
  assert.equal(await readFile(recoveredPath, "utf8"), forkSource);
  await cli(["prepare-restart"]);

  // Own the real daemon as a fixture so failure cleanup can reap it. All
  // address and token defaults still resolve through the packaged launcher.
  terminalControl = { bin, environment };
  terminalOwner = startProcess(
    bin,
    [
      "terminal-daemon",
      "--root",
      installedRoot,
      "--host",
      loopback,
      "--port",
      String(port),
    ],
    processOptions,
  );
  const [protocol, { TerminalDaemonClient }, { terminalDaemonSecretPath }] =
    await Promise.all([
      installed("build/server/terminal-daemon-protocol.js"),
      installed("build/server/terminal-daemon-client.js"),
      installed("build/server/terminal-daemon-tls.js"),
    ]);
  const paths = { environment, home: homeDirectory };
  const daemonAddress = protocol.defaultTerminalDaemonAddress(
    installedRoot,
    loopback,
    port,
    paths,
  );
  const secretPath = terminalDaemonSecretPath(
    protocol.defaultTerminalDaemonTokenPath(
      installedRoot,
      loopback,
      port,
      paths,
    ),
  );
  terminalClient = await waitFor("the packaged terminal daemon", async () => {
    if (
      terminalOwner.child.exitCode !== null ||
      terminalOwner.child.signalCode !== null
    )
      throw new Error("Packaged terminal daemon exited during startup");
    try {
      const daemonToken = (await readFile(secretPath, "utf8")).trim();
      const client = new TerminalDaemonClient(daemonAddress, daemonToken);
      await client.probe();
      return client;
    } catch {
      return null;
    }
  });

  const origin = `http://${loopback}:${port}`;
  async function request(path, { method = "GET", body, headers } = {}) {
    const response = await fetch(origin + "/api" + path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok)
      throw new Error(
        `${method} ${path} failed (${response.status}): ${await response.text()}`,
      );
    return response.json();
  }
  async function terminalMutation(path, method, body) {
    const { epoch } = await request("/terminal-operations");
    return request(path, {
      method,
      body,
      headers: {
        "X-Terminal-Operation": JSON.stringify({ id: randomUUID(), epoch }),
      },
    });
  }

  host = startProcess(bin, [], processOptions);
  const hostState = await waitFor("the packaged Host", async () => {
    if (host.child.exitCode !== null || host.child.signalCode !== null)
      throw new Error("Packaged launcher exited during startup");
    try {
      const state = JSON.parse(await readFile(statePath, "utf8"));
      const health = await request("/health");
      return health.appName === "inspire" && state.processStartTime && state;
    } catch {
      return null;
    }
  });
  const status = await cli(["status"]);
  assert.match(status.stdout, /#inspire-bootstrap=/u);
  assert(!status.stdout.includes(token), "The launcher printed its Host token");

  // Verify the packaged maintenance helper finds its compiled control module.
  const { requestMaintenance } = await installed(
    "deploy/systemd/idle-maintenance-restart.mjs",
  );
  const lease = await requestMaintenance(hostState);
  assert(lease?.kind, "Packaged maintenance could not authenticate the Host");
  if (lease.kind === "ready") {
    const released = await requestMaintenance(
      hostState,
      "release",
      lease.leaseId,
    );
    assert.equal(released?.kind, "released");
  }

  const terminal = await terminalMutation("/terminals", "POST", {
    cwd: canonicalWorkspace,
    cols: 80,
    rows: 24,
  });
  const { decodeTerminalServerDataFrame } = await installed(
    "build/shared/terminal-contracts.js",
  );
  let output = "";
  const attachment = await terminalClient.attach(
    { terminalId: terminal.id, clientId: randomUUID(), cols: 80, rows: 24 },
    {
      sendData(data) {
        const frame = decodeTerminalServerDataFrame(data);
        output = (output + Buffer.from(frame.data).toString("utf8")).slice(
          -8192,
        );
      },
      sendControl() {},
      close() {},
    },
  );
  // Split the marker in the command so line editing/echo cannot satisfy it.
  const echo =
    terminal.profileId === "cmd"
      ? "echo INSPIRE_DAEMON_BE^FORE\r"
      : 'echo INSPIRE_DAEMON_"BEFORE"\r';
  try {
    attachment.writeInput(1, Buffer.from(echo));
    await waitFor(
      "real PTY output",
      () => output.includes("INSPIRE_DAEMON_BEFORE"),
      15_000,
    );
  } finally {
    attachment.detach();
  }

  const { active } = await request("/sessions/new", {
    method: "POST",
    body: { cwd: canonicalWorkspace },
  });
  assert(
    active?.sessionId,
    "The packaged Host did not start a real Pi session",
  );
  assert.equal(active.cwd, canonicalWorkspace);

  const restart = await request("/host/restart");
  await request("/host/restart", {
    method: "POST",
    body: { hostId: restart.hostId, operationId: randomUUID(), scope: "host" },
  });
  await waitFor(
    "the replacement packaged Host",
    async () => {
      if (host.child.exitCode !== null || host.child.signalCode !== null)
        throw new Error("Packaged launcher exited during page restart");
      const next = await request("/host/restart").catch(() => null);
      if (["rejected", "unknown"].includes(next?.operation?.phase))
        throw new Error(next.operation.error || "Packaged page restart failed");
      return next?.available && next.hostId !== restart.hostId;
    },
    60_000,
  );
  const { terminals } = await request(
    `/terminals?cwd=${encodeURIComponent(canonicalWorkspace)}`,
  );
  assert(
    terminals.some((row) => row.id === terminal.id && row.status === "running"),
    "Packaged Host restart lost the real PTY",
  );
  await terminalMutation(
    `/terminals/${encodeURIComponent(terminal.id)}?force=1`,
    "DELETE",
  );

  await cli(["stop"]);
  await waitForExit(host.child);
  assert.equal(host.child.exitCode, 0, "Packaged Host did not exit cleanly");

  const before = await terminalClient.daemonInfo();
  await cli(["terminal", "restart"]);
  const after = await terminalClient.daemonInfo();
  assert.notEqual(
    after.instanceId,
    before.instanceId,
    "Daemon restart reused its old owner",
  );
  await cli(["terminal", "stop"]);
  terminalControl = null;
  await waitForExit(terminalOwner.child);
  assert.equal(
    terminalOwner.child.exitCode,
    0,
    "Packaged daemon did not exit cleanly",
  );

  console.log(
    JSON.stringify({
      package: `${installedPackage.name}@${installedPackage.version}`,
      externalPi: externalPi.version,
      verifiedFontAssets: expectedFonts.size,
      publishDryRun: "accepted without metadata correction",
      installation: "production-only, no bundled Pi",
      packagedChecks:
        "CLI, maintenance, fork, recovery, external Pi session, PTY output and restart",
    }),
  );
} catch (error) {
  if (host?.output) console.error(host.output);
  if (terminalOwner?.output) console.error(terminalOwner.output);
  throw error;
} finally {
  await stopProcess(host);
  if (terminalControl)
    await execFile(
      process.execPath,
      [terminalControl.bin, "terminal", "stop", "--force"],
      { env: terminalControl.environment, timeout: 30_000 },
    ).catch(() => undefined);
  await terminalClient?.close();
  await stopProcess(terminalOwner);
  await rm(temporary, { recursive: true, force: true });
}
