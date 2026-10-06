import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PiRpcProcess } from "../../server/pi-rpc.js";
import { resolvePiSessionDirectory } from "../../server/pi-session-directory.js";
import { SessionCatalog } from "../../server/session-catalog.js";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("real Pi CLI session-directory compatibility", () => {
  it.each([
    "absolute",
    "relative",
    "tilde",
    "absent",
    "empty",
    "default",
    "cli",
  ])(
    "matches %s selection and rediscovers a Pi-written fork after catalog reconstruction",
    async (selection) => {
      const root = await realpath(
        await mkdtemp(join(tmpdir(), "inspire-pi-session-directory-")),
      );
      roots.push(root);
      const cwd = join(root, "project");
      const agent = join(root, "agent");
      await mkdir(join(cwd, ".pi"), { recursive: true });
      await mkdir(agent);
      await writeFile(
        join(agent, "settings.json"),
        JSON.stringify({ sessionDir: "global-sessions" }),
      );
      await writeFile(
        join(cwd, ".pi", "settings.json"),
        JSON.stringify({
          sessionDir: selection === "default" ? "" : "project-sessions",
        }),
      );
      const envDirectory = join(root, "environment-sessions");
      const environment =
        selection === "absolute" || selection === "cli"
          ? envDirectory
          : selection === "relative"
            ? "relative-sessions"
            : selection === "tilde"
              ? `~/${relative(homedir(), envDirectory)}`
              : selection === "empty"
                ? ""
                : undefined;
      vi.stubEnv("PI_CODING_AGENT_DIR", agent);
      vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", environment);
      const source = join(root, "source.jsonl");
      await writeFile(
        source,
        [
          {
            type: "session",
            version: 3,
            id: "55555555-5555-4555-8555-555555555555",
            cwd,
            timestamp: "2026-01-01T00:00:00Z",
          },
          {
            type: "message",
            id: "a1",
            parentId: null,
            timestamp: "2026-01-01T00:00:01Z",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "offline fixture" }],
              api: "openai-completions",
              provider: "fixture",
              model: "offline",
              stopReason: "stop",
              timestamp: 1,
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  total: 0,
                },
              },
            },
          },
        ]
          .map((entry) => JSON.stringify(entry))
          .join("\n") + "\n",
      );
      const cliDirectory = join(root, "cli-sessions");
      const rpc = new PiRpcProcess({
        cwd,
        args: [
          "--no-extensions",
          "--no-skills",
          "--no-prompt-templates",
          "--no-themes",
          "--fork",
          source,
          ...(selection === "cli" ? ["--session-dir", cliDirectory] : []),
        ],
        env: { PI_OFFLINE: "1" },
      });
      let state: { sessionId: string; sessionFile: string };
      await rpc.start();
      try {
        state = await rpc.request({ type: "get_state" });
      } finally {
        await rpc.stop();
      }
      const file = resolve(cwd, state.sessionFile);
      const expected =
        selection === "cli" ? cliDirectory : resolvePiSessionDirectory(cwd);
      if (expected) expect(dirname(file)).toBe(expected);
      else expect(dirname(dirname(file))).toBe(join(agent, "sessions"));
      const persisted = await readFile(file, "utf8");
      expect(JSON.parse(persisted.split("\n")[0]!)).toMatchObject({
        id: state.sessionId,
        cwd,
      });
      expect(persisted).toContain("offline fixture");
      // Inspire never supplies --session-dir; a CLI-only override is not a
      // catalog fallback. All ordinary inherited-env/settings cases must agree.
      for (let restart = 0; restart < 2; restart++) {
        const catalog = new SessionCatalog(cwd);
        if (selection === "cli") {
          expect((await catalog.list()).sessions).toEqual([]);
        } else {
          expect((await catalog.list()).sessions.map((row) => row.id)).toEqual([
            state.sessionId,
          ]);
          expect(await catalog.get(state.sessionId)).toMatchObject({
            path: file,
            cwd,
          });
        }
      }
    },
    30_000,
  );
});
