import { expect, it } from "vitest";
import {
  ATTACHMENT_CONTEXT_HEADING,
  fileReferenceName,
  parseAttachmentContext,
} from "../../shared/attachment-context";
import {
  userMessageContent,
  userMessageTitle,
} from "../../shared/user-message";
import { userTurnSummary } from "../../shared/user-turns";

const trailer = (...paths: string[]) =>
  `${ATTACHMENT_CONTEXT_HEADING}\n${paths.map((path) => `- ${JSON.stringify(path)}`).join("\n")}`;
const imageNote =
  "[Image: original 2560x133, displayed at 2000x104. Multiply coordinates by 1.28 to map to original image.]";

it("reads mixed file and image prompts without exposing model instructions or changing paths", () => {
  const paths = [
    '/workspace/quoted "file"\nnext.md',
    String.raw`C:\work\report.md`,
  ];
  const source = `Inspect\n\n${trailer(...paths)}\n\n${imageNote}\n${imageNote}`;
  const message = {
    content: [
      { type: "text", text: source },
      { type: "image" },
      { type: "image" },
    ],
  };
  expect(userMessageContent(message.content)).toMatchObject({
    text: "Inspect",
    references: paths,
  });
  expect(userMessageTitle(message.content)).toBe("Inspect");
  expect(userTurnSummary(message)).toEqual({
    snippet: "Inspect",
    attachmentCount: 4,
  });
  expect(userMessageContent(source)).toMatchObject({
    text: source,
    references: [],
  });
});

it.each([
  ["relative path", `${ATTACHMENT_CONTEXT_HEADING}\n- "relative.md"`],
  ["non-string path", `${ATTACHMENT_CONTEXT_HEADING}\n- {"path":"/report.md"}`],
  ["trailing user text", `${trailer("/report.md")}\nMore text`],
  ["fenced example", `\`\`\`text\n${trailer("/report.md")}\n\`\`\``],
  ["non-trailing image note", `\n\n${imageNote}\nMore text`],
])("keeps a %s as user text", (_scenario, text) => {
  expect(parseAttachmentContext(text, 1)).toEqual({ text, references: [] });
});

it("honors the caller's path rules for a file trailer", () => {
  const text = trailer(String.raw`C:\work\report.md`);
  expect(
    parseAttachmentContext(text, 0, (path) => path.startsWith("/")),
  ).toEqual({
    text,
    references: [],
  });
});

it("shows file-only captions without storage IDs and leaves ordinary filenames intact", () => {
  const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const stored = `/cache/attachments/123-1792213034751-${id}/${id}-AGENTS 1.md`;
  const fileOnly = trailer(stored, String.raw`C:\workspace\report.md`);
  expect(userMessageContent(fileOnly)).toMatchObject({
    text: "",
    references: [stored, String.raw`C:\workspace\report.md`],
  });
  expect(userTurnSummary({ content: fileOnly })).toEqual({
    snippet: "AGENTS 1.md, report.md",
    attachmentCount: 2,
  });
  expect(fileReferenceName(`C:${stored.replaceAll("/", "\\")}`)).toBe(
    "AGENTS 1.md",
  );
  expect(fileReferenceName(`/project/${id}-report.md`)).toBe(`${id}-report.md`);
  expect(fileReferenceName(String.raw`/workspace/back\slash.md`)).toBe(
    String.raw`back\slash.md`,
  );
});

it("labels image-only turns and bounds text without splitting Unicode characters", () => {
  expect(
    userTurnSummary({
      content: [{ type: "text", text: `\n\n${imageNote}` }, { type: "image" }],
    }),
  ).toEqual({
    snippet: "Image attachment",
    attachmentCount: 1,
  });
  expect(
    userTurnSummary({ content: [{ type: "image" }, { type: "image" }] }),
  ).toEqual({
    snippet: "2 image attachments",
    attachmentCount: 2,
  });
  expect(userTurnSummary({ content: "😀".repeat(181) }).snippet).toBe(
    "😀".repeat(180),
  );
});
