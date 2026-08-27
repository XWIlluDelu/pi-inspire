import { execFile as execFileCallback } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  type FileHandle,
  link,
  lstat,
  mkdir,
  open,
  rm,
  unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { supportsPosixPermissions } from "./platform-paths.mjs";

const execFile = promisify(execFileCallback);
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

interface DesktopTrashOptions {
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
  home?: string;
  windowsRecycle?: (path: string) => Promise<void>;
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

async function ensurePrivateDirectory(
  path: string,
  platform: NodeJS.Platform,
): Promise<void> {
  await mkdir(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const stats = await lstat(path);
  if (!stats.isDirectory() || stats.isSymbolicLink())
    throw new Error("The desktop Trash path is not a directory");
  if (typeof process.getuid === "function" && stats.uid !== process.getuid())
    throw new Error("The desktop Trash path is not owned by the current user");
  if (supportsPosixPermissions(platform) && (stats.mode & 0o077) !== 0)
    await chmod(path, PRIVATE_DIRECTORY_MODE);
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
  options: Required<Pick<DesktopTrashOptions, "platform" | "home">> & {
    environment: NodeJS.ProcessEnv;
  },
): Promise<void> {
  const configuredDataHome = options.environment.XDG_DATA_HOME;
  const dataHome =
    configuredDataHome && isAbsolute(configuredDataHome)
      ? configuredDataHome
      : join(options.home, ".local", "share");
  const trashRoot = join(dataHome, "Trash");
  const filesDirectory = join(trashRoot, "files");
  const infoDirectory = join(trashRoot, "info");
  await ensurePrivateDirectory(trashRoot, options.platform);
  await ensurePrivateDirectory(filesDirectory, options.platform);
  await ensurePrivateDirectory(infoDirectory, options.platform);

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
          `[Trash Info]\nPath=${percentEncodePath(originalPath)}\nDeletionDate=${localDeletionDate()}\n`,
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

async function macosTrash(
  payloadPath: string,
  originalPath: string,
  home: string,
): Promise<void> {
  const trashRoot = join(home, ".Trash");
  await ensurePrivateDirectory(trashRoot, "darwin");
  const originalName = basename(originalPath) || "session.jsonl";
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const destination = join(
      trashRoot,
      `${originalName}.${randomBytes(9).toString("base64url")}`,
    );
    try {
      await moveByHardLink(payloadPath, destination);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
  }
  throw new Error("Unable to reserve a unique macOS Trash entry");
}

async function recycleOnWindows(
  path: string,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  const command = environment.SystemRoot
    ? join(
        environment.SystemRoot,
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      )
    : "powershell.exe";
  await execFile(
    command,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      [
        "$ErrorActionPreference = 'Stop'",
        "Add-Type -AssemblyName Microsoft.VisualBasic",
        "[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($env:INSPIRE_TRASH_PATH, [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs, [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin)",
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

/** Move an already-private payload into the native desktop Trash. Unsupported
 * or cross-volume moves throw so the caller can apply its identity-checked
 * permanent-delete fallback rather than creating a fake Trash directory. */
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
      platform,
      environment,
      home,
    });
    return;
  }
  if (platform === "darwin") {
    await macosTrash(payloadPath, originalPath, home);
    return;
  }
  if (platform === "win32") {
    if (suppliedOptions.windowsRecycle) {
      await suppliedOptions.windowsRecycle(payloadPath);
    } else {
      await recycleOnWindows(payloadPath, environment);
    }
    await lstat(payloadPath).then(
      () => {
        throw new Error("Windows Recycle Bin did not consume the payload");
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
