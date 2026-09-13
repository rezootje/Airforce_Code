export class AirforceError extends Error {
  constructor(
    message: string,
    public readonly code = 'GENERAL',
    public readonly exitCode = 1,
  ) {
    super(message);
    this.name = 'AirforceError';
  }
}
export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
export const errorCode = (error: unknown): string =>
  error instanceof AirforceError ? error.code : 'GENERAL';
export const formatError = (error: unknown): string =>
  `[${errorCode(error)}] ${errorMessage(error)}`;
export function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}
