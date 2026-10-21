import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  type NativeActionRequest,
  nativeActionFrame,
  type PiActivityRecord,
  piActivityProcessIdentity,
} from "../../docs/examples/session-activity.js";
import { PiNativeActions } from "../../server/pi-native-actions.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function fixture() {
  const directory = await mkdtemp(
    join(tmpdir(), "inspire-native-actions-unit-"),
  );
  directories.push(directory);
  const sessionFile = join(directory, "session.jsonl");
  await writeFile(sessionFile, "");
  const receiverId = randomUUID(),
    report = join(directory, process.pid + "-" + randomUUID() + ".json");
  const record: PiActivityRecord = {
    version: 1,
    pid: process.pid,
    processIdentity: await piActivityProcessIdentity(process.pid),
    sessionId: "one",
    sessionFile,
    activity: "idle",
    updatedAt: Date.now(),
    nativeActions: { version: 1, receiverId },
  };
  const publish = () => writeFile(report, JSON.stringify(record));
  await publish();
  const actions = new PiNativeActions(
    process.pid,
    "one",
    sessionFile,
    record.processIdentity,
    directory,
  );
  const payload = async () => {
    const [name] = await readdir(join(directory, "actions"));
    return JSON.parse(
      await readFile(join(directory, "actions", name!), "utf8"),
    ) as NativeActionRequest;
  };
  return { actions, record, directory, receiverId, publish, payload };
}

it.each(["missing", "process", "file", "ambiguous"] as const)(
  "requires one exact live action receiver (%s)",
  async (change) => {
    const f = await fixture(),
      send = vi.fn();
    if (change === "missing") delete f.record.nativeActions;
    if (change === "process") f.record.pid += 1;
    if (change === "file")
      f.record.sessionFile = join(f.directory, "other.jsonl");
    if (change === "ambiguous")
      await writeFile(
        join(f.directory, process.pid + "-" + randomUUID() + ".json"),
        JSON.stringify(f.record),
      );
    await f.publish();
    await expect(
      f.actions.invoke({ type: "abort" }, send),
    ).rejects.toMatchObject({ code: "NATIVE_ACTIONS_UNAVAILABLE" });
    expect(send).not.toHaveBeenCalled();
  },
);

it.each(["invoked", "rejected"] as const)(
  "consumes only the matched native %s receipt and removes transport data",
  async (status) => {
    const f = await fixture();
    const send = vi.fn(async (frame: string) => {
      const request = await f.payload();
      expect(frame).toBe(nativeActionFrame(f.receiverId, request.operationId));
      expect(request).toMatchObject({
        sessionId: "one",
        pid: process.pid,
        action: { type: "prompt", message: "hello" },
      });
      f.record.nativeActions!.result = {
        operationId: request.operationId,
        status,
        code: "NATIVE_EDITOR_NOT_EMPTY",
        message: "Keep terminal draft",
      };
      await f.publish();
    });
    const result = f.actions.invoke({ type: "prompt", message: "hello" }, send);
    if (status === "invoked") await expect(result).resolves.toBeUndefined();
    else
      await expect(result).rejects.toMatchObject({
        status: 409,
        code: "NATIVE_EDITOR_NOT_EMPTY",
      });
    expect(send).toHaveBeenCalledOnce();
    expect(await readdir(join(f.directory, "actions"))).toEqual([]);
  },
);

it("does not turn a late receiver rebind into success or retry a mutation", async () => {
  const f = await fixture();
  const send = vi.fn(async () => {
    f.record.sessionId = "other";
    await f.publish();
  });
  await expect(f.actions.invoke({ type: "abort" }, send)).rejects.toMatchObject(
    { code: "PI_RPC_OUTCOME_UNKNOWN", outcomeUnknown: true },
  );
  expect(send).toHaveBeenCalledOnce();
  expect(await readdir(join(f.directory, "actions"))).toEqual([]);
});

it("checks original Stop ownership before emitting a frame", async () => {
  const f = await fixture(),
    send = vi.fn();
  await expect(
    f.actions.invoke({ type: "prompt", message: "old" }, send, () => {
      throw new Error("Stopped before send");
    }),
  ).rejects.toThrow("Stopped before send");
  expect(send).not.toHaveBeenCalled();
  expect(await readdir(join(f.directory, "actions"))).toEqual([]);
});
