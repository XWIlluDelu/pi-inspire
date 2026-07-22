import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PiRpcProcess } from "../../server/pi-rpc.js";

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

  it("starts the installed Pi RPC runtime without invoking a model", async () => {
    const rpc = new PiRpcProcess({ cwd: process.cwd(), args: ["--no-session"] });
    processes.push(rpc);
    await rpc.start();
    const state = await rpc.request<{ sessionId: string; isStreaming: boolean }>({ type: "get_state" }, 60_000);
    expect(state.sessionId).toMatch(/^[0-9a-f-]+$/);
    expect(state.isStreaming).toBe(false);
  }, 90_000);
});
