import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const KEEPER = resolve("server/pi-worker-keeper.mjs");
// Reports when its input ends, so the test sees what Pi's RPC mode would.
const CHILD = `process.stdin.on("data", (d) => process.stdout.write("got " + d));
process.stdin.on("end", () => { process.stdout.write("input ended\\n"); process.exit(0); });
setInterval(() => {}, 1000);`;

function keep(env: NodeJS.ProcessEnv = process.env, child = CHILD) {
  const keeper = spawn(
    process.execPath,
    [KEEPER, process.execPath, "-e", child],
    {
      env,
      stdio: ["pipe", "pipe", "pipe", "pipe"],
    },
  );
  let output = "";
  keeper.stdout!.on("data", (chunk) => {
    output += chunk;
  });
  const exited = new Promise<number | null>((done) =>
    keeper.once("exit", (code) => done(code)),
  );
  return { keeper, output: () => output, exited };
}

describe.skipIf(process.platform === "win32")("pi worker keeper", () => {
  it("relays bytes and ends Pi's input with the Host's", async () => {
    const { keeper, output, exited } = keep();
    keeper.stdin!.write("hello\n");
    await expect.poll(output).toContain("got hello");
    keeper.stdin!.end();
    expect(await exited).toBe(0);
    expect(output()).toContain("input ended");
  });

  it("starts Pi with a dialog channel even when TMPDIR is too long for a socket", async () => {
    const root = await mkdtemp(join(tmpdir(), "keeper-"));
    const deep = join(root, "x".repeat(120));
    await mkdir(deep);
    try {
      const { keeper, output, exited } = keep(
        { ...process.env, TMPDIR: deep },
        `const ui = JSON.parse(process.env.PI_ATTACH_CONTROL_RPC_UI ?? "null");
process.stdout.write("relay " + (ui ? ui.endpoint.length : "none") + "\\n");
process.stdin.on("end", () => process.exit(0));`,
      );
      await expect.poll(output).toMatch(/relay \d+/);
      expect(Number(/relay (\d+)/.exec(output())![1])).toBeLessThanOrEqual(100);
      keeper.stdin!.end();
      expect(await exited).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("starts Pi without dialog recovery when the channel cannot be created", async () => {
    const { keeper, output, exited } = keep(
      { ...process.env, TMPDIR: "/nonexistent-inspire-tmp" },
      `process.stdout.write("relay " + (process.env.PI_ATTACH_CONTROL_RPC_UI ? "set" : "none") + "\\n");
process.stdin.on("end", () => process.exit(0));`,
    );
    await expect.poll(output).toContain("relay none");
    keeper.stdin!.end();
    expect(await exited).toBe(0);
  });

  it("keeps Pi's input open after detach, so it outlives the Host", async () => {
    const { keeper, output, exited } = keep();
    keeper.stdin!.write("hello\n");
    await expect.poll(output).toContain("got hello");
    (keeper.stdio[3] as NodeJS.WritableStream).end("detach\n");
    await new Promise((done) => setTimeout(done, 100));
    keeper.stdin!.end();
    keeper.stdout!.destroy();
    let settled = false;
    void exited.then(() => {
      settled = true;
    });
    await new Promise((done) => setTimeout(done, 500));
    expect(settled).toBe(false);
    expect(output()).not.toContain("input ended");
    keeper.kill("SIGTERM");
    await exited;
  });
});
