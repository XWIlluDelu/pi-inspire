import { describe, expect, it } from "vitest";
import {
  PI_NATIVE_COMMANDS,
  parseCommandInvocation,
  parseCompactCommand,
  parseNativeCommand,
} from "../../shared/commands";

describe("Pi native command inventory", () => {
  it("covers Pi's built-in interactive commands without duplicate names", () => {
    const names = PI_NATIVE_COMMANDS.map((command) => command.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual([
      "settings",
      "model",
      "tree",
      "thinking",
      "scoped-models",
      "export",
      "import",
      "share",
      "copy",
      "name",
      "session",
      "changelog",
      "hotkeys",
      "fork",
      "clone",
      "trust",
      "login",
      "logout",
      "new",
      "compact",
      "resume",
      "reload",
      "quit",
    ]);
  });

  it("parses a leading command token and preserves arguments", () => {
    expect(
      parseCommandInvocation("  /compact  keep exact paths\nnext  "),
    ).toEqual({
      name: "compact",
      argument: "keep exact paths\nnext",
      raw: "/compact  keep exact paths\nnext",
    });
    expect(parseNativeCommand("/model anthropic/sonnet")).toMatchObject({
      name: "model",
      argument: "anthropic/sonnet",
    });
    expect(parseCompactCommand("/compact focus")).toEqual({
      instructions: "focus",
    });
    expect(parseNativeCommand("/not-a-pi-command")).toBeNull();
    expect(parseCommandInvocation("/MODEL")).toMatchObject({ name: "MODEL" });
    expect(parseNativeCommand("/MODEL")).toBeNull();
    expect(parseCommandInvocation("/skill:docs reference")).toMatchObject({
      name: "skill:docs",
      argument: "reference",
    });
    expect(parseCommandInvocation("explain /compact")).toBeNull();
    expect(parseCommandInvocation("/tmp/project/file")).toBeNull();
  });
});
