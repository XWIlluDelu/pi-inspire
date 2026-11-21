export function replacePrivateStateFile(
  path: string,
  serialized: string,
  options?: {
    beforeReplace?: (candidatePath: string) => void | Promise<void>;
    flush?: boolean;
  },
): Promise<void>;
