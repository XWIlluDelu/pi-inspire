import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  stat,
} from "node:fs/promises";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  sep,
} from "node:path";

interface LinuxMountAuthority {
  mountPoint: string;
  root: string;
  filesystem: string;
  source: string;
}
export interface LinuxMount extends LinuxMountAuthority {
  id: number;
}
interface LinuxDirectoryAuthority extends LinuxMountAuthority {
  directory: string;
}
export interface LinuxTrashOptions {
  home?: string;
  environment?: NodeJS.ProcessEnv;
  uid?: number;
  /** Logical mount namespaces keep native filesystem tests inside owned fixtures. */
  mounts?: () => Promise<readonly LinuxMount[]>;
}

function unescapeMount(value: string): string {
  return value.replace(/\\(040|011|012|134)/gu, (_, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8)),
  );
}

export function parseLinuxMountInfo(text: string): LinuxMount[] {
  const mounts: LinuxMount[] = [];
  for (const line of text.split("\n").filter(Boolean)) {
    const fields = line.split(" ");
    const separator = fields.indexOf("-");
    const id = Number(fields[0]);
    const root = unescapeMount(fields[3] ?? "");
    const mountPoint = unescapeMount(fields[4] ?? "");
    if (
      !Number.isSafeInteger(id) ||
      id < 1 ||
      separator < 6 ||
      fields.length < separator + 4 ||
      !posix.isAbsolute(root) ||
      !posix.isAbsolute(mountPoint)
    )
      throw new Error("Invalid Linux mountinfo; Trash volume is unknown");
    mounts.push({
      id,
      root,
      mountPoint,
      filesystem: fields[separator + 1]!,
      source: unescapeMount(fields[separator + 2]!),
    });
  }
  if (!mounts.length)
    throw new Error("Linux mountinfo has no Trash volume authority");
  return mounts;
}

export async function linuxMounts(
  options: LinuxTrashOptions = {},
): Promise<readonly LinuxMount[]> {
  return options.mounts
    ? options.mounts()
    : parseLinuxMountInfo(await readFile("/proc/self/mountinfo", "utf8"));
}

function contains(parent: string, path: string): boolean {
  const part = relative(parent, path);
  return (
    part === "" ||
    (!isAbsolute(part) && part !== ".." && !part.startsWith(".." + sep))
  );
}

function mountFor(path: string, mounts: readonly LinuxMount[]): LinuxMount {
  // Logical fixture namespaces use longest-prefix lookup. Native lookups use
  // the opened directory\'s fdinfo mount ID, including overmounted paths.
  const mount = mounts
    .filter((entry) => contains(entry.mountPoint, path))
    .sort(
      (a, b) => b.mountPoint.length - a.mountPoint.length || b.id - a.id,
    )[0];
  if (!mount) throw new Error("Unable to identify the Linux Trash mount");
  return mount;
}

/** Canonicalize the nearest existing ancestor without creating missing paths.
 * A missing leaf on a verified mount is different from a disappeared mount. */
export async function linuxDirectoryAuthority(
  directory: string,
  mounts: readonly LinuxMount[],
  options: Pick<LinuxTrashOptions, "mounts"> = {},
): Promise<{
  authority: LinuxDirectoryAuthority;
  mount: LinuxMount;
  exists: boolean;
}> {
  let ancestor = resolve(directory);
  const missing: string[] = [];
  while (true) {
    try {
      const physical = await realpath(ancestor);
      if (!(await stat(physical)).isDirectory())
        throw new Error("Session storage is not a directory");
      const canonical = join(physical, ...missing.reverse());
      let mount: LinuxMount;
      if (options.mounts) mount = mountFor(canonical, mounts);
      else {
        const directory = await open(
          physical,
          constants.O_RDONLY |
            constants.O_DIRECTORY |
            (constants.O_NOFOLLOW ?? 0),
        );
        try {
          const fdinfo = await readFile(
            `/proc/self/fdinfo/${directory.fd}`,
            "utf8",
          );
          const id = Number(/^mnt_id:\s+(\d+)$/mu.exec(fdinfo)?.[1]);
          const current = mounts.find((entry) => entry.id === id);
          if (!current || !contains(current.mountPoint, canonical))
            throw new Error("Linux mount authority changed during path lookup");
          mount = current;
        } finally {
          await directory.close();
        }
      }
      const { id: _id, ...stable } = mount;
      return {
        authority: { ...stable, directory: canonical },
        mount,
        exists: missing.length === 0,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      missing.push(basename(ancestor));
      ancestor = parent;
    }
  }
}

function linuxHomeTrash(options: LinuxTrashOptions = {}): string {
  const configured = (options.environment ?? process.env).XDG_DATA_HOME;
  return join(
    configured && isAbsolute(configured)
      ? configured
      : join(options.home ?? homedir(), ".local", "share"),
    "Trash",
  );
}

function userId(options: LinuxTrashOptions): number {
  const uid = options.uid ?? process.getuid?.();
  if (uid === undefined || !Number.isSafeInteger(uid) || uid < 0)
    throw new Error("Unable to identify the Linux Trash user");
  return uid;
}

async function optionalStats(path: string) {
  return lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
}

async function privateDirectory(
  path: string,
  uid: number,
  create: boolean,
  recursive = false,
): Promise<boolean> {
  if (create)
    await mkdir(path, { recursive, mode: 0o700 }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      },
    );
  const stats = await optionalStats(path);
  if (!stats) return false;
  if (!stats.isDirectory() || stats.isSymbolicLink() || stats.uid !== uid)
    throw new Error(
      "Linux Trash directory is not a current-user non-symlink directory",
    );
  if ((stats.mode & 0o077) !== 0) {
    if (!create) throw new Error("Linux Trash directory is not private");
    await chmod(path, 0o700);
  }
  return true;
}

async function validSharedTrash(path: string): Promise<boolean> {
  const stats = await optionalStats(path);
  return (
    !!stats &&
    stats.isDirectory() &&
    !stats.isSymbolicLink() &&
    (stats.mode & 0o1000) !== 0
  );
}

async function prepareRoot(
  root: string,
  uid: number,
  recursive = false,
): Promise<void> {
  await privateDirectory(root, uid, true, recursive);
  await privateDirectory(join(root, "files"), uid, true);
  await privateDirectory(join(root, "info"), uid, true);
}

export async function selectLinuxTrash(
  payloadPath: string,
  originalPath: string,
  options: LinuxTrashOptions = {},
): Promise<{ root: string; restorePath: string }> {
  const mounts = await linuxMounts(options);
  const source = await linuxDirectoryAuthority(
    dirname(payloadPath),
    mounts,
    options,
  );
  const original = await linuxDirectoryAuthority(
    dirname(originalPath),
    mounts,
    options,
  );
  if (source.mount.id !== original.mount.id)
    throw new Error(
      "Original session and private payload do not share a Linux mount",
    );
  const uid = userId(options);
  const prepare = async (root: string, recursive = false) => {
    await prepareRoot(root, uid, recursive);
    if (
      (await linuxDirectoryAuthority(join(root, "files"), mounts, options))
        .mount.id !== source.mount.id
    )
      throw new Error("Linux Trash files directory is on a different mount");
  };
  const home = linuxHomeTrash(options);
  try {
    const homeMount = await linuxDirectoryAuthority(home, mounts, options);
    if (source.mount.id === homeMount.mount.id) {
      await prepare(home, true);
      return {
        root: home,
        restorePath: join(original.authority.directory, basename(originalPath)),
      };
    }
  } catch {
    // An unavailable/unsafe home Trash need not turn a usable source-volume
    // Trash operation into permanent deletion. No payload has moved yet.
  }
  const topdir = source.mount.mountPoint;
  const restorePath = relative(
    topdir,
    join(original.authority.directory, basename(originalPath)),
  );
  if (
    !restorePath ||
    !contains(
      topdir,
      join(original.authority.directory, basename(originalPath)),
    )
  )
    throw new Error("The original session is outside its Linux Trash volume");
  const shared = join(topdir, ".Trash");
  try {
    if (await validSharedTrash(shared)) {
      const root = join(shared, String(uid));
      await prepare(root);
      return { root, restorePath };
    }
  } catch {
    // The standard requires immediate fallback when shared Trash is unusable.
  }
  const root = join(topdir, ".Trash-" + uid);
  await prepare(root);
  return { root, restorePath };
}
