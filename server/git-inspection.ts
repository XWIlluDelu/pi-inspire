import { stat } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import type {
  GitDeltaFacet,
  GitDeltaKind,
  GitDiffLine,
  GitDiffResponse,
  GitDiffSide,
  GitFileChange,
  GitHead,
  GitPathIdentity,
  GitStatusResponse,
  GitSubmoduleState,
} from "../shared/contracts.js";
import {
  GIT_CONFIG_ARGS,
  GIT_STDERR_BYTES,
  GIT_TIMEOUT_MS,
  GitInspectionError,
  spawnGit,
  type GitRunner,
  type GitRunResult,
} from "./git-runner.js";

export { GIT_STDERR_BYTES, GIT_TIMEOUT_MS, GitInspectionError, spawnGit };
export type { GitRunner };
export const GIT_STATUS_OUTPUT_BYTES = 4 * 1024 * 1024;
export const GIT_DIFF_OUTPUT_BYTES = 1024 * 1024;
const MAX_GIT_STATUS_FILES = 1_000;
const MAX_GIT_DIFF_LINES = 2_000;
const MAX_PATH_ID_LENGTH = 16 * 1024;

const fatalDecoder = new TextDecoder("utf-8", { fatal: true });

function strictUtf8(value: Buffer): string | undefined {
  try {
    return fatalDecoder.decode(value);
  } catch {
    return undefined;
  }
}

function controlSafeDisplay(value: Buffer): string {
  const decoded = strictUtf8(value);
  if (decoded !== undefined) {
    return decoded
      .replace(/\\/g, "\\\\")
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r")
      .replace(/\t/g, "\\t")
      .replace(
        /[\0-\x08\x0b\x0c\x0e-\x1f\x7f]/g,
        (character) =>
          `\\x${character.charCodeAt(0).toString(16).padStart(2, "0")}`,
      );
  }
  let result = "";
  for (const byte of value) {
    result +=
      byte >= 0x20 && byte <= 0x7e && byte !== 0x5c
        ? String.fromCharCode(byte)
        : `\\x${byte.toString(16).padStart(2, "0")}`;
  }
  return result;
}

function safeRepositoryPath(value: string): boolean {
  if (
    !value ||
    value.includes("\0") ||
    value.startsWith("/") ||
    value.split("/").some((part) => part === "." || part === "..")
  )
    return false;
  return true;
}

function underPrefix(path: Buffer, prefix: Buffer): Buffer | undefined {
  if (prefix.length === 0) return path;
  if (
    path.length <= prefix.length ||
    !path.subarray(0, prefix.length).equals(prefix)
  )
    return undefined;
  return path.subarray(prefix.length);
}

function identity(raw: Buffer, workspacePrefix: Buffer): GitPathIdentity {
  const result: GitPathIdentity = {
    id: raw.toString("base64url"),
    display: controlSafeDisplay(raw),
  };
  const path = strictUtf8(raw);
  if (path !== undefined && safeRepositoryPath(path)) result.utf8Path = path;
  const relative = underPrefix(raw, workspacePrefix);
  if (relative) {
    const workspacePath = strictUtf8(relative);
    if (workspacePath !== undefined && safeRepositoryPath(workspacePath))
      result.workspacePath = workspacePath;
  }
  return result;
}

function splitFixed(
  record: Buffer,
  spaces: number,
): { fields: string[]; path: Buffer } {
  const fields: string[] = [];
  let start = 0;
  for (let index = 0; index < spaces; index += 1) {
    const end = record.indexOf(0x20, start);
    if (end < 0)
      throw new GitInspectionError("Git returned malformed status data");
    const field = record.subarray(start, end);
    if (field.length === 0 || field.some((byte) => byte > 0x7f)) {
      throw new GitInspectionError("Git returned malformed status data");
    }
    fields.push(field.toString("ascii"));
    start = end + 1;
  }
  const path = record.subarray(start);
  if (path.length === 0 || path.includes(0))
    throw new GitInspectionError("Git returned malformed status data");
  return { fields, path };
}

function validateTrackedFields(
  fields: string[],
  type: string,
  modeIndexes: number[],
  hashIndexes: number[],
): void {
  const validHash = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
  if (
    fields[0] !== type ||
    modeIndexes.some((index) => !/^[0-7]{6}$/.test(fields[index] ?? "")) ||
    hashIndexes.some((index) => !validHash.test(fields[index] ?? ""))
  )
    throw new GitInspectionError("Git returned malformed status data");
}

function deltaKind(code: string): GitDeltaKind | undefined {
  const kinds: Record<string, GitDeltaKind> = {
    A: "added",
    M: "modified",
    D: "deleted",
    R: "renamed",
    C: "copied",
    T: "type-changed",
    U: "unmerged",
  };
  if (code === ".") return undefined;
  const kind = kinds[code];
  if (!kind)
    throw new GitInspectionError("Git returned an unknown change status");
  return kind;
}

function facets(
  xy: string,
  originalPath?: GitPathIdentity,
): Pick<GitFileChange, "staged" | "unstaged"> {
  // U belongs exclusively to porcelain-v2 unmerged (`u`) records, and an
  // ordinary record must describe at least one actual facet.
  if (!/^[.AMDRCT]{2}$/.test(xy) || xy === "..") {
    throw new GitInspectionError("Git returned malformed change facets");
  }
  const stagedKind = deltaKind(xy[0]!);
  const unstagedKind = deltaKind(xy[1]!);
  const facet = (kind: GitDeltaKind): GitDeltaFacet => ({
    kind,
    ...(originalPath && (kind === "renamed" || kind === "copied")
      ? { originalPath }
      : {}),
  });
  return {
    ...(stagedKind ? { staged: facet(stagedKind) } : {}),
    ...(unstagedKind ? { unstaged: facet(unstagedKind) } : {}),
  };
}

function submoduleState(field: string): GitSubmoduleState | undefined {
  if (field === "N...") return undefined;
  if (!/^S[.C][.M][.U]$/.test(field))
    throw new GitInspectionError("Git returned malformed submodule status");
  return {
    commitChanged: field[1] === "C",
    trackedModified: field[2] === "M",
    untracked: field[3] === "U",
  };
}

const MAX_BRANCH_REF_BYTES = 4_096;
const MAX_BRANCH_AB_BYTES = 64;

function validBranchRef(value: Buffer): boolean {
  if (value.length === 0 || value.length > MAX_BRANCH_REF_BYTES) return false;
  if (value.length === 1 && value[0] === 0x40) return false; // @
  if (value[0] === 0x2f || value.at(-1) === 0x2f || value.at(-1) === 0x2e)
    return false;
  const text = value.toString("latin1");
  if (text.includes("//") || text.includes("..") || text.includes("@{"))
    return false;
  if (
    value.some(
      (byte) =>
        byte < 0x20 ||
        byte === 0x7f ||
        " ~^:?*[\\".includes(String.fromCharCode(byte)),
    )
  )
    return false;
  return text
    .split("/")
    .every(
      (component) =>
        component.length > 0 &&
        !component.startsWith(".") &&
        !component.endsWith(".lock"),
    );
}

function validBranchAb(value: Buffer): boolean {
  if (
    value.length === 0 ||
    value.length > MAX_BRANCH_AB_BYTES ||
    value.some((byte) => byte > 0x7f)
  )
    return false;
  const text = value.toString("ascii");
  if (text === "+? -?") return true;
  const match = /^\+([0-9]+) -([0-9]+)$/.exec(text);
  if (!match) return false;
  return [match[1], match[2]].every((count) => {
    const numeric = Number(count);
    return Number.isSafeInteger(numeric) && numeric >= 0;
  });
}

interface ParsedRepository {
  response: Extract<GitStatusResponse, { kind: "repository" }>;
  rawById: Map<string, Buffer>;
}

export function parsePorcelainV2(
  output: Buffer,
  workspacePrefix = Buffer.alloc(0),
): ParsedRepository {
  if (output.length === 0 || output[output.length - 1] !== 0) {
    throw new GitInspectionError("Git returned incomplete status data");
  }
  const records = output
    .subarray(0, -1)
    .toString("latin1")
    .split("\0")
    .map((part) => Buffer.from(part, "latin1"));
  let branchOid: string | undefined;
  let branchHead: string | undefined;
  let branchUpstreamSeen = false;
  let branchAbSeen = false;
  const files: GitFileChange[] = [];
  const rawById = new Map<string, Buffer>();
  const seenIds = new Set<string>();
  let total = 0;

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    if (record.subarray(0, 13).toString("ascii") === "# branch.oid ") {
      if (branchOid !== undefined)
        throw new GitInspectionError("Git returned duplicate branch data");
      const value = record.subarray(13);
      if (value.length === 0 || value.some((byte) => byte > 0x7f)) {
        throw new GitInspectionError("Git returned malformed branch data");
      }
      branchOid = value.toString("ascii");
      continue;
    }
    if (record.subarray(0, 14).toString("ascii") === "# branch.head ") {
      if (branchHead !== undefined)
        throw new GitInspectionError("Git returned duplicate branch data");
      const value = record.subarray(14);
      if (!(value.equals(Buffer.from("(detached)")) || validBranchRef(value))) {
        throw new GitInspectionError("Git returned malformed branch data");
      }
      branchHead = controlSafeDisplay(value);
      continue;
    }
    if (record.subarray(0, 18).toString("ascii") === "# branch.upstream ") {
      if (branchUpstreamSeen)
        throw new GitInspectionError("Git returned duplicate branch data");
      branchUpstreamSeen = true;
      if (!validBranchRef(record.subarray(18)))
        throw new GitInspectionError("Git returned malformed branch data");
      continue;
    }
    if (record.subarray(0, 12).toString("ascii") === "# branch.ab ") {
      if (branchAbSeen)
        throw new GitInspectionError("Git returned duplicate branch data");
      branchAbSeen = true;
      if (!validBranchAb(record.subarray(12)))
        throw new GitInspectionError("Git returned malformed branch data");
      continue;
    }
    const type = String.fromCharCode(record[0] ?? 0);
    let change: GitFileChange;
    let rawPath: Buffer;
    if (type === "1") {
      const parsed = splitFixed(record, 8);
      rawPath = parsed.path;
      validateTrackedFields(parsed.fields, "1", [3, 4, 5], [6, 7]);
      const [, xy, sub] = parsed.fields;
      change = {
        path: identity(rawPath, workspacePrefix),
        ...facets(xy!),
        untracked: false,
        ...(submoduleState(sub!) ? { submodule: submoduleState(sub!) } : {}),
      };
    } else if (type === "2") {
      const parsed = splitFixed(record, 9);
      rawPath = parsed.path;
      const original = records[++index];
      if (!original || original.length === 0)
        throw new GitInspectionError(
          "Git returned an incomplete rename record",
        );
      validateTrackedFields(parsed.fields, "2", [3, 4, 5], [6, 7]);
      const [, xy, sub, , , , , , score] = parsed.fields;
      facets(xy!); // Validate the ordinary facet grammar before rename metadata.
      const renameFacets = [...xy!].filter(
        (value) => value === "R" || value === "C",
      );
      const scoreValue = Number(score?.slice(1));
      if (
        renameFacets.length !== 1 ||
        !/^[RC][0-9]{1,3}$/.test(score!) ||
        score![0] !== renameFacets[0] ||
        !Number.isInteger(scoreValue) ||
        scoreValue < 0 ||
        scoreValue > 100
      )
        throw new GitInspectionError("Git returned malformed rename data");
      const originalPath = identity(original, workspacePrefix);
      change = {
        path: identity(rawPath, workspacePrefix),
        ...facets(xy!, originalPath),
        untracked: false,
        ...(submoduleState(sub!) ? { submodule: submoduleState(sub!) } : {}),
      };
    } else if (type === "u") {
      const parsed = splitFixed(record, 10);
      rawPath = parsed.path;
      validateTrackedFields(parsed.fields, "u", [3, 4, 5, 6], [7, 8, 9]);
      const [, xy, sub] = parsed.fields;
      if (!/^(?:DD|AU|UD|UA|DU|AA|UU)$/.test(xy!)) {
        throw new GitInspectionError("Git returned malformed conflict data");
      }
      change = {
        path: identity(rawPath, workspacePrefix),
        conflict: { code: xy! },
        untracked: false,
        ...(submoduleState(sub!) ? { submodule: submoduleState(sub!) } : {}),
      };
    } else if (type === "?") {
      const parsed = splitFixed(record, 1);
      rawPath = parsed.path;
      change = { path: identity(rawPath, workspacePrefix), untracked: true };
    } else {
      throw new GitInspectionError("Git returned an unsupported status record");
    }
    total += 1;
    if (seenIds.has(change.path.id))
      throw new GitInspectionError("Git returned duplicate path identities");
    seenIds.add(change.path.id);
    if (files.length < MAX_GIT_STATUS_FILES) {
      rawById.set(change.path.id, rawPath);
      files.push(change);
    }
  }

  if (branchOid === undefined || branchHead === undefined)
    throw new GitInspectionError("Git omitted branch identity");
  if (branchUpstreamSeen !== branchAbSeen)
    throw new GitInspectionError(
      "Git returned incomplete branch tracking data",
    );
  if (
    branchOid !== "(initial)" &&
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(branchOid)
  ) {
    throw new GitInspectionError("Git returned malformed branch data");
  }
  let head: GitHead;
  if (branchOid === "(initial)") {
    if (branchHead === "(detached)")
      throw new GitInspectionError("Git returned malformed unborn head data");
    head = { kind: "unborn", name: branchHead };
  } else if (branchHead === "(detached)") {
    head = { kind: "detached", oid: branchOid };
  } else {
    head = { kind: "branch", name: branchHead, oid: branchOid };
  }
  const response: ParsedRepository["response"] = {
    kind: "repository",
    head,
    files,
    total,
    truncated: total > files.length,
    groups: {
      conflicted: files
        .filter((file) => file.conflict)
        .map((file) => file.path.id),
      staged: files.filter((file) => file.staged).map((file) => file.path.id),
      unstaged: files
        .filter((file) => file.unstaged)
        .map((file) => file.path.id),
      untracked: files
        .filter((file) => file.untracked)
        .map((file) => file.path.id),
    },
  };
  return { response, rawById };
}

function decodePatchLines(
  output: Buffer,
  outputTruncated: boolean,
): {
  lines: string[];
  encodingLossy: boolean;
  truncated: boolean;
} {
  let usable = output;
  if (outputTruncated) {
    const lastNewline = usable.lastIndexOf(0x0a);
    usable =
      lastNewline < 0 ? Buffer.alloc(0) : usable.subarray(0, lastNewline + 1);
  }
  const encodingLossy = strictUtf8(usable) === undefined;
  const lineBuffers: Buffer[] = [];
  let start = 0;
  while (start < usable.length && lineBuffers.length < MAX_GIT_DIFF_LINES) {
    const newline = usable.indexOf(0x0a, start);
    if (newline < 0) {
      lineBuffers.push(usable.subarray(start));
      start = usable.length;
    } else {
      lineBuffers.push(usable.subarray(start, newline));
      start = newline + 1;
    }
  }
  const cardinalityTruncated = start < usable.length;
  const truncated = outputTruncated || cardinalityTruncated;
  const contentLimit = truncated ? MAX_GIT_DIFF_LINES - 1 : MAX_GIT_DIFF_LINES;
  const lines = lineBuffers
    .slice(0, contentLimit)
    .map((line) => line.toString("utf8"));
  if (truncated) {
    lines.push(
      cardinalityTruncated
        ? `… diff truncated at ${MAX_GIT_DIFF_LINES} projected lines`
        : `… diff truncated at ${GIT_DIFF_OUTPUT_BYTES} bytes`,
    );
  }
  return { lines, encodingLossy, truncated };
}

export function parseUnifiedDiff(
  output: Buffer,
  outputTruncated = false,
): Pick<
  Extract<GitDiffResponse, { kind: "text" }>,
  "lines" | "encodingLossy" | "truncated"
> {
  const decoded = decodePatchLines(output, outputTruncated);
  const lines: GitDiffLine[] = [];
  let oldLine: number | null = null;
  let newLine: number | null = null;
  for (const text of decoded.lines) {
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(text);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[3]);
      lines.push({ kind: "hunk", text, oldLine: null, newLine: null });
    } else if (
      oldLine !== null &&
      newLine !== null &&
      text.startsWith("+") &&
      !text.startsWith("+++")
    ) {
      lines.push({ kind: "add", text, oldLine: null, newLine });
      newLine += 1;
    } else if (
      oldLine !== null &&
      newLine !== null &&
      text.startsWith("-") &&
      !text.startsWith("---")
    ) {
      lines.push({ kind: "delete", text, oldLine, newLine: null });
      oldLine += 1;
    } else if (oldLine !== null && newLine !== null && text.startsWith(" ")) {
      lines.push({ kind: "context", text, oldLine, newLine });
      oldLine += 1;
      newLine += 1;
    } else {
      lines.push({ kind: "meta", text, oldLine: null, newLine: null });
    }
  }
  return {
    lines,
    encodingLossy: decoded.encodingLossy,
    truncated: decoded.truncated,
  };
}

async function hasGitMarker(cwd: string): Promise<boolean> {
  let current = resolve(cwd);
  try {
    if (!(await stat(current)).isDirectory())
      throw new GitInspectionError(
        "The session workspace is not a directory",
        502,
      );
  } catch (error) {
    if (error instanceof GitInspectionError) throw error;
    throw new GitInspectionError(
      "The session workspace cannot be inspected",
      502,
      (error as Error).message,
    );
  }
  while (true) {
    try {
      await stat(resolve(current, ".git"));
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        throw new GitInspectionError(
          "Repository metadata cannot be inspected",
          502,
          (error as Error).message,
        );
      }
    }
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

interface InspectionRepository extends ParsedRepository {
  repoRoot: string;
}

export interface GitInspectionLike {
  status(cwd: string, signal?: AbortSignal): Promise<GitStatusResponse>;
  diff(
    cwd: string,
    pathId: string,
    side: GitDiffSide,
    signal?: AbortSignal,
  ): Promise<GitDiffResponse>;
}

export class GitInspectionService implements GitInspectionLike {
  constructor(private readonly runner: GitRunner = spawnGit) {}

  private async inspect(
    cwd: string,
    signal?: AbortSignal,
  ): Promise<InspectionRepository | null> {
    let inside: GitRunResult;
    try {
      inside = await this.runner(
        [...GIT_CONFIG_ARGS, "-C", cwd, "rev-parse", "--is-inside-work-tree"],
        { stdoutLimit: GIT_STDERR_BYTES, signal },
      );
    } catch (error) {
      // rev-parse uses 128 when cwd is outside a repository. Do not inspect
      // localized stderr. Spawn, timeout, signal, and cap failures remain
      // operational errors through the runner.
      if (
        error instanceof GitInspectionError &&
        error.message === "Git inspection failed" &&
        error.exitCode === 128
      ) {
        if (!(await hasGitMarker(cwd))) return null;
      }
      throw error;
    }
    const stripTerminatingLf = (value: Buffer): Buffer =>
      value.at(-1) === 0x0a ? value.subarray(0, -1) : value;
    if (stripTerminatingLf(inside.stdout).toString("ascii") !== "true") {
      throw new GitInspectionError(
        "Git returned malformed repository identity",
      );
    }
    const [rootResult, prefixResult] = await Promise.all([
      this.runner(
        [...GIT_CONFIG_ARGS, "-C", cwd, "rev-parse", "--show-toplevel"],
        { stdoutLimit: GIT_STDERR_BYTES, signal },
      ),
      this.runner(
        [...GIT_CONFIG_ARGS, "-C", cwd, "rev-parse", "--show-prefix"],
        { stdoutLimit: GIT_STDERR_BYTES, signal },
      ),
    ]);
    const repoRoot = strictUtf8(stripTerminatingLf(rootResult.stdout));
    if (!repoRoot || !isAbsolute(repoRoot))
      throw new GitInspectionError(
        "Git returned malformed repository identity",
      );
    const workspacePrefix = stripTerminatingLf(prefixResult.stdout);
    if (workspacePrefix.length > 0 && workspacePrefix.at(-1) !== 0x2f) {
      throw new GitInspectionError("Git returned malformed workspace prefix");
    }
    const status = await this.runner(
      [
        ...GIT_CONFIG_ARGS,
        "-C",
        repoRoot,
        "status",
        "--porcelain=v2",
        "--branch",
        "-z",
        "--untracked-files=all",
        "--ignore-submodules=none",
        "--no-ahead-behind",
      ],
      { stdoutLimit: GIT_STATUS_OUTPUT_BYTES, signal },
    );
    return {
      ...parsePorcelainV2(status.stdout, Buffer.from(workspacePrefix)),
      repoRoot,
    };
  }

  async status(cwd: string, signal?: AbortSignal): Promise<GitStatusResponse> {
    const inspected = await this.inspect(cwd, signal);
    return inspected?.response ?? { kind: "not-repository" };
  }

  async diff(
    cwd: string,
    pathId: string,
    side: GitDiffSide,
    signal?: AbortSignal,
  ): Promise<GitDiffResponse> {
    if (
      pathId.length === 0 ||
      pathId.length > MAX_PATH_ID_LENGTH ||
      !/^[A-Za-z0-9_-]+$/.test(pathId)
    ) {
      throw Object.assign(new Error("Invalid Git path identity"), {
        status: 400,
      });
    }
    const inspected = await this.inspect(cwd, signal);
    if (!inspected)
      throw Object.assign(
        new Error("That session is not in a Git repository"),
        { status: 409 },
      );
    const change = inspected.response.files.find(
      (file) => file.path.id === pathId,
    );
    const authorized =
      change?.conflict ??
      (side === "staged"
        ? change?.staged
        : (change?.unstaged ??
          (change?.untracked ? { kind: "added" } : undefined)));
    if (!change || !authorized)
      throw Object.assign(
        new Error("That path and diff side are not present in fresh status"),
        { status: 409 },
      );
    const base = { path: change.path, side } as const;
    if (change.conflict)
      return { ...base, kind: "conflict", code: change.conflict.code };
    if (change.submodule)
      return { ...base, kind: "submodule", state: change.submodule };
    if (change.untracked)
      return { ...base, kind: "unsupported", reason: "untracked-content" };
    if (!change.path.utf8Path)
      return { ...base, kind: "unsupported", reason: "path-encoding" };

    const common = [
      ...GIT_CONFIG_ARGS,
      "-C",
      inspected.repoRoot,
      "diff",
      "--no-ext-diff",
      "--no-textconv",
    ];
    const cached = side === "staged" ? ["--cached"] : [];
    const numstat = await this.runner(
      [...common, "--numstat", "-z", ...cached, "--", change.path.utf8Path],
      { stdoutLimit: GIT_DIFF_OUTPUT_BYTES, signal },
    );
    if (numstat.stdout.subarray(0, 4).toString("ascii") === "-\t-\t")
      return { ...base, kind: "binary" };
    const patch = await this.runner(
      [...common, "--unified=3", ...cached, "--", change.path.utf8Path],
      {
        stdoutLimit: GIT_DIFF_OUTPUT_BYTES,
        allowStdoutTruncation: true,
        signal,
      },
    );
    if (patch.stdout.length === 0)
      return { ...base, kind: "empty", reason: "no-changes" };
    return {
      ...base,
      kind: "text",
      ...parseUnifiedDiff(patch.stdout, patch.truncated),
    };
  }
}
