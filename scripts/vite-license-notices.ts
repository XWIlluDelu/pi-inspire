import { readFile, readdir } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { Plugin } from "vite";

interface PackageMetadata {
  name?: string;
  version?: string;
  license?: string;
  repository?: string | { url?: string };
}

interface PackageNotice {
  identity: string;
  license: string;
  repository?: string;
  texts: Array<{ name: string; text: string }>;
}

const projectRoot = resolve(import.meta.dirname, "..");
const licenseOverrides = new Map<string, string>([
  [
    "@earendil-works/pi-tui@0.84.1",
    resolve(projectRoot, "scripts/licenses/earendil-works-pi-MIT.txt"),
  ],
  [
    "rehype-katex@7.0.1",
    resolve(projectRoot, "scripts/licenses/rehype-katex-MIT.txt"),
  ],
]);

function packageRootFor(moduleId: string): string | null {
  const clean = moduleId.replace(/^\0+/u, "").split("?", 1)[0]!;
  if (!isAbsolute(clean)) return null;
  const normalized = clean.replaceAll("\\", "/");
  const marker = "/node_modules/";
  const markerIndex = normalized.lastIndexOf(marker);
  if (markerIndex < 0) return null;
  const packageStart = markerIndex + marker.length;
  const parts = normalized.slice(packageStart).split("/");
  const packageParts = parts[0]?.startsWith("@")
    ? parts.slice(0, 2)
    : parts.slice(0, 1);
  if (packageParts.length === 0 || packageParts.some((part) => !part))
    return null;
  return normalized.slice(0, packageStart + packageParts.join("/").length);
}

function repositoryUrl(
  repository: PackageMetadata["repository"],
): string | undefined {
  const value = typeof repository === "string" ? repository : repository?.url;
  if (!value) return undefined;
  const normalized = value.replace(/^git\+/u, "").replace(/\.git$/u, "");
  if (/^[\w.-]+\/[\w.-]+$/u.test(normalized))
    return `https://github.com/${normalized}`;
  return normalized.replace(/^git:\/\//u, "https://");
}

async function noticeFor(packageRoot: string): Promise<PackageNotice> {
  const metadata = JSON.parse(
    await readFile(resolve(packageRoot, "package.json"), "utf8"),
  ) as PackageMetadata;
  if (!metadata.name || !metadata.version || !metadata.license) {
    throw new Error(
      `Bundled package at ${packageRoot} has incomplete license metadata`,
    );
  }

  const files = (await readdir(packageRoot))
    .filter((name) => /^(?:licen[cs]e|copying|notice)(?:\.|$)/iu.test(name))
    .sort((left, right) => left.localeCompare(right));
  const identity = `${metadata.name}@${metadata.version}`;
  const override = licenseOverrides.get(identity);
  const texts = override
    ? [{ name: "upstream LICENSE", text: await readFile(override, "utf8") }]
    : await Promise.all(
        files.map(async (name) => ({
          name,
          text: await readFile(resolve(packageRoot, name), "utf8"),
        })),
      );
  if (texts.length === 0) {
    throw new Error(
      `Bundled package ${metadata.name}@${metadata.version} provides no license text`,
    );
  }

  return {
    identity,
    license: metadata.license,
    repository: repositoryUrl(metadata.repository),
    texts,
  };
}

function renderNotices(notices: PackageNotice[]): string {
  const sections = notices.map((notice) => {
    const metadata = [
      notice.identity,
      `Declared license: ${notice.license}`,
      ...(notice.repository ? [`Source: ${notice.repository}`] : []),
    ];
    const texts = notice.texts
      .map(({ name, text }) => `--- ${name} ---\n${text.trimEnd()}`)
      .join("\n\n");
    return `${metadata.join("\n")}\n\n${texts}`;
  });
  return [
    "THIRD-PARTY SOFTWARE NOTICES",
    "",
    "Generated from the third-party modules included in the INSΠRE browser bundle.",
    "The project license is in ../LICENSE. Bundled font licenses are under ../src/assets/licenses/.",
    "",
    sections.join(`\n\n${"=".repeat(79)}\n\n`),
    "",
  ].join("\n");
}

export function bundledLicenseNotices(): Plugin {
  return {
    name: "inspire-bundled-license-notices",
    apply: "build",
    async generateBundle() {
      const packageRoots = new Set<string>();
      for (const moduleId of this.getModuleIds()) {
        const packageRoot = packageRootFor(moduleId);
        if (packageRoot) packageRoots.add(packageRoot);
      }

      const roots = [...packageRoots].sort();
      const results = await Promise.allSettled(
        roots.map((packageRoot) => noticeFor(packageRoot)),
      );
      const failures = results.flatMap((result) =>
        result.status === "rejected" ? [String(result.reason)] : [],
      );
      if (failures.length > 0) {
        throw new Error(
          `Bundled license collection failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}`,
        );
      }
      const byIdentity = new Map<string, PackageNotice>();
      for (const result of results) {
        if (result.status === "fulfilled")
          byIdentity.set(result.value.identity, result.value);
      }
      const notices = [...byIdentity.values()].sort((left, right) =>
        left.identity.localeCompare(right.identity),
      );
      if (notices.length === 0)
        throw new Error(
          "Browser bundle contained no attributable third-party packages",
        );
      this.emitFile({
        type: "asset",
        fileName: "THIRD_PARTY_NOTICES.txt",
        source: renderNotices(notices),
      });
    },
  };
}
