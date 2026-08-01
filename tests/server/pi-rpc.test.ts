import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_RPC_LINE_BYTES, PiRpcOutcomeUnknownError, PiRpcProcess } from "../../server/pi-rpc.js";

const processes: PiRpcProcess[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(processes.splice(0).map((process) => process.stop()));
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("PiRpcProcess", () => {
  it("uses LF-only JSONL framing and correlates responses", async () => {
    const directory = await mkdtemp(join(tmpdir(), "inspire-rpc-"));
    directories.push(directory);
    const cliPath = join(directory, "fake-pi.mjs");
    await writeFile(
      cliPath,
      `let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, index).replace(/\\r$/, "");
    buffer = buffer.slice(index + 1);
    const command = JSON.parse(line);
    if (command.type === "echo") {
      process.stdout.write(JSON.stringify({type:"notice", value:"left\\u2028right"}) + "\\n");
      process.stdout.write(JSON.stringify({type:"response", id:command.id, command:"echo", success:true, data:{value:command.value}}) + "\\n");
    } else {
      process.stdout.write(JSON.stringify({type:"response", id:command.id, command:command.type, success:true, data:{isStreaming:false}}) + "\\n");
    }
  }
});
`,
      "utf8",
    );

    const rpc = new PiRpcProcess({ cwd: directory, cliPath });
    processes.push(rpc);
    const events: unknown[] = [];
    rpc.on("event", (event) => events.push(event));
    await rpc.start();
    const result = await rpc.request<{ value: string }>({ type: "echo", value: "ok" });
    expect(result).toEqual({ value: "ok" });
    expect(events).toEqual([{ type: "notice", value: "left right" }]);
  });

  it("keeps stderr out of error messages, carrying it as host-side detail", async () => {
    const directory = await mkdtemp(join(tmpdir(), "inspire-rpc-stderr-"));
    directories.push(directory);
    const cliPath = join(directory, "fake-pi.mjs");
    await writeFile(
      cliPath,
      `let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    const command = JSON.parse(line);
    if (command.type === "die") {
      process.stderr.write("token=super-secret-credential\\n");
      process.exit(1);
    }
    process.stdout.write(JSON.stringify({type:"response", id:command.id, command:command.type, success:true, data:{}}) + "\\n");
  }
});
`,
      "utf8",
    );

    const rpc = new PiRpcProcess({ cwd: directory, cliPath });
    processes.push(rpc);
    const exits: Error[] = [];
    rpc.on("exit", (error: Error) => exits.push(error));
    await rpc.start();
    await rpc.request({ type: "ping" });

    const failure = (await rpc.request({ type: "die" }).catch((error: Error) => error)) as Error & {
      detail?: string;
    };
    expect(failure).toBeInstanceOf(Error);
    // The browser-visible message stays clean; diagnostics ride in `detail`.
    expect(failure.message).not.toContain("super-secret-credential");
    expect(failure.detail).toContain("super-secret-credential");
    expect(exits[0]?.message ?? "").not.toContain("super-secret-credential");
  });

  it("marks a written timeout acceptance-unknown, hard-stops, and preserves late disk evidence", async () => {
    const directory = await mkdtemp(join(tmpdir(), "inspire-rpc-unknown-"));
    directories.push(directory);
    const marker = join(directory, "persisted.txt");
    const cliPath = join(directory, "fake-pi.mjs");
    await writeFile(cliPath, `import { writeFileSync } from "node:fs";
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\\n")) >= 0) {
    const command = JSON.parse(buffer.slice(0, index));
    buffer = buffer.slice(index + 1);
    if (command.type === "late") {
      setTimeout(() => writeFileSync(${JSON.stringify(marker)}, "committed"), 10);
    } else {
      process.stdout.write(JSON.stringify({type:"response", id:command.id, command:command.type, success:true, data:{}}) + "\\n");
    }
  }
});`, "utf8");
    const rpc = new PiRpcProcess({ cwd: directory, cliPath });
    processes.push(rpc);
    await rpc.start();
    const exited = new Promise<Error>((resolveExit) => rpc.once("exit", resolveExit));
    const failure = await rpc.request({ type: "late" }, 80).catch((error: Error) => error);
    expect(failure).toBeInstanceOf(PiRpcOutcomeUnknownError);
    await (failure as PiRpcOutcomeUnknownError).stopped;
    expect(await exited).toBe(failure);
    expect(await import("node:fs/promises").then(({ readFile }) => readFile(marker, "utf8"))).toBe("committed");
    await expect(rpc.request({ type: "second" })).rejects.toThrow(/not available/);
  });

  it("terminates a child that emits an oversized unterminated JSONL line", async () => {
    const directory = await mkdtemp(join(tmpdir(), "inspire-rpc-line-limit-"));
    directories.push(directory);
    const cliPath = join(directory, "fake-pi.mjs");
    await writeFile(
      cliPath,
      `let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\\n")) >= 0) {
    const command = JSON.parse(buffer.slice(0, index));
    buffer = buffer.slice(index + 1);
    if (command.type === "overflow") {
      process.stdout.write("x".repeat(${MAX_RPC_LINE_BYTES + 1}));
    } else {
      process.stdout.write(JSON.stringify({type:"response", id:command.id, command:command.type, success:true, data:{}}) + "\\n");
    }
  }
});
`,
      "utf8",
    );

    const rpc = new PiRpcProcess({ cwd: directory, cliPath });
    processes.push(rpc);
    const exits: Error[] = [];
    rpc.on("exit", (error: Error) => exits.push(error));
    await rpc.start();

    await expect(rpc.request({ type: "overflow" }, 10_000)).rejects.toBeInstanceOf(PiRpcOutcomeUnknownError);
    expect(exits).toHaveLength(1);
    expect(exits[0]?.message).toContain(`Pi RPC stdout line exceeded ${MAX_RPC_LINE_BYTES} bytes`);
  });

  it("starts the installed Pi RPC runtime without invoking a model", async () => {
    const rpc = new PiRpcProcess({ cwd: process.cwd(), args: ["--no-session"] });
    processes.push(rpc);
    await rpc.start();
    const state = await rpc.request<{ sessionId: string; isStreaming: boolean }>({ type: "get_state" }, 60_000);
    expect(state.sessionId).toMatch(/^[0-9a-f-]+$/);
    expect(state.isStreaming).toBe(false);
  }, 90_000);
});
