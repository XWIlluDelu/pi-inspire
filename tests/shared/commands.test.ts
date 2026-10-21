import { describe, expect, it } from "vitest";
import {
  parseCommandInvocation,
  parseNativeCommand,
} from "../../shared/commands";

describe("Pi native command parsing", () => {
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
    expect(parseNativeCommand("/compact focus")).toMatchObject({
      name: "compact",
      argument: "focus",
      descriptor: { execution: "host" },
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

  it("uses Pi's inventory for names outside ordinary command syntax", () => {
    const names = new Set(["audit.inspect", "审阅/检查"]);
    const known = (name: string) => names.has(name);
    for (const name of names)
      expect(
        parseCommandInvocation(`/${name}\tkeep paths\nnext`, known),
      ).toEqual({
        name,
        argument: "keep paths\nnext",
        raw: `/${name}\tkeep paths\nnext`,
      });
    expect(parseCommandInvocation("/tmp/project/file", known)).toBeNull();
    expect(parseCommandInvocation("/unknown.command", known)).toBeNull();
  });
});
