export class FolderNotFoundError {
  readonly _tag = 'FolderNotFoundError';
  constructor(readonly path: string) {}
}

export class FolderReadError {
  readonly _tag = 'FolderReadError';
  constructor(
    readonly path: string,
    readonly reason: string,
  ) {}
}

export class ThumbnailError {
  readonly _tag = 'ThumbnailError';
  constructor(
    readonly filePath: string,
    readonly reason: string,
  ) {}
}

export class TrashError {
  readonly _tag = 'TrashError';
  constructor(
    readonly filePath: string,
    readonly reason: string,
  ) {}
}

export class FileNotFoundError {
  readonly _tag = 'FileNotFoundError';
  constructor(readonly path: string) {}
}

// Raised when reading a video's duration with ffprobe fails (file missing,
// not a real video, ffprobe not installed, etc.).
export class VideoProbeError {
  readonly _tag = 'VideoProbeError';
  constructor(
    readonly filePath: string,
    readonly reason: string,
  ) {}
}

// Raised when a single ffmpeg clip-cutting command fails for a video.
export class FFmpegError {
  readonly _tag = 'FFmpegError';
  constructor(
    readonly filePath: string,
    readonly reason: string,
  ) {}
}

// Raised when the overall clip-generation run for a video cannot complete.
export class ClipGenerationError {
  readonly _tag = 'ClipGenerationError';
  constructor(
    readonly filePath: string,
    readonly reason: string,
  ) {}
}

export type PhotoSiftError =
  | FolderNotFoundError
  | FolderReadError
  | ThumbnailError
  | TrashError
  | FileNotFoundError
  | VideoProbeError
  | FFmpegError
  | ClipGenerationError;
