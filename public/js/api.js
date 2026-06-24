/* PhotoSift — API Calls */

import { state, STORAGE_KEY } from './state.js';
import {
  $modeControls, $photoCount,
} from './dom.js';
import {
  showLoading, hideLoading, showUndoToast, dismissUndo,
  getVisiblePhotos, updateGroupNav,
  showProgressOverlay, updateProgressOverlay, hideProgressOverlay,
} from './ui.js';
import { renderGrid } from './grid.js';
import { refreshVideoTile } from './video-grid.js';

// Natural, case-insensitive sort by stem so "clip-2" sorts before "clip-10".
// Shared by the photo and video lists so both order the same way.
function byStem(a, b) {
  return (a.stem || '').localeCompare(b.stem || '', undefined, {
    numeric: true,
    sensitivity: 'base',
  });
}

// Rebuild the list of group names the navigation should step through.
// In video mode it filters the video groups; otherwise the photo groups.
// Both use the same "minimum items per group" threshold the user set.
export function applyGroupFilter() {
  const groups = state.mode === 'videos' ? state.videoGroups : state.groups;
  // Photo mode reuses the already-sorted allGroupNames; video mode derives and
  // sorts its names here. Either way, drop groups below the user's size filter.
  const names = state.mode === 'videos'
    ? Object.keys(groups).sort()
    : state.allGroupNames;
  state.groupNames = names.filter(
    (name) => (groups[name] || []).length >= state.groupFilterCount,
  );
  state.currentGroupIndex = 0;
}

export async function scanFolder(folderPath, restoreGroupName, options = {}) {
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
    state.photos.sort(byStem);

    state.groups = data.groups;
    state.allGroupNames = Object.keys(data.groups).sort();
    applyGroupFilter();

    // Store the video side of the scan. One scan returns both photos and videos,
    // so switching modes later never needs another scan.
    state.videos = (data.videos || []).slice().sort(byStem);
    state.videoGroups = data.videoGroups || {};

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
    updateModeCount();

    if (state.groupMode && state.groupNames.length > 0) {
      updateGroupNav();
    }

    renderGrid();

    // If we just scanned while in video mode and some videos still need preview
    // clips, kick off background generation now (renderGrid alone does not start it).
    // Callers can pass autoGenerate:false (e.g. the post-completion refresh scan)
    // so that finishing one generation run cannot immediately start another.
    if (state.mode === 'videos' && options.autoGenerate !== false) {
      maybeGenerateClips();
    }
  } finally {
    hideLoading();
  }
}

// Update the count label in the top bar to match the current mode.
export function updateModeCount() {
  if (state.mode === 'videos') {
    $photoCount.textContent = `${state.videos.length} videos`;
  } else {
    $photoCount.textContent = `${state.photos.length} photos`;
  }
}

// Tell the backend to build any missing preview clips for the current folder,
// then listen for progress updates over Server-Sent Events. Safe to call when
// everything is already generated — it simply does nothing in that case.
export async function maybeGenerateClips() {
  const notReady = state.videos.filter((v) => !v.clipsReady);
  if (notReady.length === 0) return;

  try {
    const result = await generateClips(state.currentFolder);
    if (result && result.started && result.total > 0) {
      subscribeToProgress(result.total);
    }
  } catch (err) {
    console.error('Failed to start clip generation', err);
  }
}

// POST /api/generate-clips — asks the backend to start building preview clips.
// Returns { started, total } where total is how many videos needed work.
export async function generateClips(folderPath) {
  const response = await fetch('/api/generate-clips', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ folder: folderPath }),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.message || 'generate-clips failed');
  }
  return response.json();
}

// Open a live stream of clip-generation progress from the backend.
// The backend pushes one message per video state change over Server-Sent Events
// (a one-way "server keeps the connection open and sends text" channel). Each
// message looks like {"stem","done","total","status"} where status is
// "start" | "done" | "error" and done/total are overall video counts.
export function subscribeToProgress(total) {
  // Close any previous stream so we never have two running at once.
  if (state.videoProgressSource) {
    state.videoProgressSource.close();
    state.videoProgressSource = null;
  }

  showProgressOverlay(0, total);

  const source = new EventSource('/api/progress');
  state.videoProgressSource = source;

  source.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      console.warn('Ignoring malformed progress message', event.data);
      return;
    }

    const finishedOne = msg.status === 'done' || msg.status === 'error';

    // The overall counter only advances when a video finishes. "start" events
    // also carry a count, but a sibling worker can read it a moment before its
    // own increment lands, which would make the bar appear to tick backward — so
    // we ignore the count on "start".
    if (finishedOne) {
      updateProgressOverlay(msg.done, msg.total);
    }

    // When a single video finishes, mark it ready and re-render just that tile
    // so its placeholder turns into a live preview without a full reload.
    if (msg.status === 'done' && msg.stem) {
      const video = state.videos.find((v) => v.stem === msg.stem);
      if (video) {
        video.clipsReady = true;
        refreshVideoTile(msg.stem);
      }
    }

    // All videos processed — stop listening and hide the overlay. Only a
    // completion event can end the run (a "start" carrying done === total cannot).
    if (finishedOne && msg.total > 0 && msg.done >= msg.total) {
      hideProgressOverlay();
      source.close();
      state.videoProgressSource = null;
      // One final scan to pick up the freshly written clip paths for every tile.
      // autoGenerate:false so this refresh cannot trigger another generation run.
      scanFolder(state.currentFolder, undefined, { autoGenerate: false });
    }
  };

  source.onerror = () => {
    // The connection dropped (or the server finished). Hide the overlay; tiles
    // that already turned ready stay ready.
    hideProgressOverlay();
    source.close();
    state.videoProgressSource = null;
  };
}

// POST /api/open — open the original video in the macOS default player.
export async function openVideo(filePath) {
  const response = await fetch('/api/open', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file: filePath }),
  });
  return response.json();
}

// Soft-delete a single video file (moves it to _deleted) and show the undo toast.
// Reuses the same /api/delete + /api/restore flow the photo grid uses.
export async function deleteVideo(video) {
  showLoading('Moving video to _deleted...');
  try {
    const response = await fetch('/api/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: [video.path] }),
    });
    const result = await response.json();

    if (result.failed && result.failed.length > 0) {
      const msgs = result.failed.map((f) => `${f.path}: ${f.reason}`);
      alert(`Failed to delete:\n${msgs.join('\n')}`);
    }

    state.lastDeletedFiles = result.deleted || [];
    state.lastDeletedGroup = null;

    // Re-scan so the grid reflects the removal (cheap: scan does no FFmpeg work).
    await scanFolder(state.currentFolder);

    if (state.lastDeletedFiles.length > 0) {
      showUndoToast(1);
    }
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
  } finally {
    hideLoading();
  }
}

export async function undoLastDelete() {
  if (state.lastDeletedFiles.length === 0) return;

  const filesToRestore = [...state.lastDeletedFiles];
  const targetGroup = state.lastDeletedGroup;

  dismissUndo();
  // Clear state immediately to prevent double-click issues
  state.lastDeletedFiles = [];
  state.lastDeletedGroup = null;

  showLoading('Restoring files...');
  try {
    const response = await fetch('/api/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: filesToRestore }),
    });
    const result = await response.json();

    if (result.failed && result.failed.length > 0) {
      const msgs = result.failed.map((f) => `${f.path}: ${f.reason}`);
      alert(`Some files failed to restore:\n${msgs.join('\n')}`);
    }

    await scanFolder(state.currentFolder, targetGroup || state.groupNames[state.currentGroupIndex]);
  } finally {
    hideLoading();
  }
}
