import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PI_NATIVE_COMMANDS } from "../../shared/commands.js";

describe("installed Pi built-in command inventory", () => {
  it("classifies every built-in shipped by the development Pi baseline", () => {
    const source = readFileSync(
      resolve(
        import.meta.dirname,
        "../../node_modules/@earendil-works/pi-coding-agent/dist/core/slash-commands.js",
      ),
      "utf8",
    );
    const names = [...source.matchAll(/name: "([^"\n]+)"/g)].map(
      (match) => match[1],
    );
    expect(names.length).toBeGreaterThan(0);
    expect(PI_NATIVE_COMMANDS.map((command) => command.name).sort()).toEqual(
      names.sort(),
    );
  });
});
