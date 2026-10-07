import {
  FileArchive,
  FileAudio,
  FileCode2,
  FileImage,
  FileJson2,
  FileSpreadsheet,
  FileText,
  FileVideo,
} from "lucide-react";
import { describe, expect, it } from "vitest";
import { fileIconForPath } from "../../src/file-icons";

describe("Changes file icons", () => {
  it.each([
    ["src/panel.tsx", FileCode2],
    ["src\\panel.TSX", FileCode2],
    ["Makefile", FileCode2],
    ["config.JSON", FileJson2],
    ["plot.svg", FileImage],
    ["clip.flac", FileAudio],
    ["demo.webm", FileVideo],
    ["bundle.tar.gz", FileArchive],
    ["metrics.csv", FileSpreadsheet],
    ["notes.md", FileText],
    ["file.unknown", FileText],
    ["folder.ts/LICENSE", FileText],
  ])("uses the filename's category for %s", (path, Icon) => {
    expect(fileIconForPath(path)).toBe(Icon);
  });
});
