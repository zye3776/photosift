/* PhotoSift — API Calls */

import { state, STORAGE_KEY } from './state.js';
import {
  $modeControls, $photoCount,
  $confirmMessage, $confirmDialog,
  $btnConfirmCancel, $btnConfirmDelete,
} from './dom.js';
import {
  showLoading, hideLoading, showUndoToast, dismissUndo,
  getVisiblePhotos, updateGroupNav,
} from './ui.js';
import { renderGrid } from './grid.js';

export async function scanFolder(folderPath, restoreGroupName) {
  showLoading('Scanning folder...');
  try {
    const url = `/api/scan?folder=${encodeURIComponent(folderPath)}`;
    const response = await fetch(url);
    if (!response.ok) {
      const err = await response.json();
      alert(`Scan failed: ${err.error} \u2014 ${err.message || ''}`);
      return;
    }
    const data = await response.json();
    state.photos = data.photos;
    // Sort by name (natural sort)
    state.photos.sort((a, b) => 
      a.stem.localeCompare(b.stem, undefined, { numeric: true, sensitivity: 'base' })
    );

    state.groups = data.groups;
    state.groupNames = Object.keys(data.groups).sort();
    state.currentFolder = folderPath;
    state.selectedKeepers.clear();

    // Restore group position if a group name was provided
    if (restoreGroupName) {
      const idx = state.groupNames.indexOf(restoreGroupName);
      state.currentGroupIndex = idx >= 0 ? idx : 0;
    } else {
      state.currentGroupIndex = 0;
    }
    state.currentPage = 0;

    localStorage.setItem(STORAGE_KEY, folderPath);

    $modeControls.classList.remove('hidden');
    $photoCount.textContent = `${state.photos.length} photos`;

    if (state.groupMode && state.groupNames.length > 0) {
      updateGroupNav();
    }

    renderGrid();
  } finally {
    hideLoading();
  }
}

export async function deleteUnselected() {
  const visible = getVisiblePhotos();
  const toDelete = visible.filter((p) => !state.selectedKeepers.has(p.stem));

  if (toDelete.length === 0) {
    alert('All photos are selected as keepers. Nothing to delete.');
    return;
  }

  const filesToDelete = [];
  for (const photo of toDelete) {
    filesToDelete.push(photo.jpgPath);
    if (photo.rafPath) {
      filesToDelete.push(photo.rafPath);
    }
  }

  const count = toDelete.length;
  const fileCount = filesToDelete.length;
  $confirmMessage.textContent = `This will move ${count} photo(s) (${fileCount} files including RAW) to _deleted subfolder.`;
  $confirmDialog.classList.remove('hidden');

  return new Promise((resolve) => {
    const onCancel = () => {
      $confirmDialog.classList.add('hidden');
      $btnConfirmCancel.removeEventListener('click', onCancel);
      $btnConfirmDelete.removeEventListener('click', onConfirm);
      resolve(false);
    };

    const onConfirm = async () => {
      $confirmDialog.classList.add('hidden');
      $btnConfirmCancel.removeEventListener('click', onCancel);
      $btnConfirmDelete.removeEventListener('click', onConfirm);

      // Remember current group name before re-scan
      const currentGroupName = state.groupMode
        ? state.groupNames[state.currentGroupIndex]
        : null;

      showLoading('Moving files to _deleted...');
      try {
        const response = await fetch('/api/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ files: filesToDelete }),
        });
        const result = await response.json();

        if (result.failed && result.failed.length > 0) {
          const msgs = result.failed.map((f) => `${f.path}: ${f.reason}`);
          alert(`Some files failed to delete:\n${msgs.join('\n')}`);
        }

        // Store deleted files for undo
        state.lastDeletedFiles = result.deleted || [];
        state.lastDeletedGroup = currentGroupName;

        // Re-scan but stay on the same group (or closest valid)
        await scanFolder(state.currentFolder, currentGroupName);

        // Show undo toast
        if (state.lastDeletedFiles.length > 0) {
          showUndoToast(count);
        }

        resolve(true);
      } finally {
        hideLoading();
      }
    };

    $btnConfirmCancel.addEventListener('click', onCancel);
    $btnConfirmDelete.addEventListener('click', onConfirm);
  });
}

export async function undoLastDelete() {
  if (state.lastDeletedFiles.length === 0) return;

  const targetGroup = state.lastDeletedGroup;

  dismissUndo();
  showLoading('Restoring files...');
  try {
    const response = await fetch('/api/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: state.lastDeletedFiles }),
    });
    const result = await response.json();

    if (result.failed && result.failed.length > 0) {
      const msgs = result.failed.map((f) => `${f.path}: ${f.reason}`);
      alert(`Some files failed to restore:\n${msgs.join('\n')}`);
    }

    state.lastDeletedFiles = [];
    state.lastDeletedGroup = null;
    await scanFolder(state.currentFolder, targetGroup || state.groupNames[state.currentGroupIndex]);
  } finally {
    hideLoading();
  }
}
