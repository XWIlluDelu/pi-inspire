import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({
  spawn: null,
  processFile: null,
  write: null,
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    spawn: (...args) => hooks.spawn?.(...args) ?? actual.spawn(...args),
  };
});
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    readFile: (path, ...args) =>
      hooks.processFile?.("readFile", path) ?? actual.readFile(path, ...args),
    readlink: (path, ...args) =>
      hooks.processFile?.("readlink", path) ?? actual.readlink(path, ...args),
    stat: (path, ...args) =>
      hooks.processFile?.("stat", path) ?? actual.stat(path, ...args),
    writeFile: (path, ...args) =>
      hooks.write?.(path) ?? actual.writeFile(path, ...args),
  };
});

import { runSshReverseAction } from "../../connections/ssh-reverse/runner.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Real private files and kernel locks; SSH/systemd and /proc identities are
 * synthetic. No remote connection or existing process is ever controlled. */
describe.runIf(process.platform === "linux")(
  "direct SSH reverse lifecycle",
  () => {
    let fixture, root, server, masters, launches, commands, signals, nextLaunch;
    const pending = [];
    const gates = [];
    const action = (name) => {
      const promise = runSshReverseAction(root, name);
      pending.push(promise);
      void promise.catch(() => {});
      return promise;
    };
    const holdLaunch = () => {
      const gate = { entered: deferred(), release: deferred() };
      gates.push(gate);
      nextLaunch = gate;
      return gate;
    };

    beforeEach(async () => {
      fixture = await mkdtemp(join(tmpdir(), "inspire-ssh-lifecycle-"));
      root = join(fixture, "root");
      await mkdir(root);
      vi.stubEnv("XDG_CONFIG_HOME", join(fixture, "config"));
      vi.stubEnv("XDG_STATE_HOME", join(fixture, "state"));
      const config = join(fixture, "connection.env");
      vi.stubEnv("INSPIRE_SSH_REVERSE_CONFIG", config);
      server = createServer((socket) => socket.end());
      await new Promise((done) => server.listen(0, "127.0.0.1", done));
      await writeFile(
        config,
        `INSPIRE_SSH_TARGET=synthetic-relay\nINSPIRE_SSH_REMOTE_PORT=14587\nINSPIRE_SSH_LOCAL_PORT=${server.address().port}\n`,
        { mode: 0o600 },
      );
      masters = new Map();
      launches = [];
      commands = [];
      signals = [];
      nextLaunch = null;
      vi.spyOn(console, "log").mockImplementation(() => {});
      const kill = process.kill.bind(process);
      vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
        const master = masters.get(pid);
        if (!master) {
          if (signal !== 0)
            throw new Error("Unexpected signal to a real process");
          return kill(pid, 0);
        }
        if (!master.alive)
          throw Object.assign(new Error("gone"), { code: "ESRCH" });
        if (signal !== 0) {
          signals.push({ pid, signal });
          master.alive = false;
        }
        return true;
      });
      hooks.processFile = (method, path) => {
        const match = /^\/proc\/(\d+)(?:\/(stat|cmdline|cwd))?$/.exec(
          String(path),
        );
        const master = match && masters.get(Number(match[1]));
        if (!master) return undefined;
        if (!master.alive)
          return Promise.reject(
            Object.assign(new Error("gone"), { code: "ENOENT" }),
          );
        if (method === "stat")
          return Promise.resolve({ uid: process.getuid() });
        if (method === "readlink") return Promise.resolve(root);
        if (match[2] === "cmdline")
          return Promise.resolve(
            `ssh\0-M\0-S\0${master.controlPath}\0synthetic-relay\0`,
          );
        return Promise.resolve(
          `${master.pid} (ssh) S ${Array(18).fill("0").join(" ")} ${master.birth}`,
        );
      };
      hooks.spawn = (command, args) => {
        if (command !== "ssh" && command !== "systemctl") return undefined;
        const child = new EventEmitter();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        commands.push([command, ...args]);
        queueMicrotask(async () => {
          let code = 0;
          try {
            if (command === "systemctl") code = 3;
            else {
              const controlPath = args[args.indexOf("-S") + 1];
              const operation = args.includes("-O")
                ? args[args.indexOf("-O") + 1]
                : null;
              if (operation) {
                const master = [...masters.values()].find(
                  (m) =>
                    m.alive &&
                    m.controlPath === controlPath &&
                    existsSync(controlPath),
                );
                if (!master || (operation === "exit" && master.rejectExit))
                  code = 1;
                else if (operation === "check")
                  child.stderr.write(`Master running (pid=${master.pid})\n`);
                else if (operation === "exit") {
                  master.alive = false;
                  await rm(controlPath, { force: true });
                }
              } else if ([...masters.values()].some((m) => m.alive)) {
                code = 1;
                child.stderr.write("remote port forwarding failed\n");
              } else {
                const master = {
                  pid: 10_000_000 + masters.size,
                  birth: "12345",
                  controlPath,
                  alive: true,
                  rejectExit: false,
                };
                masters.set(master.pid, master);
                launches.push(master);
                await writeFile(controlPath, "synthetic control socket");
                const gate = nextLaunch;
                nextLaunch = null;
                if (gate) {
                  gate.entered.resolve(master);
                  await gate.release.promise;
                }
              }
            }
          } catch (error) {
            code = 1;
            child.stderr.write(String(error));
          }
          child.stdout.end();
          child.stderr.end();
          child.emit("exit", code);
          child.emit("close", code);
        });
        return child;
      };
    });

    afterEach(async () => {
      for (const gate of gates.splice(0)) gate.release.resolve();
      await Promise.allSettled(pending.splice(0));
      hooks.spawn = hooks.processFile = hooks.write = null;
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
      await new Promise((done) => server.close(done));
      await rm(fixture, { recursive: true, force: true });
    });

    const assertWaiting = async (promise) => {
      expect(
        await Promise.race([
          promise.then(
            () => "settled",
            () => "settled",
          ),
          delay(100, "waiting"),
        ]),
      ).toBe("waiting");
    };

    it("serializes overlapping starts without unlinking a live control socket", async () => {
      const gate = holdLaunch();
      const first = action("start");
      const master = await gate.entered.promise;
      const second = action("start");
      await assertWaiting(second);
      expect(existsSync(master.controlPath)).toBe(true);
      gate.release.resolve();
      await Promise.all([first, second]);
      expect(launches).toHaveLength(1);
      const statePath = join(dirname(master.controlPath), "state.json");
      expect(JSON.parse(await readFile(statePath, "utf8")).pid).toBe(
        master.pid,
      );
      await action("stop");
      expect(master.alive).toBe(false);
      expect(existsSync(statePath)).toBe(false);
    });

    it("waits for an in-progress start before stopping its published tunnel", async () => {
      const gate = holdLaunch();
      const start = action("start");
      const master = await gate.entered.promise;
      const stop = action("stop");
      await assertWaiting(stop);
      gate.release.resolve();
      await Promise.all([start, stop]);
      expect(master.alive).toBe(false);
      expect(existsSync(master.controlPath)).toBe(false);
    });

    it("holds one lock through both phases of restart", async () => {
      await action("start");
      const gate = holdLaunch();
      const restart = action("restart");
      const master = await gate.entered.promise;
      const concurrentStart = action("start");
      await assertWaiting(concurrentStart);
      gate.release.resolve();
      await Promise.all([restart, concurrentStart]);
      expect(launches).toHaveLength(2);
      expect(launches[0].alive).toBe(false);
      expect(master.alive).toBe(true);
      await action("stop");
    });

    it("retires its verified launch when state publication fails, then allows retry", async () => {
      hooks.write = (path) => {
        if (!String(path).includes("state.json.")) return undefined;
        hooks.write = null;
        launches.at(-1).rejectExit = true;
        return Promise.reject(new Error("synthetic state publication failure"));
      };
      await expect(action("start")).rejects.toThrow(
        "synthetic state publication failure",
      );
      const master = launches[0];
      expect(master.alive).toBe(false);
      expect(signals).toEqual([{ pid: master.pid, signal: "SIGTERM" }]);
      expect(existsSync(master.controlPath)).toBe(false);
      expect(existsSync(join(dirname(master.controlPath), "state.json"))).toBe(
        false,
      );
      await action("start");
      expect(launches).toHaveLength(2);
      await action("stop");
    });

    it("preserves a live tunnel with a missing socket until an identity-checked stop", async () => {
      await action("start");
      const master = launches[0];
      await rm(master.controlPath);
      await expect(action("start")).rejects.toThrow("still running");
      expect(launches).toHaveLength(1);
      expect(existsSync(join(dirname(master.controlPath), "state.json"))).toBe(
        true,
      );
      await action("stop");
      expect(master.alive).toBe(false);
      expect(signals).toEqual([{ pid: master.pid, signal: "SIGTERM" }]);
    });

    it("does not stop a changed process identity during failed-publication cleanup", async () => {
      hooks.write = (path) => {
        if (!String(path).includes("state.json.")) return undefined;
        hooks.write = null;
        launches.at(-1).birth = "different-process";
        return Promise.reject(new Error("synthetic state publication failure"));
      };
      await expect(action("start")).rejects.toThrow(
        "synthetic state publication failure",
      );
      expect(launches[0].alive).toBe(true);
      expect(signals).toEqual([]);
      expect(commands.filter((args) => args.includes("exit"))).toHaveLength(0);
      expect(existsSync(launches[0].controlPath)).toBe(true);
    });
  },
);
