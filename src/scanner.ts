import { Effect } from 'effect';
import { readdir, stat } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
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

// Folder name that holds generated previews, one subfolder per video stem:
//   <folder>/.clips/<video-stem>/preview.webp + poster.jpg + meta.json
// Exported so the clip generator and the trash module share one definition.
export const CLIPS_FOLDER = '.clips';

// The two preview assets written per video. A single looping animated image
// (preview) is shown when a tile is on screen; a single still frame (poster) is
// shown when it is off screen, so off-screen tiles cost nothing to animate.
//   - preview.webp is the preferred animated format (small, full colour). When
//     the WebP command-line tools aren't installed we fall back to preview.gif,
//     so the scanner looks for either.
//   - poster.jpg is always a plain JPEG (built with ffmpeg alone).
export const PREVIEW_WEBP_FILE = 'preview.webp';
export const PREVIEW_GIF_FILE = 'preview.gif';
export const POSTER_FILE = 'poster.jpg';

// A 1-second motion burst is sampled every CLIP_INTERVAL_SECS within the usable
// window (see clipTimestamps). Exported so the clip generator uses the same
// interval the scanner counts by.
export const CLIP_INTERVAL_SECS = 300;

// How much of the start and end of a video to skip when sampling, so previews
// avoid title cards / intros and trailing credits. The amount scales with the
// video's length — a feature-length video has a long intro to skip, a short clip
// barely any:
//   - 1 hour or longer:  skip the first 30 min and last 10 min
//   - 30 min to 1 hour:  skip the first 5 min and last 3 min
//   - under 30 min:      skip the first 2 min and last 1 min
// Returns [skipStart, skipEnd] in seconds for the given duration.
const ONE_HOUR_SECS = 60 * 60;
const HALF_HOUR_SECS = 30 * 60;

function skipWindow(duration: number): [number, number] {
  if (duration >= ONE_HOUR_SECS) return [30 * 60, 10 * 60];
  if (duration >= HALF_HOUR_SECS) return [5 * 60, 3 * 60];
  return [2 * 60, 1 * 60];
}

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

// The timestamps (in seconds) at which to sample preview bursts for a video of
// the given length, taken every CLIP_INTERVAL_SECS within the length-based skip
// window (see skipWindow). If the video is so short that the window is empty
// (e.g. only a couple of minutes long), fall back to a single sample near the
// middle so every video still gets a preview. A sample never lands at or past
// the end (the window stops early), so ffmpeg always has real footage to cut.
export function clipTimestamps(duration: number): number[] {
  const [skipStart, skipEnd] = skipWindow(duration);
  const times = timesInWindow(skipStart, duration - skipEnd);
  if (times.length > 0) return times;

  return [Math.max(0, Math.floor(duration / 2))];
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

// Read a single video's preview folder and report the preview/poster paths that
// exist, plus whether the preview is fully built.
//
// Scans must stay fast, so we never run ffprobe here. The generator writes a
// meta.json (holding the duration it measured) only AFTER the animated preview
// is finished, so the presence of BOTH the preview file and meta.json means the
// preview is complete. Without them we report not-ready and the generator fills
// it in. The preview may be a .webp (preferred) or a .gif fallback.
function readClipsForStem(
  folderPath: string,
  stem: string,
): { preview: string; poster: string; clipsReady: boolean; duration: number } {
  const clipDir = join(folderPath, CLIPS_FOLDER, stem);
  const empty = { preview: '', poster: '', clipsReady: false, duration: 0 };
  if (!existsSync(clipDir)) return empty;

  const webpPath = join(clipDir, PREVIEW_WEBP_FILE);
  const gifPath = join(clipDir, PREVIEW_GIF_FILE);
  const preview = existsSync(webpPath)
    ? webpPath
    : existsSync(gifPath)
      ? gifPath
      : '';

  const posterPath = join(clipDir, POSTER_FILE);
  const poster = existsSync(posterPath) ? posterPath : '';

  let duration = 0;
  const metaPath = join(clipDir, CLIP_META_FILE);
  const hasMeta = existsSync(metaPath);
  if (hasMeta) {
    try {
      const meta = JSON.parse(readFileSync(metaPath, 'utf-8')) as {
        duration?: number;
      };
      duration = typeof meta.duration === 'number' ? meta.duration : 0;
    } catch {
      // Unreadable meta.json — treat as no duration; readiness handled below.
    }
  }

  // Ready only when the animated preview exists and meta.json confirms the run
  // finished (meta is written last). Poster is best-effort; the UI falls back to
  // the preview as its still frame when a poster is missing.
  const clipsReady = preview !== '' && hasMeta;
  return { preview, poster, clipsReady, duration };
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
      const { preview, poster, clipsReady, duration } = readClipsForStem(
        folderPath,
        stem,
      );
      videos.push({
        stem,
        path,
        group: extractGroup(stem),
        preview,
        poster,
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
