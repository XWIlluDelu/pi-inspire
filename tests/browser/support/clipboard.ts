import type { Page } from "@playwright/test";

/** Windows exposes native clipboard line endings; compare content, not encoding. */
export async function clipboardLines(page: Page) {
  return (await page.evaluate(() => navigator.clipboard.readText())).split(
    /\r?\n/,
  );
}

interface ClipboardWrite {
  text: string | null;
  imageWidth: number | null;
}
declare global {
  interface Window {
    gestureClipboardWrites: ClipboardWrite[];
    gestureClipboardWriteStarts: number;
  }
}
// Keep the real browser clipboard. Inspect the original items only after the
// native write succeeds; OS reads need a separate gesture on Safari/Firefox.
export async function observeClipboardWrites(page: Page) {
  await page.evaluate(() => {
    const clipboard = navigator.clipboard;
    const write = clipboard.write.bind(clipboard);
    const writeText = clipboard.writeText.bind(clipboard);
    window.gestureClipboardWrites = [];
    window.gestureClipboardWriteStarts = 0;
    clipboard.write = async (items) => {
      window.gestureClipboardWriteStarts += 1;
      await write(items);
      const item = items[0]!;
      let imageWidth: number | null = null;
      if (item.types.includes("image/png")) {
        const image = await createImageBitmap(await item.getType("image/png"));
        imageWidth = image.width;
        image.close();
      }
      window.gestureClipboardWrites.push({
        text: item.types.includes("text/plain")
          ? await (await item.getType("text/plain")).text()
          : null,
        imageWidth,
      });
    };
    clipboard.writeText = async (text) => {
      window.gestureClipboardWriteStarts += 1;
      await writeText(text);
      window.gestureClipboardWrites.push({ text, imageWidth: null });
    };
  });
}
