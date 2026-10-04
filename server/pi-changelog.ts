import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { piInstallation } from "./pi-installation.js";

/** Read shipped release notes; no network lookup or user-configured path. */
export async function installedPiChangelog(): Promise<{
  version: string;
  markdown: string;
}> {
  const version = piInstallation.version;
  const source = await readFile(
    join(piInstallation.packageRoot, "CHANGELOG.md"),
    "utf8",
  );
  const sections = source.split(/(?=^## \[)/mu);
  const markdown = sections.find((section) =>
    section.startsWith(`## [${version}]`),
  );
  if (!markdown)
    throw new Error(
      `The installed Pi package has no changelog entry for ${version}`,
    );
  // Shipped relative documentation links point to public upstream docs, not Host files.
  return {
    version,
    markdown: markdown
      .trim()
      .replace(
        /\]\((docs\/[^)]+)\)/gu,
        "](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/$1)",
      ),
  };
}
