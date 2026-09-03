import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { discoverTerminalProfiles } from "../../server/terminal-profiles.js";

describe("terminal profiles", () => {
  it.runIf(process.platform !== "win32")(
    "deduplicates executable aliases without changing the preferred shell path",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "inspire-shells-"));
      const preferred = join(directory, "preferred-shell");
      try {
        await symlink(process.execPath, preferred);
        await symlink(process.execPath, join(directory, "bash"));

        const profiles = discoverTerminalProfiles({
          SHELL: preferred,
          PATH: directory,
        });

        expect(profiles).toHaveLength(1);
        expect(profiles[0]).toMatchObject({
          id: "preferred-shell",
          shell: preferred,
          isDefault: true,
        });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
