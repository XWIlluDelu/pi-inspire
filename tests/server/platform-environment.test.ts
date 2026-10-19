import { describe, expect, it } from "vitest";
import {
  environmentValue,
  executablePathDirectories,
} from "../../server/platform-environment.mjs";

describe("native executable environment", () => {
  it("reads copied Windows variable names case-insensitively, preserving empty values", () => {
    const environment = {
      Path: "C:\\tools",
      ComSpec: "C:\\Windows\\cmd.exe",
      pathext: ".EXE;.CMD",
      Empty: "",
    };
    expect(environmentValue(environment, "PATH", "win32")).toBe(
      environment.Path,
    );
    expect(environmentValue(environment, "COMSPEC", "win32")).toBe(
      environment.ComSpec,
    );
    expect(environmentValue(environment, "PATHEXT", "win32")).toBe(
      environment.pathext,
    );
    expect(environmentValue(environment, "EMPTY", "win32")).toBe("");
    expect(environmentValue(environment, "MISSING", "win32")).toBeUndefined();
    expect(environmentValue(environment, "PATH", "linux")).toBeUndefined();
  });
  it("uses Node's duplicate-key priority without mutating the caller", () => {
    const environment = { Path: "old", PATH: undefined };
    expect(environmentValue(environment, "Path", "win32")).toBeUndefined();
    expect(environment).toEqual({ Path: "old", PATH: undefined });
  });
  it("recognizes quoted Windows PATH entries with spaces and embedded semicolons", () => {
    expect(
      executablePathDirectories(
        ';"C:\\Program Files;Research\\node";C:\\Windows\\System32;"C:\\用户\\bin";;',
        "win32",
      ),
    ).toEqual([
      "C:\\Program Files;Research\\node",
      "C:\\Windows\\System32",
      "C:\\用户\\bin",
    ]);
  });
  it("keeps POSIX quote characters literal and never introduces implicit cwd lookup", () => {
    expect(
      executablePathDirectories(
        ':/opt/"quoted":/tools;research::/usr/bin:',
        "darwin",
      ),
    ).toEqual(['/opt/"quoted"', "/tools;research", "/usr/bin"]);
    expect(executablePathDirectories(';;"";', "win32")).toEqual([]);
  });
});
