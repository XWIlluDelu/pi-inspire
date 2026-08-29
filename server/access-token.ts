import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, link, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { installationKey } from "./installation-key.js";
import {
  inspireStateDirectory,
  supportsPosixPermissions,
} from "./platform-paths.mjs";

const TOKEN_LENGTH = 64;
const TOKEN_PATTERN = new RegExp(`^[A-Za-z0-9_-]{${TOKEN_LENGTH}}$`);
// Earlier releases generated 32 or 96 random bytes, which encode to 43 or
// 128 base64url characters. Retire either generation on the next host start.
const LEGACY_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$|^[A-Za-z0-9_-]{128}$/;
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIRECTORY_MODE = 0o700;

export function defaultAccessTokenPath(
  root: string,
  host: string,
  port: number,
): string {
  return join(
    inspireStateDirectory(),
    `${installationKey(root, host, port)}.token`,
  );
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(
      `The Inspire access-token directory is not a private directory: ${path}`,
    );
  }
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new Error(
      `The Inspire access-token directory is not owned by the current user: ${path}`,
    );
  }
  if (supportsPosixPermissions() && (info.mode & 0o077) !== 0)
    await chmod(path, PRIVATE_DIRECTORY_MODE);
}

interface StoredToken {
  token: string;
  legacy: boolean;
}

async function readPrivateToken(path: string): Promise<StoredToken> {
  const pathInfo = await lstat(path);
  if (!pathInfo.isFile() || pathInfo.isSymbolicLink())
    throw new Error(
      `The Inspire access-token path is not a regular file: ${path}`,
    );
  const noFollow =
    process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0);
  const handle = await open(path, constants.O_RDONLY | noFollow);
  try {
    const info = await handle.stat();
    if (
      !info.isFile() ||
      info.dev !== pathInfo.dev ||
      info.ino !== pathInfo.ino
    )
      throw new Error(
        `The Inspire access-token path changed while it was opened: ${path}`,
      );
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
      throw new Error(
        `The Inspire access-token file is not owned by the current user: ${path}`,
      );
    }
    if (supportsPosixPermissions() && (info.mode & 0o077) !== 0) {
      throw new Error(
        `The Inspire access-token file must not be accessible by other users: ${path}`,
      );
    }
    if (info.size > 256)
      throw new Error(`The Inspire access-token file is invalid: ${path}`);
    const token = (await handle.readFile("utf8")).trim();
    if (TOKEN_PATTERN.test(token)) return { token, legacy: false };
    if (LEGACY_TOKEN_PATTERN.test(token)) return { token, legacy: true };
    throw new Error(`The Inspire access-token file is invalid: ${path}`);
  } finally {
    await handle.close();
  }
}

function generateToken(): string {
  // 48 random bytes encode to exactly 64 base64url characters (384 bits).
  return randomBytes(48).toString("base64url");
}

async function writeTemporaryToken(
  path: string,
  token: string,
): Promise<string> {
  const temporary = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  const handle = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    PRIVATE_FILE_MODE,
  );
  let written = false;
  try {
    await handle.writeFile(`${token}\n`, "utf8");
    await handle.sync();
    written = true;
    return temporary;
  } finally {
    await handle.close();
    if (!written) await rm(temporary, { force: true });
  }
}

async function createPrivateToken(path: string): Promise<string> {
  const token = generateToken();
  const temporary = await writeTemporaryToken(path, token);
  try {
    await link(temporary, path);
    return token;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      const existing = await readPrivateToken(path);
      return existing.legacy ? rotateLegacyToken(path) : existing.token;
    }
    throw error;
  } finally {
    await rm(temporary, { force: true });
  }
}

async function rotateLegacyToken(path: string): Promise<string> {
  const token = generateToken();
  const temporary = await writeTemporaryToken(path, token);
  try {
    // The launcher serializes normal starts for one checkout/host/port. Read
    // again before replacement so a concurrent newer start always wins.
    const current = await readPrivateToken(path);
    if (!current.legacy) return current.token;
    await rename(temporary, path);
    return token;
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function resolveAccessToken(
  explicitToken: string | undefined,
  path: string,
): Promise<string> {
  if (explicitToken !== undefined) {
    if (explicitToken.length < 1 || explicitToken.length > 256) {
      throw new Error(
        "INSPIRE_TOKEN must contain between 1 and 256 characters",
      );
    }
    return explicitToken;
  }
  await ensurePrivateDirectory(dirname(path));
  try {
    const stored = await readPrivateToken(path);
    return stored.legacy ? rotateLegacyToken(path) : stored.token;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return createPrivateToken(path);
  }
}
