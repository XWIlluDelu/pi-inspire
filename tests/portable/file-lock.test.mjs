import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { acquireFileLock } from "../../server/file-lock.mjs";

const directories = [];
after(async () => {
  await Promise.all(
    directories.map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function lockPath() {
  const directory = await mkdtemp(join(tmpdir(), "inspire-file-lock-"));
  directories.push(directory);
  return join(directory, "resource.lock");
}

test("serializes live owners and releases idempotently", async () => {
  const path = await lockPath();
  const first = await acquireFileLock(path, { waitMs: 100, retryMs: 10 });
  await assert.rejects(
    acquireFileLock(path, { waitMs: 60, retryMs: 10, label: "test" }),
    (error) => error?.code === "ELOCKTIMEOUT",
  );
  await first.assertOwned();
  await first.release();
  await first.release();
  const second = await acquireFileLock(path, { waitMs: 100, retryMs: 10 });
  await second.release();
});

test("detects a replaced lock path without deleting the replacement", async () => {
  const path = await lockPath();
  const displaced = `${path}.displaced`;
  const lease = await acquireFileLock(path, { waitMs: 100, retryMs: 10 });
  await rename(path, displaced);
  const replacement = `${JSON.stringify({
    schemaVersion: 1,
    pid: process.pid,
    token: "replacement-owner",
    processStartTime: `pid:${process.pid}`,
    createdAt: new Date().toISOString(),
  })}\n`;
  await writeFile(path, replacement);

  await assert.rejects(
    lease.assertOwned(),
    (error) => error?.code === "ECOMPROMISED",
  );
  await lease.release();
  assert.equal(await readFile(path, "utf8"), replacement);
});

test("reclaims a complete owner record after its process is gone", async () => {
  const path = await lockPath();
  await writeFile(
    path,
    `${JSON.stringify({
      schemaVersion: 1,
      pid: 2_147_483_000,
      token: "dead-owner",
      processStartTime: "linux:dead",
      createdAt: new Date(0).toISOString(),
    })}\n`,
  );
  const lease = await acquireFileLock(path, { waitMs: 200, retryMs: 10 });
  await lease.assertOwned();
  await lease.release();
});

test("reclaims a live recycled PID only when its process identity differs", async () => {
  const path = await lockPath();
  await writeFile(
    path,
    `${JSON.stringify({
      schemaVersion: 1,
      pid: process.pid,
      token: "recycled-owner",
      processStartTime: "linux:not-this-process",
      createdAt: new Date(0).toISOString(),
    })}\n`,
  );
  const lease = await acquireFileLock(path, { waitMs: 200, retryMs: 10 });
  await lease.release();
});

test("does not reclaim a live fallback PID record", async () => {
  const path = await lockPath();
  await writeFile(
    path,
    `${JSON.stringify({
      schemaVersion: 1,
      pid: process.pid,
      token: "fallback-owner",
      processStartTime: `pid:${process.pid}`,
      createdAt: new Date(0).toISOString(),
    })}\n`,
  );
  await assert.rejects(
    acquireFileLock(path, { waitMs: 60, retryMs: 10 }),
    (error) => error?.code === "ELOCKTIMEOUT",
  );
});

test("reclaims a legacy directory lock after its owner is gone", async () => {
  const path = await lockPath();
  await mkdir(path);
  await writeFile(
    join(path, "owner.json"),
    `${JSON.stringify({ pid: 2_147_483_000 })}\n`,
  );
  const old = new Date(Date.now() - 60_000);
  await utimes(path, old, old);
  const lease = await acquireFileLock(path, { waitMs: 200, retryMs: 10 });
  await lease.release();
});
