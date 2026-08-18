import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, link, lstat, mkdir, open, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIRECTORY_MODE = 0o700;

function accessTokenKey(root: string, host: string, port: number): string {
  return createHash("sha256")
    .update(root)
    .update("\0")
    .update(host)
    .update("\0")
    .update(String(port))
    .digest("hex");
}

export function defaultAccessTokenPath(
  root: string,
  host: string,
  port: number,
): string {
  const stateHome =
    process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  return join(
    stateHome,
    "inspire",
    `${accessTokenKey(root, host, port)}.token`,
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
  if ((info.mode & 0o077) !== 0) await chmod(path, PRIVATE_DIRECTORY_MODE);
}

async function readPrivateToken(path: string): Promise<string> {
  const noFollow =
    process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0);
  const handle = await open(path, constants.O_RDONLY | noFollow);
  try {
    const info = await handle.stat();
    if (!info.isFile())
      throw new Error(
        `The Inspire access-token path is not a regular file: ${path}`,
      );
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
      throw new Error(
        `The Inspire access-token file is not owned by the current user: ${path}`,
      );
    }
    if ((info.mode & 0o077) !== 0) {
      throw new Error(
        `The Inspire access-token file must not be accessible by other users: ${path}`,
      );
    }
    if (info.size > 256)
      throw new Error(`The Inspire access-token file is invalid: ${path}`);
    const token = (await handle.readFile("utf8")).trim();
    if (!TOKEN_PATTERN.test(token))
      throw new Error(`The Inspire access-token file is invalid: ${path}`);
    return token;
  } finally {
    await handle.close();
  }
}

async function createPrivateToken(path: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  const temporary = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  const handle = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    PRIVATE_FILE_MODE,
  );
  try {
    await handle.writeFile(`${token}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temporary, path);
    return token;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      return readPrivateToken(path);
    throw error;
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
    await stat(path);
    return await readPrivateToken(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return createPrivateToken(path);
  }
}
