import { execFile as execFileCallback, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
  "24612c6ced4a164a61f355bcc3e7a3acc5159b8bf5f921f0e2cae0b6b394c281";

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
  const manifest = reviewedText(
    await readFile(join(directory, "SHA256SUMS")),
    `${label} checksum manifest`,
  );
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
    if (!filename.endsWith(".woff2"))
      reviewedText(value, `${label} ${filename}`);
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
  const labelFonts = await Promise.all(
    [500, 600].map(async (weight) =>
      sha256(
        await readFile(
          join(fontRoot, "rajdhani", `Rajdhani-Latin-${weight}.woff2`),
        ),
      ),
    ),
  );
  return {
    digests: new Set([...digests.flat(), ...labelFonts]),
    // The critical sheet repeats five Latin/core declarations from the
    // complete deferred registries; font assets are still emitted once.
    installedFaces: { ibm: 648 + 3, flux: 112 + 2, rajdhani: 2 },
  };
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
  const missing = [...expectedFonts.digests].filter(
    (digest) => !installedDigests.has(digest),
  );
  if (missing.length > 0)
    throw new Error(
      `Installed bundle is missing ${missing.length} verified font assets`,
    );
  if (
    (css.match(/IBMPlexSansSC-/gu) ?? []).length !==
      expectedFonts.installedFaces.ibm ||
    (css.match(/@font-face\{font-family:Flux Mono SC;/gu) ?? []).length !==
      expectedFonts.installedFaces.flux ||
    (css.match(/@font-face\{font-family:Rajdhani;/gu) ?? []).length !==
      expectedFonts.installedFaces.rajdhani ||
    /Noto|MOTO|IBM Plex Mono/u.test(css)
  ) {
    throw new Error(
      "Installed bundle does not contain the reviewed IBM UI, Flux code, and Rajdhani label type system",
    );
  }
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

async function waitForHealth(url, token, expectedMock, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (response.ok) {
        const body = await response.json();
        if (body.appName === "inspire" && body.mock === expectedMock) return;
      }
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`Packaged host did not become healthy at ${url}`);
}

async function waitForInstanceState(path, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const state = JSON.parse(await readFile(path, "utf8"));
      if (
        Number.isInteger(state?.pid) &&
        state.pid > 0 &&
        typeof state.processStartTime === "string" &&
        state.processStartTime.length > 0
      )
        return state;
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`Packaged host did not publish instance state at ${path}`);
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

const temporary = await realpath(
  await mkdtemp(join(tmpdir(), "inspire-release-smoke-")),
);
let host = null;
let hostOutput = "";
let terminalOwner = null;
let terminalOwnerOutput = "";
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
  const required = new Set([
    "build/server/file-lock.mjs",
    "build/server/index.js",
    "build/server/instance-state.mjs",
    "build/server/instance-control.mjs",
    "build/server/npm-command.mjs",
    "build/server/pi-installation.js",
    "build/server/pi-runtime.js",
    "build/server/restart-preflight.js",
    "build/server/host-restart-systemd.js",
    "build/server/host-restart-backend.js",
    "build/server/host-restart-preparation.js",
    "build/server/launcher-restart.mjs",
    "build/server/platform-paths.mjs",
    "build/server/platform-environment.mjs",
    "build/server/process-tree.mjs",
    "build/server/static-asset-cache.mjs",
    "build/server/user-environment.mjs",
    "build/server/session-fork.js",
    "build/server/session-fork-worker.js",
    "build/server/session-recovery-entry.js",
    "build/server/terminal-control-entry.js",
    "build/server/terminal-daemon-control.js",
    "connections/dispatch.mjs",
    "connections/ssh-reverse/manifest.json",
    "connections/ssh-reverse/runner.mjs",
    "connections/ssh-reverse/systemd/inspire-connection-ssh-reverse.service.in",
    "deploy/systemd/control.mjs",
    "deploy/systemd/inspire-host.service.in",
    "docs/ssh-reverse.md",
    "docs/examples/native-ui.ts",
    "docs/examples/session-activity.ts",
    "dist/index.html",
    "dist/THIRD_PARTY_NOTICES.txt",
    "inspire",
    "inspire.mjs",
    "LICENSE",
    "src/assets/licenses/ibm-plex-LICENSE.txt",
    "src/assets/licenses/ibm-plex-sans-sc-LICENSE.txt",
    "src/assets/licenses/flux-mono-LICENSE.txt",
    "src/assets/licenses/flux-mono-NOTICE.md",
    "src/assets/licenses/rajdhani-LICENSE.txt",
  ]);
  const packedPaths = new Set(
    (record.files ?? []).map((file) => file.path ?? ""),
  );
  const missing = [...required].filter((path) => !packedPaths.has(path));
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
        path !== "docs/examples/session-activity.ts"),
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
  const fontLicenses = `${await readFile(join(installedRoot, "src/assets/licenses/ibm-plex-LICENSE.txt"), "utf8")}\n${await readFile(join(installedRoot, "src/assets/licenses/ibm-plex-sans-sc-LICENSE.txt"), "utf8")}\n${await readFile(join(installedRoot, "src/assets/licenses/flux-mono-LICENSE.txt"), "utf8")}\n${await readFile(join(installedRoot, "src/assets/licenses/flux-mono-NOTICE.md"), "utf8")}\n${await readFile(join(installedRoot, "src/assets/licenses/rajdhani-LICENSE.txt"), "utf8")}`;
  for (const witness of [
    "SIL OPEN FONT LICENSE Version 1.1",
    'Reserved Font Name "Plex"',
    "IBM Corp.",
    "Flux Mono SC",
    "Indian Type Foundry",
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

  // Exercise the installed JS worker boundary itself, not only its presence in
  // the tarball. This catches source-only loaders or omitted sibling modules.
  const forkWorkspace = join(temporary, "fork-workspace");
  await mkdir(forkWorkspace);
  const forkSourcePath = join(forkWorkspace, "source.jsonl");
  const forkSourceId = "11111111-1111-4111-8111-111111111111";
  const forkTargetId = "33333333-3333-4333-8333-333333333333";
  const forkParentId = "22222222-2222-4222-8222-222222222222";
  const forkSourceBytes = Buffer.from(
    `${[
      {
        type: "session",
        version: 3,
        id: forkSourceId,
        timestamp: "2026-08-01T00:00:00.000Z",
        cwd: forkWorkspace,
      },
      {
        type: "message",
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        parentId: null,
        timestamp: "2026-08-01T00:00:01.000Z",
        message: { role: "user", content: "release root", timestamp: 1 },
      },
      {
        type: "message",
        id: forkParentId,
        parentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        timestamp: "2026-08-01T00:00:02.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "release answer" }],
          provider: "release-smoke",
          model: "release-smoke",
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          stopReason: "stop",
          timestamp: 2,
        },
      },
      {
        type: "message",
        id: forkTargetId,
        parentId: forkParentId,
        timestamp: "2026-08-01T00:00:03.000Z",
        message: { role: "user", content: "release fork", timestamp: 3 },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n")}\n`,
  );
  await writeFile(forkSourcePath, forkSourceBytes, { mode: 0o600 });
  const previousPiCommand = process.env.INSPIRE_PI_COMMAND;
  process.env.INSPIRE_PI_COMMAND = externalPiCommand;
  const forkModule = await import(
    pathToFileURL(join(installedRoot, "build/server/session-fork.js")).href
  );
  if (previousPiCommand === undefined) delete process.env.INSPIRE_PI_COMMAND;
  else process.env.INSPIRE_PI_COMMAND = previousPiCommand;
  const stagedFork = await forkModule.stageSessionFork({
    sourcePath: forkSourcePath,
    sourceSessionId: forkSourceId,
    sourceCommittedBytes: forkSourceBytes.length,
    sourceFingerprint: sha256(forkSourceBytes),
    targetId: forkTargetId,
    targetParentId: forkParentId,
  });
  const stagedForkText = await readFile(stagedFork.stagedPath, "utf8");
  if (
    !stagedForkText.includes(`"id":"${forkParentId}"`) ||
    stagedForkText.includes(`"id":"${forkTargetId}"`)
  ) {
    throw new Error("Installed Session fork worker produced the wrong branch");
  }
  await forkModule.discardStagedSessionFork(stagedFork);

  const port = await freePort();
  const token = "inspire-release-smoke-token";
  // Exercise lifecycle through the installed JS entry after the npm-generated
  // shell/.cmd shim has independently proved that package bin linking works.
  const bin = join(installedRoot, "inspire.mjs");
  const environment = {
    ...process.env,
    INSPIRE_HOST: "127.0.0.1",
    INSPIRE_PORT: String(port),
    INSPIRE_TOKEN: token,
    INSPIRE_OPEN: "0",
    INSPIRE_ENVIRONMENT: "inherit",
    INSPIRE_TERMINAL_ID: undefined,
    INSPIRE_STATE_PATH: join(stateDirectory, "instance.json"),
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
    PI_CODING_AGENT_DIR: agentDirectory,
    PI_OFFLINE: "1",
    INSPIRE_PI_COMMAND: externalPiCommand,
    // Keep the release smoke self-contained: ordinary detached daemons are
    // intentionally not stopped with their Host, while this temporary install
    // must leave no process behind.
    INSPIRE_TERMINAL_IN_PROCESS: "1",
  };
  const instanceModule = await import(
    pathToFileURL(join(installedRoot, "build/server/instance-state.mjs")).href
  );
  const maintenanceModule = await import(
    pathToFileURL(
      join(installedRoot, "deploy/systemd/idle-maintenance-restart.mjs"),
    ).href
  );
  // Exercise the installed CLI against a disposable Host-shaped impostor.
  // Only random fixture credentials exist here; no user endpoint is contacted.
  const probes = [];
  const impostor = createHttpServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += String(chunk);
    probes.push({ authorization: request.headers.authorization, body });
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ appName: "inspire", mock: false }));
  });
  await new Promise((resolve) => impostor.listen(0, "127.0.0.1", resolve));
  try {
    const fakeState = {
      schemaVersion: 1,
      root: installedRoot,
      host: "127.0.0.1",
      port: impostor.address().port,
      token: randomBytes(64).toString("base64url"),
      pid: process.pid,
      processStartTime: await instanceModule.processStartIdentity(process.pid),
      startedAt: new Date().toISOString(),
      mock: false,
      httpControlVersion: 1,
    };
    const fakePath = join(stateDirectory, "impostor.json");
    await instanceModule.writeInstanceState(fakePath, fakeState);
    for (const command of ["status", "token"]) {
      const rejected = await execFile(process.execPath, [bin, command], {
        cwd: temporary,
        env: {
          ...environment,
          INSPIRE_STATE_PATH: fakePath,
          INSPIRE_PORT: String(fakeState.port),
        },
      }).then(
        () => null,
        (error) => error,
      );
      if (
        !rejected ||
        rejected.code !== 1 ||
        rejected.stdout.includes(fakeState.token) ||
        rejected.stderr.includes(fakeState.token)
      )
        throw new Error(
          "Installed CLI trusted an unauthenticated readiness peer",
        );
    }
    if ((await maintenanceModule.requestMaintenance(fakeState)) !== null)
      throw new Error("Installed maintenance trusted an unauthenticated peer");
    if (
      probes.length !== 3 ||
      probes.some(
        (probe) =>
          probe.authorization !== undefined ||
          probe.body.includes(fakeState.token),
      )
    )
      throw new Error("Installed lifecycle disclosed its reusable credential");
  } finally {
    impostor.closeAllConnections();
    await new Promise((resolve) => impostor.close(resolve));
  }

  // Recovery must work in the production-only package and resolve a relative
  // folder against the caller, not the launcher's installation directory.
  const recoveryModule = await import(
    pathToFileURL(join(installedRoot, "build/server/session-recovery.js")).href
  );
  for (const recovery of [
    {
      parent: temporary,
      name: "relative recovery bundle",
      argument: "relative recovery bundle",
      id: "relative",
    },
    {
      parent: homeDirectory,
      name: "home recovery bundle",
      argument:
        process.platform === "win32"
          ? "~\\home recovery bundle"
          : "~/home recovery bundle",
      id: "home",
    },
  ]) {
    const recoveryBundle = join(recovery.parent, recovery.name);
    await mkdir(recoveryBundle);
    const fileName = `recovered-${recovery.id}.jsonl`;
    const recoveredPath = join(temporary, fileName);
    const recoveryContents =
      JSON.stringify({
        type: "session",
        id: "release-recovery-" + recovery.id,
        cwd: temporary,
      }) + "\n";
    const recoveryPayload = join(recoveryBundle, fileName);
    await writeFile(recoveryPayload, recoveryContents);
    await recoveryModule.prepareSessionRecovery(recoveryPayload, recoveredPath);
    const recovered = await execFile(
      process.execPath,
      [bin, "recover-session", recovery.argument],
      { cwd: temporary, env: environment, maxBuffer: 1024 * 1024 },
    );
    if (
      !recovered.stdout.includes("Recovered session: ") ||
      (await readFile(recoveredPath, "utf8")) !== recoveryContents
    )
      throw new Error("Installed session recovery failed for " + recovery.id);
  }

  const preparation = await execFile(
    process.execPath,
    [bin, "prepare-restart"],
    {
      cwd: temporary,
      env: environment,
      maxBuffer: 1024 * 1024,
    },
  );
  if (!preparation.stdout.includes("Restart preparation passed."))
    throw new Error("Installed runtime preparation did not complete");
  host = spawn(process.execPath, [bin, "mock"], {
    cwd: temporary,
    env: environment,
    ...isolatedProcessOptions(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  host.stdout?.on("data", (chunk) => {
    hostOutput = `${hostOutput}${String(chunk)}`.slice(-8_192);
  });
  host.stderr?.on("data", (chunk) => {
    hostOutput = `${hostOutput}${String(chunk)}`.slice(-8_192);
  });
  const mockOrigin = `http://127.0.0.1:${port}`;
  await waitForHealth(`${mockOrigin}/api/health`, token, true);
  const mockState = await waitForInstanceState(environment.INSPIRE_STATE_PATH);
  if (
    mockState.httpControlVersion !== 1 ||
    (
      await instanceModule.inspectInstance(environment.INSPIRE_STATE_PATH, {
        root: installedRoot,
        host: "127.0.0.1",
        port,
        mock: true,
      })
    ).kind !== "healthy"
  )
    throw new Error("Installed Host did not authenticate readiness");
  if (!(await maintenanceModule.requestMaintenance(mockState))?.kind)
    throw new Error(
      "Installed maintenance could not authenticate the Host result",
    );
  const terminalEpochResponse = await fetch(
    `${mockOrigin}/api/terminal-operations`,
    {
      headers: { Authorization: `Bearer ${token}` },
    },
  );
  const { epoch: terminalEpoch } = await terminalEpochResponse.json();
  const terminalMutationHeaders = () => ({
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "X-Terminal-Operation": JSON.stringify({
      id: randomUUID(),
      epoch: terminalEpoch,
    }),
  });
  const terminalResponse = await fetch(`${mockOrigin}/api/terminals`, {
    method: "POST",
    headers: terminalMutationHeaders(),
    body: JSON.stringify({ cwd: temporary, cols: 80, rows: 24 }),
  });
  if (!terminalResponse.ok)
    throw new Error(
      `Packaged PTY startup failed with ${terminalResponse.status}: ${await terminalResponse.text()}`,
    );
  const packagedTerminal = await terminalResponse.json();
  if (typeof packagedTerminal.id !== "string")
    throw new Error("Packaged PTY startup returned no terminal identity");
  const closeTerminalResponse = await fetch(
    `${mockOrigin}/api/terminals/${encodeURIComponent(packagedTerminal.id)}?force=1`,
    {
      method: "DELETE",
      headers: terminalMutationHeaders(),
    },
  );
  if (!closeTerminalResponse.ok)
    throw new Error(
      `Packaged PTY cleanup failed with ${closeTerminalResponse.status}`,
    );
  const status = await execFile(process.execPath, [bin, "status"], {
    cwd: temporary,
    env: environment,
    maxBuffer: 1024 * 1024,
  });
  if (
    status.stdout.includes(token) ||
    status.stdout.includes("?token=") ||
    !status.stdout.includes("#inspire-bootstrap=")
  )
    throw new Error(
      "Installed launcher did not use a credential-free pairing transfer",
    );
  const shownToken = await execFile(process.execPath, [bin, "token"], {
    cwd: temporary,
    env: environment,
  });
  if (shownToken.stdout.trim() !== token)
    throw new Error(
      "Explicit installed token output did not match the verified Host",
    );
  await execFile(process.execPath, [bin, "stop"], {
    cwd: temporary,
    env: environment,
    maxBuffer: 1024 * 1024,
  });
  await waitForExit(host);
  if (host.exitCode !== 0)
    throw new Error(`Packaged mock host exited with ${host.exitCode}`);

  host = null;
  hostOutput = "";
  const realPort = await freePort();
  const workspace = join(temporary, "workspace");
  await mkdir(join(workspace, ".pi"), { recursive: true });
  const canonicalWorkspace = await realpath(workspace);
  await writeFile(
    join(workspace, ".pi", "settings.json"),
    `${JSON.stringify({
      defaultProvider: "release-smoke",
      defaultModel: "release-smoke",
      enabledModels: ["release-smoke/release-smoke"],
    })}\n`,
    { mode: 0o600 },
  );
  const realEnvironment = {
    ...environment,
    INSPIRE_PORT: String(realPort),
    INSPIRE_STATE_PATH: join(stateDirectory, "instance-real.json"),
    INSPIRE_PREFERENCES_PATH: join(stateDirectory, "preferences-real.json"),
    INSPIRE_LOG_PATH: join(stateDirectory, "diagnostics-real.jsonl"),
    INSPIRE_TERMINAL_IN_PROCESS: "0",
  };
  for (const key of [
    "INSPIRE_TERMINAL_DAEMON_ADDRESS",
    "INSPIRE_TERMINAL_TOKEN_PATH",
    "INSPIRE_TERMINAL_STATE_PATH",
  ])
    delete realEnvironment[key];
  // Keep auto-launch isolated from the developer's systemd user manager.
  realEnvironment.DBUS_SESSION_BUS_ADDRESS =
    "unix:path=" + join(temporary, "no-user-bus");
  delete realEnvironment.NOTIFY_SOCKET;
  delete realEnvironment.INVOCATION_ID;
  terminalControl = { bin, environment: realEnvironment };
  // Own the real daemon as an explicit fixture process. It still uses the
  // product's default address, state and authentication, but cannot escape
  // cleanup as an intentionally detached production owner would.
  terminalOwner = spawn(
    process.execPath,
    [
      bin,
      "terminal-daemon",
      "--root",
      installedRoot,
      "--host",
      "127.0.0.1",
      "--port",
      String(realPort),
    ],
    {
      cwd: temporary,
      env: realEnvironment,
      ...isolatedProcessOptions(),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  for (const stream of [terminalOwner.stdout, terminalOwner.stderr])
    stream?.on("data", (chunk) => {
      terminalOwnerOutput = (terminalOwnerOutput + String(chunk)).slice(-8192);
    });
  const daemonProtocol = await import(
    pathToFileURL(
      join(installedRoot, "build/server/terminal-daemon-protocol.js"),
    ).href
  );
  const { TerminalDaemonClient } = await import(
    pathToFileURL(join(installedRoot, "build/server/terminal-daemon-client.js"))
      .href
  );
  const paths = { environment: realEnvironment, home: homeDirectory };
  const daemonAddress = daemonProtocol.defaultTerminalDaemonAddress(
    installedRoot,
    "127.0.0.1",
    realPort,
    paths,
  );
  const { terminalDaemonSecretPath } = await import(
    pathToFileURL(join(installedRoot, "build/server/terminal-daemon-tls.js"))
      .href
  );
  const daemonTokenPath = daemonProtocol.defaultTerminalDaemonTokenPath(
    installedRoot,
    "127.0.0.1",
    realPort,
    paths,
  );
  const daemonDeadline = Date.now() + 20_000;
  while (!terminalClient) {
    if (
      terminalOwner.exitCode !== null ||
      terminalOwner.signalCode !== null ||
      Date.now() > daemonDeadline
    )
      throw new Error("Installed default terminal daemon did not start");
    try {
      const daemonToken = (
        await readFile(terminalDaemonSecretPath(daemonTokenPath), "utf8")
      ).trim();
      const candidate = new TerminalDaemonClient(daemonAddress, daemonToken);
      await candidate.probe();
      terminalClient = candidate;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  host = spawn(process.execPath, [bin], {
    cwd: canonicalWorkspace,
    env: realEnvironment,
    ...isolatedProcessOptions(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  host.stdout?.on("data", (chunk) => {
    hostOutput = `${hostOutput}${String(chunk)}`.slice(-8_192);
  });
  host.stderr?.on("data", (chunk) => {
    hostOutput = `${hostOutput}${String(chunk)}`.slice(-8_192);
  });
  const realOrigin = `http://127.0.0.1:${realPort}`;
  await waitForHealth(`${realOrigin}/api/health`, token, false);
  await waitForInstanceState(realEnvironment.INSPIRE_STATE_PATH);
  const headers = { Authorization: `Bearer ${token}` };
  async function daemonMutationHeaders() {
    const epochResponse = await fetch(realOrigin + "/api/terminal-operations", {
      headers,
    });
    const { epoch } = await epochResponse.json();
    return {
      ...headers,
      "Content-Type": "application/json",
      "X-Terminal-Operation": JSON.stringify({ id: randomUUID(), epoch }),
    };
  }
  const daemonTerminalResponse = await fetch(realOrigin + "/api/terminals", {
    method: "POST",
    headers: await daemonMutationHeaders(),
    body: JSON.stringify({ cwd: canonicalWorkspace, cols: 80, rows: 24 }),
  });
  if (!daemonTerminalResponse.ok)
    throw new Error(
      "Packaged default-daemon PTY creation failed: " +
        (await daemonTerminalResponse.text()),
    );
  const daemonTerminal = await daemonTerminalResponse.json();
  const { decodeTerminalServerDataFrame } = await import(
    pathToFileURL(join(installedRoot, "build/shared/terminal-contracts.js"))
      .href
  );
  let daemonOutput = "";
  const attachment = await terminalClient.attach(
    {
      terminalId: daemonTerminal.id,
      clientId: randomUUID(),
      cols: 80,
      rows: 24,
    },
    {
      sendData(data) {
        daemonOutput = (
          daemonOutput +
          Buffer.from(decodeTerminalServerDataFrame(data).data).toString("utf8")
        ).slice(-8192);
      },
      sendControl() {},
      close() {},
    },
  );
  const echoCommand =
    daemonTerminal.profileId === "cmd"
      ? "echo INSPIRE_DAEMON_BE^FORE\r"
      : 'echo INSPIRE_DAEMON_"BEFORE"\r';
  attachment.writeInput(1, Buffer.from(echoCommand));
  const outputDeadline = Date.now() + 15_000;
  while (!daemonOutput.includes("INSPIRE_DAEMON_BEFORE")) {
    if (Date.now() > outputDeadline)
      throw new Error(
        "Packaged default daemon did not deliver real PTY output",
      );
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  attachment.detach();
  const defaultsResponse = await fetch(
    `${realOrigin}/api/models?cwd=${encodeURIComponent(canonicalWorkspace)}`,
    { headers },
  );
  if (!defaultsResponse.ok)
    throw new Error(
      `Packaged model-default lookup failed with ${defaultsResponse.status}`,
    );
  const { defaults } = await defaultsResponse.json();
  if (!defaults.model?.provider || !defaults.model?.id)
    throw new Error("Packaged model-default lookup returned no model");
  const createResponse = await fetch(`${realOrigin}/api/sessions/new`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      cwd: canonicalWorkspace,
      model: { provider: defaults.model.provider, id: defaults.model.id },
      thinkingLevel: defaults.thinkingLevel,
    }),
  });
  if (!createResponse.ok)
    throw new Error(
      `Packaged real Pi session startup failed with ${createResponse.status}: ${await createResponse.text()}`,
    );
  const created = await createResponse.json();
  if (!created.active?.sessionId || created.active.cwd !== canonicalWorkspace)
    throw new Error(
      "Packaged real Pi session startup returned the wrong owner",
    );
  // Cross-platform CI must exercise the user-facing page lifecycle, not just
  // startup/status/stop. An idle owned Pi worker must retire before replacement.
  const previousState = JSON.parse(
    await readFile(realEnvironment.INSPIRE_STATE_PATH, "utf8"),
  );
  const previousRestart = await fetch(`${realOrigin}/api/host/restart`, {
    headers,
  }).then((response) => response.json());
  if (!previousRestart.available || previousRestart.allAvailable)
    throw new Error("Installed direct Host reported incorrect restart scopes");
  const restartResponse = await fetch(`${realOrigin}/api/host/restart`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      hostId: previousRestart.hostId,
      operationId: randomUUID(),
      scope: "host",
    }),
  });
  if (restartResponse.status !== 202)
    throw new Error(
      `Packaged page restart failed with ${restartResponse.status}`,
    );
  const restartDeadline = Date.now() + 60_000;
  let replaced = false;
  while (Date.now() < restartDeadline) {
    let operation;
    try {
      const response = await fetch(`${realOrigin}/api/host/restart`, {
        headers,
      });
      const current = await response.json();
      operation = current.operation;
      const state = JSON.parse(
        await readFile(realEnvironment.INSPIRE_STATE_PATH, "utf8"),
      );
      if (
        response.ok &&
        current.hostId !== previousRestart.hostId &&
        current.available &&
        state.pid !== previousState.pid &&
        state.token === previousState.token
      ) {
        replaced = true;
        break;
      }
    } catch (error) {
      if (host.exitCode !== null || host.signalCode !== null)
        throw new Error(
          `Packaged launcher exited during page restart: ${error}`,
        );
    }
    if (operation?.phase === "rejected" || operation?.phase === "unknown")
      throw new Error(operation.error || "Page restart was not submitted");
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  if (!replaced)
    throw new Error("Packaged page restart did not replace the Host");
  await waitForHealth(`${realOrigin}/api/health`, token, false);
  const retainedTerminals = await fetch(
    realOrigin + "/api/terminals?cwd=" + encodeURIComponent(canonicalWorkspace),
    { headers },
  ).then((response) => response.json());
  if (
    !retainedTerminals.terminals.some(
      (terminal) =>
        terminal.id === daemonTerminal.id && terminal.status === "running",
    ) ||
    terminalOwner.exitCode !== null ||
    terminalOwner.signalCode !== null
  )
    throw new Error(
      "Page restart did not preserve the real default-daemon PTY",
    );
  const removedDaemonTerminal = await fetch(
    realOrigin +
      "/api/terminals/" +
      encodeURIComponent(daemonTerminal.id) +
      "?force=1",
    {
      method: "DELETE",
      headers: await daemonMutationHeaders(),
    },
  );
  if (!removedDaemonTerminal.ok)
    throw new Error("Packaged default-daemon PTY cleanup failed");
  await execFile(process.execPath, [bin, "status"], {
    cwd: canonicalWorkspace,
    env: realEnvironment,
    maxBuffer: 1024 * 1024,
  });
  await execFile(process.execPath, [bin, "stop"], {
    cwd: canonicalWorkspace,
    env: realEnvironment,
    maxBuffer: 1024 * 1024,
  });
  await waitForExit(host);
  if (host.exitCode !== 0)
    throw new Error(`Packaged real host exited with ${host.exitCode}`);

  const previousDaemonInfo = await terminalClient.daemonInfo();
  const terminalStatus = await execFile(
    process.execPath,
    [bin, "terminal", "status"],
    {
      env: realEnvironment,
      timeout: 30_000,
    },
  );
  if (!terminalStatus.stdout.includes(previousDaemonInfo.instanceId))
    throw new Error(
      "Packaged terminal status did not identify the actual owner",
    );
  await execFile(process.execPath, [bin, "terminal", "restart"], {
    env: realEnvironment,
    timeout: 40_000,
  });
  const replacementDaemonInfo = await terminalClient.daemonInfo();
  if (replacementDaemonInfo.instanceId === previousDaemonInfo.instanceId)
    throw new Error("Packaged terminal restart did not replace the owner");
  await execFile(process.execPath, [bin, "terminal", "stop"], {
    env: realEnvironment,
    timeout: 30_000,
  });
  await waitForExit(terminalOwner);
  if (terminalOwner.exitCode !== 0)
    throw new Error("Packaged terminal daemon did not exit cleanly");

  console.log(
    JSON.stringify({
      package: `${installedPackage.name}@${installedPackage.version}`,
      license: installedPackage.license,
      bundledNotices: "present",
      verifiedFontAssets: expectedFonts.digests.size,
      piManifest: false,
      sourceOnlyFiles: 0,
      requiredFiles: "present",
      piRuntime: externalPi.version,
      piAuthority: "external installation",
      installMode: "production dependencies only; Pi not bundled",
      portableCliEntry: "npm shim and JS entry resolved",
      mockHealth: "ok",
      readinessPeer:
        "fresh mutual proofs; impostor rejected without bearer disclosure",
      localPairing:
        "one-use fragment; explicit token output only when requested",
      terminalPty: "in-process and default authenticated daemon",
      terminalHostRestart: "same live daemon PTY retained",
      terminalLifecycle:
        "authenticated scoped status/restart/stop; confirmed clean exit",
      sessionRecoveryCli:
        "original paths from caller-relative and Host-home bundles",
      retentionMigrationCli:
        "zero-write preview and explicit namespace/volume trust",
      realPiStartup: "ok",
      sessionForkWorker: "ok",
      publishDryRun: "accepted without metadata correction",
      lifecycle:
        "mock and real start/status/stop; real page restart with owned Pi",
    }),
  );
} catch (error) {
  if (hostOutput) console.error(hostOutput);
  if (terminalOwnerOutput) console.error(terminalOwnerOutput);
  throw error;
} finally {
  if (terminalControl)
    await execFile(
      process.execPath,
      [terminalControl.bin, "terminal", "stop", "--force"],
      {
        env: terminalControl.environment,
        timeout: 30_000,
      },
    ).catch(() => undefined);
  await terminalClient?.close();
  if (host && host.exitCode === null && host.signalCode === null) {
    await signalProcessTree(host, "SIGTERM", { isolated: true });
    await waitForExit(host, 5_000).catch(() => undefined);
    if (host.exitCode === null && host.signalCode === null) {
      await signalProcessTree(host, "SIGKILL", { isolated: true });
      await waitForExit(host).catch(() => undefined);
    }
  }
  if (
    terminalOwner &&
    terminalOwner.exitCode === null &&
    terminalOwner.signalCode === null
  ) {
    await signalProcessTree(terminalOwner, "SIGTERM", { isolated: true });
    await waitForExit(terminalOwner, 5_000).catch(() => undefined);
    if (terminalOwner.exitCode === null && terminalOwner.signalCode === null) {
      await signalProcessTree(terminalOwner, "SIGKILL", { isolated: true });
      await waitForExit(terminalOwner).catch(() => undefined);
    }
  }
  await rm(temporary, { recursive: true, force: true });
}
