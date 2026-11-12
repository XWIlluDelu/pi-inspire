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

// Use a real child and pipes. Each case supplies only the wire behavior that
// differs from an ordinary reply; the production client owns the input parser.
async function rpcFixture(
  receive: string,
  setup = "",
  environment: (directory: string) => NodeJS.ProcessEnv = () => ({}),
) {
  const directory = await mkdtemp(join(tmpdir(), "inspire-rpc-"));
  directories.push(directory);
  const cliPath = join(directory, "fake-pi.mjs");
  await writeFile(
    cliPath,
    [
      'import { createInterface } from "node:readline";',
      setup,
      'const send = frame => process.stdout.write(JSON.stringify(frame) + "\\n");',
      "const response = (command, data = { isStreaming: false }) => ({",
      '  type: "response", id: command.id, command: command.type, success: true, data,',
      "});",
      "const input = createInterface({ input: process.stdin });",
      'input.on("line", line => {',
      "  const command = JSON.parse(line);",
      receive,
      "  send(response(command));",
      "});",
    ].join("\n"),
  );
  const rpc = new PiRpcProcess({
    cwd: directory,
    cliPath,
    env: environment(directory),
  });
  processes.push(rpc);
  return { rpc, directory };
}

const nextExit = (rpc: PiRpcProcess) =>
  new Promise<Error>((resolve) => rpc.once("exit", resolve));

describe("Pi RPC over real child-process pipes", () => {
  it.each([undefined, "", "test"])(
    "preserves the caller's exports through a Pi subprocess (NODE_ENV %j)",
    async (nodeEnv) => {
      const { rpc, directory } = await rpcFixture(
        'send(response(command, JSON.parse(execFileSync(process.execPath, ["-p", expression], { encoding: "utf8" })))); return;',
        [
          'import { execFileSync } from "node:child_process";',
          'const expression = "JSON.stringify({ nodeEnv: process.env.NODE_ENV ?? null, custom: process.env.USER_EXPORT, path: process.env.PATH })";',
        ].join("\n"),
        (directory) => ({
          NODE_ENV: nodeEnv,
          USER_EXPORT: "caller-value",
          PATH: directory,
        }),
      );
      await rpc.start();
      await expect(rpc.request({ type: "get_state" })).resolves.toEqual({
        nodeEnv: nodeEnv ?? null,
        custom: "caller-value",
        path: directory,
      });
    },
  );

  it("cancels a stopped compaction with a pending response", async () => {
    const { rpc } = await rpcFixture('if (command.type === "compact") return;');
    await rpc.start();
    const pending = rpc.request({ type: "compact" }, null);
    const cancelled =
      expect(pending).rejects.toBeInstanceOf(PiRpcCancelledError);
    // Fence the write without relying on an arbitrary sleep.
    await rpc.request({ type: "get_state" });
    await rpc.stop("compact");
    await cancelled;
  });

  it("correlates replies, preserves Unicode line separators, and rejects oversized input without stopping Pi", async () => {
    const { rpc } = await rpcFixture(
      [
        'if (command.type === "echo") {',
        '  send({ type: "notice", value: "left\\u2028right" });',
        "  send(response(command, { value: command.value }));",
        "  return;",
        "}",
      ].join("\n"),
    );
    const notice = new Promise<unknown>((resolve) =>
      rpc.once("event", resolve),
    );
    await rpc.start();
    await expect(rpc.request({ type: "echo", value: "ok" })).resolves.toEqual({
      value: "ok",
    });
    await expect(notice).resolves.toEqual({
      type: "notice",
      value: "left\u2028right",
    });

    await expect(
      rpc.request({
        type: "oversized",
        value: "x".repeat(MAX_RPC_OUTBOUND_LINE_BYTES),
      }),
    ).rejects.toThrow(/Pi RPC stdin line exceeded/);
    await expect(rpc.request({ type: "get_state" })).resolves.toEqual({
      isStreaming: false,
    });
  });

  it("flips a response fence before dispatching the next frame in the same chunk", async () => {
    const { rpc } = await rpcFixture(
      [
        'if (command.type === "fenced") {',
        '  process.stdout.write(JSON.stringify(response(command)) + "\\n" + JSON.stringify({ type: "after_response" }) + "\\n");',
        "  return;",
        "}",
      ].join("\n"),
    );
    await rpc.start();
    const fence = { received: false };
    const observed = new Promise<boolean>((resolve) =>
      rpc.once("event", () => resolve(fence.received)),
    );
    await rpc.request({ type: "fenced" }, 30_000, fence);
    expect(await observed).toBe(true);
  });

  it("accepts a Pi message echo larger than the outbound budget", async () => {
    const imageBytes = 9 * 1024 * 1024;
    const { rpc } = await rpcFixture(
      'if (command.type === "echo-image") send({ type: "message_start", message: { role: "user", content: [{ type: "image", data: "A".repeat(' +
        imageBytes +
        '), mimeType: "image/png" }] } });',
    );
    await rpc.start();
    const event = new Promise<Record<string, unknown>>((resolve) =>
      rpc.once("event", resolve),
    );
    await rpc.request({ type: "echo-image" });
    const message = (await event).message as {
      content: Array<{ data: string }>;
    };
    expect(message.content[0]?.data).toHaveLength(imageBytes);
  });

  it("keeps stderr out of exposed error messages and carries it as Host detail", async () => {
    const { rpc } = await rpcFixture(
      [
        'if (command.type === "die") {',
        '  process.stderr.write("token=synthetic-secret\\n", () => process.exit(1));',
        "  return;",
        "}",
      ].join("\n"),
    );
    const exited = nextExit(rpc);
    await rpc.start();
    const failure = (await rpc
      .request({ type: "die" })
      .catch((error) => error)) as Error & { detail?: string };
    expect(failure.message).not.toContain("synthetic-secret");
    expect(failure.detail).toContain("synthetic-secret");
    expect((await exited).message).not.toContain("synthetic-secret");
  });

  it("retires the writer after an extension response cannot drain stdin", async () => {
    const { rpc } = await rpcFixture(
      [
        "send(response(command));",
        "input.close();",
        "process.stdin.pause();",
        "setInterval(() => {}, 1000);",
        "return;",
      ].join("\n"),
    );
    await rpc.start();
    const exited = nextExit(rpc);
    const failure = await rpc
      .sendExtensionUiResponse(
        { id: "blocked", value: "x".repeat(8 * 1024 * 1024) },
        80,
      )
      .catch((error: unknown) => error);
    if (!(failure instanceof PiRpcOutcomeUnknownError)) {
      throw new Error("Expected unknown extension response outcome", {
        cause: failure,
      });
    }
    expect(failure.message).toMatch(/stdin write timed out/);
    await failure.stopped;
    expect(await exited).toBe(failure);
    expect(rpc.available).toBe(false);
  });

  it("keeps real writes and later reads usable across retired response waits", async () => {
    const { rpc, directory } = await rpcFixture(
      [
        'if (command.type === "prompt" || command.type === "get_tree") {',
        '  if (command.type === "prompt") writeFileSync("persisted.txt", "committed");',
        "  delayed.push(response(command));",
        "  return;",
        "}",
        "for (const frame of delayed.splice(0)) send(frame);",
      ].join("\n"),
      'import { writeFileSync } from "node:fs"; const delayed = [];',
    );
    await rpc.start();
    const fence = { received: false };
    const [mutation, read] = await Promise.allSettled([
      rpc.request({ type: "prompt" }, 80, fence),
      rpc.request({ type: "get_tree" }, 80),
    ]);
    expect(mutation).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({ stopped: null }),
    });
    expect(mutation.status === "rejected" && mutation.reason).toBeInstanceOf(
      PiRpcOutcomeUnknownError,
    );
    expect(read).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({
        message: "Pi command get_tree response timed out",
      }),
    });
    expect(fence.received).toBe(false);

    await expect(rpc.request({ type: "get_state" })).resolves.toEqual({
      isStreaming: false,
    });
    expect(fence.received).toBe(true);
    expect(await readFile(join(directory, "persisted.txt"), "utf8")).toBe(
      "committed",
    );
  });

  it("accepts a complete final response when stdout closes without LF", async () => {
    const { rpc } = await rpcFixture(
      [
        'if (command.type === "final") {',
        "  process.stdout.end(JSON.stringify(response(command)), () => process.exit(0));",
        "  return;",
        "}",
      ].join("\n"),
    );
    const exited = nextExit(rpc);
    await rpc.start();
    await expect(rpc.request({ type: "final" })).resolves.toEqual({
      isStreaming: false,
    });
    await expect(exited).resolves.toMatchObject({
      message: "Pi RPC stdout closed unexpectedly",
    });
  });

  it.each([
    [
      "malformed JSON",
      'process.stdout.write("{broken\\n");',
      /malformed frame/,
    ],
    [
      "invalid UTF-8",
      "process.stdout.write(Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d, 0x0a]));",
      /not valid UTF-8/,
    ],
    [
      "oversized unterminated line",
      'process.stdout.write("x".repeat(' + (MAX_RPC_LINE_BYTES + 1) + "));",
      /stdout line exceeded/,
    ],
    [
      "mismatched command",
      'send({ ...response(command), command: "wrong" });',
      /malformed frame/,
    ],
  ])("retires the writer on %s", async (_name, output, message) => {
    const { rpc } = await rpcFixture(
      'if (command.type === "break_protocol") { ' + output + " return; }",
    );
    const exited = nextExit(rpc);
    await rpc.start();
    await expect(
      rpc.request({ type: "break_protocol" }),
    ).rejects.toBeInstanceOf(PiRpcOutcomeUnknownError);
    await expect(exited).resolves.toMatchObject({
      message: expect.stringMatching(message),
    });
    await expect(rpc.request({ type: "get_state" })).rejects.toThrow(
      /not available/,
    );
  });

  it.each(["graceful", "protocol-failure"])(
    "terminates a SIGTERM-resistant worker tree after %s",
    async (mode) => {
      const { rpc, directory } = await rpcFixture(
        [
          "void ready.then(() => {",
          '  if (command.type === "break_protocol") process.stdout.write("{malformed\\n");',
          "  else send(response(command));",
          "});",
          "return;",
        ].join("\n"),
        [
          'import { spawn } from "node:child_process";',
          'import { writeFileSync } from "node:fs";',
          'process.on("SIGTERM", () => {});',
          'const tool = spawn(process.execPath, ["-e", "process.on(\\\"SIGTERM\\\", () => {}); process.stdout.write(\\\"ready\\\"); setInterval(() => {}, 1000)"], { stdio: ["ignore", "pipe", "ignore"] });',
          'const ready = new Promise(resolve => tool.stdout.once("data", resolve));',
          'writeFileSync("child.pid", String(tool.pid));',
        ].join("\n"),
      );
      await rpc.start();
      const childPid = Number(
        await readFile(join(directory, "child.pid"), "utf8"),
      );
      const leaderPid = rpc.pid!;

      if (mode === "protocol-failure") {
        const failure = await rpc
          .request({ type: "break_protocol" })
          .catch((error: unknown) => error);
        if (!(failure instanceof PiRpcOutcomeUnknownError) || !failure.stopped)
          throw new Error("Expected confirmed-exit fence", { cause: failure });
        await failure.stopped;
      } else {
        await rpc.stop();
      }
      expect(() => process.kill(leaderPid, 0)).toThrow();
      await expect
        .poll(async () => {
          try {
            process.kill(childPid, 0);
            // A Linux container can retain a zombie PID after process exit.
            return (
              process.platform !== "linux" ||
              !/\) Z /u.test(
                await readFile("/proc/" + childPid + "/stat", "utf8"),
              )
            );
          } catch (error) {
            if (
              ["ESRCH", "ENOENT"].includes(
                (error as NodeJS.ErrnoException).code ?? "",
              )
            )
              return false;
            throw error;
          }
        })
        .toBe(false);
    },
  );
});
