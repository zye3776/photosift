import { Effect } from 'effect';
import { readdir, stat } from 'node:fs/promises';
import { join, parse, extname } from 'node:path';
import { FolderNotFoundError, FolderReadError } from './errors';
import type { PhotoPair, ScanResult } from './types';

const GROUP_PATTERN = /^(.+)-(\d{2,3})$/;

const JPG_EXTENSIONS = new Set(['.jpg', '.jpeg']);
const RAW_EXTENSION = '.raf';

function extractGroup(stem: string): string {
  const match = GROUP_PATTERN.exec(stem);
  return match ? match[1] : stem;
}

function buildGroups(photos: PhotoPair[]): Record<string, PhotoPair[]> {
  const groups: Record<string, PhotoPair[]> = {};
  for (const photo of photos) {
    if (!groups[photo.group]) {
      groups[photo.group] = [];
    }
    groups[photo.group].push(photo);
  }
  return groups;
}

type ScanError = FolderNotFoundError | FolderReadError;

export function scanFolder(
  folderPath: string,
): Effect.Effect<ScanResult, ScanError> {
  return Effect.gen(function* (_) {
    const folderStat = yield* _(
      Effect.tryPromise({
        try: () => stat(folderPath),
        catch: () => new FolderNotFoundError(folderPath),
      }),
    );

    if (!folderStat.isDirectory()) {
      yield* _(Effect.fail(new FolderNotFoundError(folderPath)));
    }

    const entries = yield* _(
      Effect.tryPromise({
        try: () => readdir(folderPath, { withFileTypes: true }),
        catch: (error) => new FolderReadError(folderPath, String(error)),
      }),
    );

    const filesByName = new Map<string, Set<string>>();

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      if (!entry.isFile()) continue;

      const ext = extname(entry.name).toLowerCase();
      if (!JPG_EXTENSIONS.has(ext) && ext !== RAW_EXTENSION) continue;
      const { name } = parse(entry.name);
      if (!filesByName.has(name)) {
        filesByName.set(name, new Set());
      }
      filesByName.get(name)!.add(ext);
    }

    const photos: PhotoPair[] = [];

    for (const [stem, extensions] of filesByName) {
      const hasJpg = [...extensions].some((ext) => JPG_EXTENSIONS.has(ext));
      if (!hasJpg) continue;

      const jpgExt = [...extensions].find((ext) => JPG_EXTENSIONS.has(ext)) ?? '.jpg';
      const hasRaf = extensions.has(RAW_EXTENSION);

      photos.push({
        stem,
        jpgPath: join(folderPath, `${stem}${jpgExt}`),
        rafPath: hasRaf ? join(folderPath, `${stem}${RAW_EXTENSION}`) : null,
        group: extractGroup(stem),
      });
    }

    photos.sort((a, b) => a.stem.localeCompare(b.stem));

    return {
      folder: folderPath,
      photos,
      groups: buildGroups(photos),
    };
  });
}
