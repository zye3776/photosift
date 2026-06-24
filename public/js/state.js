/* PhotoSift — State & Constants */

export const TILE_SIZE_MIN = 80;
export const TILE_SIZE_MAX = 1200;
export const TILE_SIZE_STEP = 40;
export const TILE_SIZE_DEFAULT = 200;
export const PAGE_SIZE = 100;
export const STORAGE_KEY = 'photosift_last_folder';
// localStorage key that remembers whether the user last looked at photos or videos.
export const MODE_STORAGE_KEY = 'photosift_mode';

export const state = {
  // 'photos' = the original photo picker, 'videos' = the new video preview mode.
  // Loaded from localStorage so the app reopens in the same mode the user last used.
  mode: localStorage.getItem(MODE_STORAGE_KEY) === 'videos' ? 'videos' : 'photos',

  photos: [],
  groups: {},
  groupNames: [],
  selectedKeepers: new Set(),
  tileSize: TILE_SIZE_DEFAULT,
  groupMode: false,
  currentGroupIndex: 0,
  currentFolder: '',
  currentPage: 0,
  lastDeletedFiles: [],
  lastDeletedGroup: null,
  undoTimeout: null,
  groupFilterCount: 6,
  allGroupNames: [],

  // ── Video preview mode ──────────────────────────
  videos: [],                 // VideoItem[] from /api/scan
  videoGroups: {},            // Record<string, VideoItem[]> keyed by group name
  videoProgressSource: null,  // the open EventSource for clip-generation progress (or null)
};
