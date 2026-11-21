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
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  isolatedProcessOptions,
  signalProcessTree,
} from "../server/process-tree.mjs";
import { freeLoopbackPort } from "../tests/fixtures/packaged-launcher.mjs";
import { execNpm, npmPackageRecord } from "./npm-package-manifest.mjs";

const execFile = promisify(execFileCallback);
const root = resolve(import.meta.dirname, "..");

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

async function verifyFontFiles(directory, label) {
  const manifest = await readFile(join(directory, "SHA256SUMS"));
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
    verifyFontFiles(join(fontRoot, "ibm-plex-sans-sc"), "IBM Plex Sans SC"),
    verifyFontFiles(join(fontRoot, "flux-mono-sc"), "Flux Mono SC"),
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
  await once(child, "exit", { signal: AbortSignal.timeout(timeoutMs) });
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
    [
      "pack",
      "--json",
      "--foreground-scripts=false",
      "--pack-destination",
      packDirectory,
    ],
    { cwd: root },
  );
  const record = npmPackageRecord(packed.stdout, "npm pack");
  if (typeof record.filename !== "string" || record.filename.length === 0) {
    throw new Error("npm pack did not report a tarball");
  }
  // The installed smoke exercises the Host, launcher, recovery, fork and PTY
  // module graph. Keep a contents check for optional entries it cannot load.
  const required = [
    "build/server/restart-submission.mjs",
    "build/server/attached-pi-entry.js",
    "build/server/current-web-build.mjs",
    "connections/dispatch.mjs",
    "connections/ssh-reverse/manifest.json",
    "connections/ssh-reverse/runner.mjs",
    "connections/ssh-reverse/systemd/inspire-connection-ssh-reverse.service.in",
    "deploy/systemd/control.mjs",
    "deploy/systemd/inspire-host.service.in",
    "docs/ssh-reverse.md",
    "docs/examples/native-ui.ts",
    "extensions/attach-control.ts",
    "build/extensions/attach-control.js",
    "dist/index.html",
    "dist/.inspire-current-assets.json",
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
        path !== "extensions/attach-control.ts"),
  );
  if (forbidden.length > 0)
    throw new Error(
      `Release tarball contains source-only files: ${forbidden.join(", ")}`,
    );

  const tarball = join(packDirectory, record.filename);
  const publishDryRun = await execNpm(
    ["publish", tarball, "--dry-run", "--json"],
    { cwd: root },
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
  const publishRecord = npmPackageRecord(
    publishDryRun.stdout,
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
    { cwd: root },
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

  const port = await freeLoopbackPort();
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
  async function terminalMutation(command, params) {
    const { epoch } = await request("/terminal-operations");
    const receipt = await request("/terminal-operations", {
      method: "POST",
      body: {
        operationId: randomUUID(),
        executor: { kind: "terminal", epoch },
        intent: { command, params },
      },
    });
    assert.equal(receipt.state, "completed");
    return receipt.result;
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

  const terminal = await terminalMutation("create", {
    request: { cwd: canonicalWorkspace, cols: 80, rows: 24 },
  });
  assert.equal(terminal.status, "running");

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
  assert.equal(
    terminals.find((row) => row.id === terminal.id)?.status,
    "exited",
    "Packaged Host restart must restore the tab without its old PTY",
  );
  await terminalMutation("remove", { id: terminal.id, force: true });

  await cli(["stop"]);
  await waitForExit(host.child);
  assert.equal(host.child.exitCode, 0, "Packaged Host did not exit cleanly");

  console.log(
    JSON.stringify({
      package: `${installedPackage.name}@${installedPackage.version}`,
      externalPi: externalPi.version,
      verifiedFontAssets: expectedFonts.size,
      publishDryRun: "accepted without metadata correction",
      installation: "production-only, no bundled Pi",
      packagedChecks:
        "CLI, maintenance, fork, recovery, external Pi session, PTY and restart",
    }),
  );
} catch (error) {
  if (host?.output) console.error(host.output);
  throw error;
} finally {
  await stopProcess(host);
  await rm(temporary, { recursive: true, force: true });
}
