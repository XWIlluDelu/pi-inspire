import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  INSTANCE_STATE_VERSION,
  inspectInstance,
  processStartIdentity,
  stopManagedInstance,
  writeInstanceState,
} from "../../server/instance-state.mjs";

const directories = [];
after(async () => {
  await Promise.all(
    directories.map((path) => rm(path, { recursive: true, force: true })),
  );
});

function childServer(token) {
  const source = String.raw`
    const http = require("node:http");
    const token = process.argv[1];
    const server = http.createServer((request, response) => {
      if (request.headers.authorization !== "Bearer " + token) {
        response.writeHead(401).end();
        return;
      }
      if (request.method === "GET" && request.url === "/api/health") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ appName: "inspire", mock: false }));
        return;
      }
      if (request.method === "POST" && request.url === "/api/host/shutdown") {
        response.writeHead(202).end();
        setImmediate(() => server.close(() => process.exit(0)));
        return;
      }
      response.writeHead(404).end();
    });
    server.listen(0, "127.0.0.1", () => {
      process.stdout.write(String(server.address().port) + "\n");
    });
  `;
  return spawn(process.execPath, ["-e", source, token], {
    stdio: ["ignore", "pipe", "inherit"],
  });
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

test("inspects and stops a healthy Host through authenticated HTTP", async () => {
  const directory = await mkdtemp(join(tmpdir(), "inspire-instance-http-"));
  directories.push(directory);
  const path = join(directory, "instance.json");
  const token = "portable-lifecycle-token";
  const child = childServer(token);
  const port = Number(await firstLine(child.stdout));
  const state = {
    schemaVersion: INSTANCE_STATE_VERSION,
    pid: child.pid,
    root: process.cwd(),
    host: "127.0.0.1",
    port,
    token,
    startedAt: new Date().toISOString(),
    processStartTime: await processStartIdentity(child.pid),
    mock: false,
  };
  await writeInstanceState(path, state);
  const expected = {
    root: state.root,
    host: state.host,
    port: state.port,
    mock: false,
  };
  await assert.doesNotReject(async () => {
    const inspected = await inspectInstance(path, expected);
    assert.equal(inspected.kind, "healthy");
  });
  const stopped = await stopManagedInstance(path, expected, {
    timeoutMs: 5_000,
  });
  assert.equal(stopped.kind, "stopped");
});
