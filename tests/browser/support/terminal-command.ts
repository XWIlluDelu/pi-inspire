/** Emit exact bytes through the real PTY under POSIX shells and cmd.exe alike.
 * Base64 avoids shell quoting and prevents command echo from impersonating output. */
export function terminalWriteCommand(text: string) {
  const bytes = Buffer.from(text).toString("base64");
  return `node -e "process.stdout.write(Buffer.from('${bytes}', 'base64'))"`;
}
