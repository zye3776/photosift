/* PhotoSift — State & Constants */

export const TILE_SIZE_MIN = 80;
export const TILE_SIZE_MAX = 1200;
export const TILE_SIZE_STEP = 40;
export const TILE_SIZE_DEFAULT = 200;
// How many items show per page by default, and the choices offered in the
// page-size dropdown. Smaller pages keep the grid lighter; larger pages let you
// scan more at once.
export const PAGE_SIZE = 100;
export const PAGE_SIZE_OPTIONS = [50, 100, 250, 500, 1000];
export const STORAGE_KEY = 'photosift_last_folder';
// localStorage key that remembers whether the user last looked at photos or videos.
export const MODE_STORAGE_KEY = 'photosift_mode';
// localStorage key that remembers the user's chosen page size.
export const PAGE_SIZE_STORAGE_KEY = 'photosift_page_size';

// The page size to start with: the user's saved choice if it's one of the
// offered options, otherwise the default.
function initialPageSize() {
  const saved = parseInt(localStorage.getItem(PAGE_SIZE_STORAGE_KEY), 10);
  return PAGE_SIZE_OPTIONS.includes(saved) ? saved : PAGE_SIZE;
}

export const state = {
  // 'photos' = the original photo picker, 'videos' = the video preview mode.
  // Videos is the default; loaded from localStorage so the app reopens in the
  // same mode the user last used (only an explicit 'photos' keeps photo mode).
  mode: localStorage.getItem(MODE_STORAGE_KEY) === 'photos' ? 'photos' : 'videos',

  // How many items to show per page; changed via the page-size dropdown.
  pageSize: initialPageSize(),

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
