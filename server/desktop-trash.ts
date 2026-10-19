import { execFile as execFileCallback } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  type FileHandle,
  link,
  lstat,
  open,
  rm,
  unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { type LinuxTrashOptions, selectLinuxTrash } from "./linux-trash.js";
import { windowsPowerShellCommand } from "./platform-environment.mjs";
import { prepareSessionRecovery } from "./session-recovery.js";

const execFile = promisify(execFileCallback);
const PRIVATE_FILE_MODE = 0o600;

interface DesktopTrashOptions {
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
  home?: string;
  linux?: Pick<LinuxTrashOptions, "mounts" | "uid">;
  windowsRecycle?: (directory: string) => Promise<void>;
  macosRecycle?: (directory: string) => Promise<void>;
}

function percentEncodePath(path: string): string {
  let encoded = "";
  for (const byte of Buffer.from(path)) {
    const character = String.fromCharCode(byte);
    encoded += /[A-Za-z0-9._~\/-]/u.test(character)
      ? character
      : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return encoded;
}

function localDeletionDate(date = new Date()): string {
  const part = (value: number) => String(value).padStart(2, "0");
  return (
    `${date.getFullYear()}-${part(date.getMonth() + 1)}-${part(date.getDate())}` +
    `T${part(date.getHours())}:${part(date.getMinutes())}:${part(date.getSeconds())}`
  );
}

async function moveByHardLink(
  payloadPath: string,
  destination: string,
): Promise<void> {
  // link() is the only portable no-replace primitive available to Node for a
  // same-volume regular file. It reserves the destination atomically; unlink
  // then commits the move without changing the inode or bytes.
  await link(payloadPath, destination);
  try {
    await unlink(payloadPath);
  } catch (error) {
    await rm(destination, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function freedesktopTrash(
  payloadPath: string,
  originalPath: string,
  options: LinuxTrashOptions,
): Promise<void> {
  const { root: trashRoot, restorePath } = await selectLinuxTrash(
    payloadPath,
    originalPath,
    options,
  );
  const filesDirectory = join(trashRoot, "files");
  const infoDirectory = join(trashRoot, "info");

  const originalName = basename(originalPath) || "session.jsonl";
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const suffix = randomBytes(9).toString("base64url");
    const trashName = `${originalName}.${suffix}`;
    const infoPath = join(infoDirectory, `${trashName}.trashinfo`);
    const payloadDestination = join(filesDirectory, trashName);
    let info: FileHandle;
    try {
      info = await open(
        infoPath,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          (constants.O_NOFOLLOW ?? 0),
        PRIVATE_FILE_MODE,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
    try {
      try {
        await info.writeFile(
          `[Trash Info]\nPath=${percentEncodePath(restorePath)}\nDeletionDate=${localDeletionDate()}\n`,
          "utf8",
        );
        await info.sync();
      } finally {
        await info.close();
      }
      await moveByHardLink(payloadPath, payloadDestination);
      return;
    } catch (error) {
      await rm(infoPath, { force: true });
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
  }
  throw new Error("Unable to reserve a unique desktop Trash entry");
}

async function recycleOnMacos(directory: string): Promise<void> {
  // Foundation owns native Trash placement (including per-volume Trash).
  // No Finder automation permission or private .DS_Store metadata is needed.
  await execFile(
    "/usr/bin/osascript",
    [
      "-l",
      "JavaScript",
      "-e",
      [
        'ObjC.import("Foundation");',
        "function run(argv) {",
        "  const error = Ref();",
        "  const url = $.NSURL.fileURLWithPath(argv[0]);",
        "  if (!$.NSFileManager.defaultManager.trashItemAtURLResultingItemURLError(url, null, error))",
        "    throw new Error(ObjC.unwrap(error[0].localizedDescription));",
        "}",
      ].join("\n"),
      directory,
    ],
    {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 64 * 1024,
    },
  );
}

async function recycleOnWindows(
  path: string,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  const command = windowsPowerShellCommand(environment);
  await execFile(
    command,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      [
        "$ErrorActionPreference = 'Stop'",
        "Microsoft.PowerShell.Utility\\Add-Type -AssemblyName Microsoft.VisualBasic",
        "[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($env:INSPIRE_TRASH_PATH, [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs, [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin)",
      ].join("; "),
    ],
    {
      env: { ...environment, INSPIRE_TRASH_PATH: path },
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 64 * 1024,
      windowsHide: true,
    },
  );
}

/** Move an already-private payload into desktop Trash. Native Windows/macOS
 * APIs consume its private recovery bundle, never the original public pathname.
 * Unsupported moves throw for the caller's identity-checked permanent fallback. */
export async function moveToDesktopTrash(
  payloadPath: string,
  originalPath: string,
  suppliedOptions: DesktopTrashOptions = {},
): Promise<void> {
  const platform = suppliedOptions.platform ?? process.platform;
  const environment = suppliedOptions.environment ?? process.env;
  const home = suppliedOptions.home ?? homedir();
  if (platform === "linux") {
    await freedesktopTrash(payloadPath, originalPath, {
      ...suppliedOptions.linux,
      environment,
      home,
    });
    return;
  }
  if (platform === "darwin" || platform === "win32") {
    await prepareSessionRecovery(payloadPath, originalPath);
    const directory = dirname(payloadPath);
    if (platform === "darwin") {
      await (suppliedOptions.macosRecycle ?? recycleOnMacos)(directory);
    } else if (suppliedOptions.windowsRecycle) {
      await suppliedOptions.windowsRecycle(directory);
    } else {
      await recycleOnWindows(directory, environment);
    }
    await lstat(payloadPath).then(
      () => {
        throw new Error(
          "Native Trash did not consume the session recovery bundle",
        );
      },
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      },
    );
    return;
  }
  throw Object.assign(new Error("Desktop Trash is unsupported on this host"), {
    code: "ENOTSUP",
  });
}
