import { Effect } from 'effect';
import { existsSync, mkdirSync, renameSync, readdirSync } from 'node:fs';
import { dirname, basename, join, parse, extname } from 'node:path';
import { TrashError, FileNotFoundError } from './errors';
import { VIDEO_EXTENSIONS, CLIPS_FOLDER } from './scanner';
import type { DeleteResult } from './types';

const DELETED_FOLDER = '_deleted';

// When a video is soft-deleted we also move its preview clips out of the way so
// they don't linger as orphans. The clips folder is moved to
// <folder>/_deleted/.clips/<video-stem>/ so a later restore can put it back.
function moveClipsToDeleted(videoPath: string): void {
  const ext = extname(videoPath).toLowerCase();
  if (!VIDEO_EXTENSIONS.has(ext)) return;

  const dir = dirname(videoPath);
  const { name: stem } = parse(videoPath);
  const clipDir = join(dir, CLIPS_FOLDER, stem);
  if (!existsSync(clipDir)) return;

  const deletedClipsParent = join(dir, DELETED_FOLDER, CLIPS_FOLDER);
  if (!existsSync(deletedClipsParent)) {
    mkdirSync(deletedClipsParent, { recursive: true });
  }
  const dest = join(deletedClipsParent, stem);
  // If a stale clips folder is already parked in _deleted, remove it first so
  // the rename does not fail.
  if (existsSync(dest)) {
    renameSync(dest, `${dest}.old-${Date.now()}`);
  }
  renameSync(clipDir, dest);
}

// Undo of moveClipsToDeleted: put a video's parked clips folder back in place.
function restoreClipsFromDeleted(videoPath: string): void {
  const ext = extname(videoPath).toLowerCase();
  if (!VIDEO_EXTENSIONS.has(ext)) return;

  const dir = dirname(videoPath);
  const { name: stem } = parse(videoPath);
  const parked = join(dir, DELETED_FOLDER, CLIPS_FOLDER, stem);
  if (!existsSync(parked)) return;

  const clipsParent = join(dir, CLIPS_FOLDER);
  if (!existsSync(clipsParent)) {
    mkdirSync(clipsParent, { recursive: true });
  }
  const dest = join(clipsParent, stem);
  if (existsSync(dest)) return; // a live clips folder already exists; leave it
  renameSync(parked, dest);
}

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

      // If this was a video, move its preview clips aside too so they don't
      // orphan. Photos are unaffected (no-op for non-video files).
      moveClipsToDeleted(filePath);
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

      // If this was a video, put its preview clips back as well.
      restoreClipsFromDeleted(originalPath);
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
