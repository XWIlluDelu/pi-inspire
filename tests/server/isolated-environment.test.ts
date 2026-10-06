import { expect, it } from "vitest";
import { isolatedTestEnvironment } from "./fixtures/isolated-environment.js";

it.each([
  ["SystemRoot", "ProgramFiles", "ProgramFiles(x86)", "Path"],
  ["SYSTEMROOT", "PROGRAMFILES", "PROGRAMFILES(X86)", "PATH"],
])(
  "preserves Windows OS key spelling (%s) without shadow aliases",
  (systemRoot, programFiles, programFilesX86, path) => {
    const source = {
      [systemRoot]: String.raw`C:\Windows`,
      [programFiles]: String.raw`C:\Program Files`,
      [programFilesX86]: String.raw`C:\Program Files (x86)`,
      [path]: String.raw`C:\Users\real-user\bin`,
      Home: String.raw`C:\Users\real-user`,
      AppData: String.raw`C:\Users\real-user\AppData\Roaming`,
      NODE_OPTIONS: "--require private-user-bootstrap.cjs",
      OPENAI_API_KEY: "synthetic-inherited-key",
      HTTPS_PROXY: "https://private-proxy.invalid",
      INSPIRE_BRANCH_WORKER_ID: "old-worker",
    };
    const root = String.raw`C:\isolated-fixture`;
    const environment = isolatedTestEnvironment(
      root,
      {
        INSPIRE_BRANCH_WORKER_ID: "fixture-worker",
      },
      { source, platform: "win32" },
    );
    for (const key of [systemRoot, programFiles, programFilesX86, path]) {
      expect(
        Object.keys(environment).filter(
          (candidate) => candidate.toLowerCase() === key.toLowerCase(),
        ),
      ).toEqual([key]);
    }
    const keys = Object.keys(environment);
    expect(new Set(keys.map((key) => key.toUpperCase())).size).toBe(
      keys.length,
    );
    const child = Object.fromEntries(
      Object.entries({ ...source, ...environment })
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => [key.toUpperCase(), value]),
    );
    expect(child).toMatchObject({
      SYSTEMROOT: source[systemRoot],
      PROGRAMFILES: source[programFiles],
      "PROGRAMFILES(X86)": source[programFilesX86],
      HOME: root,
      USERPROFILE: root,
      APPDATA: String.raw`C:\isolated-fixture\appdata`,
      LOCALAPPDATA: String.raw`C:\isolated-fixture\localappdata`,
      PI_CODING_AGENT_DIR: String.raw`C:\isolated-fixture\agent`,
      PI_CODING_AGENT_SESSION_DIR: String.raw`C:\isolated-fixture\sessions`,
      TMP: root,
      INSPIRE_BRANCH_WORKER_ID: "fixture-worker",
    });
    expect(child.PATH).toContain(String.raw`C:\Windows\System32`);
    expect(child.PATH).not.toContain("real-user");
    for (const key of ["NODE_OPTIONS", "OPENAI_API_KEY", "HTTPS_PROXY"])
      expect(child).not.toHaveProperty(key);
  },
);

it("isolates POSIX user state and launch configuration while retaining explicit fixture overrides", () => {
  const source = {
    HOME: "/real-home",
    PATH: "/private-bin",
    ProgramFiles: "/not-an-os-variable-here",
    NODE_OPTIONS: "--require private-bootstrap.cjs",
    PI_CODING_AGENT_DIR: "/real-agent",
    INSPIRE_BRANCH_COMMAND: "old-command",
  };
  const environment = isolatedTestEnvironment(
    "/fixture",
    {
      PI_CODING_AGENT_DIR: "/fixture/config",
      INSPIRE_BRANCH_COMMAND: "fixture-command",
    },
    { source, platform: "linux" },
  );
  const child = Object.fromEntries(
    Object.entries({ ...source, ...environment }).filter(
      ([, value]) => value !== undefined,
    ),
  );
  expect(child).toMatchObject({
    HOME: "/fixture",
    XDG_CONFIG_HOME: "/fixture/config",
    XDG_DATA_HOME: "/fixture/data",
    XDG_STATE_HOME: "/fixture/state",
    TMPDIR: "/fixture",
    PI_CODING_AGENT_DIR: "/fixture/config",
    INSPIRE_BRANCH_COMMAND: "fixture-command",
    PI_OFFLINE: "1",
  });
  expect(child.PATH).not.toContain("private-bin");
  expect(child).not.toHaveProperty("NODE_OPTIONS");
  expect(child).not.toHaveProperty("ProgramFiles");
});
