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
});
