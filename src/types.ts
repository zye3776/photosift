export interface PhotoPair {
  stem: string;
  jpgPath: string;
  rafPath: string | null;
  group: string;
}

// A single video file found in the scanned folder, plus the short preview
// clips PhotoSift cuts from it. Clips let the UI show a moving preview of a
// long video without playing the whole thing.
export interface VideoItem {
  stem: string; // filename without extension
  path: string; // absolute path to the video file
  group: string; // from extractGroup(stem) — same regex used for photos
  clips: string[]; // absolute paths to that video's clip files, sorted ascending
  clipsReady: boolean; // true when the expected number of clips already exist on disk
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
