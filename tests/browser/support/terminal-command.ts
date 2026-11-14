/** Emit exact bytes through the real PTY under POSIX shells and cmd.exe alike.
 * Base64 avoids shell quoting and prevents command echo from impersonating output. */
export function terminalNodeCommand(script: string) {
  // POSIX login shells may reset PATH; Windows profiles retain the fixture PATH.
  const node =
    process.platform === "win32"
      ? "node"
      : `'${process.execPath.replaceAll("'", "'\\''")}'`;
  return `${node} -e "${script}"`;
}

export function terminalWriteCommand(text: string) {
  const bytes = Buffer.from(text).toString("base64");
  return terminalNodeCommand(
    `process.stdout.write(Buffer.from('${bytes}', 'base64'))`,
  );
}
