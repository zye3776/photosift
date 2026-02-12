/* PhotoSift — UI Helpers */

import { state, PAGE_SIZE } from './state.js';
import {
  $loading, $loadingText, $undoMessage,
  $selectionCount, $groupNav, $groupInfo,
  $btnPrevGroup, $btnNextGroup, $btnUndo,
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

export function getPagedPhotos() {
  const visible = getVisiblePhotos();
  const start = state.currentPage * PAGE_SIZE;
  return visible.slice(start, start + PAGE_SIZE);
}

export function getTotalPages() {
  return Math.max(1, Math.ceil(getVisiblePhotos().length / PAGE_SIZE));
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
    $groupInfo.textContent = `No groups with at least ${state.groupFilterCount} photos`;
    $btnPrevGroup.disabled = true;
    $btnNextGroup.disabled = true;
    return;
  }
  const groupName = state.groupNames[state.currentGroupIndex];
  const photos = state.groups[groupName] || [];
  const idx = state.currentGroupIndex + 1;
  $groupInfo.textContent = `${groupName} (${photos.length} photos) \u2014 Group ${idx} of ${total}`;
  $btnPrevGroup.disabled = state.currentGroupIndex === 0;
  $btnNextGroup.disabled = state.currentGroupIndex >= total - 1;
}
