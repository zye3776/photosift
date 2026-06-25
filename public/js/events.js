/* PhotoSift — Event Listeners */

import {
  state, TILE_SIZE_MIN, TILE_SIZE_MAX, TILE_SIZE_STEP, STORAGE_KEY, MODE_STORAGE_KEY,
  PAGE_SIZE_STORAGE_KEY,
} from './state.js';
import {
  $btnPickFolder, $folderDisplay, $btnScanFolder, $toggleGroupMode,
  $groupFilter, $groupSizeFilter, $pageSizeSelect,
  $btnPrevGroup, $btnNextGroup,
  $btnSelectAll, $btnInvertSelection, $btnDeselectAll, $btnDelete,
  $btnUndo, $photoGrid,
  $btnModePhotos, $btnModeVideos, $btnStopGenerate,
} from './dom.js';
import { getVisiblePhotos, updateGroupNav, hideProgressOverlay } from './ui.js';
import { renderGrid } from './grid.js';
import {
  scanFolder, applyGroupFilter, deleteUnselected, undoLastDelete,
  updateModeCount, maybeGenerateClips, stopClips,
} from './api.js';

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

/* ── Photos / Videos mode toggle ──────────────────
   Switching mode only re-renders — the single scan already returned both
   photos and videos, so we never re-scan just to switch. */

function setMode(mode) {
  if (state.mode === mode) return;
  state.mode = mode;
  localStorage.setItem(MODE_STORAGE_KEY, mode);

  // Leaving video mode: stop any in-flight clip-generation progress stream so we
  // don't keep a Server-Sent Events connection open (and updating now-hidden
  // tiles) while the user browses photos.
  if (mode !== 'videos' && state.videoProgressSource) {
    state.videoProgressSource.close();
    state.videoProgressSource = null;
    hideProgressOverlay();
  }

  // Reflect which button is active.
  $btnModePhotos.classList.toggle('active', mode === 'photos');
  $btnModeVideos.classList.toggle('active', mode === 'videos');

  // Group navigation lists differ between photos and videos, so rebuild them.
  state.currentGroupIndex = 0;
  state.currentPage = 0;
  applyGroupFilter();
  updateGroupNav();
  updateModeCount();
  renderGrid();

  // Entering video mode may need preview clips built for not-ready videos.
  if (mode === 'videos') {
    maybeGenerateClips();
  }
}

$btnModePhotos.addEventListener('click', () => setMode('photos'));
$btnModeVideos.addEventListener('click', () => setMode('videos'));

// Stop button on the "Generating previews…" overlay halts the current run.
$btnStopGenerate.addEventListener('click', () => stopClips());

// Reflect the persisted mode on the toggle buttons at startup.
$btnModePhotos.classList.toggle('active', state.mode === 'photos');
$btnModeVideos.classList.toggle('active', state.mode === 'videos');

/* ── Page-size dropdown ───────────────────────────
   Lets the user choose how many items show per page. Changing it remembers the
   choice, jumps back to the first page (the old page number may no longer
   exist), and redraws. */

// Reflect the saved/default page size on the dropdown at startup.
$pageSizeSelect.value = String(state.pageSize);

$pageSizeSelect.addEventListener('change', () => {
  const size = parseInt($pageSizeSelect.value, 10);
  if (!Number.isFinite(size) || size <= 0) return;
  state.pageSize = size;
  localStorage.setItem(PAGE_SIZE_STORAGE_KEY, String(size));
  state.currentPage = 0;
  renderGrid();
  $photoGrid.scrollTop = 0;
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

  // Rebuild the group list for the current mode before navigating.
  applyGroupFilter();
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
