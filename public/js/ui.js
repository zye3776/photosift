/* PhotoSift — UI Helpers */

import { state, PAGE_SIZE } from './state.js';
import {
  $loading, $loadingText, $undoMessage,
  $selectionCount, $groupNav, $groupInfo,
  $btnPrevGroup, $btnNextGroup, $btnUndo,
  $progressOverlay, $progressText,
} from './dom.js';

export function showLoading(text) {
  $loadingText.textContent = text;
  $loading.classList.remove('hidden');
}

export function hideLoading() {
  $loading.classList.add('hidden');
}

export function showUndoToast(count) {
  $undoMessage.textContent = `${count} deleted.`;
  $undoMessage.classList.remove('hidden');
  $btnUndo.disabled = false;

  if (state.undoTimeout) clearTimeout(state.undoTimeout);
  state.undoTimeout = setTimeout(() => dismissUndo(), 15000);
}

export function dismissUndo() {
  $undoMessage.classList.add('hidden');
  $btnUndo.disabled = true;

  if (state.undoTimeout) {
    clearTimeout(state.undoTimeout);
    state.undoTimeout = null;
  }
}

export function getVisiblePhotos() {
  if (!state.groupMode) return state.photos;
  const groupName = state.groupNames[state.currentGroupIndex];
  return state.groups[groupName] || [];
}

// Videos that should be shown right now. In group mode it returns the current
// group's videos; otherwise all videos. Mirrors getVisiblePhotos for the video grid.
export function getVisibleVideos() {
  if (!state.groupMode) return state.videos;
  const groupName = state.groupNames[state.currentGroupIndex];
  return state.videoGroups[groupName] || [];
}

// The items the current mode is showing (photos or videos). Pagination and
// the page math below are shared, so they go through this one helper.
export function getVisibleItems() {
  return state.mode === 'videos' ? getVisibleVideos() : getVisiblePhotos();
}

export function getPagedPhotos() {
  const visible = getVisiblePhotos();
  const start = state.currentPage * PAGE_SIZE;
  return visible.slice(start, start + PAGE_SIZE);
}

// The slice of videos for the current page (same paging rule as photos).
export function getPagedVideos() {
  const visible = getVisibleVideos();
  const start = state.currentPage * PAGE_SIZE;
  return visible.slice(start, start + PAGE_SIZE);
}

export function getTotalPages() {
  return Math.max(1, Math.ceil(getVisibleItems().length / PAGE_SIZE));
}

export function updateSelectionCount() {
  const visible = getVisiblePhotos();
  const kept = visible.filter((p) => state.selectedKeepers.has(p.stem)).length;
  $selectionCount.textContent = `Keeping ${kept} of ${visible.length}`;
}

export function updateGroupNav() {
  if (!state.groupMode) {
    $groupNav.classList.add('hidden');
    return;
  }
  $groupNav.classList.remove('hidden');
  const total = state.groupNames.length;
  if (total === 0) {
    const noun = state.mode === 'videos' ? 'videos' : 'photos';
    $groupInfo.textContent = `No groups with at least ${state.groupFilterCount} ${noun}`;
    $btnPrevGroup.disabled = true;
    $btnNextGroup.disabled = true;
    return;
  }
  const groupName = state.groupNames[state.currentGroupIndex];
  const items = getVisibleItems();
  const noun = state.mode === 'videos' ? 'videos' : 'photos';
  const idx = state.currentGroupIndex + 1;
  $groupInfo.textContent = `${groupName} (${items.length} ${noun}) \u2014 Group ${idx} of ${total}`;
  $btnPrevGroup.disabled = state.currentGroupIndex === 0;
  $btnNextGroup.disabled = state.currentGroupIndex >= total - 1;
}

/* \u2500\u2500 Clip generation progress overlay \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
   A small floating message ("Generating previews\u2026 X/Y") shown while the
   backend builds video preview clips in the background. */

export function showProgressOverlay(done, total) {
  updateProgressOverlay(done, total);
  $progressOverlay.classList.remove('hidden');
}

export function updateProgressOverlay(done, total) {
  $progressText.textContent = `Generating previews\u2026 ${done}/${total}`;
}

export function hideProgressOverlay() {
  $progressOverlay.classList.add('hidden');
}
