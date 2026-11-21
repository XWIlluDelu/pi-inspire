import type { Locator } from "@playwright/test";

/** Emit exact bytes through the real PTY under POSIX shells and PowerShell.
 * Base64 avoids shell quoting and prevents command echo from impersonating output. */
export function terminalNodeCommand(script: string) {
  const node =
    process.platform === "win32"
      ? `& '${process.execPath.replaceAll("'", "''")}'`
      : `'${process.execPath.replaceAll("'", "'\\''")}'`;
  return `${node} -e "${script}"`;
}

export function terminalWriteCommand(text: string) {
  const bytes = Buffer.from(text).toString("base64");
  return terminalNodeCommand(
    `process.stdout.write(Buffer.from('${bytes}', 'base64'))`,
  );
}

export async function pasteTerminalText(input: Locator, text: string) {
  await input.focus();
  await input.evaluate((element, text) => {
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: { getData: (type: string) => (type === "text/plain" ? text : "") },
    });
    element.dispatchEvent(event);
  }, text);
}
