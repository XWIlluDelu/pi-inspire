import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_RPC_LINE_BYTES,
  MAX_RPC_OUTBOUND_LINE_BYTES,
  PiRpcCancelledError,
  PiRpcOutcomeUnknownError,
  PiRpcProcess,
} from "../../server/pi-rpc.js";

const processes: PiRpcProcess[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(processes.splice(0).map((process) => process.stop()));
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("PiRpcProcess", () => {
  it("marks an explicitly stopped compact request as cancelled, not outcome-unknown", async () => {
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
    const command = JSON.parse(buffer.slice(0, index));
    buffer = buffer.slice(index + 1);
    if (command.type === "get_state") {
      process.stdout.write(JSON.stringify({
        type: "response",
        id: command.id,
        command: command.type,
        success: true,
        data: { isStreaming: false }
      }) + "\\n");
    }
  }
});
`,
      "utf8",
    );
    const rpc = new PiRpcProcess({ cwd: directory, cliPath });
    processes.push(rpc);
    await rpc.start();
    const result = rpc
      .request({ type: "compact" }, 10_000)
      .catch((error: Error) => error);
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    await rpc.stop("compact");
    const failure = await result;
    expect(failure).toBeInstanceOf(PiRpcCancelledError);
    expect(failure).not.toBeInstanceOf(PiRpcOutcomeUnknownError);
  });

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
    const result = await rpc.request<{ value: string }>({
      type: "echo",
      value: "ok",
    });
    expect(result).toEqual({ value: "ok" });
    expect(events).toEqual([{ type: "notice", value: "left right" }]);
    expect(MAX_RPC_LINE_BYTES).toBeGreaterThan(MAX_RPC_OUTBOUND_LINE_BYTES);

    await expect(
      rpc.request({
        type: "oversized",
        value: "x".repeat(MAX_RPC_OUTBOUND_LINE_BYTES),
      }),
    ).rejects.toThrow(
      `Pi RPC stdin line exceeded ${MAX_RPC_OUTBOUND_LINE_BYTES} bytes`,
    );
    await expect(rpc.request({ type: "ping" })).resolves.toEqual({
      isStreaming: false,
    });
  });

  it("flips a response fence before dispatching a following event frame", async () => {
    const directory = await mkdtemp(join(tmpdir(), "inspire-rpc-fence-"));
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
    const response = JSON.stringify({type:"response", id:command.id, command:command.type, success:true, data:{}});
    const event = JSON.stringify({type:"after_response"});
    process.stdout.write(response + "\\n" + event + "\\n");
  }
});
`,
      "utf8",
    );

    const rpc = new PiRpcProcess({ cwd: directory, cliPath });
    processes.push(rpc);
    await rpc.start();
    const fence = { received: false };
    const observed = new Promise<boolean>((resolveEvent) =>
      rpc.once("event", () => resolveEvent(fence.received)),
    );
    await rpc.request({ type: "fenced" }, 30_000, fence);
    expect(fence.received).toBe(true);
    expect(await observed).toBe(true);
  });

  it("retires a worker whose response does not match the pending command", async () => {
    const directory = await mkdtemp(join(tmpdir(), "inspire-rpc-mismatch-"));
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
    process.stdout.write(JSON.stringify({
      type:"response",
      id:command.id,
      command:command.type === "get_state" ? command.type : "another-command",
      success:true,
      data:{isStreaming:false}
    }) + "\\n");
  }
});
`,
      "utf8",
    );

    const rpc = new PiRpcProcess({ cwd: directory, cliPath });
    processes.push(rpc);
    await rpc.start();
    await expect(rpc.request({ type: "mismatched" })).rejects.toBeInstanceOf(
      PiRpcOutcomeUnknownError,
    );
  });

  it("accepts a bounded Pi message echo above the former image-line ceiling", async () => {
    const directory = await mkdtemp(join(tmpdir(), "inspire-rpc-image-echo-"));
    directories.push(directory);
    const cliPath = join(directory, "fake-pi.mjs");
    const imageBytes = 9 * 1024 * 1024;
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
    process.stdout.write(JSON.stringify({
      type:"message_start",
      message:{role:"user", content:[{type:"image", data:"A".repeat(${imageBytes}), mimeType:"image/png"}]}
    }) + "\\n");
    process.stdout.write(JSON.stringify({type:"response", id:command.id, command:command.type, success:true, data:{}}) + "\\n");
  }
});
`,
      "utf8",
    );

    const rpc = new PiRpcProcess({ cwd: directory, cliPath });
    processes.push(rpc);
    const event = new Promise<Record<string, unknown>>((resolveEvent) =>
      rpc.once("event", resolveEvent),
    );
    await rpc.start();
    await rpc.request({ type: "echo-image" });
    const message = (await event).message as {
      content: Array<{ data: string }>;
    };
    expect(message.content[0]?.data).toHaveLength(imageBytes);
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

    const failure = (await rpc
      .request({ type: "die" })
      .catch((error: Error) => error)) as Error & {
      detail?: string;
    };
    expect(failure).toBeInstanceOf(Error);
    // The browser-visible message stays clean; diagnostics ride in `detail`.
    expect(failure.message).not.toContain("super-secret-credential");
    expect(failure.detail).toContain("super-secret-credential");
    expect(exits[0]?.message ?? "").not.toContain("super-secret-credential");
  });

  it("times out a backpressured extension response and retires the worker", async () => {
    const directory = await mkdtemp(join(tmpdir(), "inspire-rpc-ui-stall-"));
    directories.push(directory);
    const cliPath = join(directory, "fake-pi.mjs");
    await writeFile(
      cliPath,
      `let buffer = "";
const consume = chunk => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\\n")) >= 0) {
    const command = JSON.parse(buffer.slice(0, index));
    buffer = buffer.slice(index + 1);
    process.stdout.write(JSON.stringify({type:"response", id:command.id, command:command.type, success:true, data:{isStreaming:false}}) + "\\n");
    process.stdin.off("data", consume);
    process.stdin.pause();
    setInterval(() => undefined, 1_000);
  }
};
process.stdin.setEncoding("utf8");
process.stdin.on("data", consume);
`,
      "utf8",
    );

    const rpc = new PiRpcProcess({ cwd: directory, cliPath });
    processes.push(rpc);
    await rpc.start();
    const exited = new Promise<Error>((resolveExit) =>
      rpc.once("exit", resolveExit),
    );

    let failure: unknown;
    try {
      await rpc.sendExtensionUiResponse(
        { id: "blocked", value: "x".repeat(8 * 1024 * 1024) },
        80,
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(PiRpcOutcomeUnknownError);
    if (!(failure instanceof PiRpcOutcomeUnknownError)) {
      throw new Error("Expected the extension response outcome to be unknown");
    }
    expect(failure.message).toMatch(/stdin write timed out/);
    await failure.stopped;
    expect(await exited).toBe(failure);
    await expect(rpc.request({ type: "second" })).rejects.toThrow(
      /not available/,
    );
  });

  it("marks a written timeout acceptance-unknown, hard-stops, and preserves late disk evidence", async () => {
    const directory = await mkdtemp(join(tmpdir(), "inspire-rpc-unknown-"));
    directories.push(directory);
    const marker = join(directory, "persisted.txt");
    const cliPath = join(directory, "fake-pi.mjs");
    await writeFile(
      cliPath,
      `import { writeFileSync } from "node:fs";
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
});`,
      "utf8",
    );
    const rpc = new PiRpcProcess({ cwd: directory, cliPath });
    processes.push(rpc);
    await rpc.start();
    const exited = new Promise<Error>((resolveExit) =>
      rpc.once("exit", resolveExit),
    );
    const failure = await rpc
      .request({ type: "late" }, 80)
      .catch((error: Error) => error);
    expect(failure).toBeInstanceOf(PiRpcOutcomeUnknownError);
    await (failure as PiRpcOutcomeUnknownError).stopped;
    expect(await exited).toBe(failure);
    expect(
      await import("node:fs/promises").then(({ readFile }) =>
        readFile(marker, "utf8"),
      ),
    ).toBe("committed");
    await expect(rpc.request({ type: "second" })).rejects.toThrow(
      /not available/,
    );
  });

  it("retires a stalled read without reporting a mutation outcome conflict", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "inspire-rpc-read-timeout-"),
    );
    directories.push(directory);
    const cliPath = join(directory, "fake-pi.mjs");
    await writeFile(
      cliPath,
      `let buffer = "";
let reads = 0;
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\\n")) >= 0) {
    const command = JSON.parse(buffer.slice(0, index));
    buffer = buffer.slice(index + 1);
    reads += 1;
    if (reads === 1) {
      process.stdout.write(JSON.stringify({type:"response", id:command.id, command:command.type, success:true, data:{isStreaming:false}}) + "\\n");
    }
  }
});`,
      "utf8",
    );
    const rpc = new PiRpcProcess({ cwd: directory, cliPath });
    processes.push(rpc);
    await rpc.start();
    const exited = new Promise<Error>((resolveExit) =>
      rpc.once("exit", resolveExit),
    );

    const failure = await rpc
      .request({ type: "get_state" }, 80)
      .catch((error: Error) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(PiRpcOutcomeUnknownError);
    expect(await exited).toBe(failure);
    await expect(rpc.request({ type: "second" })).rejects.toThrow(
      /not available/,
    );
  });

  it("accepts a complete final response when stdout closes without a newline", async () => {
    const directory = await mkdtemp(join(tmpdir(), "inspire-rpc-final-line-"));
    directories.push(directory);
    const cliPath = join(directory, "fake-pi.mjs");
    await writeFile(
      cliPath,
      `let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\\n")) >= 0) {
    const command = JSON.parse(buffer.slice(0, index));
    buffer = buffer.slice(index + 1);
    const response = JSON.stringify({type:"response", id:command.id, command:command.type, success:true, data:{isStreaming:false}});
    if (command.type === "final") {
      process.stdout.end(response, () => process.exit(0));
    } else {
      process.stdout.write(response + "\\n");
    }
  }
});
`,
      "utf8",
    );
    const rpc = new PiRpcProcess({ cwd: directory, cliPath });
    const exited = new Promise<Error>((resolve) => rpc.once("exit", resolve));
    await rpc.start();

    await expect(rpc.request({ type: "final" }, 10_000)).resolves.toEqual({
      isStreaming: false,
    });
    await expect(exited).resolves.toMatchObject({
      message: "Pi RPC stdout closed unexpectedly",
    });
  });

  it("terminates a child that emits malformed JSONL instead of hanging its request", async () => {
    const directory = await mkdtemp(join(tmpdir(), "inspire-rpc-malformed-"));
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
    if (command.type === "malformed") {
      process.stdout.write("{broken\\n");
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
    const exited = new Promise<Error>((resolveExit) =>
      rpc.once("exit", resolveExit),
    );
    await rpc.start();

    await expect(
      rpc.request({ type: "malformed" }, 10_000),
    ).rejects.toBeInstanceOf(PiRpcOutcomeUnknownError);
    await expect(exited).resolves.toMatchObject({
      message: "Pi RPC stdout contained a malformed frame",
    });
    await expect(rpc.request({ type: "second" })).rejects.toThrow(
      /not available/,
    );
  });

  it("terminates a child that emits non-UTF-8 JSONL", async () => {
    const directory = await mkdtemp(join(tmpdir(), "inspire-rpc-utf8-"));
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
    if (command.type === "invalid_utf8") {
      process.stdout.write(Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d, 0x0a]));
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
    const exited = new Promise<Error>((resolveExit) =>
      rpc.once("exit", resolveExit),
    );
    await rpc.start();

    await expect(
      rpc.request({ type: "invalid_utf8" }, 10_000),
    ).rejects.toBeInstanceOf(PiRpcOutcomeUnknownError);
    await expect(exited).resolves.toMatchObject({
      message: "Pi RPC stdout was not valid UTF-8",
    });
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

    await expect(
      rpc.request({ type: "overflow" }, 10_000),
    ).rejects.toBeInstanceOf(PiRpcOutcomeUnknownError);
    expect(exits).toHaveLength(1);
    expect(exits[0]?.message).toContain(
      `Pi RPC stdout line exceeded ${MAX_RPC_LINE_BYTES} bytes`,
    );
  });

  it("terminates tool descendants with their Pi worker", async () => {
    const directory = await mkdtemp(join(tmpdir(), "inspire-rpc-tree-"));
    directories.push(directory);
    const marker = join(directory, "child.pid");
    const cliPath = join(directory, "fake-pi.mjs");
    await writeFile(
      cliPath,
      `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const tool = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });
writeFileSync(${JSON.stringify(marker)}, String(tool.pid));
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\\n")) >= 0) {
    const command = JSON.parse(buffer.slice(0, index));
    buffer = buffer.slice(index + 1);
    process.stdout.write(JSON.stringify({type:"response", id:command.id, command:command.type, success:true, data:{isStreaming:false}}) + "\\n");
  }
});`,
      "utf8",
    );
    const rpc = new PiRpcProcess({ cwd: directory, cliPath });
    processes.push(rpc);
    await rpc.start();
    const childPid = Number(await readFile(marker, "utf8"));

    await rpc.stop();
    let alive = true;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        process.kill(childPid, 0);
        await new Promise((resolve) => setTimeout(resolve, 10));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") {
          alive = false;
          break;
        }
        throw error;
      }
    }
    expect(alive).toBe(false);
  });

  it("starts the installed Pi RPC runtime without invoking a model", async () => {
    const rpc = new PiRpcProcess({
      cwd: process.cwd(),
      args: ["--no-session"],
    });
    processes.push(rpc);
    await rpc.start();
    const state = await rpc.request<{
      sessionId: string;
      isStreaming: boolean;
    }>({ type: "get_state" }, 60_000);
    expect(state.sessionId).toMatch(/^[0-9a-f-]+$/);
    expect(state.isStreaming).toBe(false);
  }, 90_000);
});
