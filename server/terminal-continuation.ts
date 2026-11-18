import type { Terminal } from "@xterm/headless";

// xterm 6.0.0 exposes handlers publicly but keeps its pending input private.
interface InputHandler {
  _utf8Decoder: { interim: Uint8Array };
  _parser: {
    initialState: number;
    currentState: number;
    _transitions: { table: Uint8Array };
    parse(
      data: Uint32Array,
      length: number,
      resumed?: boolean,
    ): void | Promise<boolean>;
  };
}

/** Capture input that SerializeAddon cannot represent, using xterm's own decoder and transitions. */
export function captureTerminalContinuation(
  terminal: Terminal,
  limit: number,
): () => Buffer | null {
  const { _parser: parser, _utf8Decoder: decoder } = (
    terminal as unknown as { _core: { _inputHandler: InputHandler } }
  )._core._inputHandler;
  const {
    initialState: ground,
    _transitions: { table },
  } = parser;
  const parse = parser.parse.bind(parser);
  const stateMask = 15;
  const execute = 3;
  const dcsPut = 13;
  let pending: string | null = "";
  let startState: number | undefined;
  parser.parse = (data, length, resumed) => {
    let state = (startState ??= parser.currentState);
    const result = parse(data, length, resumed);
    if (result) return result;
    startState = undefined;
    if (parser.currentState === ground) {
      pending = "";
      return;
    }
    const start = data
      .subarray(0, length)
      .findLastIndex(
        (code) =>
          code < 0xa0 && (table[(ground << 8) | code]! & stateMask) !== ground,
      );
    if (start >= 0) {
      pending = "";
      state = ground;
    }
    if (pending === null) return;
    let suffix = "";
    let inDcsPayload = false;
    for (let i = Math.max(0, start); i < length; i++) {
      const code = data[i]!;
      const transition = table[(state << 8) | Math.min(code, 0xa0)]!;
      const action = transition >> 4;
      const next = transition & stateMask;
      // xterm's DCS read-ahead includes DEL within a payload run.
      inDcsPayload = action === dcsPut || (inDcsPayload && code === 0x7f);
      if (action !== execute && (action || next !== state || inDcsPayload))
        suffix += String.fromCodePoint(code);
      state = next;
    }
    pending = pending.length + suffix.length > limit ? null : pending + suffix;
  };
  return () =>
    pending === null
      ? null
      : Buffer.concat([Buffer.from(pending), decoder.interim.filter(Boolean)]);
}
