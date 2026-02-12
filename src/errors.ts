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

export type PhotoSiftError =
  | FolderNotFoundError
  | FolderReadError
  | ThumbnailError
  | TrashError
  | FileNotFoundError;
