import {
  parseRichText,
  type RichTextParseRequest,
  type RichTextParseResponse,
} from "./rich-text-parser";

// Keep the worker entry's globals separate from the browser DOM build types.
const port = self as unknown as {
  onmessage: (event: MessageEvent<RichTextParseRequest>) => void;
  postMessage(response: RichTextParseResponse): void;
};
port.onmessage = ({ data }) => {
  try {
    port.postMessage({
      id: data.id,
      tree: parseRichText(data.text, data.headings),
    });
  } catch (error) {
    port.postMessage({
      id: data.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
