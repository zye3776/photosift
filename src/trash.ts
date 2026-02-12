import { Effect } from 'effect';
import { existsSync, mkdirSync, renameSync, readdirSync } from 'node:fs';
import { dirname, basename, join, parse } from 'node:path';
import { TrashError, FileNotFoundError } from './errors';
import type { DeleteResult } from './types';

const DELETED_FOLDER = '_deleted';

function moveToDeleted(filePath: string): Effect.Effect<void, TrashError | FileNotFoundError> {
  return Effect.try({
    try: () => {
      if (!existsSync(filePath)) {
        throw new FileNotFoundError(filePath);
      }

      const dir = dirname(filePath);
      const deletedDir = join(dir, DELETED_FOLDER);

      if (!existsSync(deletedDir)) {
        mkdirSync(deletedDir, { recursive: true });
      }

      const dest = join(deletedDir, basename(filePath));
      renameSync(filePath, dest);
    },
    catch: (error) => {
      if (error instanceof FileNotFoundError) return error;
      return new TrashError(filePath, String(error));
    },
  });
}

export function deleteFiles(filePaths: string[]): Effect.Effect<DeleteResult, never> {
  return Effect.gen(function* (_) {
    const deleted: string[] = [];
    const failed: Array<{ path: string; reason: string }> = [];

    for (const filePath of filePaths) {
      const result = yield* _(
        Effect.either(moveToDeleted(filePath)),
      );

      if (result._tag === 'Right') {
        deleted.push(filePath);
      } else {
        const error = result.left;
        failed.push({ path: filePath, reason: error._tag });
      }
    }

    return { deleted, failed };
  });
}

function restoreFromDeleted(originalPath: string): Effect.Effect<void, TrashError | FileNotFoundError> {
  return Effect.try({
    try: () => {
      const dir = dirname(originalPath);
      const deletedDir = join(dir, DELETED_FOLDER);
      const deletedPath = join(deletedDir, basename(originalPath));

      if (!existsSync(deletedPath)) {
        throw new FileNotFoundError(deletedPath);
      }

      renameSync(deletedPath, originalPath);
    },
    catch: (error) => {
      if (error instanceof FileNotFoundError) return error;
      return new TrashError(originalPath, String(error));
    },
  });
}

export function restoreFiles(filePaths: string[]): Effect.Effect<DeleteResult, never> {
  return Effect.gen(function* (_) {
    const deleted: string[] = [];
    const failed: Array<{ path: string; reason: string }> = [];

    for (const filePath of filePaths) {
      const result = yield* _(
        Effect.either(restoreFromDeleted(filePath)),
      );

      if (result._tag === 'Right') {
        deleted.push(filePath);
      } else {
        const error = result.left;
        failed.push({ path: filePath, reason: error._tag });
      }
    }

    return { deleted, failed };
  });
}

export function restoreGroup(folderPath: string, groupName: string): Effect.Effect<DeleteResult, never> {
  return Effect.gen(function* (_) {
    const deletedDir = join(folderPath, DELETED_FOLDER);

    if (!existsSync(deletedDir)) {
      return { deleted: [], failed: [] };
    }

    const entriesOrError = yield* _(
      Effect.try({
        try: () => readdirSync(deletedDir),
        catch: (error: unknown) => new TrashError(deletedDir, String(error)),
      }),
      Effect.either
    );

    if (entriesOrError._tag === 'Left') {
      return { deleted: [], failed: [{ path: deletedDir, reason: entriesOrError.left.reason }] };
    }
    const entries = entriesOrError.right;

    const groupFiles: string[] = [];
    const GROUP_PATTERN = /^(.+)-(\d{3})$/;

    for (const entry of entries) {
      if (entry.startsWith('.')) continue;

      const { name } = parse(entry);

      // Extract group from name, based on pattern
      const match = GROUP_PATTERN.exec(name);
      
      if (match && match[1] === groupName) {
        // Construct ORIGINAL path for restoreFiles
        const originalPath = join(folderPath, entry);
        groupFiles.push(originalPath);
      }
    }

    if (groupFiles.length === 0) {
      return { deleted: [], failed: [] };
    }

    return yield* _(restoreFiles(groupFiles));
  });
}
