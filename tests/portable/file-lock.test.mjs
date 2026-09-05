import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { once } from "node:events";
import fs, {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { acquireFileLock as acquireCrossPlatformFileLock } from "../../server/file-lock.mjs";

function acquireFileLock(path, options = {}) {
  return acquireCrossPlatformFileLock(path, {
    ...options,
    platform: "darwin",
  });
}

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
  await writeFile(path, "replacement owner\n", { flag: "wx" });

  await assert.rejects(
    lease.assertOwned(),
    (error) => error?.code === "ECOMPROMISED",
  );
  await lease.release();
  assert.equal(await readFile(path, "utf8"), "replacement owner\n");
});

test("continues after a crashed owner", async () => {
  const path = await lockPath();
  const moduleUrl = pathToFileURL(
    join(process.cwd(), "server", "file-lock.mjs"),
  ).href;
  const holder = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { acquireFileLock } from ${JSON.stringify(moduleUrl)};
       await acquireFileLock(${JSON.stringify(path)}, { waitMs: 500, platform: "darwin" });
       process.stdout.write("ready\\n");
       setInterval(() => undefined, 1_000);`,
    ],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  let stopped = false;
  try {
    await once(holder.stdout, "data");
    const waiting = acquireFileLock(path, { waitMs: 5_000, retryMs: 20 });
    await delay(50);
    holder.kill("SIGKILL");
    await once(holder, "close");
    stopped = true;
    const lease = await waiting;
    await lease.release();
  } finally {
    if (!stopped && holder.exitCode === null && holder.signalCode === null) {
      holder.kill("SIGKILL");
      await once(holder, "close");
    }
  }
});

for (const transitionScan of [1, 2]) {
  test(`does not miss a choosing-to-ticket rename during scan ${transitionScan}`, async (t) => {
    // Use a real process-birth identity for a second live participant, but
    // control exactly when its choosing file becomes a numbered ticket.
    const seed = await acquireFileLock(await lockPath());
    const identity = seed.owner;
    await seed.release();
    const path = await lockPath();
    await mkdir(path, { mode: 0o700 });
    const lower = "00000000-0000-4000-8000-000000000001";
    const upper = "ffffffff-ffff-4fff-bfff-ffffffffffff";
    const holderToken = transitionScan === 1 ? upper : lower;
    const contenderToken = transitionScan === 1 ? lower : upper;
    const choosing = `choosing-${holderToken}.json`;
    const ticket = `ticket-1-${holderToken}.json`;
    await writeFile(
      join(path, choosing),
      JSON.stringify({ ...identity, token: holderToken }),
    );

    const realReaddir = fs.readdir;
    let scans = 0;
    t.mock.method(crypto, "randomUUID", () => contenderToken);
    t.mock.method(fs, "readdir", async (...args) => {
      const names = await realReaddir(...args);
      if (args[0] === path && ++scans === transitionScan) {
        assert.ok(names.includes(choosing));
        // The directory snapshot contains choosing, but lstat/readFile now
        // sees ENOENT there. The owner is still live under its ticket name.
        await rename(join(path, choosing), join(path, ticket));
      }
      return names;
    });
    syncBuiltinESMExports();
    t.after(() => {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    });

    let unexpectedLease;
    try {
      await assert.rejects(
        async () => {
          unexpectedLease = await acquireFileLock(path, {
            waitMs: 150,
            retryMs: 5,
          });
        },
        (error) => error?.code === "ELOCKTIMEOUT",
      );
      assert.ok(scans > transitionScan);
      assert.equal(
        JSON.parse(await readFile(join(path, ticket), "utf8")).token,
        holderToken,
      );
    } finally {
      await unexpectedLease?.release();
    }
  });
}

test("preserves all updates when writers arrive together", async () => {
  const path = await lockPath();
  const counterPath = `${path}.counter`;
  await writeFile(counterPath, "0");
  let active = 0;
  const results = await Promise.allSettled(
    Array.from({ length: 8 }, async () => {
      const lease = await acquireFileLock(path, { waitMs: 5_000, retryMs: 5 });
      active += 1;
      try {
        assert.equal(active, 1, "portable lock admitted concurrent writers");
        const value = Number(await readFile(counterPath, "utf8"));
        await delay(2);
        await lease.assertOwned();
        await writeFile(counterPath, String(value + 1));
      } finally {
        active -= 1;
        await lease.release();
      }
    }),
  );
  for (const result of results) {
    if (result.status === "rejected") throw result.reason;
  }
  assert.equal(Number(await readFile(counterPath, "utf8")), 8);
});

test("keeps queued owners mutually exclusive", async () => {
  const path = await lockPath();
  const first = await acquireFileLock(path, { waitMs: 100, retryMs: 10 });
  const secondRequest = acquireFileLock(path, {
    waitMs: 2_000,
    retryMs: 10,
  });
  await delay(20);
  const thirdRequest = acquireFileLock(path, {
    waitMs: 2_000,
    retryMs: 10,
  });

  const contenders = [
    secondRequest.then((lease) => ({ lease, name: "second" })),
    thirdRequest.then((lease) => ({ lease, name: "third" })),
  ];
  await first.release();
  const winner = await Promise.race(contenders);
  const waiting = contenders[winner.name === "second" ? 1 : 0];
  let waitingSettled = false;
  void waiting.then(() => {
    waitingSettled = true;
  });
  await delay(40);
  assert.equal(waitingSettled, false);
  await winner.lease.release();
  const successor = await waiting;
  await successor.lease.release();
});
