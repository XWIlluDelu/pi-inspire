import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  inspectInstance,
  stopManagedInstance,
} from "../../server/instance-state.mjs";

const directories = [];
after(async () => {
  await Promise.all(
    directories.map((path) => rm(path, { recursive: true, force: true })),
  );
});

function childServer(path, token) {
  const source = String.raw`
    import { createServer } from "node:http";
    const { InstanceHttpControl } = await import(process.argv[1]);
    const { processStartIdentity, writeInstanceState, completeInstanceShutdown,
      removeInstanceState, watchInstanceShutdown } = await import(process.argv[2]);
    const path = process.argv[3];
    const token = process.argv[4];
    const control = new InstanceHttpControl();
    let state;
    const server = createServer(async (request, response) => {
      if (request.headers.authorization || request.url !== "/api/host/local-control") {
        response.writeHead(401).end();
        return;
      }
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const grant = control.accept(state, JSON.parse(Buffer.concat(chunks)));
      if (!grant) return response.writeHead(401).end();
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(control.reply(grant, { appName: "inspire", mock: false })));
    });
    server.listen(0, "127.0.0.1", async () => {
      state = {
        schemaVersion: 1, pid: process.pid, root: process.cwd(), host: "127.0.0.1",
        port: server.address().port, token, startedAt: new Date().toISOString(),
        processStartTime: await processStartIdentity(process.pid), mock: false,
        shutdownControlVersion: 1, httpControlVersion: 1,
      };
      await writeInstanceState(path, state);
      const close = watchInstanceShutdown(path, state, async () => {
        close();
        server.close(async () => {
          await completeInstanceShutdown(path, state, true);
          await removeInstanceState(path, state);
          process.exit(0);
        });
      });
      process.stdout.write(JSON.stringify(state) + "\n");
    });
  `;
  return spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      source,
      new URL("../../server/instance-control.mjs", import.meta.url).href,
      new URL("../../server/instance-state.mjs", import.meta.url).href,
      path,
      token,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
}

async function firstLine(stream) {
  return new Promise((resolve, reject) => {
    let value = "";
    const onData = (chunk) => {
      value += String(chunk);
      const newline = value.indexOf("\n");
      if (newline < 0) return;
      cleanup();
      resolve(value.slice(0, newline));
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      stream.off("data", onData);
      stream.off("error", onError);
    };
    stream.on("data", onData);
    stream.on("error", onError);
  });
}

test("inspects a proven Host and stops it without sending a bearer", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "inspire-instance-proof-"));
  directories.push(directory);
  const path = join(directory, "instance.json");
  const child = childServer(path, "portable-lifecycle-token");
  context.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGKILL");
    await exited;
  });
  const state = JSON.parse(await firstLine(child.stdout));
  const expected = {
    root: state.root,
    host: state.host,
    port: state.port,
    mock: false,
  };
  assert.equal((await inspectInstance(path, expected)).kind, "healthy");
  const stopped = await stopManagedInstance(path, expected, {
    timeoutMs: 5_000,
  });
  assert.equal(stopped.kind, "stopped");
});
