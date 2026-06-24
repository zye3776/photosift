import { Effect } from 'effect';
import { readdir, stat } from 'node:fs/promises';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, parse, extname } from 'node:path';
import { FolderNotFoundError, FolderReadError } from './errors';
import { readStats } from './stats';
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

// A 1-second preview clip is cut every CLIP_INTERVAL_SECS within the usable
// window (see clipTimestamps). Exported so the clip generator uses the same
// interval the scanner counts by.
export const CLIP_INTERVAL_SECS = 300;

// Skip windows: don't cut preview clips from the very start or very end of a
// video, where there's usually a title card / intro or trailing credits.
const SKIP_START_SECS = 30 * 60; // skip the first 30 minutes
const SKIP_END_SECS = 10 * 60; // skip the last 10 minutes
// For videos too short for the window above, fall back to skipping just the
// first and last 5 minutes instead.
const SHORT_SKIP_SECS = 5 * 60;

export function extractGroup(stem: string): string {
  const match = GROUP_PATTERN.exec(stem);
  return match ? match[1] : stem;
}

// Clip start times (seconds) within [start, end], one every CLIP_INTERVAL_SECS.
function timesInWindow(start: number, end: number): number[] {
  const times: number[] = [];
  for (let t = start; t <= end; t += CLIP_INTERVAL_SECS) {
    times.push(t);
  }
  return times;
}

// The timestamps (in seconds) at which to cut preview clips for a video of the
// given length, taken every CLIP_INTERVAL_SECS. We try progressively smaller
// skip windows so every video still gets at least one preview:
//   1. skip the first 30 min and last 10 min (the normal case),
//   2. if the video is too short for that, skip just the first and last 5 min,
//   3. if it's still too short, a single clip near the middle.
// A clip never lands at or past the end (each window stops early), so ffmpeg
// always has real footage to cut.
export function clipTimestamps(duration: number): number[] {
  const primary = timesInWindow(SKIP_START_SECS, duration - SKIP_END_SECS);
  if (primary.length > 0) return primary;

  const short = timesInWindow(SHORT_SKIP_SECS, duration - SHORT_SKIP_SECS);
  if (short.length > 0) return short;

  return [Math.max(0, Math.floor(duration / 2))];
}

// Number of preview clips a video should have — the count of clip timestamps.
// Derived from clipTimestamps so the scanner's "is it complete?" check always
// matches exactly what the generator produces.
export function expectedClipCount(duration: number): number {
  return clipTimestamps(duration).length;
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
    // generated clip folder here — no ffmpeg/ffprobe runs during a scan. Open
    // counts come from the stats file (read once; missing file => all zero).
    const openCounts = readStats();
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
        opens: openCounts[path] || 0,
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
