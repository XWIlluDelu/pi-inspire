import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import {
  assertExternalPiRestartCaller,
  createLinuxPiProcessAdapter,
  stopAllPiProcesses,
  supportsGlobalPiStop,
} from "../../server/pi-processes.mjs";

function identity(pid, overrides = {}) {
  return {
    pid,
    uid: 1000,
    startTime: String(pid * 100),
    title: "pi",
    state: "S",
    inHerdr: false,
    ...overrides,
  };
}

function fixture(identities, hooks = {}) {
  const f = {
    records: new Map(identities.map((record) => [record.pid, record])),
    inspections: [],
    signals: [],
    sleeps: [],
    enumerations: 0,
  };
  f.adapter = {
    uid: 1000,
    async enumerate() {
      f.enumerations++;
      return [...f.records.keys()];
    },
    async inspect(pid) {
      f.inspections.push(pid);
      await hooks.inspect?.(pid, f);
      const record = f.records.get(pid);
      return record ? { ...record } : null;
    },
    async signal(pid, signal) {
      f.signals.push([pid, signal]);
      if (hooks.signal) await hooks.signal(pid, signal, f);
      else f.records.delete(pid);
    },
    async sleep(ms) {
      f.sleeps.push(ms);
      await hooks.sleep?.(ms, f);
    },
  };
  f.stop = (options = {}) =>
    stopAllPiProcesses({
      platform: "linux",
      adapter: f.adapter,
      ...options,
    });
  return f;
}

function denied() {
  return Object.assign(new Error("permission denied"), { code: "EACCES" });
}

function ancestryFixture(records, onInspect) {
  const state = {
    records: new Map(records.map((record) => [record.pid, record])),
    calls: [],
  };
  const adapter = {
    uid: 1000,
    async inspect(pid) {
      state.calls.push(pid);
      await onInspect?.(pid, state);
      const record = state.records.get(pid);
      return record ? { ...record } : null;
    },
  };
  return {
    state,
    check: (options = {}) =>
      assertExternalPiRestartCaller({
        platform: "linux",
        pid: 100,
        adapter,
        ...options,
      }),
  };
}

function ancestor(pid, parentPid, overrides = {}) {
  return identity(pid, { parentPid, title: "node", ...overrides });
}

test("external restart caller allows a verified non-Pi chain through foreign-owned init", async () => {
  const f = ancestryFixture([
    ancestor(100, 90),
    ancestor(90, 1, { title: "bash" }),
    ancestor(1, 0, { title: "systemd", uid: 0 }),
  ]);
  await f.check();
  assert.deepEqual(f.state.calls, [100, 90, 100, 1, 90]);
});

test("external restart caller rejects Pi and RPC ancestors with actionable instructions", async () => {
  for (const title of ["pi", "pi-rpc"]) {
    const f = ancestryFixture([
      ancestor(100, 90),
      ancestor(90, 1, { title }),
      ancestor(1, 0, { uid: 0 }),
    ]);
    await assert.rejects(
      f.check(),
      /^Error: Run inspire restart --all outside Pi, from an OS terminal\.$/,
    );
  }
});

test("foreign-owned wrappers cannot conceal a current-user Pi ancestor", async () => {
  const f = ancestryFixture([
    ancestor(100, 90),
    ancestor(90, 80, { uid: 0, title: "sudo" }),
    ancestor(80, 1, { title: "pi" }),
    ancestor(1, 0, { uid: 0 }),
  ]);
  await assert.rejects(f.check(), /outside Pi, from an OS terminal/);
  assert.ok(f.state.calls.includes(80));
});

test("foreign Pi and unrelated title prefixes are not guessed to be global targets", async () => {
  const f = ancestryFixture([
    ancestor(100, 90),
    ancestor(90, 80, { uid: 0, title: "pi" }),
    ancestor(80, 1, { title: "pi-other" }),
    ancestor(1, 0, { uid: 0 }),
  ]);
  await f.check();
});

test("caller ancestry birth, owner, parent and title races fail closed", async () => {
  for (const change of [
    { startTime: "replacement" },
    { uid: 1001 },
    { parentPid: 1 },
    { title: "pi" },
  ]) {
    const f = ancestryFixture(
      [
        ancestor(100, 90),
        ancestor(90, 1, { title: "bash" }),
        ancestor(1, 0, { uid: 0 }),
      ],
      (pid, state) => {
        if (pid === 100 && state.calls.length === 3)
          Object.assign(state.records.get(pid), change);
      },
    );
    await assert.rejects(f.check(), /ancestry changed.*outside Pi/);
  }
});

test("missing, inaccessible, malformed and cyclic caller ancestries fail closed", async () => {
  for (const records of [
    [ancestor(100, 90)],
    [ancestor(100, 100)],
    [ancestor(100, 90), ancestor(90, 100)],
    [ancestor(100, -1)],
    [ancestor(100, 0, { state: "Z" })],
    [ancestor(100, 0, { startTime: "" })],
  ]) {
    const f = ancestryFixture(records);
    await assert.rejects(f.check(), /ancestry.*outside Pi/);
  }
  const f = ancestryFixture([ancestor(100, 90)], () => {
    throw denied();
  });
  await assert.rejects(f.check(), /Cannot inspect.*outside Pi/);
});

test("caller guard rejects unsupported platforms before inspecting or mutating anything", async () => {
  const f = ancestryFixture([ancestor(100, 0)]);
  await assert.rejects(f.check({ platform: "darwin" }), /unsupported/);
  assert.deepEqual(f.state.calls, []);
  await assert.rejects(f.check({ pid: 0 }), /valid PID/);
  assert.deepEqual(f.state.calls, []);
});

test("Linux is supported; other platforms refuse before touching any process", async () => {
  assert.equal(supportsGlobalPiStop("linux"), true);
  for (const platform of ["darwin", "win32", "freebsd", "aix"]) {
    assert.equal(supportsGlobalPiStop(platform), false);
    const f = fixture([identity(10)]);
    await assert.rejects(f.stop({ platform }), /unsupported/);
    assert.equal(f.enumerations, 0);
    assert.deepEqual(f.signals, []);
  }
});

test("requires a complete injected adapter, never mixing fake hooks with native ones", async () => {
  await assert.rejects(
    stopAllPiProcesses({
      platform: "linux",
      adapter: { uid: 1000, enumerate: async () => [] },
    }),
    /complete process adapter/,
  );
});

test("snapshots every Pi title before TERM, including nested Pi, and leaves non-Pi processes alone", async () => {
  const f = fixture(
    [
      identity(10),
      identity(11, { title: "pi-rpc" }),
      identity(12, { title: "pi", uid: 1001 }),
      identity(13, { title: "herdr" }),
      identity(14, { title: "bash" }),
      identity(15, { title: "inspire-host" }),
      identity(16, { title: "node" }),
      identity(17, { title: "pi-worker-keeper" }),
      identity(18, { title: "pi-unknown" }),
      identity(19, { title: "pi", state: "Z" }),
      identity(20, { title: "pi-rpc", state: "X" }),
    ],
    {
      signal(pid, _signal, state) {
        assert.ok(state.inspections.includes(20), "complete discovery first");
        state.records.delete(pid);
      },
    },
  );
  await f.stop();
  assert.deepEqual(f.signals, [
    [10, "SIGTERM"],
    [11, "SIGTERM"],
  ]);
  assert.deepEqual(f.sleeps, []);
  assert.equal(f.enumerations, 2);
});

test("Herdr Pi are excluded by default and included only when requested", async () => {
  for (const includeHerdr of [false, true]) {
    const f = fixture([
      identity(10),
      identity(11, { inHerdr: true }),
      identity(12, { title: "pi-rpc", inHerdr: true }),
      identity(13, { title: "herdr", inHerdr: true }),
    ]);
    await f.stop({ includeHerdr });
    assert.deepEqual(
      f.signals,
      includeHerdr
        ? [
            [10, "SIGTERM"],
            [11, "SIGTERM"],
            [12, "SIGTERM"],
          ]
        : [[10, "SIGTERM"]],
    );
    assert.ok(f.records.has(13));
  }
});

test("fresh final verification honors the Herdr inclusion scope", async () => {
  for (const includeHerdr of [false, true]) {
    const f = fixture([identity(10)], {
      signal(pid, _signal, state) {
        state.records.delete(pid);
        state.records.set(11, identity(11, { inHerdr: true }));
      },
    });
    if (includeHerdr)
      await assert.rejects(f.stop({ includeHerdr }), /PID 11: new Pi process/);
    else await f.stop();
    assert.deepEqual(f.signals, [[10, "SIGTERM"]]);
  }
});

test("a failed final enumeration or inspection cannot claim global success", async () => {
  for (const operation of ["enumerate", "inspect"]) {
    const f = fixture([identity(10)]);
    if (operation === "enumerate") {
      const enumerate = f.adapter.enumerate;
      f.adapter.enumerate = () => {
        if (f.enumerations) throw denied();
        return enumerate();
      };
    } else {
      f.adapter.enumerate = async () => {
        f.enumerations++;
        return f.enumerations === 1 ? [10] : [11];
      };
      const inspect = f.adapter.inspect;
      f.adapter.inspect = (pid) => {
        if (pid === 11) throw denied();
        return inspect(pid);
      };
    }
    await assert.rejects(
      f.stop(),
      /Cannot verify global Pi exit: permission denied/,
    );
    assert.deepEqual(f.signals, [[10, "SIGTERM"]]);
  }
});

test("empty snapshots succeed without waiting or signalling", async () => {
  const f = fixture([]);
  await f.stop();
  assert.deepEqual(f.signals, []);
  assert.deepEqual(f.sleeps, []);
});

test("stubborn processes receive KILL only after the default five-second grace", async () => {
  const f = fixture([identity(10)], {
    signal(pid, signal, state) {
      if (signal === "SIGKILL") {
        assert.ok(state.sleeps.reduce((sum, ms) => sum + ms, 0) >= 4_900);
        state.records.delete(pid);
      }
    },
  });
  await f.stop();
  assert.deepEqual(f.signals, [
    [10, "SIGTERM"],
    [10, "SIGKILL"],
  ]);
  assert.ok(f.sleeps.reduce((sum, ms) => sum + ms, 0) <= 5_000);
});

test("later Pi is not signalled, but the fresh final scan refuses global success", async () => {
  const f = fixture([identity(10)], {
    signal() {},
    sleep(_ms, state) {
      state.records.delete(10);
      state.records.set(11, identity(11));
    },
  });
  await assert.rejects(f.stop(), /PID 11: new Pi process remains/);
  assert.deepEqual(f.signals, [[10, "SIGTERM"]]);
  assert.equal(f.enumerations, 2);
  assert.ok(f.records.has(11));
});

test("birth, owner and title are revalidated before the first signal", async () => {
  for (const change of [
    { startTime: "replacement" },
    { uid: 1001 },
    { title: "bash" },
    { state: "Z" },
    { inHerdr: true },
    null,
  ]) {
    const f = fixture([identity(10)], {
      inspect(pid, state) {
        if (state.inspections.length === 2) {
          if (change) Object.assign(state.records.get(pid), change);
          else state.records.delete(pid);
        }
      },
    });
    if (change?.startTime)
      await assert.rejects(f.stop(), /new Pi process remains/);
    else await f.stop();
    assert.deepEqual(f.signals, []);
  }
});

test("PID reuse, owner changes and non-Pi exec during grace never receive KILL", async () => {
  for (const change of [
    { startTime: "replacement" },
    { uid: 1001 },
    { title: "sh" },
    { inHerdr: true },
  ]) {
    const f = fixture([identity(10)], {
      signal() {},
      sleep(_ms, state) {
        Object.assign(state.records.get(10), change);
      },
    });
    if (change.startTime)
      await assert.rejects(f.stop(), /new Pi process remains/);
    else await f.stop();
    assert.deepEqual(f.signals, [[10, "SIGTERM"]]);
  }
});

test("rechecks birth immediately before KILL as well as during the wait", async () => {
  const f = fixture([identity(10)], {
    signal() {},
    inspect(pid, state) {
      // discovery, TERM validation, final grace check, KILL validation
      if (state.inspections.length === 4)
        state.records.get(pid).startTime = "replacement";
    },
  });
  await assert.rejects(f.stop({ graceMs: 0 }), /new Pi process remains/);
  assert.deepEqual(f.signals, [[10, "SIGTERM"]]);
});

test("an inaccessible discovery aborts before any signal, instead of claiming a complete stop", async () => {
  const f = fixture([identity(10), identity(11)], {
    inspect(pid) {
      if (pid === 11) throw denied();
    },
  });
  await assert.rejects(f.stop(), /permission denied/);
  assert.deepEqual(f.signals, []);
});

test("enumeration failures and malformed identities abort before signalling", async () => {
  const f = fixture([identity(10, { startTime: "" })]);
  await assert.rejects(f.stop(), /Invalid process identity/);
  assert.deepEqual(f.signals, []);
  f.adapter.enumerate = async () => {
    throw denied();
  };
  await assert.rejects(f.stop(), /permission denied/);
  f.adapter.enumerate = async () => [0];
  await assert.rejects(f.stop(), /Invalid enumerated PID/);
});

test("disappearance during inspection or signalling is successful exit", async () => {
  for (const operation of ["inspect", "signal"]) {
    const f = fixture([identity(10)], {
      [operation](_pid, value, state) {
        if (operation === "inspect" && value.inspections.length === 1) return;
        if (operation === "signal") state.records.delete(10);
        throw Object.assign(new Error("gone"), { code: "ESRCH" });
      },
    });
    await f.stop();
    assert.deepEqual(f.sleeps, []);
  }
});

test("reports signal failures while still terminating the other snapshotted Pi", async () => {
  const f = fixture([identity(10), identity(11)], {
    signal(pid, _signal, state) {
      if (pid === 10) throw denied();
      state.records.delete(pid);
    },
  });
  await assert.rejects(f.stop(), /PID 10: SIGTERM: permission denied/);
  assert.deepEqual(f.signals, [
    [10, "SIGTERM"],
    [11, "SIGTERM"],
  ]);
});

test("observes a retiring process through a transient read denial without issuing an unchecked KILL", async () => {
  for (const exits of [true, false]) {
    const f = fixture([identity(10)], {
      signal() {},
      inspect(_pid, state) {
        if (state.inspections.length >= 3 && state.records.size) throw denied();
      },
      sleep(_ms, state) {
        if (exits) state.records.delete(10);
      },
    });
    const stopped = f.stop({ graceMs: 1_000, pollMs: 500 });
    if (exits) await stopped;
    else await assert.rejects(stopped, /cannot verify exit: permission denied/);
    assert.deepEqual(f.signals, [[10, "SIGTERM"]]);
  }
});

test("waits for KILL to take effect and errors if the original process survives", async () => {
  const f = fixture([identity(10)], { signal() {} });
  await assert.rejects(
    f.stop({ graceMs: 0, killWaitMs: 20, pollMs: 10 }),
    /PID 10: still running after SIGKILL/,
  );
  assert.deepEqual(f.signals, [
    [10, "SIGTERM"],
    [10, "SIGKILL"],
  ]);
  assert.ok(f.inspections.length >= 5, "verify after KILL");
  assert.ok(f.sleeps.reduce((sum, ms) => sum + ms, 0) <= 20);
});

test("invalid wait limits fail before discovery", async () => {
  for (const options of [
    { graceMs: -1 },
    { graceMs: Infinity },
    { killWaitMs: NaN },
    { pollMs: 0 },
    { killWaitMs: 60_001 },
    { includeHerdr: "yes" },
  ]) {
    const f = fixture([identity(10)]);
    await assert.rejects(f.stop(options), /Invalid|includeHerdr/);
    assert.equal(f.enumerations, 0);
    assert.deepEqual(f.signals, []);
  }
});

async function disposable(t, title, stubborn = false, environment = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (key.startsWith("HERDR_")) delete env[key];
  const child = spawn(
    process.execPath,
    [
      "-e",
      `process.title = ${JSON.stringify(title)};
       ${stubborn ? 'process.on("SIGTERM", () => {});' : ""}
       setInterval(() => {}, 1000);
       process.stdout.write("ready\\n");`,
    ],
    { stdio: ["ignore", "pipe", "pipe"], env: { ...env, ...environment } },
  );
  const exited = once(child, "exit");
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
    await exited;
  });
  await Promise.race([
    once(child.stdout, "data"),
    exited.then(() => {
      throw new Error("disposable process exited before readiness");
    }),
  ]);
  return { child, exited };
}

test("native Linux inspection and termination are scoped to disposable fixtures only", {
  skip: process.platform !== "linux",
  timeout: 10_000,
}, async (t) => {
  const graceful = await disposable(t, "pi");
  const stubborn = await disposable(t, "pi-rpc", true, {
    HERDR_PANE_ID: "fixture-pane",
    HERDR_SOCKET_PATH: "/fixture/herdr.sock",
  });
  const unrelated = await disposable(t, "inspire-host");
  const native = createLinuxPiProcessAdapter();
  const adapter = {
    ...native,
    // Never enumerate or stop the real user's Pi processes in tests.
    enumerate: async () => [
      graceful.child.pid,
      stubborn.child.pid,
      unrelated.child.pid,
    ],
  };
  const current = await adapter.inspect(stubborn.child.pid);
  assert.equal(current.uid, process.getuid());
  assert.equal(current.title, "pi-rpc");
  assert.equal(current.inHerdr, true);
  assert.equal(current.parentPid, process.pid);
  await assert.rejects(
    assertExternalPiRestartCaller({ pid: stubborn.child.pid }),
    /outside Pi, from an OS terminal/,
  );
  assert.equal((await adapter.inspect(graceful.child.pid)).inHerdr, false);
  assert.match(current.startTime, /^[0-9]+$/);
  const sent = [];
  adapter.signal = (pid, signal) => {
    assert.ok([graceful.child.pid, stubborn.child.pid].includes(pid));
    sent.push([pid, signal]);
    return native.signal(pid, signal);
  };
  await stopAllPiProcesses({
    adapter,
    graceMs: 50,
    killWaitMs: 1_000,
    pollMs: 10,
  });
  await graceful.exited;
  assert.equal(stubborn.child.exitCode, null);
  assert.equal(stubborn.child.signalCode, null);
  await stopAllPiProcesses({
    adapter,
    includeHerdr: true,
    graceMs: 50,
    killWaitMs: 1_000,
    pollMs: 10,
  });
  await stubborn.exited;
  assert.deepEqual(sent, [
    [graceful.child.pid, "SIGTERM"],
    [stubborn.child.pid, "SIGTERM"],
    [stubborn.child.pid, "SIGKILL"],
  ]);
  assert.equal(unrelated.child.exitCode, null);
  assert.equal(unrelated.child.signalCode, null);
});
