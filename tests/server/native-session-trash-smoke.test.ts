import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  access,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join, parse } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { AttachmentStore } from "../../server/attachments.js";
import { windowsPowerShellCommand } from "../../server/platform-environment.mjs";
import { deleteSessionFile } from "../../server/session-delete.js";
import { SessionMetadataIndex } from "../../server/session-metadata.js";
import {
  RECOVERY_MANIFEST,
  recoverSessionBundle,
} from "../../server/session-recovery.js";

const enabled =
  process.env.CI === "true" &&
  process.env.INSPIRE_NATIVE_TRASH_TEST === "1" &&
  (process.platform === "darwin" || process.platform === "win32");

/** Real native APIs only on disposable CI runners. Ordinary local test runs
 * must never use a developer's Recycle Bin/Trash as an integration fixture. */
it.runIf(enabled)(
  "recycles an owned session bundle, retains its upload and recovers without clobbering",
  async ({ skip }) => {
    const root = await realpath(
      await mkdtemp(join(homedir(), ".inspire-native-trash-ci-")),
    );
    const store = new AttachmentStore(join(root, "uploads"), null, {
      sweepIntervalMs: 0,
    });
    try {
      const doc = await store.add({
        originalname: "notes.txt",
        mimetype: "text/plain",
        size: 5,
        buffer: Buffer.from("hello"),
      } as Express.Multer.File);
      const { files } = await store.resolveForPrompt([doc.id]);
      const upload = files[0]!.path;
      const id = randomUUID();
      const original = join(root, "session.jsonl");
      const text =
        [
          {
            type: "session",
            version: 3,
            id,
            cwd: root,
            timestamp: new Date().toISOString(),
          },
          {
            type: "message",
            id: "source",
            message: {
              role: "user",
              content: [{ type: "text", text: upload }],
            },
          },
        ]
          .map((value) => JSON.stringify(value))
          .join("\n") + "\n";
      await writeFile(original, text);
      await store.releaseConsumed([doc.id]);
      const [session] = await new SessionMetadataIndex().list(root);
      expect(session?.path).toBe(original);
      expect(await deleteSessionFile(session!)).toBe("trashed");
      await expect(access(original)).rejects.toMatchObject({ code: "ENOENT" });

      const collection = await store.collectStaged();
      expect(collection.reclaimed).toEqual([]);
      await expect(access(upload)).resolves.toBeUndefined();
      const trash =
        process.platform === "darwin"
          ? [join(homedir(), ".Trash")]
          : [
              join(
                parse(root).root,
                "$Recycle.Bin",
                (
                  await promisify(execFileCallback)(
                    windowsPowerShellCommand(),
                    [
                      "-NoLogo",
                      "-NoProfile",
                      "-NonInteractive",
                      "-Command",
                      "[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
                    ],
                    { encoding: "utf8", timeout: 10000, windowsHide: true },
                  )
                ).stdout.trim(),
              ),
            ];
      let bundle: string | undefined;
      let privacyBlocked = false;
      for (const directory of trash) {
        const entries = await readdir(directory, { withFileTypes: true }).catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code === "EPERM" || error.code === "EACCES") {
              privacyBlocked = true;
              return [];
            }
            if (error.code === "ENOENT") return [];
            throw error;
          },
        );
        for (const entry of entries) {
          if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
          const candidate = join(directory, entry.name);
          const manifest = await readFile(
            join(candidate, RECOVERY_MANIFEST),
            "utf8",
          )
            .then(
              (value) =>
                JSON.parse(value) as {
                  originalPath?: string;
                  sessionId?: string;
                },
            )
            .catch(() => null);
          if (manifest?.originalPath === original && manifest.sessionId === id)
            bundle = candidate;
        }
      }
      if (!bundle && privacyBlocked) {
        skip(
          "Native Trash move succeeded; OS privacy blocks the runner from inspecting recovery contents",
        );
      }
      expect(
        bundle,
        "Native Trash must retain a discoverable recovery bundle",
      ).toBeTruthy();
      expect(await recoverSessionBundle(bundle!)).toBe(original);
      expect(await readFile(original, "utf8")).toBe(text);
      await expect(recoverSessionBundle(bundle!)).rejects.toThrow(
        "already exists",
      );
      expect((await store.collectStaged()).reclaimed).toEqual([]);
      // The complete bundle stays with the OS until this disposable runner is
      // destroyed. Do not edit private Windows $I or Finder restoration metadata.
    } finally {
      await store.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  60000,
);
