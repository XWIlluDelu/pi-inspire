import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, isAbsolute, resolve } from "node:path";
import type { SerializeAddon } from "@xterm/addon-serialize";
import type { Terminal as HeadlessTerminal } from "@xterm/headless";
import {
  encodeTerminalServerDataFrame,
  INSPIRE_SHELL_OSC,
  MAX_TERMINAL_COLS,
  MAX_TERMINAL_COMMAND_CHARS,
  MAX_TERMINAL_CWD_CHARS,
  MAX_TERMINAL_HISTORY_DAYS,
  MAX_TERMINAL_PROFILE_ID_CHARS,
  MAX_TERMINAL_ROWS,
  MAX_TERMINAL_SOCKET_MESSAGE_BYTES,
  MAX_TERMINAL_TITLE_CHARS,
  MAX_TERMINALS_PER_PROJECT,
  MAX_TERMINALS_TOTAL,
  MIN_TERMINAL_COLS,
  MIN_TERMINAL_HISTORY_DAYS,
  MIN_TERMINAL_ROWS,
  type TerminalCatalogResponse,
  type TerminalCreateRequest,
  type TerminalDescriptor,
  type TerminalRemoveResponse,
  type TerminalRenameRequest,
  type TerminalServerControlMessage,
  type TerminalServiceSettings,
  type TerminalServiceSettingsPatch,
} from "../shared/terminal-contracts.js";
import {
  discoverTerminalProfiles,
  publicTerminalProfiles,
  type ResolvedTerminalProfile,
} from "./terminal-profiles.js";
import { TerminalRingBuffer } from "./terminal-ring-buffer.js";
import {
  type TerminalAttachment,
  type TerminalAttachmentSink,
  type TerminalAttachOptions,
  type TerminalService,
  TerminalServiceError,
} from "./terminal-service.js";
import { signalProcessTree } from "./process-tree.mjs";
import { integratedTerminalLaunch } from "./terminal-shell-integration.js";

const require = createRequire(import.meta.url);
const { Terminal: HeadlessTerminalConstructor } =
  require("@xterm/headless") as typeof import("@xterm/headless");
const { SerializeAddon: SerializeAddonConstructor } =
  require("@xterm/addon-serialize") as typeof import("@xterm/addon-serialize");
const nodePty =
  require("@lydell/node-pty") as typeof import("@lydell/node-pty");

const DEFAULT_COLS = 100;
const DEFAULT_ROWS = 30;
const DEFAULT_RING_BYTES = 8 * 1024 * 1024;
const DEFAULT_SCROLLBACK_ROWS = 20_000;
const DEFAULT_OWNER_RECONNECT_GRACE_MS = 30_000;
const TERMINATE_GRACE_MS = 2_000;
// ConPTY may drain output for a second before emitting onExit. Allow room for
// that drain and scheduling latency; a kill request alone is not confirmation.
const PTY_EXIT_TIMEOUT_MS = 5_000;
const TERMINAL_DATA_PAYLOAD_BYTES = MAX_TERMINAL_SOCKET_MESSAGE_BYTES - 13;
const MAX_SERIALIZED_SNAPSHOT_BYTES = 3 * 1024 * 1024;
const EMULATOR_PAUSE_BYTES = 4 * 1024 * 1024;
const EMULATOR_RESUME_BYTES = 1024 * 1024;

interface Disposable {
  dispose(): void;
}

export interface TerminalPty {
  readonly pid: number;
  readonly process: string;
  onData(listener: (data: string | Buffer) => void): Disposable;
  onExit(
    listener: (event: { exitCode: number; signal?: number }) => void,
  ): Disposable;
  resize(cols: number, rows: number): void;
  write(data: string | Buffer): void;
  pause?(): void;
  resume?(): void;
  kill(signal?: string): void;
  killTree?(signal?: string): void | Promise<void>;
}

export interface TerminalPtySpawnOptions {
  cols: number;
  rows: number;
  cwd: string;
  env: Record<string, string>;
}

export type TerminalPtyFactory = (
  shell: string,
  args: string[],
  options: TerminalPtySpawnOptions,
) => TerminalPty;

interface OwnerLease {
  token: string;
  clientId: string;
  attachmentId: string | null;
  lastInputSequence: number;
  releaseTimer: NodeJS.Timeout | null;
}

interface ManagedAttachment {
  id: string;
  terminalId: string;
  clientId: string;
  sink: TerminalAttachmentSink;
  ready: boolean;
  writable: boolean;
  detached: boolean;
}

interface ManagedTerminal {
  id: string;
  projectCwd: string;
  profile: ResolvedTerminalProfile;
  titleSource: "automatic" | "user";
  customTitle: string;
  automaticTitle: string;
  currentCwd: string;
  currentCommand: string;
  activeCommand: string;
  commandStartedAt: number | null;
  status: "running" | "exited";
  exitCode: number | null;
  signal: number | null;
  cols: number;
  rows: number;
  resizeRevision: number;
  outputEpoch: string;
  createdAt: string;
  updatedAt: string;
  ring: TerminalRingBuffer;
  emulator: HeadlessTerminal;
  serializer: SerializeAddon;
  emulatorTail: Promise<void>;
  emulatorPendingBytes: number;
  ptyPausedForEmulator: boolean;
  pty: TerminalPty | null;
  ptyDisposables: Disposable[];
  emulatorDisposables: Disposable[];
  attachments: Map<string, ManagedAttachment>;
  owner: OwnerLease | null;
  exitPromise: Promise<void>;
  resolveExit: () => void;
}

export interface TerminalPersistedSession {
  id: string;
  projectCwd: string;
  profileId: string;
  titleSource: "automatic" | "user";
  customTitle: string;
  currentCwd: string;
  cols: number;
  rows: number;
  createdAt: string;
  updatedAt: string;
}

export interface TerminalPersistedState {
  version: 1;
  settings: TerminalServiceSettings;
  terminals: TerminalPersistedSession[];
  orderByProject: Array<{ projectCwd: string; terminalIds: string[] }>;
}

export interface TerminalHistoryBackend {
  read(terminalId: string): Promise<Buffer | null>;
  append(terminalId: string, data: Uint8Array): void;
  remove(terminalId: string): Promise<void>;
  clear(): Promise<void>;
  prune(retentionDays: number): Promise<void>;
  flush(): Promise<void>;
}

interface TerminalSessionManagerOptions {
  profiles?: ResolvedTerminalProfile[];
  ptyFactory?: TerminalPtyFactory;
  env?: NodeJS.ProcessEnv;
  ringBytes?: number;
  scrollbackRows?: number;
  ownerReconnectGraceMs?: number;
  catalogEpoch?: string;
  now?: () => Date;
  uuid?: () => string;
  onChange?: () => void;
  history?: TerminalHistoryBackend;
  settings?: Partial<TerminalServiceSettings>;
  shellIntegrationDirectory?: string;
}

function posixDescendantPids(rootPid: number): number[] {
  const output = execFileSync("ps", ["-A", "-o", "pid=,ppid="], {
    encoding: "utf8",
    timeout: 1_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const children = new Map<number, number[]>();
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/u.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const parentPid = Number(match[2]);
    children.set(parentPid, [...(children.get(parentPid) ?? []), pid]);
  }
  const descendants: number[] = [];
  const visited = new Set([rootPid]);
  const visit = (parentPid: number): void => {
    for (const pid of children.get(parentPid) ?? []) {
      if (visited.has(pid)) continue;
      visited.add(pid);
      visit(pid);
      descendants.push(pid);
    }
  };
  visit(rootPid);
  return descendants;
}

function killPosixProcessTree(
  rootPid: number,
  signal: string,
  knownDescendants: number[] = [],
): { groupSignaled: boolean; descendants: number[] } {
  let currentDescendants: number[] = [];
  try {
    currentDescendants = posixDescendantPids(rootPid);
  } catch {
    // A previous tree walk still lets shutdown reach children whose parent
    // exited after the first signal.
  }
  const descendants = [
    ...new Set([...knownDescendants, ...currentDescendants]),
  ];
  for (const pid of descendants) {
    try {
      process.kill(pid, signal as NodeJS.Signals);
    } catch {
      // A descendant may exit while the process table is being traversed.
    }
  }
  let groupSignaled = false;
  try {
    process.kill(-rootPid, signal as NodeJS.Signals);
    groupSignaled = true;
  } catch {
    // The PTY leader may already be gone while a captured child remains.
  }
  return { groupSignaled, descendants };
}

function defaultPtyFactory(
  shell: string,
  args: string[],
  options: TerminalPtySpawnOptions,
): TerminalPty {
  const pty = nodePty.spawn(shell, args, {
    ...options,
    encoding: null,
    name: "xterm-256color",
  });
  let knownDescendants: number[] = [];
  return {
    get pid() {
      return pty.pid;
    },
    get process() {
      return pty.process;
    },
    onData: (listener) => pty.onData(listener),
    onExit: (listener) => pty.onExit(listener),
    resize: (cols, rows) => pty.resize(cols, rows),
    // The runtime accepts raw bytes when `encoding` is null, although its
    // declaration exposes only the common string overload.
    write: (data) =>
      (pty.write as unknown as (value: string | Buffer) => void)(data),
    pause: () => pty.pause(),
    resume: () => pty.resume(),
    kill: (signal) =>
      pty.kill(process.platform === "win32" ? undefined : signal),
    killTree: (signal) => {
      if (process.platform === "win32")
        return signalProcessTree(
          {
            pid: pty.pid,
            exitCode: null,
            signalCode: null,
            kill: () => {
              // node-pty rejects POSIX signal arguments on Windows, including
              // in the direct-PTY fallback when taskkill fails or times out.
              pty.kill();
              return true;
            },
          },
          (signal ?? "SIGHUP") as NodeJS.Signals,
          { environment: options.env, platform: "win32", timeoutMs: 1_000 },
        );
      const result = killPosixProcessTree(
        pty.pid,
        signal ?? "SIGHUP",
        knownDescendants,
      );
      knownDescendants = signal === "SIGKILL" ? [] : result.descendants;
      if (!result.groupSignaled) pty.kill(signal);
    },
  };
}

function terminalError(code: string, status: number, message: string): never {
  throw new TerminalServiceError(code, status, message);
}

function validateDimensions(cols: number, rows: number): void {
  if (
    !Number.isInteger(cols) ||
    cols < MIN_TERMINAL_COLS ||
    cols > MAX_TERMINAL_COLS ||
    !Number.isInteger(rows) ||
    rows < MIN_TERMINAL_ROWS ||
    rows > MAX_TERMINAL_ROWS
  )
    terminalError("invalid_dimensions", 400, "Terminal dimensions are invalid");
}

function cleanTerminalText(value: string, maxChars: number): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, maxChars);
}

function cleanTerminalCommand(value: string): string {
  if (
    value.length < 1 ||
    value.length > MAX_TERMINAL_COMMAND_CHARS ||
    /[\u0000\u0007\u001b]/u.test(value) ||
    !/\S/u.test(value)
  )
    return "";
  return value;
}

function decodedShellMarkerPayload(phase: string, payload: string): string {
  if (!phase.endsWith("1")) return payload;
  try {
    return decodeURIComponent(payload);
  } catch {
    return "";
  }
}

function cleanTerminalPath(value: string): string {
  if (
    value.length < 1 ||
    value.length > MAX_TERMINAL_CWD_CHARS ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    return "";
  return value;
}

function environmentForPty(
  source: NodeJS.ProcessEnv,
  id: string,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === "string") env[key] = value;
  }
  env.TERM = "xterm-256color";
  env.COLORTERM = "truecolor";
  env.TERM_PROGRAM = "Inspire";
  env.TERM_PROGRAM_VERSION = process.env.npm_package_version ?? "0";
  env.INSPIRE_TERMINAL_ID = id;
  return env;
}

function asOutputBytes(data: string | Buffer): Buffer {
  return Buffer.isBuffer(data) ? Buffer.from(data) : Buffer.from(data, "utf8");
}

function normalizeCwd(value: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > MAX_TERMINAL_CWD_CHARS ||
    cleanTerminalPath(value) !== value ||
    !isAbsolute(value)
  )
    terminalError("invalid_cwd", 400, "Terminal working directory is invalid");
  return resolve(value);
}

class SessionAttachment implements TerminalAttachment {
  constructor(
    private readonly manager: TerminalSessionManager,
    readonly terminalId: string,
    readonly id: string,
  ) {}

  writeInput(sequence: number, data: Uint8Array): void {
    this.manager.writeInput(this.terminalId, this.id, sequence, data);
  }

  control(message: Parameters<TerminalAttachment["control"]>[0]): void {
    this.manager.controlAttachment(this.terminalId, this.id, message);
  }

  detach(): void {
    this.manager.detachAttachment(this.terminalId, this.id);
  }
}

export class TerminalSessionManager implements TerminalService {
  private readonly sessions = new Map<string, ManagedTerminal>();
  private readonly lifecycleMutations = new Set<string>();
  private readonly orderByProject = new Map<string, string[]>();
  private readonly profiles: ResolvedTerminalProfile[];
  private readonly ptyFactory: TerminalPtyFactory;
  private readonly env: NodeJS.ProcessEnv;
  private readonly ringBytes: number;
  private readonly scrollbackRows: number;
  private readonly ownerReconnectGraceMs: number;
  private readonly catalogEpoch: string;
  private readonly now: () => Date;
  private readonly uuid: () => string;
  private readonly onChange: () => void;
  private readonly history: TerminalHistoryBackend | null;
  private readonly shellIntegrationDirectory: string | null;
  private settings: TerminalServiceSettings;
  private revision = 0;
  private closing = false;
  private closePromise: Promise<void> | null = null;

  constructor(options: TerminalSessionManagerOptions = {}) {
    this.env = options.env ?? process.env;
    this.profiles = [
      ...(options.profiles ?? discoverTerminalProfiles(this.env)),
    ];
    this.ptyFactory = options.ptyFactory ?? defaultPtyFactory;
    this.ringBytes = options.ringBytes ?? DEFAULT_RING_BYTES;
    this.scrollbackRows = options.scrollbackRows ?? DEFAULT_SCROLLBACK_ROWS;
    this.ownerReconnectGraceMs =
      options.ownerReconnectGraceMs ?? DEFAULT_OWNER_RECONNECT_GRACE_MS;
    this.catalogEpoch = options.catalogEpoch ?? randomUUID();
    this.now = options.now ?? (() => new Date());
    this.uuid = options.uuid ?? randomUUID;
    this.onChange = options.onChange ?? (() => {});
    this.history = options.history ?? null;
    this.shellIntegrationDirectory = options.shellIntegrationDirectory ?? null;
    this.settings = {
      persistOutput: options.settings?.persistOutput ?? false,
      historyRetentionDays: options.settings?.historyRetentionDays ?? 30,
    };
  }

  list(cwd?: string): TerminalCatalogResponse {
    const projectCwd = cwd === undefined ? undefined : normalizeCwd(cwd);
    const sessions = [...this.sessions.values()].filter(
      (session) =>
        projectCwd === undefined || session.projectCwd === projectCwd,
    );
    const order = projectCwd ? (this.orderByProject.get(projectCwd) ?? []) : [];
    sessions.sort((left, right) => {
      if (projectCwd) return order.indexOf(left.id) - order.indexOf(right.id);
      const cwdOrder = left.projectCwd.localeCompare(right.projectCwd);
      if (cwdOrder !== 0) return cwdOrder;
      const projectOrder = this.orderByProject.get(left.projectCwd) ?? [];
      return projectOrder.indexOf(left.id) - projectOrder.indexOf(right.id);
    });
    return {
      catalogEpoch: this.catalogEpoch,
      revision: this.revision,
      terminals: sessions.map((session) => this.describe(session)),
      profiles: publicTerminalProfiles(this.profiles),
    };
  }

  exportState(): TerminalPersistedState {
    return {
      version: 1,
      settings: { ...this.settings },
      terminals: [...this.sessions.values()].map((session) => ({
        id: session.id,
        projectCwd: session.projectCwd,
        profileId: session.profile.id,
        titleSource: session.titleSource,
        customTitle: session.customTitle,
        currentCwd: session.currentCwd,
        cols: session.cols,
        rows: session.rows,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      })),
      orderByProject: [...this.orderByProject].map(
        ([projectCwd, terminalIds]) => ({
          projectCwd,
          terminalIds: [...terminalIds],
        }),
      ),
    };
  }

  async restoreState(value: unknown): Promise<void> {
    if (this.sessions.size > 0 || this.closing) return;
    if (value === null || typeof value !== "object") return;
    const state = value as Partial<TerminalPersistedState>;
    if (state.version !== 1 || !Array.isArray(state.terminals)) return;
    const storedSettings = state.settings as
      | Partial<TerminalServiceSettings>
      | undefined;
    this.settings = {
      persistOutput: storedSettings?.persistOutput === true,
      historyRetentionDays:
        typeof storedSettings?.historyRetentionDays === "number" &&
        Number.isInteger(storedSettings.historyRetentionDays) &&
        storedSettings.historyRetentionDays >= MIN_TERMINAL_HISTORY_DAYS &&
        storedSettings.historyRetentionDays <= MAX_TERMINAL_HISTORY_DAYS
          ? storedSettings.historyRetentionDays
          : 30,
    };
    if (this.settings.persistOutput)
      await this.history?.prune(this.settings.historyRetentionDays);
    for (const candidate of state.terminals.slice(0, MAX_TERMINALS_TOTAL)) {
      if (
        candidate === null ||
        typeof candidate !== "object" ||
        typeof candidate.id !== "string" ||
        !/^[A-Za-z0-9_-]{1,80}$/u.test(candidate.id) ||
        this.sessions.has(candidate.id) ||
        typeof candidate.projectCwd !== "string" ||
        typeof candidate.profileId !== "string" ||
        typeof candidate.cols !== "number" ||
        typeof candidate.rows !== "number"
      )
        continue;
      try {
        const projectCwd = normalizeCwd(candidate.projectCwd);
        const cwdInfo = await stat(projectCwd).catch(() => null);
        if (!cwdInfo?.isDirectory()) continue;
        const projectCount = [...this.sessions.values()].filter(
          (session) => session.projectCwd === projectCwd,
        ).length;
        if (projectCount >= MAX_TERMINALS_PER_PROJECT) continue;
        validateDimensions(candidate.cols, candidate.rows);
        const profile = this.profileForRestore(candidate.profileId);
        const createdAt =
          typeof candidate.createdAt === "string" &&
          Number.isFinite(Date.parse(candidate.createdAt))
            ? candidate.createdAt
            : this.now().toISOString();
        const updatedAt =
          typeof candidate.updatedAt === "string" &&
          Number.isFinite(Date.parse(candidate.updatedAt))
            ? candidate.updatedAt
            : createdAt;
        const titleSource =
          candidate.titleSource === "user" ? "user" : "automatic";
        const customTitle =
          typeof candidate.customTitle === "string"
            ? cleanTerminalText(candidate.customTitle, MAX_TERMINAL_TITLE_CHARS)
            : "";
        const persistedOutput = this.settings.persistOutput
          ? await this.history?.read(candidate.id)
          : null;
        const restoredCurrentCwd =
          typeof candidate.currentCwd === "string"
            ? cleanTerminalPath(candidate.currentCwd)
            : "";
        const session = this.restoreSession({
          id: candidate.id,
          projectCwd,
          profile,
          cols: candidate.cols,
          rows: candidate.rows,
          createdAt,
          updatedAt,
          titleSource: customTitle ? titleSource : "automatic",
          customTitle,
          automaticTitle: profile.label,
          currentCwd:
            restoredCurrentCwd && isAbsolute(restoredCurrentCwd)
              ? restoredCurrentCwd
              : projectCwd,
          currentCommand: basename(profile.shell),
          persistedOutput: persistedOutput ?? null,
        });
        this.sessions.set(session.id, session);
      } catch {
        // Ignore stale or invalid records while preserving the remaining tabs.
      }
    }
    const persistedOrder = new Map<string, string[]>();
    if (Array.isArray(state.orderByProject)) {
      for (const entry of state.orderByProject) {
        if (
          entry &&
          typeof entry.projectCwd === "string" &&
          Array.isArray(entry.terminalIds)
        )
          persistedOrder.set(
            resolve(entry.projectCwd),
            entry.terminalIds.filter(
              (id): id is string => typeof id === "string",
            ),
          );
      }
    }
    const projectCwds = new Set(
      [...this.sessions.values()].map((session) => session.projectCwd),
    );
    for (const projectCwd of projectCwds) {
      const validIds = [...this.sessions.values()]
        .filter((session) => session.projectCwd === projectCwd)
        .map((session) => session.id);
      const preferred = [
        ...new Set(persistedOrder.get(projectCwd) ?? []),
      ].filter((id) => validIds.includes(id));
      this.orderByProject.set(projectCwd, [
        ...preferred,
        ...validIds.filter((id) => !preferred.includes(id)),
      ]);
    }
    if (this.sessions.size > 0) this.revision += 1;
  }

  getSettings(): TerminalServiceSettings {
    return { ...this.settings };
  }

  async updateSettings(
    patch: TerminalServiceSettingsPatch,
  ): Promise<TerminalServiceSettings> {
    if (
      patch.persistOutput !== undefined &&
      typeof patch.persistOutput !== "boolean"
    )
      terminalError(
        "invalid_terminal_settings",
        400,
        "persistOutput must be a boolean",
      );
    if (
      patch.historyRetentionDays !== undefined &&
      (!Number.isInteger(patch.historyRetentionDays) ||
        patch.historyRetentionDays < MIN_TERMINAL_HISTORY_DAYS ||
        patch.historyRetentionDays > MAX_TERMINAL_HISTORY_DAYS)
    )
      terminalError(
        "invalid_terminal_settings",
        400,
        `historyRetentionDays must be between ${MIN_TERMINAL_HISTORY_DAYS} and ${MAX_TERMINAL_HISTORY_DAYS}`,
      );
    const wasPersisting = this.settings.persistOutput;
    this.settings = { ...this.settings, ...patch };
    if (wasPersisting && !this.settings.persistOutput)
      await this.history?.clear();
    else if (this.settings.persistOutput)
      await this.history?.prune(this.settings.historyRetentionDays);
    this.revision += 1;
    this.onChange();
    return this.getSettings();
  }

  async clearHistory(): Promise<void> {
    await this.history?.clear();
  }

  async create(request: TerminalCreateRequest): Promise<TerminalDescriptor> {
    this.requireOpen();
    const projectCwd = normalizeCwd(request.cwd);
    const cwdStat = await stat(projectCwd).catch(() => null);
    if (!cwdStat?.isDirectory())
      terminalError(
        "invalid_cwd",
        400,
        "Terminal working directory does not exist",
      );
    this.requireOpen();
    const projectSessions = this.orderByProject.get(projectCwd) ?? [];
    if (projectSessions.length >= MAX_TERMINALS_PER_PROJECT)
      terminalError(
        "project_terminal_limit",
        409,
        "This project already has the maximum number of terminals",
      );
    if (this.sessions.size >= MAX_TERMINALS_TOTAL)
      terminalError(
        "terminal_limit",
        409,
        "The terminal service has reached its terminal limit",
      );
    const profile = this.resolveProfile(request.profileId);
    const cols = request.cols ?? DEFAULT_COLS;
    const rows = request.rows ?? DEFAULT_ROWS;
    validateDimensions(cols, rows);
    const id = this.uuid();
    const session = this.spawnSession({
      id,
      projectCwd,
      profile,
      cols,
      rows,
      createdAt: this.now().toISOString(),
      titleSource: "automatic",
      customTitle: "",
    });
    this.sessions.set(id, session);
    this.orderByProject.set(projectCwd, [...projectSessions, id]);
    this.touch(session);
    return this.describe(session);
  }

  async rename(
    id: string,
    request: TerminalRenameRequest,
  ): Promise<TerminalDescriptor> {
    const session = this.requireStableSession(id);
    if (request.title === null || request.title.trim() === "") {
      session.titleSource = "automatic";
      session.customTitle = "";
    } else {
      const title = cleanTerminalText(request.title, MAX_TERMINAL_TITLE_CHARS);
      if (!title)
        terminalError("invalid_title", 400, "Terminal title is invalid");
      session.titleSource = "user";
      session.customTitle = title;
    }
    this.touch(session);
    this.broadcastDescriptor(session);
    return this.describe(session);
  }

  async reorder(
    cwd: string,
    terminalIds: string[],
  ): Promise<TerminalCatalogResponse> {
    const projectCwd = normalizeCwd(cwd);
    const current = this.orderByProject.get(projectCwd) ?? [];
    if (
      terminalIds.length !== current.length ||
      new Set(terminalIds).size !== terminalIds.length ||
      terminalIds.some((id) => !current.includes(id))
    )
      terminalError(
        "invalid_terminal_order",
        400,
        "Terminal order does not match this project",
      );
    this.orderByProject.set(projectCwd, [...terminalIds]);
    this.revision += 1;
    this.onChange();
    return this.list(projectCwd);
  }

  async restart(id: string): Promise<TerminalDescriptor> {
    const previous = this.beginLifecycleMutation(id);
    try {
      const profile = this.resolveProfile(previous.profile.id);
      const metadata = {
        id: previous.id,
        projectCwd: previous.projectCwd,
        profile,
        cols: previous.cols,
        rows: previous.rows,
        createdAt: previous.createdAt,
        titleSource: previous.titleSource,
        customTitle: previous.customTitle,
      } as const;
      await this.stopPty(previous, false);
      await this.history?.remove(id);
      this.requireOpen();
      const session = this.spawnSession(metadata);
      this.sessions.set(id, session);
      this.closeAttachments(previous, 1012, "Terminal restarted");
      this.disposeRuntime(previous);
      this.touch(session);
      return this.describe(session);
    } finally {
      this.lifecycleMutations.delete(id);
    }
  }

  async remove(id: string, force: boolean): Promise<TerminalRemoveResponse> {
    const session = this.beginLifecycleMutation(id);
    try {
      await this.stopPty(session, force);
      if (this.closing)
        return { catalogEpoch: this.catalogEpoch, revision: this.revision };
      this.sessions.delete(id);
      const order = (this.orderByProject.get(session.projectCwd) ?? []).filter(
        (terminalId) => terminalId !== id,
      );
      if (order.length === 0) this.orderByProject.delete(session.projectCwd);
      else this.orderByProject.set(session.projectCwd, order);
      this.closeAttachments(session, 1000, "Terminal closed");
      this.disposeRuntime(session);
      await this.history?.remove(id);
      this.revision += 1;
      this.onChange();
      return { catalogEpoch: this.catalogEpoch, revision: this.revision };
    } finally {
      this.lifecycleMutations.delete(id);
    }
  }

  async attach(
    options: TerminalAttachOptions,
    sink: TerminalAttachmentSink,
  ): Promise<TerminalAttachment> {
    this.requireOpen();
    const session = this.requireStableSession(options.terminalId);
    validateDimensions(options.cols, options.rows);
    if (!options.clientId || options.clientId.length > 128)
      terminalError(
        "invalid_client",
        400,
        "Terminal client identifier is invalid",
      );
    const attachment: ManagedAttachment = {
      id: this.uuid(),
      terminalId: session.id,
      clientId: options.clientId,
      sink,
      ready: false,
      writable: false,
      detached: false,
    };
    session.attachments.set(attachment.id, attachment);
    const ownershipReason = this.attachOwnership(
      session,
      attachment,
      options.ownerToken,
    );
    if (attachment.writable && session.status === "running")
      this.resizeSession(session, options.cols, options.rows, attachment.id);

    const canReplayDelta =
      options.outputEpoch === session.outputEpoch &&
      options.resizeRevision === session.resizeRevision &&
      typeof options.nextOutputOffset === "number" &&
      session.ring.contains(options.nextOutputOffset);
    const replay = canReplayDelta ? "delta" : "snapshot";
    this.sendControl(attachment, {
      type: "attached",
      terminal: this.describe(session),
      attachmentId: attachment.id,
      writable: attachment.writable,
      ownerToken: attachment.writable ? session.owner?.token : undefined,
      nextInputSequence: attachment.writable
        ? (session.owner?.lastInputSequence ?? 0) + 1
        : 1,
      replay,
    });

    try {
      if (canReplayDelta) {
        this.sendRingFrom(
          session,
          attachment,
          options.nextOutputOffset as number,
        );
      } else {
        await this.sendSnapshot(session, attachment);
      }
      if (attachment.detached)
        terminalError(
          "attachment_closed",
          409,
          "Terminal attachment was closed",
        );
      attachment.ready = true;
      this.sendControl(attachment, {
        type: "replay_complete",
        nextOutputOffset: session.ring.nextOffset,
      });
      if (ownershipReason)
        this.sendControl(attachment, {
          type: "ownership",
          writable: attachment.writable,
          hasOwner: session.owner !== null,
          ownerToken: attachment.writable ? session.owner?.token : undefined,
          nextInputSequence: attachment.writable
            ? (session.owner?.lastInputSequence ?? 0) + 1
            : undefined,
          reason: ownershipReason,
        });
      this.broadcastDescriptor(session, attachment.id);
      return new SessionAttachment(this, session.id, attachment.id);
    } catch (error) {
      this.detachAttachment(session.id, attachment.id);
      throw error;
    }
  }

  writeInput(
    terminalId: string,
    attachmentId: string,
    sequence: number,
    data: Uint8Array,
  ): void {
    const { session, attachment } = this.requireAttachment(
      terminalId,
      attachmentId,
    );
    const owner = session.owner;
    if (
      session.status !== "running" ||
      !attachment.writable ||
      owner?.attachmentId !== attachment.id
    ) {
      this.sendControl(attachment, {
        type: "error",
        code: "terminal_read_only",
        message: "Take control before sending terminal input",
        fatal: false,
      });
      return;
    }
    if (!Number.isInteger(sequence) || sequence < 1 || sequence > 0xffffffff) {
      this.sendControl(attachment, {
        type: "error",
        code: "invalid_input_sequence",
        message: "Terminal input sequence is invalid",
        fatal: true,
      });
      attachment.sink.close(1008, "Invalid input sequence");
      return;
    }
    if (sequence <= owner.lastInputSequence) {
      this.sendControl(attachment, { type: "input_ack", sequence });
      return;
    }
    if (sequence !== owner.lastInputSequence + 1) {
      this.sendControl(attachment, {
        type: "error",
        code: "input_sequence_gap",
        message: "Terminal input sequence has a gap",
        fatal: true,
      });
      attachment.sink.close(1008, "Input sequence gap");
      return;
    }
    session.pty?.write(Buffer.from(data));
    owner.lastInputSequence = sequence;
    this.sendControl(attachment, { type: "input_ack", sequence });
  }

  controlAttachment(
    terminalId: string,
    attachmentId: string,
    message: Parameters<TerminalAttachment["control"]>[0],
  ): void {
    const { session, attachment } = this.requireAttachment(
      terminalId,
      attachmentId,
    );
    if (message.type === "ping") {
      this.sendControl(attachment, { type: "heartbeat" });
      return;
    }
    if (message.type === "take_control") {
      validateDimensions(message.cols, message.rows);
      this.takeControl(session, attachment, message.cols, message.rows);
      return;
    }
    if (message.type === "release_control") {
      this.releaseControl(session, attachment);
      return;
    }
    if (message.type === "resize") {
      validateDimensions(message.cols, message.rows);
      if (attachment.writable && session.owner?.attachmentId === attachment.id)
        this.resizeSession(session, message.cols, message.rows);
    }
  }

  detachAttachment(terminalId: string, attachmentId: string): void {
    const session = this.sessions.get(terminalId);
    const attachment = session?.attachments.get(attachmentId);
    if (!session || !attachment) return;
    attachment.detached = true;
    session.attachments.delete(attachmentId);
    if (session.owner?.attachmentId === attachmentId) {
      session.owner.attachmentId = null;
      session.owner.releaseTimer = setTimeout(() => {
        if (session.owner?.attachmentId !== null) return;
        session.owner = null;
        this.touch(session);
        this.broadcastOwnership(session, "available");
        this.broadcastDescriptor(session);
      }, this.ownerReconnectGraceMs);
      session.owner.releaseTimer.unref?.();
    }
    this.touch(session);
    this.broadcastDescriptor(session);
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    const sessions = [...this.sessions.values()];
    this.closePromise = (async () => {
      await Promise.allSettled(
        sessions.map(async (session) => {
          await this.stopPty(session, true);
          this.closeAttachments(session, 1012, "Terminal service stopped");
          this.disposeRuntime(session);
        }),
      );
      await this.history?.flush();
      this.sessions.clear();
      this.lifecycleMutations.clear();
      this.orderByProject.clear();
    })();
    return this.closePromise;
  }

  private profileForRestore(profileId: string): ResolvedTerminalProfile {
    if (
      profileId.length < 1 ||
      profileId.length > MAX_TERMINAL_PROFILE_ID_CHARS ||
      !/^[A-Za-z0-9_-]+$/u.test(profileId)
    )
      throw new Error("Persisted terminal profile is invalid");
    const known = this.profiles.find((candidate) => candidate.id === profileId);
    if (known) return known;
    const unavailable: ResolvedTerminalProfile = {
      id: profileId,
      label: profileId,
      shell: profileId,
      args: [],
      available: false,
      isDefault: false,
    };
    this.profiles.push(unavailable);
    return unavailable;
  }

  private resolveProfile(
    profileId: string | undefined,
  ): ResolvedTerminalProfile {
    const profile = profileId
      ? this.profiles.find((candidate) => candidate.id === profileId)
      : (this.profiles.find((candidate) => candidate.isDefault) ??
        this.profiles[0]);
    if (!profile?.available)
      terminalError(
        "terminal_profile_unavailable",
        400,
        "The requested terminal profile is unavailable",
      );
    return profile;
  }

  private spawnSession(metadata: {
    id: string;
    projectCwd: string;
    profile: ResolvedTerminalProfile;
    cols: number;
    rows: number;
    createdAt: string;
    titleSource: "automatic" | "user";
    customTitle: string;
  }): ManagedTerminal {
    const emulator = new HeadlessTerminalConstructor({
      allowProposedApi: true,
      cols: metadata.cols,
      rows: metadata.rows,
      scrollback: this.scrollbackRows,
      windowsPty:
        process.platform === "win32" ? { backend: "conpty" } : undefined,
    });
    const serializer = new SerializeAddonConstructor();
    emulator.loadAddon(serializer as never);
    let resolveExit = () => {};
    const exitPromise = new Promise<void>((resolvePromise) => {
      resolveExit = resolvePromise;
    });
    const launch = integratedTerminalLaunch(
      metadata.profile,
      this.shellIntegrationDirectory,
      environmentForPty(this.env, metadata.id),
    );
    const launchArgs =
      process.platform === "win32" &&
      basename(metadata.profile.shell).toLowerCase() === "wsl.exe"
        ? [...launch.args, "--cd", metadata.projectCwd]
        : launch.args;
    const pty = this.ptyFactory(metadata.profile.shell, launchArgs, {
      cols: metadata.cols,
      rows: metadata.rows,
      cwd: metadata.projectCwd,
      env: environmentForPty(launch.env, metadata.id),
    });
    const now = this.now().toISOString();
    const session: ManagedTerminal = {
      ...metadata,
      automaticTitle: metadata.profile.label,
      currentCwd: metadata.projectCwd,
      currentCommand: basename(metadata.profile.shell),
      activeCommand: "",
      commandStartedAt: null,
      status: "running",
      exitCode: null,
      signal: null,
      resizeRevision: 0,
      outputEpoch: this.uuid(),
      updatedAt: now,
      ring: new TerminalRingBuffer(this.ringBytes),
      emulator,
      serializer,
      emulatorTail: Promise.resolve(),
      emulatorPendingBytes: 0,
      ptyPausedForEmulator: false,
      pty,
      ptyDisposables: [],
      emulatorDisposables: [],
      attachments: new Map(),
      owner: null,
      exitPromise,
      resolveExit,
    };
    session.emulatorDisposables.push(
      emulator.onTitleChange((title) => this.handleTitle(session, title)),
      emulator.parser.registerOscHandler(7, (value) => {
        this.handleWorkingDirectory(session, value);
        return false;
      }),
      emulator.parser.registerOscHandler(INSPIRE_SHELL_OSC, (value) => {
        this.handleShellMarker(session, value);
        return true;
      }),
    );
    session.ptyDisposables.push(
      pty.onData((data) => this.handleOutput(session, asOutputBytes(data))),
      pty.onExit((event) => this.handleExit(session, event)),
    );
    return session;
  }

  private restoreSession(metadata: {
    id: string;
    projectCwd: string;
    profile: ResolvedTerminalProfile;
    cols: number;
    rows: number;
    createdAt: string;
    updatedAt: string;
    titleSource: "automatic" | "user";
    customTitle: string;
    automaticTitle: string;
    currentCwd: string;
    currentCommand: string;
    persistedOutput: Buffer | null;
  }): ManagedTerminal {
    const emulator = new HeadlessTerminalConstructor({
      allowProposedApi: true,
      cols: metadata.cols,
      rows: metadata.rows,
      scrollback: this.scrollbackRows,
      windowsPty:
        process.platform === "win32" ? { backend: "conpty" } : undefined,
    });
    const serializer = new SerializeAddonConstructor();
    emulator.loadAddon(serializer as never);
    const { persistedOutput, ...restoredMetadata } = metadata;
    const session: ManagedTerminal = {
      ...restoredMetadata,
      activeCommand: "",
      commandStartedAt: null,
      status: "exited",
      exitCode: null,
      signal: null,
      resizeRevision: 0,
      outputEpoch: this.uuid(),
      ring: new TerminalRingBuffer(this.ringBytes),
      emulator,
      serializer,
      emulatorTail: Promise.resolve(),
      emulatorPendingBytes: 0,
      ptyPausedForEmulator: false,
      pty: null,
      ptyDisposables: [],
      emulatorDisposables: [],
      attachments: new Map(),
      owner: null,
      exitPromise: Promise.resolve(),
      resolveExit: () => {},
    };
    session.emulatorDisposables.push(
      emulator.onTitleChange((title) => this.handleTitle(session, title)),
      emulator.parser.registerOscHandler(7, (value) => {
        this.handleWorkingDirectory(session, value);
        return false;
      }),
      emulator.parser.registerOscHandler(INSPIRE_SHELL_OSC, (value) => {
        this.handleShellMarker(session, value);
        return true;
      }),
    );
    if (persistedOutput?.byteLength) {
      session.ring.append(persistedOutput);
      this.queueEmulatorWrite(session, persistedOutput);
    }
    const notice = Buffer.from(
      "\r\n\u001b[2m[Terminal process ended when the system restarted]\u001b[0m\r\n",
      "utf8",
    );
    session.ring.append(notice);
    this.queueEmulatorWrite(session, notice);
    return session;
  }

  private handleOutput(session: ManagedTerminal, data: Buffer): void {
    if (data.byteLength === 0) return;
    if (this.settings.persistOutput) this.history?.append(session.id, data);
    const offset = session.ring.append(data);
    // Output offsets are part of the catalog projection. Advance its cheap
    // in-memory revision without scheduling a metadata write for every PTY
    // chunk, so polling cannot overwrite a newer socket descriptor with an
    // equal-revision response.
    this.revision += 1;
    this.queueEmulatorWrite(session, data);
    for (const attachment of session.attachments.values()) {
      if (!attachment.ready || attachment.detached) continue;
      this.sendDataChunks(
        attachment,
        "output",
        session.resizeRevision,
        offset,
        data,
      );
    }
  }

  private handleExit(
    session: ManagedTerminal,
    event: { exitCode: number; signal?: number },
  ): void {
    if (session.status === "exited") return;
    session.status = "exited";
    session.activeCommand = "";
    session.commandStartedAt = null;
    session.exitCode = event.exitCode;
    session.signal = event.signal || null;
    session.owner = null;
    session.resolveExit();
    this.touch(session);
    const descriptor = this.describe(session);
    this.broadcastControl(session, {
      type: "exit",
      exitCode: event.exitCode,
      signal: event.signal || null,
      terminal: descriptor,
    });
  }

  private handleTitle(session: ManagedTerminal, title: string): void {
    const cleaned = cleanTerminalText(title, MAX_TERMINAL_TITLE_CHARS);
    if (!cleaned || cleaned === session.currentCommand) return;
    session.currentCommand = cleaned;
    session.automaticTitle = cleaned;
    this.touch(session);
    this.broadcastDescriptor(session);
  }

  private handleShellMarker(session: ManagedTerminal, value: string): void {
    const separator = value.indexOf(";");
    const phase = separator < 0 ? value : value.slice(0, separator);
    const payload = decodedShellMarkerPayload(
      phase,
      separator < 0 ? "" : value.slice(separator + 1),
    );
    if (phase === "P" || phase === "P1") {
      const cwd = cleanTerminalPath(payload);
      if (!cwd || !isAbsolute(cwd) || cwd === session.currentCwd) return;
      session.currentCwd = cwd;
      this.touch(session);
      this.broadcastDescriptor(session);
      return;
    }
    if (phase === "C" || phase === "C1") {
      const command = cleanTerminalCommand(payload);
      if (!command) return;
      const commandTitle = cleanTerminalText(command, MAX_TERMINAL_TITLE_CHARS);
      session.activeCommand = command;
      session.commandStartedAt = this.now().getTime();
      session.currentCommand = commandTitle;
      session.automaticTitle = commandTitle;
      this.touch(session);
      this.broadcastDescriptor(session);
      return;
    }
    if (phase !== "D" || !session.activeCommand) return;
    const parsedExitCode = Number(payload);
    const exitCode = Number.isInteger(parsedExitCode) ? parsedExitCode : null;
    const completedAt = this.now().getTime();
    const durationMs =
      session.commandStartedAt === null
        ? null
        : Math.max(0, completedAt - session.commandStartedAt);
    const command = session.activeCommand;
    session.activeCommand = "";
    session.commandStartedAt = null;
    session.currentCommand = basename(session.profile.shell);
    session.automaticTitle = session.profile.label;
    this.touch(session);
    this.broadcastControl(session, {
      type: "command_complete",
      command,
      currentCwd: session.currentCwd,
      exitCode,
      durationMs,
    });
    this.broadcastDescriptor(session);
  }

  private handleWorkingDirectory(
    session: ManagedTerminal,
    value: string,
  ): void {
    try {
      const url = new URL(value);
      if (url.protocol !== "file:") return;
      const decoded = decodeURIComponent(url.pathname);
      const cwd = cleanTerminalPath(
        process.platform === "win32" ? decoded.replace(/^\//u, "") : decoded,
      );
      if (!cwd || !isAbsolute(cwd) || cwd === session.currentCwd) return;
      session.currentCwd = cwd;
      this.touch(session);
      this.broadcastDescriptor(session);
    } catch {
      // Shell integration metadata is advisory; malformed OSC 7 is ignored.
    }
  }

  private queueEmulatorWrite(session: ManagedTerminal, data: Uint8Array): void {
    const bytes = data.byteLength;
    session.emulatorPendingBytes += bytes;
    if (
      session.emulatorPendingBytes > EMULATOR_PAUSE_BYTES &&
      !session.ptyPausedForEmulator &&
      session.pty?.pause
    ) {
      try {
        session.pty.pause();
        session.ptyPausedForEmulator = true;
      } catch {
        // A concurrently exiting PTY needs no further flow control.
      }
    }
    const settle = (): void => {
      session.emulatorPendingBytes = Math.max(
        0,
        session.emulatorPendingBytes - bytes,
      );
      if (
        session.ptyPausedForEmulator &&
        session.emulatorPendingBytes <= EMULATOR_RESUME_BYTES
      ) {
        try {
          session.pty?.resume?.();
        } catch {
          // A concurrently exiting PTY needs no further flow control.
        }
        session.ptyPausedForEmulator = false;
      }
    };
    session.emulatorTail = session.emulatorTail
      .then(
        () =>
          new Promise<void>((resolvePromise) => {
            session.emulator.write(data, resolvePromise);
          }),
      )
      .then(settle, settle);
  }

  private async snapshot(session: ManagedTerminal): Promise<{
    data: Uint8Array;
    offset: number;
    resizeRevision: number;
  }> {
    const offset = session.ring.nextOffset;
    const resizeRevision = session.resizeRevision;
    let serialized = "";
    const task = session.emulatorTail.then(() => {
      let scrollback = this.scrollbackRows;
      do {
        serialized = session.serializer.serialize({ scrollback });
        if (Buffer.byteLength(serialized) <= MAX_SERIALIZED_SNAPSHOT_BYTES)
          break;
        scrollback = Math.floor(scrollback / 2);
      } while (scrollback > 0);
    });
    session.emulatorTail = task.catch(() => {});
    await task;
    return {
      data: Buffer.from(serialized, "utf8"),
      offset,
      resizeRevision,
    };
  }

  private async sendSnapshot(
    session: ManagedTerminal,
    attachment: ManagedAttachment,
  ): Promise<void> {
    while (!attachment.detached) {
      const snapshot = await this.snapshot(session);
      if (attachment.detached) return;
      if (
        snapshot.resizeRevision !== session.resizeRevision ||
        !session.ring.contains(snapshot.offset)
      )
        continue;
      this.sendDataChunks(
        attachment,
        "snapshot",
        snapshot.resizeRevision,
        snapshot.offset,
        snapshot.data,
        false,
      );
      this.sendRingFrom(session, attachment, snapshot.offset);
      return;
    }
  }

  private sendRingFrom(
    session: ManagedTerminal,
    attachment: ManagedAttachment,
    offset: number,
  ): void {
    const slices = session.ring.slicesFrom(offset);
    if (!slices)
      terminalError(
        "terminal_replay_evicted",
        409,
        "Terminal output was evicted during replay",
      );
    for (const slice of slices)
      this.sendDataChunks(
        attachment,
        "output",
        session.resizeRevision,
        slice.offset,
        slice.data,
      );
  }

  private sendDataChunks(
    attachment: ManagedAttachment,
    kind: "output" | "snapshot",
    resizeRevision: number,
    offset: number,
    data: Uint8Array,
    advanceOffset = true,
  ): void {
    if (data.byteLength === 0) {
      this.sendData(
        attachment,
        encodeTerminalServerDataFrame(kind, resizeRevision, offset, data),
      );
      return;
    }
    for (
      let index = 0;
      index < data.byteLength;
      index += TERMINAL_DATA_PAYLOAD_BYTES
    ) {
      const chunk = data.subarray(
        index,
        Math.min(index + TERMINAL_DATA_PAYLOAD_BYTES, data.byteLength),
      );
      this.sendData(
        attachment,
        encodeTerminalServerDataFrame(
          kind === "snapshot" && index > 0 ? "snapshot-continuation" : kind,
          resizeRevision,
          advanceOffset ? offset + index : offset,
          chunk,
        ),
      );
    }
  }

  private attachOwnership(
    session: ManagedTerminal,
    attachment: ManagedAttachment,
    ownerToken: string | undefined,
  ): "claimed" | "reconnected" | null {
    if (session.status !== "running") return null;
    if (
      session.owner &&
      ownerToken &&
      ownerToken === session.owner.token &&
      attachment.clientId === session.owner.clientId
    ) {
      if (session.owner.releaseTimer) clearTimeout(session.owner.releaseTimer);
      if (session.owner.attachmentId) {
        const previous = session.attachments.get(session.owner.attachmentId);
        if (previous) {
          previous.writable = false;
          this.sendControl(previous, {
            type: "ownership",
            writable: false,
            hasOwner: true,
            reason: "reconnected",
          });
        }
      }
      session.owner.attachmentId = attachment.id;
      session.owner.releaseTimer = null;
      attachment.writable = true;
      return "reconnected";
    }
    if (!session.owner) {
      session.owner = {
        token: this.uuid(),
        clientId: attachment.clientId,
        attachmentId: attachment.id,
        lastInputSequence: 0,
        releaseTimer: null,
      };
      attachment.writable = true;
      this.touch(session);
      return "claimed";
    }
    return null;
  }

  private takeControl(
    session: ManagedTerminal,
    attachment: ManagedAttachment,
    cols: number,
    rows: number,
  ): void {
    if (session.status !== "running") {
      this.sendControl(attachment, {
        type: "error",
        code: "terminal_exited",
        message: "Restart the terminal before taking control",
        fatal: false,
      });
      return;
    }
    const previousId = session.owner?.attachmentId;
    if (session.owner?.releaseTimer) clearTimeout(session.owner.releaseTimer);
    if (previousId && previousId !== attachment.id) {
      const previous = session.attachments.get(previousId);
      if (previous) {
        previous.writable = false;
        this.sendControl(previous, {
          type: "ownership",
          writable: false,
          hasOwner: true,
          reason: "taken",
        });
      }
    }
    session.owner = {
      token: this.uuid(),
      clientId: attachment.clientId,
      attachmentId: attachment.id,
      lastInputSequence: 0,
      releaseTimer: null,
    };
    attachment.writable = true;
    this.resizeSession(session, cols, rows);
    this.sendControl(attachment, {
      type: "ownership",
      writable: true,
      hasOwner: true,
      ownerToken: session.owner.token,
      nextInputSequence: 1,
      reason: "taken",
    });
    this.touch(session);
    this.broadcastDescriptor(session);
  }

  private releaseControl(
    session: ManagedTerminal,
    attachment: ManagedAttachment,
  ): void {
    if (session.owner?.attachmentId !== attachment.id) return;
    if (session.owner.releaseTimer) clearTimeout(session.owner.releaseTimer);
    session.owner = null;
    attachment.writable = false;
    this.touch(session);
    this.broadcastOwnership(session, "released");
    this.broadcastDescriptor(session);
  }

  private resizeSession(
    session: ManagedTerminal,
    cols: number,
    rows: number,
    exceptAttachmentId?: string,
  ): void {
    if (session.status !== "running") return;
    if (session.cols === cols && session.rows === rows) return;
    session.cols = cols;
    session.rows = rows;
    session.resizeRevision += 1;
    // Raw output produced for the previous grid cannot safely reconstruct a
    // detached full-screen client. Preserve absolute offsets, but force those
    // clients through a fresh headless-terminal snapshot.
    session.ring.discardRetained();
    session.emulatorTail = session.emulatorTail
      .then(() => {
        session.emulator.resize(cols, rows);
      })
      .catch(() => {});
    session.pty?.resize(cols, rows);
    this.touch(session);
    this.broadcastControl(
      session,
      {
        type: "resized",
        cols,
        rows,
        resizeRevision: session.resizeRevision,
      },
      exceptAttachmentId,
    );
  }

  private async waitForPtyExit(
    session: ManagedTerminal,
    timeoutMs: number,
  ): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        session.exitPromise.then(() => true),
        new Promise<false>((resolvePromise) => {
          timer = setTimeout(() => resolvePromise(false), timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async stopPty(
    session: ManagedTerminal,
    force: boolean,
  ): Promise<void> {
    const pty = session.pty;
    if (session.status !== "running" || !pty) return;
    try {
      const signal = force ? "SIGKILL" : "SIGHUP";
      if (pty.killTree) await pty.killTree(signal);
      else pty.kill(signal);
    } catch {
      // The process may have exited between the state check and the signal.
    }
    if (force) {
      await this.waitForPtyExit(session, PTY_EXIT_TIMEOUT_MS);
      if (session.status === "running")
        terminalError(
          "terminal_stop_timeout",
          503,
          "The terminal process did not stop",
        );
      return;
    }
    const exited = await this.waitForPtyExit(session, TERMINATE_GRACE_MS);
    if (exited) {
      try {
        // A shell can exit on SIGHUP while a child that ignored it remains.
        // Reuse the captured tree and process group for the hard cleanup.
        await pty.killTree?.("SIGKILL");
      } catch {
        // The complete process group may already be gone.
      }
      return;
    }
    try {
      if (pty.killTree) await pty.killTree("SIGKILL");
      else pty.kill("SIGKILL");
    } catch {
      // Best effort after the graceful timeout.
    }
    await this.waitForPtyExit(session, PTY_EXIT_TIMEOUT_MS);
    if (session.status === "running")
      terminalError(
        "terminal_stop_timeout",
        503,
        "The terminal process did not stop",
      );
  }

  private disposeRuntime(session: ManagedTerminal): void {
    if (session.owner?.releaseTimer) clearTimeout(session.owner.releaseTimer);
    for (const disposable of session.ptyDisposables) disposable.dispose();
    for (const disposable of session.emulatorDisposables) disposable.dispose();
    session.serializer.dispose();
    session.emulator.dispose();
  }

  private describe(session: ManagedTerminal): TerminalDescriptor {
    return {
      catalogEpoch: this.catalogEpoch,
      catalogRevision: this.revision,
      id: session.id,
      projectCwd: session.projectCwd,
      title:
        session.titleSource === "user"
          ? session.customTitle
          : session.automaticTitle,
      titleSource: session.titleSource,
      profileId: session.profile.id,
      shellLabel: session.profile.label,
      currentCwd: session.currentCwd,
      currentCommand: session.currentCommand,
      commandRunning: session.activeCommand !== "",
      status: session.status,
      exitCode: session.exitCode,
      signal: session.signal,
      cols: session.cols,
      rows: session.rows,
      resizeRevision: session.resizeRevision,
      outputEpoch: session.outputEpoch,
      firstOutputOffset: session.ring.firstOffset,
      nextOutputOffset: session.ring.nextOffset,
      viewerCount: session.attachments.size,
      hasOwner: session.owner !== null,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    };
  }

  private touch(session: ManagedTerminal): void {
    session.updatedAt = this.now().toISOString();
    this.revision += 1;
    this.onChange();
  }

  private broadcastDescriptor(
    session: ManagedTerminal,
    exceptAttachmentId?: string,
  ): void {
    this.broadcastControl(
      session,
      { type: "descriptor", terminal: this.describe(session) },
      exceptAttachmentId,
    );
  }

  private broadcastOwnership(
    session: ManagedTerminal,
    reason: "available" | "released",
  ): void {
    for (const attachment of session.attachments.values()) {
      this.sendControl(attachment, {
        type: "ownership",
        writable: attachment.writable,
        hasOwner: session.owner !== null,
        reason,
      });
    }
  }

  private broadcastControl(
    session: ManagedTerminal,
    message: TerminalServerControlMessage,
    exceptAttachmentId?: string,
  ): void {
    for (const attachment of session.attachments.values()) {
      if (attachment.id === exceptAttachmentId || attachment.detached) continue;
      this.sendControl(attachment, message);
    }
  }

  private sendControl(
    attachment: ManagedAttachment,
    message: TerminalServerControlMessage,
  ): void {
    if (attachment.detached) return;
    try {
      attachment.sink.sendControl(message);
    } catch {
      this.detachAttachment(attachment.terminalId, attachment.id);
    }
  }

  private sendData(attachment: ManagedAttachment, frame: Uint8Array): void {
    if (attachment.detached) return;
    try {
      attachment.sink.sendData(frame);
    } catch {
      this.detachAttachment(attachment.terminalId, attachment.id);
    }
  }

  private closeAttachments(
    session: ManagedTerminal,
    code: number,
    reason: string,
  ): void {
    for (const attachment of session.attachments.values()) {
      attachment.detached = true;
      try {
        attachment.sink.close(code, reason);
      } catch {
        // Closing an already disconnected WebSocket is harmless.
      }
    }
    session.attachments.clear();
  }

  private requireOpen(): void {
    if (this.closing)
      terminalError("service_closing", 503, "Terminal service is stopping");
  }

  private requireSession(id: string): ManagedTerminal {
    if (typeof id !== "string" || id.length < 1 || id.length > 80)
      terminalError(
        "invalid_terminal_id",
        400,
        "Terminal identifier is invalid",
      );
    const session = this.sessions.get(id);
    if (!session)
      terminalError("terminal_not_found", 404, "Terminal was not found");
    return session;
  }

  private requireStableSession(id: string): ManagedTerminal {
    const session = this.requireSession(id);
    if (this.lifecycleMutations.has(id))
      terminalError(
        "terminal_busy",
        409,
        "Another terminal lifecycle operation is still running",
      );
    return session;
  }

  private beginLifecycleMutation(id: string): ManagedTerminal {
    this.requireOpen();
    const session = this.requireStableSession(id);
    this.lifecycleMutations.add(id);
    return session;
  }

  private requireAttachment(
    terminalId: string,
    attachmentId: string,
  ): { session: ManagedTerminal; attachment: ManagedAttachment } {
    const session = this.requireSession(terminalId);
    const attachment = session.attachments.get(attachmentId);
    if (!attachment || attachment.detached)
      terminalError(
        "attachment_not_found",
        404,
        "Terminal attachment was not found",
      );
    return { session, attachment };
  }
}
