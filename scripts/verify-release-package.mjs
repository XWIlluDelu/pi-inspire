import { execFile as execFileCallback, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const root = resolve(import.meta.dirname, "..");
const plexSansManifestDigest = "012a329e2e373c4aba5c81e46eb6df3bc78252fc65d97e2207a5c12ce286e6c6";
const fixedFontDigests = new Map([
  ["ibm-plex-mono-latin-400-normal.woff2", "08949f728dc52d528e69b1667d15c89a5686a4ee9a296ff90983985f99c380f7"],
  ["ibm-plex-mono-latin-500-normal.woff2", "01d285447409c8a588692162439a038b8cbd7871309ee20267b0d2d91c6e8e22"],
  ["ibm-plex-serif-latin-400-normal.woff2", "cb2c5eee2c0a43ff30d2365407c7bc8b20e3bd90720a4a64102ba0b328022a02"],
  ["ibm-plex-serif-latin-500-italic.woff2", "42fde68f485b8d3096a22711a16702013d437830f7293ecc4cc75554d479a363"],
  ["ibm-plex-serif-latin-500-normal.woff2", "677082fc2e9ee60701b874fe5983c98ea9fb3b588cc1b02058ff9bf29ea783e4"],
  ["ibm-plex-serif-latin-600-normal.woff2", "e279e4f8baa0d4634d98868092f2198ae0dcd9e142c935822c385b9843352a9b"],
]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parseSha256Sums(value) {
  const entries = new Map();
  for (const line of value.trimEnd().split("\n")) {
    const match = line.match(/^([a-f0-9]{64})  ([A-Za-z0-9.-]+)$/u);
    if (!match || entries.has(match[2])) throw new Error("IBM Plex Sans SC has an invalid checksum manifest");
    entries.set(match[2], match[1]);
  }
  return entries;
}

async function verifySourceFonts() {
  const fontRoot = join(root, "src/assets/fonts");
  const splitRoot = join(fontRoot, "ibm-plex-sans-sc");
  const manifestBytes = await readFile(join(splitRoot, "SHA256SUMS"));
  if (sha256(manifestBytes) !== plexSansManifestDigest) {
    throw new Error("IBM Plex Sans SC manifest does not match the reviewed official import");
  }
  const entries = parseSha256Sums(manifestBytes.toString("ascii"));
  const expectedSplitFiles = new Set(["faces.css"]);
  for (const style of ["Regular", "Medium", "SemiBold"]) {
    for (let index = 0; index <= 216; index += 1) {
      if (index === 99) continue;
      expectedSplitFiles.add(`IBMPlexSansSC-${style}-${String(index).padStart(3, "0")}.woff2`);
    }
  }
  if (entries.size !== expectedSplitFiles.size || [...entries.keys()].some((name) => !expectedSplitFiles.has(name))) {
    throw new Error("IBM Plex Sans SC manifest does not name the complete official 400/500/600 split");
  }
  const actualSplitFiles = (await readdir(splitRoot)).filter((name) => name !== "SHA256SUMS");
  if (actualSplitFiles.length !== expectedSplitFiles.size || actualSplitFiles.some((name) => !expectedSplitFiles.has(name))) {
    throw new Error("IBM Plex Sans SC source directory and checksum manifest disagree");
  }
  for (const [filename, expected] of entries) {
    const actual = sha256(await readFile(join(splitRoot, filename)));
    if (actual !== expected) throw new Error(`IBM Plex Sans SC provenance mismatch: ${filename}`);
  }
  const facesCss = await readFile(join(splitRoot, "faces.css"), "utf8");
  if ((facesCss.match(/@font-face/gu) ?? []).length !== 648) {
    throw new Error("IBM Plex Sans SC must declare exactly 648 Unicode-range faces");
  }
  for (const weight of [400, 500, 600]) {
    if ((facesCss.match(new RegExp(`font-weight: ${weight};`, "gu")) ?? []).length !== 216) {
      throw new Error(`IBM Plex Sans SC must declare exactly 216 faces at weight ${weight}`);
    }
  }
  for (const [filename, expected] of fixedFontDigests) {
    const actual = sha256(await readFile(join(fontRoot, filename)));
    if (actual !== expected) throw new Error(`IBM Plex provenance mismatch: ${filename}`);
  }
  return new Set([
    ...[...entries].filter(([filename]) => filename.endsWith(".woff2")).map(([, digest]) => digest),
    ...fixedFontDigests.values(),
  ]);
}

async function verifyInstalledFonts(installedRoot, expectedDigests) {
  const assets = join(installedRoot, "dist/assets");
  const installedDigests = new Set();
  let css = "";
  for (const filename of await readdir(assets)) {
    const value = await readFile(join(assets, filename));
    if (filename.endsWith(".woff2")) installedDigests.add(sha256(value));
    if (filename.endsWith(".css")) css += value.toString("utf8");
  }
  const missing = [...expectedDigests].filter((digest) => !installedDigests.has(digest));
  if (missing.length > 0) throw new Error(`Installed bundle is missing ${missing.length} verified IBM font assets`);
  if ((css.match(/IBMPlexSansSC-/gu) ?? []).length !== 648 || /Noto|MOTO/u.test(css)) {
    throw new Error("Installed bundle does not contain the exclusive IBM type system");
  }
}

// npm forwards prepack output before its machine-readable manifest.
function parsePackManifest(output) {
  const candidates = [0];
  for (const match of output.matchAll(/^[{[]/gmu)) candidates.push(match.index ?? 0);
  for (const index of candidates.sort((left, right) => right - left)) {
    try {
      const value = JSON.parse(output.slice(index));
      if (value && typeof value === "object") return value;
    } catch {}
  }
  throw new Error("npm pack did not return a trailing JSON manifest");
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
      server.close((error) => error ? reject(error) : resolvePort(address.port));
    });
  });
}

async function waitForHealth(url, token, expectedMock, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (response.ok) {
        const body = await response.json();
        if (body.appName === "insπre" && body.mock === expectedMock) return;
      }
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`Packaged host did not become healthy at ${url}`);
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
  await Promise.all([mkdir(packDirectory), mkdir(installDirectory), mkdir(stateDirectory, { mode: 0o700 })]);

  const sourcePackage = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const expectedFontDigests = await verifySourceFonts();
  if (sourcePackage.bin?.inspire !== "inspire") {
    throw new Error("Release package must use npm's canonical inspire bin path");
  }
  const packed = await execFile("npm", ["pack", "--silent", "--json", "--pack-destination", packDirectory], {
    cwd: root,
    maxBuffer: 10 * 1024 * 1024,
  });
  const manifest = parsePackManifest(packed.stdout);
  const record = Array.isArray(manifest) ? manifest[0] : Object.values(manifest)[0];
  if (!record?.filename) throw new Error("npm pack did not report a tarball");
  const required = new Set([
    "build/server/index.js",
    "dist/index.html",
    "dist/THIRD_PARTY_NOTICES.txt",
    "inspire",
    "LICENSE",
    "src/assets/licenses/ibm-plex-LICENSE.txt",
    "src/assets/licenses/ibm-plex-sans-sc-LICENSE.txt",
  ]);
  const packedPaths = new Set((record.files ?? []).map((file) => file.path ?? ""));
  const missing = [...required].filter((path) => !packedPaths.has(path));
  if (missing.length > 0) throw new Error(`Release tarball is missing required files: ${missing.join(", ")}`);
  const forbidden = [...packedPaths].filter((path) =>
    path.startsWith("tests/") || path.startsWith("server/") || /\.(?:[cm]?ts|tsx)$/u.test(path),
  );
  if (forbidden.length > 0) throw new Error(`Release tarball contains source-only files: ${forbidden.join(", ")}`);

  const tarball = join(packDirectory, record.filename);
  const publishDryRun = await execFile("npm", ["publish", tarball, "--dry-run", "--json"], {
    cwd: root,
    maxBuffer: 10 * 1024 * 1024,
  });
  if (/auto-corrected|errors corrected|invalid and removed/iu.test(publishDryRun.stderr)) {
    throw new Error(`npm publish would rewrite release metadata:\n${publishDryRun.stderr}`);
  }
  const publishManifest = parsePackManifest(publishDryRun.stdout);
  const publishRecord = Array.isArray(publishManifest) ? publishManifest[0] : Object.values(publishManifest)[0];
  if (publishRecord?.id !== `${sourcePackage.name}@${sourcePackage.version}`) {
    throw new Error("npm publish dry-run reported the wrong package identity");
  }

  await execFile("npm", [
    "install", "--prefix", installDirectory, "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", tarball,
  ], { cwd: root, maxBuffer: 10 * 1024 * 1024 });

  const installedRoot = join(installDirectory, "node_modules", sourcePackage.name);
  const installedPackage = JSON.parse(await readFile(join(installedRoot, "package.json"), "utf8"));
  if (installedPackage.name !== sourcePackage.name || installedPackage.version !== sourcePackage.version) {
    throw new Error("Installed release package identity is wrong");
  }
  if (installedPackage.license !== "MIT") throw new Error("Installed release package must declare MIT");
  if (installedPackage.bin?.inspire !== "inspire") throw new Error("Installed release package has the wrong inspire bin path");
  const projectLicense = await readFile(join(installedRoot, "LICENSE"), "utf8");
  if (!projectLicense.startsWith("MIT License\n") || !projectLicense.includes("Copyright (c) 2026 XWIlluDelu")) {
    throw new Error("Installed release package has the wrong project license");
  }
  const fontLicenses = `${await readFile(join(installedRoot, "src/assets/licenses/ibm-plex-LICENSE.txt"), "utf8")}\n${await readFile(join(installedRoot, "src/assets/licenses/ibm-plex-sans-sc-LICENSE.txt"), "utf8")}`;
  for (const witness of ["SIL OPEN FONT LICENSE Version 1.1", 'Reserved Font Name "Plex"', "IBM Corp."]) {
    if (!fontLicenses.includes(witness)) throw new Error(`IBM font licenses are missing ${witness}`);
  }
  await verifyInstalledFonts(installedRoot, expectedFontDigests);
  const thirdPartyNotices = await readFile(join(installedRoot, "dist/THIRD_PARTY_NOTICES.txt"), "utf8");
  for (const identity of ["@earendil-works/pi-tui@0.84.1", "katex@", "react@", "rehype-katex@"]) {
    if (!thirdPartyNotices.includes(identity)) throw new Error(`Bundled notice is missing ${identity}`);
  }
  if (installedPackage.pi !== undefined) throw new Error("Standalone insπre must not declare a Pi resource manifest");
  if (installedPackage.keywords?.includes("pi-package")) throw new Error("Standalone insπre must not use the Pi resource-package keyword");
  const expectedPi = sourcePackage.dependencies?.["@earendil-works/pi-coding-agent"];
  const installedPi = JSON.parse(await readFile(join(installDirectory, "node_modules/@earendil-works/pi-coding-agent/package.json"), "utf8"));
  if (expectedPi !== installedPi.version) throw new Error("Installed release package did not retain the exact Pi runtime");

  const port = await freePort();
  const token = "inspire-release-smoke-token";
  const bin = join(installDirectory, "node_modules/.bin/inspire");
  const environment = {
    ...process.env,
    INSPIRE_HOST: "127.0.0.1",
    INSPIRE_PORT: String(port),
    INSPIRE_TOKEN: token,
    INSPIRE_OPEN: "0",
    INSPIRE_STATE_PATH: join(stateDirectory, "instance.json"),
    INSPIRE_PREFERENCES_PATH: join(stateDirectory, "preferences.json"),
    INSPIRE_LOG_PATH: join(stateDirectory, "diagnostics.jsonl"),
  };
  host = spawn(bin, ["mock"], { cwd: temporary, env: environment, stdio: ["ignore", "pipe", "pipe"] });
  host.stdout?.on("data", (chunk) => { hostOutput = `${hostOutput}${String(chunk)}`.slice(-8_192); });
  host.stderr?.on("data", (chunk) => { hostOutput = `${hostOutput}${String(chunk)}`.slice(-8_192); });
  await waitForHealth(`http://127.0.0.1:${port}/api/health`, token, true);
  await execFile(bin, ["status"], { cwd: temporary, env: environment, maxBuffer: 1024 * 1024 });
  await execFile(bin, ["stop"], { cwd: temporary, env: environment, maxBuffer: 1024 * 1024 });
  await waitForExit(host);
  if (host.exitCode !== 0) throw new Error(`Packaged mock host exited with ${host.exitCode}`);

  host = null;
  hostOutput = "";
  const realPort = await freePort();
  const workspace = join(temporary, "workspace");
  await mkdir(workspace);
  const realEnvironment = {
    ...environment,
    INSPIRE_PORT: String(realPort),
    INSPIRE_STATE_PATH: join(stateDirectory, "instance-real.json"),
    INSPIRE_PREFERENCES_PATH: join(stateDirectory, "preferences-real.json"),
    INSPIRE_LOG_PATH: join(stateDirectory, "diagnostics-real.jsonl"),
  };
  host = spawn(bin, [], { cwd: workspace, env: realEnvironment, stdio: ["ignore", "pipe", "pipe"] });
  host.stdout?.on("data", (chunk) => { hostOutput = `${hostOutput}${String(chunk)}`.slice(-8_192); });
  host.stderr?.on("data", (chunk) => { hostOutput = `${hostOutput}${String(chunk)}`.slice(-8_192); });
  const realOrigin = `http://127.0.0.1:${realPort}`;
  await waitForHealth(`${realOrigin}/api/health`, token, false);
  const headers = { Authorization: `Bearer ${token}` };
  const defaultsResponse = await fetch(`${realOrigin}/api/new-session/defaults?cwd=${encodeURIComponent(workspace)}`, { headers });
  if (!defaultsResponse.ok) throw new Error(`Packaged model-default lookup failed with ${defaultsResponse.status}`);
  const defaults = await defaultsResponse.json();
  if (!defaults.model?.provider || !defaults.model?.id) throw new Error("Packaged model-default lookup returned no model");
  const createResponse = await fetch(`${realOrigin}/api/sessions/new`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      cwd: workspace,
      model: { provider: defaults.model.provider, id: defaults.model.id },
      thinkingLevel: defaults.thinkingLevel,
    }),
  });
  if (!createResponse.ok) throw new Error(`Packaged real Pi session startup failed with ${createResponse.status}: ${await createResponse.text()}`);
  const created = await createResponse.json();
  if (!created.active?.sessionId || created.active.cwd !== workspace) throw new Error("Packaged real Pi session startup returned the wrong owner");
  await execFile(bin, ["status"], { cwd: workspace, env: realEnvironment, maxBuffer: 1024 * 1024 });
  await execFile(bin, ["stop"], { cwd: workspace, env: realEnvironment, maxBuffer: 1024 * 1024 });
  await waitForExit(host);
  if (host.exitCode !== 0) throw new Error(`Packaged real host exited with ${host.exitCode}`);

  console.log(JSON.stringify({
    package: `${installedPackage.name}@${installedPackage.version}`,
    license: installedPackage.license,
    bundledNotices: "present",
    verifiedFontAssets: expectedFontDigests.size,
    piManifest: false,
    sourceOnlyFiles: 0,
    requiredFiles: "present",
    piRuntime: installedPi.version,
    installMode: "production dependencies only",
    cliSymlink: "resolved",
    mockHealth: "ok",
    realPiStartup: "ok",
    publishDryRun: "accepted without metadata correction",
    lifecycle: "mock and real start/status/stop",
  }));
} catch (error) {
  if (hostOutput) console.error(hostOutput);
  throw error;
} finally {
  if (host && host.exitCode === null && host.signalCode === null) {
    host.kill("SIGKILL");
    await waitForExit(host).catch(() => undefined);
  }
  await rm(temporary, { recursive: true, force: true });
}
