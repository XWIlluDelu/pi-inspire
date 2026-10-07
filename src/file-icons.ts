import {
  FileArchive,
  FileAudio,
  FileCode2,
  FileImage,
  FileJson2,
  FileSpreadsheet,
  FileText,
  FileVideo,
  type LucideIcon,
} from "lucide-react";
import { languageForFile } from "./syntax-highlighting";

const iconGroups: [LucideIcon, string[]][] = [
  [
    FileCode2,
    (
      "js jsx mjs cjs ts tsx py rb go rs c h cpp hpp cc cs java kt swift php " +
      "html htm css scss less vue svelte sh bash zsh fish sql xml yaml yml toml makefile ipynb"
    ).split(" "),
  ],
  [FileJson2, ["json", "jsonc", "jsonl"]],
  [
    FileImage,
    ["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "ico", "bmp", "tiff"],
  ],
  [FileAudio, ["mp3", "wav", "ogg", "flac", "m4a", "aac", "opus"]],
  [FileVideo, ["mp4", "webm", "mov", "mkv", "avi", "m4v"]],
  [FileArchive, ["zip", "tar", "gz", "bz2", "xz", "7z", "rar", "tgz"]],
  [FileSpreadsheet, ["csv", "tsv", "xls", "xlsx", "ods"]],
];

const iconsByExtension = new Map(
  iconGroups.flatMap(([Icon, extensions]) =>
    extensions.map((extension) => [extension, Icon] as const),
  ),
);

/** Keep file rows in the existing monochrome Lucide family. */
export function fileIconForPath(path: string): LucideIcon {
  return iconsByExtension.get(languageForFile(path)) ?? FileText;
}
