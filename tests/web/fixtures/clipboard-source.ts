import { vi } from "vitest";
import * as clipboard from "../../../src/content-copy";

/** Presentation tests inspect complete Copy input at the transport boundary.
 * Unlike a resolved write stub, this consumes the owned loader and cannot
 * accidentally skip Host-backed image reads or inspect projected previews. */
export function captureClipboardSource() {
  const written = vi.fn();
  const request = vi
    .spyOn(clipboard, "writeCopyContent")
    .mockImplementation(
      async (
        source,
        current = () => true,
        signal = new AbortController().signal,
      ) => {
        const content =
          typeof source === "function" ? await source(signal) : source;
        if (content === null || signal.aborted || !current()) return false;
        written(content);
        return true;
      },
    );
  return { request, written };
}
