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
  return {
    digests: new Set(digests.flat()),
    // The critical sheet repeats five Latin/core declarations from the
    // complete deferred registries; font assets are still emitted once.
    installedFaces: { ibm: 648 + 3, flux: 112 + 2 },
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
    /Noto|MOTO|IBM Plex Mono/u.test(css)
  ) {
    throw new Error(
      "Installed bundle does not contain the reviewed IBM UI and Flux Mono SC code type system",
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
        return;
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

const temporary = await mkdtemp(join(tmpdir(), "inspire-release-smoke-"));
let host = null;
let hostOutput = "";
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
    "build/server/npm-command.mjs",
    "build/server/pi-installation.js",
    "build/server/pi-runtime.js",
    "build/server/restart-preflight.js",
    "build/server/host-restart-systemd.js",
    "build/server/platform-paths.mjs",
    "build/server/process-tree.mjs",
    "build/server/static-asset-cache.mjs",
    "build/server/user-environment.mjs",
    "build/server/session-fork.js",
    "build/server/session-fork-worker.js",
    "connections/dispatch.mjs",
    "connections/ssh-reverse/manifest.json",
    "connections/ssh-reverse/runner.mjs",
    "connections/ssh-reverse/systemd/inspire-connection-ssh-reverse.service.in",
    "deploy/systemd/control.mjs",
    "deploy/systemd/inspire-host.service.in",
    "docs/ssh-reverse.md",
    "docs/examples/native-ui.ts",
    "dist/index.html",
    "dist/THIRD_PARTY_NOTICES.txt",
    "inspire",
    "inspire.mjs",
    "LICENSE",
    "src/assets/licenses/ibm-plex-LICENSE.txt",
    "src/assets/licenses/ibm-plex-sans-sc-LICENSE.txt",
    "src/assets/licenses/flux-mono-LICENSE.txt",
    "src/assets/licenses/flux-mono-NOTICE.md",
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
        path !== "docs/examples/native-ui.ts"),
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
  await waitForInstanceState(environment.INSPIRE_STATE_PATH);
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
  await execFile(process.execPath, [bin, "status"], {
    cwd: temporary,
    env: environment,
    maxBuffer: 1024 * 1024,
  });
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
  };
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
      terminalPty: "ok",
      realPiStartup: "ok",
      sessionForkWorker: "ok",
      publishDryRun: "accepted without metadata correction",
      lifecycle: "mock and real start/status/stop",
    }),
  );
} catch (error) {
  if (hostOutput) console.error(hostOutput);
  throw error;
} finally {
  if (host && host.exitCode === null && host.signalCode === null) {
    await signalProcessTree(host, "SIGTERM", { isolated: true });
    await waitForExit(host, 5_000).catch(() => undefined);
    if (host.exitCode === null && host.signalCode === null) {
      await signalProcessTree(host, "SIGKILL", { isolated: true });
      await waitForExit(host).catch(() => undefined);
    }
  }
  await rm(temporary, { recursive: true, force: true });
}
