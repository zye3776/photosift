export interface PhotoPair {
  stem: string;
  jpgPath: string;
  rafPath: string | null;
  group: string;
}

// A single video file found in the scanned folder, plus the two preview assets
// PhotoSift builds from it. Together they let the UI show a moving preview of a
// long video without playing the whole thing:
//   - preview: a single looping animated image (webp, or gif fallback) shown
//     while the tile is on screen.
//   - poster:  a single still frame shown while the tile is off screen, so
//     off-screen tiles cost nothing to animate.
// Both are absolute paths, or '' when not generated yet.
export interface VideoItem {
  stem: string; // filename without extension
  path: string; // absolute path to the video file
  group: string; // from extractGroup(stem) — same regex used for photos
  preview: string; // absolute path to the animated preview image ('' if not ready)
  poster: string; // absolute path to the still poster image ('' if not present)
  clipsReady: boolean; // true when the animated preview is fully built on disk
  duration: number; // seconds (0 if unknown / not yet probed)
  opens: number; // how many times this video has been opened (from the stats file)
}

export interface ScanResult {
  folder: string;
  photos: PhotoPair[];
  groups: Record<string, PhotoPair[]>;
  videos: VideoItem[];
  videoGroups: Record<string, VideoItem[]>;
}

export interface DeleteRequest {
  files: string[];
}

export interface DeleteResult {
  deleted: string[];
  failed: Array<{ path: string; reason: string }>;
}
