export interface PhotoPair {
  stem: string;
  jpgPath: string;
  rafPath: string | null;
  group: string;
}

export interface ScanResult {
  folder: string;
  photos: PhotoPair[];
  groups: Record<string, PhotoPair[]>;
}

export interface DeleteRequest {
  files: string[];
}

export interface DeleteResult {
  deleted: string[];
  failed: Array<{ path: string; reason: string }>;
}
