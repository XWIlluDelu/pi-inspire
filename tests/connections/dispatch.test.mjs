import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadConnectionManifest } from "../../connections/dispatch.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("connection dispatcher", () => {
  it("loads a checked-in module without coupling to its transport", async () => {
    await expect(
      loadConnectionManifest(root, "ssh-reverse"),
    ).resolves.toMatchObject({
      manifest: {
        id: "ssh-reverse",
        entry: "runner.mjs",
        actions: expect.arrayContaining(["start", "stop", "status"]),
      },
    });
  });

  it("refuses unsafe module names", async () => {
    await expect(
      loadConnectionManifest(root, "../ssh-reverse"),
    ).rejects.toThrow("Connection name");
  });
});
