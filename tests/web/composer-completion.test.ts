import { describe, expect, it } from "vitest";
import {
  parseCaretCompletion,
  rankCommands,
  rankProjectFiles,
  replaceCompletionToken,
} from "../../src/composer-completion";

describe("composer caret completion", () => {
  it("recognizes only the active boundary-prefixed @ token and permits spaces", () => {
    const draft = "keep @notes/field report final";
    expect(parseCaretCompletion(draft, draft.length)).toEqual({
      kind: "file",
      start: 5,
      end: draft.length,
      query: "notes/field report final",
    });
    expect(parseCaretCompletion("mail@example.com", 16)).toBeNull();
    expect(parseCaretCompletion("prefix@src/main.ts", 18)).toBeNull();
  });

  it("uses the caret token rather than reinterpreting earlier @ text", () => {
    const draft = "@first remains\nthen @second";
    expect(parseCaretCompletion(draft, draft.length)).toMatchObject({
      kind: "file",
      start: draft.lastIndexOf("@"),
      query: "second",
    });
    expect(parseCaretCompletion("use @src/ma|in.ts later".replace("|", ""), 11)).toMatchObject({
      query: "src/ma",
      end: 16,
    });
  });

  it("offers slash completion only while the caret is in Pi's leading command token", () => {
    expect(parseCaretCompletion("/comp instructions", 5)).toEqual({
      kind: "command",
      start: 0,
      end: 5,
      query: "comp",
    });
    expect(parseCaretCompletion("/compact instructions", 12)).toBeNull();
    expect(parseCaretCompletion("please /compact", 15)).toBeNull();
  });

  it("replaces exactly the parsed range and reports the restored caret", () => {
    const value = "before @src/main after";
    const token = parseCaretCompletion(value, 16)!;
    expect(replaceCompletionToken(value, token, "")).toEqual({ value: "before  after", caret: 7 });

    const command = parseCaretCompletion("/com existing args", 3)!;
    expect(replaceCompletionToken("/com existing args", command, "/compact ")).toEqual({
      value: "/compact  existing args",
      caret: 9,
    });
  });

  it("ranks basename and directory matches locally", () => {
    const files = rankProjectFiles([
      { path: "docs/field report.md", name: "field report.md" },
      { path: "src/report-field.ts", name: "report-field.ts" },
      { path: "other.txt", name: "other.txt" },
    ], "field report");
    expect(files.map((file) => file.path)).toEqual(["docs/field report.md", "src/report-field.ts"]);
  });

  it("uses Pi's command-name matcher rather than unrelated description text", () => {
    const commands = rankCommands([
      { name: "loop", description: "Run repeatedly", source: "prompt" },
      { name: "review-loop", description: "Review repeatedly", source: "extension" },
      { name: "goal", description: "Run a loop to completion", source: "extension" },
    ], "loop");
    expect(commands.map((command) => command.name)).toEqual(["loop", "review-loop"]);
  });
});
