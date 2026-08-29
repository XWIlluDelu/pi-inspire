export function requestError<T extends object = Record<never, never>>(
  message: string,
  status: number,
  details?: T,
): Error & { status: number } & T {
  return Object.assign(new Error(message), { status }, details) as Error & {
    status: number;
  } & T;
}
