import { Effect } from 'effect';

class FolderPickerCancelledError {
  readonly _tag = 'FolderPickerCancelledError';
}

class FolderPickerError {
  readonly _tag = 'FolderPickerError';
  constructor(readonly reason: string) {}
}

type PickerError = FolderPickerCancelledError | FolderPickerError;

export function pickFolder(): Effect.Effect<string, PickerError> {
  return Effect.tryPromise({
    try: async () => {
      const proc = Bun.spawn([
        'osascript',
        '-e', 'set chosenFolder to choose folder with prompt "Select photo folder"',
        '-e', 'return POSIX path of chosenFolder',
      ]);

      const exitCode = await proc.exited;
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();

      if (exitCode !== 0) {
        if (stderr.includes('User canceled') || stderr.includes('-128')) {
          throw { cancelled: true };
        }
        throw new Error(stderr || `osascript exited with code ${exitCode}`);
      }

      return stdout.trim();
    },
    catch: (error: unknown) => {
      if (
        error !== null &&
        typeof error === 'object' &&
        'cancelled' in error
      ) {
        return new FolderPickerCancelledError();
      }
      return new FolderPickerError(String(error));
    },
  });
}
