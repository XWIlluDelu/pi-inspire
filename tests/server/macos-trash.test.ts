import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { macosSessionTrashDirectories } from "../../server/macos-trash.js";

const base = join(tmpdir(), "inspire-native-volume-layout");
const home = join(base, "Users", "tester");
const homeVolume = join(base, "System", "Volumes", "Data");
const externalVolume = join(base, "Volumes", "Project disk");

describe("macOS per-volume Trash candidates", () => {
  it("scans only home and current-user Trash on volumes holding known session roots", async () => {
    const directories = [
      join(home, ".pi", "sessions"),
      join(externalVolume, "pi"),
      join(externalVolume, "other-pi"),
    ];
    const roots = await macosSessionTrashDirectories(directories, {
      home,
      uid: 501,
      volumeRoots: async (paths) => {
        expect(paths).toEqual([home, ...directories]);
        return [homeVolume, homeVolume, externalVolume, externalVolume];
      },
    });
    expect(roots).toEqual([
      join(home, ".Trash"),
      join(externalVolume, ".Trashes", "501"),
    ]);
  });

  it("propagates unreadable/unknown volume lookup instead of claiming negative references", async () => {
    await expect(
      macosSessionTrashDirectories([join(externalVolume, "pi")], {
        home,
        uid: 501,
        volumeRoots: async () => {
          throw new Error("Volume unavailable");
        },
      }),
    ).rejects.toThrow("Volume unavailable");
  });

  it("rejects incomplete native output rather than dropping a candidate volume", async () => {
    await expect(
      macosSessionTrashDirectories([join(externalVolume, "pi")], {
        home,
        uid: 501,
        volumeRoots: async () => [homeVolume],
      }),
    ).rejects.toThrow("Unable to identify");
  });
});
