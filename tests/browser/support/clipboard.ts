import type { Page } from "@playwright/test";

/** Windows exposes native clipboard line endings; compare content, not encoding. */
export async function clipboardLines(page: Page) {
  return (await page.evaluate(() => navigator.clipboard.readText())).split(
    /\r?\n/,
  );
}

interface ClipboardWrite {
  started: number;
  text: string | null;
  imageWidth: number | null;
}
declare global {
  interface Window {
    gestureClipboardWrites: ClipboardWrite[];
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
    clipboard.write = async (items) => {
      const started = performance.now();
      await write(items);
      const item = items[0]!;
      let imageWidth: number | null = null;
      if (item.types.includes("image/png")) {
        const image = await createImageBitmap(await item.getType("image/png"));
        imageWidth = image.width;
        image.close();
      }
      window.gestureClipboardWrites.push({
        started,
        text: item.types.includes("text/plain")
          ? await (await item.getType("text/plain")).text()
          : null,
        imageWidth,
      });
    };
    clipboard.writeText = async (text) => {
      const started = performance.now();
      await writeText(text);
      window.gestureClipboardWrites.push({ started, text, imageWidth: null });
    };
  });
}
