/* PhotoSift — Event Listeners */

import { state, TILE_SIZE_MIN, TILE_SIZE_MAX, TILE_SIZE_STEP, STORAGE_KEY } from './state.js';
import {
  $btnPickFolder, $folderDisplay, $btnScanFolder, $toggleGroupMode,
  $groupFilter, $groupSizeFilter,
  $btnPrevGroup, $btnNextGroup,
  $btnSelectAll, $btnInvertSelection, $btnDeselectAll, $btnDelete,
  $btnUndo, $photoGrid,
} from './dom.js';
import { getVisiblePhotos, updateGroupNav, dismissUndo } from './ui.js';
import { renderGrid } from './grid.js';
import { scanFolder, applyGroupFilter, deleteUnselected, undoLastDelete } from './api.js';

$btnPickFolder.addEventListener('click', async () => {
  $btnPickFolder.disabled = true;
  $btnPickFolder.textContent = 'Selecting...';
  try {
    const response = await fetch('/api/pick-folder');
    const data = await response.json();
    if (data.cancelled) return;
    if (data.error) {
      alert(`Folder picker failed: ${data.message}`);
      return;
    }
    $folderDisplay.textContent = data.folder;
    $folderDisplay.classList.add('active');
    state.currentFolder = data.folder;
    localStorage.setItem(STORAGE_KEY, data.folder);
  } finally {
    $btnPickFolder.disabled = false;
    $btnPickFolder.textContent = 'Select Folder';
  }
});

$btnScanFolder.addEventListener('click', () => {
  if (state.currentFolder) {
    scanFolder(state.currentFolder);
  } else {
    alert('Please select a folder first.');
  }
});

$toggleGroupMode.addEventListener('change', () => {
  state.groupMode = $toggleGroupMode.checked;
  state.currentGroupIndex = 0;
  state.currentPage = 0;
  
  if (state.groupMode) {
    $groupFilter.classList.remove('hidden');
  } else {
    $groupFilter.classList.add('hidden');
  }

  updateGroupNav();
  renderGrid();
});

$groupSizeFilter.addEventListener('input', () => {
  state.groupFilterCount = parseInt($groupSizeFilter.value) || 0;
  applyGroupFilter();
  updateGroupNav();
  renderGrid();
});

$btnPrevGroup.addEventListener('click', () => {
  if (state.currentGroupIndex > 0) {
    state.currentGroupIndex--;
    state.currentPage = 0;
    updateGroupNav();
    renderGrid();
  }
});

$btnNextGroup.addEventListener('click', () => {
  if (state.currentGroupIndex < state.groupNames.length - 1) {
    state.currentGroupIndex++;
    state.currentPage = 0;
    updateGroupNav();
    renderGrid();
  }
});


$btnSelectAll.addEventListener('click', () => {
  const visible = getVisiblePhotos();
  for (const photo of visible) {
    state.selectedKeepers.add(photo.stem);
  }
  renderGrid();
});

$btnInvertSelection.addEventListener('click', () => {
  const visible = getVisiblePhotos();
  for (const photo of visible) {
    if (state.selectedKeepers.has(photo.stem)) {
      state.selectedKeepers.delete(photo.stem);
    } else {
      state.selectedKeepers.add(photo.stem);
    }
  }
  renderGrid();
});

$btnDeselectAll.addEventListener('click', () => {
  const visible = getVisiblePhotos();
  for (const photo of visible) {
    state.selectedKeepers.delete(photo.stem);
  }
  renderGrid();
});

$btnDelete.addEventListener('click', () => deleteUnselected());
$btnUndo.addEventListener('click', () => undoLastDelete());

/* ── Scroll-to-zoom ───────────────────────────── */

$photoGrid.addEventListener('wheel', (e) => {
  if (!e.metaKey && !e.ctrlKey) return;
  e.preventDefault();

  if (e.deltaY < 0) {
    state.tileSize = Math.min(state.tileSize + TILE_SIZE_STEP, TILE_SIZE_MAX);
  } else {
    state.tileSize = Math.max(state.tileSize - TILE_SIZE_STEP, TILE_SIZE_MIN);
  }

  $photoGrid.style.setProperty('--tile-size', `${state.tileSize}px`);
}, { passive: false });
