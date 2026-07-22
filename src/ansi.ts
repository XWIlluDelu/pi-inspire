// Terminal presentation sequences that survive inside Pi's stored thinking
// text (e.g. ESC[38;2;90;128;128m truecolor SGR). They are presentation
// artifacts, not content, so they are stripped at the display boundary only;
// stored messages are never rewritten.

// CSI: ESC + "[" (or C1 CSI), then parameter bytes 0x30-0x3f, intermediate
// bytes 0x20-0x2f, and one final byte 0x40-0x7e (covers SGR "m", cursor
// movement, erasure, private modes, …). The "[" belongs to the introducer,
// not the parameter class, so an OSC prefix "ESC ]" is never consumed here.
const CSI = String.raw`(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]`;
// OSC: ESC + "]" (or C1 OSC), payload without BEL/ESC, terminated by BEL or
// ST (ESC + "\" or C1 ST).
const OSC = String.raw`(?:\u001b\]|\u009d)[^\u0007\u001b]*(?:\u0007|\u001b\\|\u009c)`;

const TERMINAL_SEQUENCE = new RegExp(`${CSI}|${OSC}`, "g");

/** Remove ANSI/VT CSI/SGR and OSC sequences from terminal-originated text. */
export function stripTerminalSequences(text: string): string {
  return text.replace(TERMINAL_SEQUENCE, "");
}
