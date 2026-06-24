import { Effect } from 'effect';
import { readdir, stat } from 'node:fs/promises';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, parse, extname } from 'node:path';
import { FolderNotFoundError, FolderReadError } from './errors';
import type { PhotoPair, VideoItem, ScanResult } from './types';

const GROUP_PATTERN = /^(.+)-(\d{2,3})$/;

const JPG_EXTENSIONS = new Set(['.jpg', '.jpeg']);
const RAW_EXTENSION = '.raf';

// Video file types PhotoSift recognizes (compared lowercase, so .MP4 works too).
export const VIDEO_EXTENSIONS = new Set([
  '.mp4',
  '.mov',
  '.m4v',
  '.mkv',
  '.webm',
  '.avi',
]);

// Folder name that holds generated preview clips, one subfolder per video stem:
//   <folder>/.clips/<video-stem>/clip-001.mp4, clip-002.mp4, ...
// Exported so the clip generator and the trash module share one definition.
export const CLIPS_FOLDER = '.clips';

// A 1-second preview clip is cut every CLIP_INTERVAL_SECS, starting at t=0.
// Exported so the clip generator uses the same interval the scanner counts by.
export const CLIP_INTERVAL_SECS = 300;

export function extractGroup(stem: string): string {
  const match = GROUP_PATTERN.exec(stem);
  return match ? match[1] : stem;
}

// Number of preview clips a video should have: one clip at the start of each
// CLIP_INTERVAL_SECS block (t = 0, 300, 600 …). We use ceil rather than
// `floor + 1` so a video whose length is an exact multiple of the interval does
// NOT get a final clip sitting right on its end timestamp. Such a clip would
// land at t === duration, where ffmpeg produces an empty file; the clip count
// would then never reach the expected total and the video would needlessly
// re-generate every time the folder is opened. Even a very short video gets one.
export function expectedClipCount(duration: number): number {
  return Math.max(1, Math.ceil(duration / CLIP_INTERVAL_SECS));
}

// Generic grouping: bucket any item that has a `group` field by that value.
// Used for both photos and videos so the two paths share one implementation.
function buildGroupsBy<T extends { group: string }>(
  items: T[],
): Record<string, T[]> {
  const groups: Record<string, T[]> = {};
  for (const item of items) {
    if (!groups[item.group]) {
      groups[item.group] = [];
    }
    groups[item.group].push(item);
  }
  return groups;
}

function buildGroups(photos: PhotoPair[]): Record<string, PhotoPair[]> {
  return buildGroupsBy(photos);
}

// Name of the small metadata file the clip generator drops next to a video's
// clips. It records the video's probed duration so a later scan can tell how
// many clips that video should have — without re-running ffprobe at scan time.
export const CLIP_META_FILE = 'meta.json';

// Read a single video's clip folder and report which clip files exist, plus
// whether the full set of expected clips is already present.
//
// We never run ffprobe during a scan (scans must stay fast), so we cannot
// compute the expected clip count from the live video. Instead the generator
// writes a meta.json holding the duration it measured. When that file is
// present we compare the number of clip-*.mp4 files against the expected count
// for that duration. Without meta.json we cannot be sure the set is complete,
// so we report not-ready (the generator will fill it in).
function readClipsForStem(
  folderPath: string,
  stem: string,
): { clips: string[]; clipsReady: boolean; duration: number } {
  const clipDir = join(folderPath, CLIPS_FOLDER, stem);
  if (!existsSync(clipDir)) {
    return { clips: [], clipsReady: false, duration: 0 };
  }
  let names: string[];
  try {
    names = readdirSync(clipDir);
  } catch {
    return { clips: [], clipsReady: false, duration: 0 };
  }
  const clips = names
    .filter((n) => /^clip-\d+\.mp4$/i.test(n))
    .sort((a, b) => a.localeCompare(b))
    .map((n) => join(clipDir, n));

  let duration = 0;
  let clipsReady = false;
  const metaPath = join(clipDir, CLIP_META_FILE);
  if (existsSync(metaPath)) {
    try {
      const meta = JSON.parse(readFileSync(metaPath, 'utf-8')) as {
        duration?: number;
      };
      duration = typeof meta.duration === 'number' ? meta.duration : 0;
      clipsReady = clips.length >= expectedClipCount(duration);
    } catch {
      clipsReady = false;
    }
  }

  return { clips, clipsReady, duration };
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
    // Stem -> absolute path for each video file found this scan.
    const videoFiles = new Map<string, string>();

    for (const entry of entries) {
      // Skip hidden entries. This also skips the .clips folder (where preview
      // clips live) so it is never treated as a photo or video, the same way
      // the _deleted folder is skipped because it is a directory, not a file.
      if (entry.name.startsWith('.')) continue;
      if (!entry.isFile()) continue;

      const ext = extname(entry.name).toLowerCase();
      const { name } = parse(entry.name);

      if (VIDEO_EXTENSIONS.has(ext)) {
        // Keep the first file seen for a stem if duplicates somehow exist.
        if (!videoFiles.has(name)) {
          videoFiles.set(name, join(folderPath, entry.name));
        }
        continue;
      }

      if (!JPG_EXTENSIONS.has(ext) && ext !== RAW_EXTENSION) continue;
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

    // Build the video list. We only list files and read each video's already
    // generated clip folder here — no ffmpeg/ffprobe runs during a scan.
    const videos: VideoItem[] = [];
    for (const [stem, path] of videoFiles) {
      const { clips, clipsReady, duration } = readClipsForStem(folderPath, stem);
      videos.push({
        stem,
        path,
        group: extractGroup(stem),
        clips,
        clipsReady,
        duration,
      });
    }
    videos.sort((a, b) => a.stem.localeCompare(b.stem));

    return {
      folder: folderPath,
      photos,
      groups: buildGroups(photos),
      videos,
      videoGroups: buildGroupsBy(videos),
    };
  });
}
