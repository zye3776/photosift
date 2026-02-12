/* PhotoSift — State & Constants */

export const TILE_SIZE_MIN = 80;
export const TILE_SIZE_MAX = 1200;
export const TILE_SIZE_STEP = 40;
export const TILE_SIZE_DEFAULT = 200;
export const PAGE_SIZE = 100;
export const STORAGE_KEY = 'photosift_last_folder';

export const state = {
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
};
