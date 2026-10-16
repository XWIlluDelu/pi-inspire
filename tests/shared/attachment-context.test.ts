import { describe, expect, it } from "vitest";
import {
  ATTACHMENT_CONTEXT_HEADING,
  fileReferenceName,
  parseAttachmentContext,
} from "../../shared/attachment-context";

const trailer = (...paths: string[]) =>
  `${ATTACHMENT_CONTEXT_HEADING}\n${paths.map((path) => `- ${JSON.stringify(path)}`).join("\n")}`;
const uuid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const privatePath = `/cache/attachments/123-1792213034751-${uuid}/${uuid}-AGENTS 1.md`;
const imageNote =
  "[Image: original 2560x133, displayed at 2000x104. Multiply coordinates by 1.28 to map to original image.]";

describe("attachment reading context", () => {
  it("separates exact file trailers without losing paths or changing source", () => {
    const paths = [
      privatePath,
      '/workspace/quoted "file"\nnext.md',
      String.raw`C:\work\report.md`,
    ];
    const source = `Inspect\n\n${trailer(...paths)}`;
    expect(parseAttachmentContext(source)).toEqual({
      text: "Inspect",
      references: paths,
    });
    expect(parseAttachmentContext(trailer(...paths))).toEqual({
      text: "",
      references: paths,
    });
    expect(parseAttachmentContext(`\n\n${trailer(...paths)}`)).toEqual({
      text: "",
      references: paths,
    });
    expect(source).toContain(JSON.stringify(paths[1]));
  });

  it.each([
    "inspect /workspace/report.md",
    `${ATTACHMENT_CONTEXT_HEADING}\n- relative.md`,
    `${ATTACHMENT_CONTEXT_HEADING}\n- "relative.md"`,
    `${ATTACHMENT_CONTEXT_HEADING}\n- {"path":"/report.md"}`,
    `${ATTACHMENT_CONTEXT_HEADING}\n- "/report.md"\nMore text`,
    `\`\`\`text\n${ATTACHMENT_CONTEXT_HEADING}\n- "/report.md"\n\`\`\``,
  ])("keeps ordinary, quoted or malformed content visible: %s", (source) => {
    expect(parseAttachmentContext(source)).toEqual({
      text: source,
      references: [],
    });
  });

  it("unwraps Pi's image hint before recognizing a mixed file/image prompt", () => {
    const source = `Inspect\n\n${trailer(privatePath)}\n\n${imageNote}`;
    expect(parseAttachmentContext(source, 1)).toEqual({
      text: "Inspect",
      references: [privatePath],
    });
    expect(parseAttachmentContext(source, 0)).toEqual({
      text: source,
      references: [],
    });
  });

  it("retains caller-specific absolute-path validation", () => {
    const source = trailer(String.raw`C:\work\report.md`);
    expect(
      parseAttachmentContext(source, 0, (path) => path.startsWith("/")),
    ).toEqual({
      text: source,
      references: [],
    });
  });

  it("omits private upload IDs only in the known storage path shape", () => {
    expect(fileReferenceName(privatePath)).toBe("AGENTS 1.md");
    expect(fileReferenceName(`C:${privatePath.replaceAll("/", "\\")}`)).toBe(
      "AGENTS 1.md",
    );
    expect(fileReferenceName(`/project/${uuid}-report.md`)).toBe(
      `${uuid}-report.md`,
    );
    expect(fileReferenceName("/workspace/report.md")).toBe("report.md");
    expect(fileReferenceName("/workspace/back\\slash.md")).toBe(
      "back\\slash.md",
    );
    expect(fileReferenceName(String.raw`C:\workspace\report.md`)).toBe(
      "report.md",
    );
  });
});
