import { Effect } from 'effect';
import sharp from 'sharp';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { ThumbnailError, FileNotFoundError } from './errors';

const THUMBNAIL_MAX_WIDTH = 800;
const CACHE_DIR = join(tmpdir(), 'photosift-thumbnails');

function ensureCacheDir(): void {
  if (!existsSync(CACHE_DIR)) {
    mkdirSync(CACHE_DIR, { recursive: true });
  }
}

function getCachePath(filePath: string): string {
  const hash = createHash('md5').update(filePath).digest('hex');
  return join(CACHE_DIR, `${hash}.jpg`);
}

export function generateThumbnail(
  filePath: string,
): Effect.Effect<Uint8Array, ThumbnailError | FileNotFoundError> {
  return Effect.gen(function* (_) {
    if (!existsSync(filePath)) {
      return yield* _(Effect.fail(new FileNotFoundError(filePath)));
    }

    ensureCacheDir();
    const cachePath = getCachePath(filePath);

    if (existsSync(cachePath)) {
      const cached = yield* _(
        Effect.tryPromise({
          try: () => Bun.file(cachePath).arrayBuffer(),
          catch: (error) => new ThumbnailError(filePath, String(error)),
        }),
      );
      return new Uint8Array(cached as ArrayBuffer);
    }

    const thumbnailBuffer = yield* _(
      Effect.tryPromise({
        try: () =>
          sharp(filePath)
            .resize(THUMBNAIL_MAX_WIDTH, undefined, { withoutEnlargement: true })
            .jpeg({ quality: 80 })
            .toBuffer(),
        catch: (error) => new ThumbnailError(filePath, String(error)),
      }),
    );

    yield* _(
      Effect.tryPromise({
        try: () => Bun.write(cachePath, thumbnailBuffer),
        catch: (error) => new ThumbnailError(filePath, String(error)),
      }),
    );

    return new Uint8Array(thumbnailBuffer);
  });
}
