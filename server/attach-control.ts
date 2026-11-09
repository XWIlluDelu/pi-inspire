import { lstat, readdir, readFile, rm } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import {
  ATTACH_CONTROL_STALE_MS,
  type AttachControlOperation,
  type AttachControlRecord,
  type AttachControlResponse,
  type AttachControlState,
  attachControlDirectory,
  processIdentity,
  requestAttachControl,
} from "../extensions/attach-control.js";
import type {
  ExternalSessionConnection,
  ExternalSessionState,
} from "./external-session.js";
import { requestError } from "./request-error.js";

const RECORD_NAME = /^[1-9]\d*-[0-9a-f-]{36}\.json$/;
const MAX_RECORD_BYTES = 32_768;
const IDENTITY_CACHE_MS = 10_000;
const OBSERVATION_MAX_AGE_MS = 1_000;

function isAttachControlRecord(value: unknown): value is AttachControlRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<AttachControlRecord>;
  return (
    record.version === 1 &&
    typeof record.instanceId === "string" &&
    Number.isSafeInteger(record.pid) &&
    record.pid! > 0 &&
    typeof record.processIdentity === "string" &&
    record.processIdentity.length > 0 &&
    typeof record.sessionId === "string" &&
    record.sessionId.length > 0 &&
    typeof record.sessionFile === "string" &&
    isAbsolute(record.sessionFile) &&
    (record.leafId === null || typeof record.leafId === "string") &&
    (record.activity === "working" ||
      record.activity === "blocked" ||
      record.activity === "idle") &&
    Number.isSafeInteger(record.updatedAt) &&
    typeof record.endpoint === "string" &&
    typeof record.token === "string"
  );
}

/** Live attach-control records of this OS user. Observation only: reading
 * never starts, stops or writes a Pi session. */
export class AttachControlRegistry {
  private readonly identities = new Map<
    number,
    { identity: string | null; checkedAt: number }
  >();
  private observation?: {
    records: Promise<AttachControlRecord[]>;
    /** null while the scan is in flight. */
    settledAt: number | null;
  };

  constructor(
    readonly directory = attachControlDirectory(),
    /** Records to ignore, such as the Host's own tagged workers. */
    private readonly ignore: (record: AttachControlRecord) => boolean = () =>
      false,
  ) {}

  private async liveIdentity(pid: number): Promise<string | null> {
    const cached = this.identities.get(pid);
    if (cached && Date.now() - cached.checkedAt < IDENTITY_CACHE_MS)
      return cached.identity;
    const identity = await processIdentity(pid).catch(() => null);
    this.identities.set(pid, { identity, checkedAt: Date.now() });
    if (this.identities.size > 512)
      this.identities.delete(this.identities.keys().next().value!);
    return identity;
  }

  private async readRecord(name: string): Promise<AttachControlRecord | null> {
    const path = join(this.directory, name);
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.size > MAX_RECORD_BYTES) return null;
      const record: unknown = JSON.parse(await readFile(path, "utf8"));
      if (!isAttachControlRecord(record) || !name.startsWith(`${record.pid}-`))
        return null;
      if ((await this.liveIdentity(record.pid)) !== record.processIdentity) {
        // A crashed or replaced process cannot remove its own record.
        this.identities.delete(record.pid);
        if ((await this.liveIdentity(record.pid)) !== record.processIdentity)
          await rm(path, { force: true }).catch(() => {});
        return null;
      }
      const age = Date.now() - record.updatedAt;
      return age >= 0 && age < ATTACH_CONTROL_STALE_MS ? record : null;
    } catch {
      return null;
    }
  }

  private async scan(
    include: (name: string) => boolean = () => true,
  ): Promise<AttachControlRecord[]> {
    let names: string[];
    try {
      names = (await readdir(this.directory)).filter(
        (name) => RECORD_NAME.test(name) && include(name),
      );
    } catch {
      return [];
    }
    return (
      await Promise.all(names.map((name) => this.readRecord(name)))
    ).filter(
      (record): record is AttachControlRecord =>
        record !== null && !this.ignore(record),
    );
  }

  /** A fresh scan of every live record. */
  list(): Promise<AttachControlRecord[]> {
    return this.scan();
  }

  /** Records for observers that tolerate a scan up to
   * `OBSERVATION_MAX_AGE_MS` old, far inside the records' own heartbeat
   * staleness. Concurrent observers share one directory scan. */
  observe(): Promise<AttachControlRecord[]> {
    const observation = this.observation;
    if (
      observation &&
      (observation.settledAt === null ||
        Date.now() - observation.settledAt < OBSERVATION_MAX_AGE_MS)
    )
      return observation.records;
    const next: NonNullable<typeof this.observation> = {
      records: this.scan(),
      settledAt: null,
    };
    this.observation = next;
    void next.records.finally(() => {
      next.settledAt = Date.now();
    });
    return next.records;
  }

  /** Live records of one session; `observe` accepts a shared recent scan. */
  async forSession(
    sessionId: string,
    sessionFile: string,
    { observe = false }: { observe?: boolean } = {},
  ): Promise<AttachControlRecord[]> {
    const file = resolve(sessionFile);
    return (await (observe ? this.observe() : this.list())).filter(
      (record) =>
        record.sessionId === sessionId && resolve(record.sessionFile) === file,
    );
  }

  /** Deletion targets the whole session, across every reported branch. A
   * reply is not exit evidence; leave the file in place until each Pi exits. */
  async stopSession(sessionId: string, sessionFile: string): Promise<void> {
    const records = await this.forSession(sessionId, sessionFile);
    const results = await Promise.allSettled(
      records.map(async (record) => {
        const response = await requestAttachControl(record.endpoint, {
          op: "shutdown",
          token: record.token,
          sessionFile: record.sessionFile,
        }).catch(() => null);
        if (response && !response.ok) {
          if (response.code === "CHANGED") return;
          throw requestError(response.error, 409, {
            code: "SESSION_INSTANCE_ACTIVE",
          });
        }
        const deadline = Date.now() + 15_000;
        while (await this.alive(record.pid, record.processIdentity)) {
          if (Date.now() >= deadline)
            throw requestError(
              "A Pi instance has not exited. The session was not deleted.",
              409,
              { code: "SESSION_INSTANCE_ACTIVE" },
            );
          await new Promise((resolvePromise) =>
            setTimeout(resolvePromise, 100),
          );
        }
      }),
    );
    for (const result of results)
      if (result.status === "rejected") throw result.reason;
    if ((await this.forSession(sessionId, sessionFile)).length)
      throw requestError(
        "Another Pi opened this session during deletion. Review it before retrying.",
        409,
        { code: "SESSION_INSTANCE_ACTIVE" },
      );
  }

  /** Fresh exit evidence for one process incarnation; reads no records. */
  async alive(pid: number, identity: string): Promise<boolean> {
    this.identities.delete(pid);
    return (await this.liveIdentity(pid)) === identity;
  }

  /** The current records of one live process, whichever session it now
   * shows. Record names carry the pid, so other processes are not read. */
  async forProcess(
    pid: number,
    identity: string,
  ): Promise<{ alive: boolean; records: AttachControlRecord[] }> {
    if (!(await this.alive(pid, identity)))
      return { alive: false, records: [] };
    return {
      alive: true,
      records: (await this.scan((name) => name.startsWith(`${pid}-`))).filter(
        (record) => record.processIdentity === identity,
      ),
    };
  }
}

/** Prefer idle instances, then the most recent activity. */
export function preferredInstance(
  records: readonly AttachControlRecord[],
): AttachControlRecord | undefined {
  return [...records].sort(
    (a, b) =>
      Number(a.activity !== "idle") - Number(b.activity !== "idle") ||
      b.updatedAt - a.updatedAt,
  )[0];
}

function stateOf(state: AttachControlState): ExternalSessionState {
  return {
    status: state.activity,
    taskRuns: state.taskRuns,
    modelSelection: state.modelSelection,
    leafId: state.leafId,
    ...(state.uiRequests ? { uiRequests: state.uiRequests } : {}),
  };
}

/** Bound to one process incarnation and session file. Every operation
 * resolves that process's current endpoint, so reloads stay transparent. */
export class AttachControlConnection implements ExternalSessionConnection {
  readonly pid: number;
  private readonly identity: string;
  private readonly sessionFile: string;
  private failingSince: number | null = null;

  constructor(
    private readonly registry: AttachControlRegistry,
    record: AttachControlRecord,
    private readonly graceMs = ATTACH_CONTROL_STALE_MS,
  ) {
    this.pid = record.pid;
    this.identity = record.processIdentity;
    this.sessionFile = resolve(record.sessionFile);
  }

  private async current(): Promise<
    AttachControlRecord | { ended: "exited" | "left-session" }
  > {
    const { alive, records } = await this.registry.forProcess(
      this.pid,
      this.identity,
    );
    if (!alive) return { ended: "exited" };
    const record = records.find(
      (candidate) => resolve(candidate.sessionFile) === this.sessionFile,
    );
    if (record?.endpoint) return record;
    // A reload briefly removes the record; another session means this Pi
    // moved away.
    if (records.length > 0) return { ended: "left-session" };
    throw requestError(
      "The attached Pi is reloading. Try again shortly.",
      409,
      {
        code: "SESSION_OWNER_UNAVAILABLE",
      },
    );
  }

  private async send(
    operation: AttachControlOperation,
    beforeSend?: () => void,
    expectedLeafId?: string | null,
    observed?: AttachControlRecord,
  ): Promise<Extract<AttachControlResponse, { ok: true }>> {
    const record = observed ?? (await this.current());
    if ("ended" in record)
      throw requestError(
        "The attached Pi is no longer running this session.",
        409,
        {
          code: "SESSION_OWNER_UNAVAILABLE",
        },
      );
    beforeSend?.();
    const response = await requestAttachControl(record.endpoint, {
      ...operation,
      token: record.token,
      sessionFile: record.sessionFile,
      ...(expectedLeafId !== undefined ? { expectedLeafId } : {}),
    }).catch((error: unknown) => {
      throw requestError(
        error instanceof Error
          ? error.message
          : "The attached Pi is unavailable.",
        409,
        { code: "SESSION_OWNER_UNAVAILABLE" },
      );
    });
    if (!response.ok)
      throw requestError(response.error, 409, {
        code:
          response.code === "BLOCKED"
            ? "NATIVE_INPUT_BLOCKED"
            : response.code === "CHANGED"
              ? "SESSION_OWNER_UNAVAILABLE"
              : `ATTACH_CONTROL_${response.code}`,
      });
    return response;
  }

  /** Failures within the grace period (such as a reload) are transient; a
   * lasting one ends the binding as "unreachable". */
  async read(): Promise<
    ExternalSessionState | { ended: "exited" | "left-session" | "unreachable" }
  > {
    try {
      const record = await this.current();
      const state =
        "ended" in record
          ? record
          : stateOf(
              (await this.send({ op: "state" }, undefined, undefined, record))
                .state,
            );
      this.failingSince = null;
      return state;
    } catch (error) {
      this.failingSince ??= Date.now();
      if (Date.now() - this.failingSince >= this.graceMs)
        return { ended: "unreachable" };
      throw error;
    }
  }

  async prompt(
    message: string,
    behavior?: "steer" | "followUp",
    beforeSend?: () => void,
    images?: { path: string; mimeType: string }[],
    expectedLeafId?: string | null,
  ): Promise<void> {
    await this.send(
      { op: "prompt", message, behavior, images },
      beforeSend,
      expectedLeafId,
    );
  }

  async abort(expectedLeafId?: string | null): Promise<void> {
    await this.send({ op: "abort" }, undefined, expectedLeafId);
  }

  async answerUi(response: Record<string, unknown>): Promise<void> {
    await this.send({ op: "ui_response", response });
  }

  async rename(name: string, beforeSend?: () => void): Promise<void> {
    await this.send({ op: "rename", name }, beforeSend);
  }

  async models() {
    const response = await this.send({ op: "models" });
    return { ...response.state.modelSelection, models: response.models ?? [] };
  }

  async setModel(provider: string, modelId: string, beforeSend?: () => void) {
    return (await this.send({ op: "set_model", provider, modelId }, beforeSend))
      .state.modelSelection;
  }

  async setThinkingLevel(
    level: AttachControlState["modelSelection"]["thinkingLevel"],
    beforeSend?: () => void,
  ) {
    return (await this.send({ op: "set_thinking", level }, beforeSend)).state
      .modelSelection;
  }

  async reload(): Promise<void> {
    await this.send({ op: "reload" });
  }

  close(): void {}
}
