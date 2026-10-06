import { expect, it } from "vitest";
import { fencedMarkdown } from "../../shared/markdown-fence";

it.each([
  ["", "text", "```text\n\n```"],
  ["  source\n\n", "", "```\n  source\n\n\n```"],
  ["`inline`\n```code\n````", "sh", "`````sh\n`inline`\n```code\n````\n`````"],
])("fences %j without changing its content", (content, language, expected) => {
  expect(fencedMarkdown(content, language)).toBe(expected);
});

it("handles a large selection with many separate backtick runs", () => {
  const content = "`x".repeat(150_000);
  expect(fencedMarkdown(content, "text")).toBe("```text\n" + content + "\n```");
});
