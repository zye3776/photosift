/* PhotoSift — Video Grid Rendering
   Draws the video preview mode. Each tile is a single <img>: a looping animated
   preview (webp/gif) while the tile is on screen, swapped for a still poster
   image while it's off screen. That swap (in playback.js, driven by an
   IntersectionObserver) means only the handful of tiles you can actually see are
   animating, so the grid stays light even with hundreds of tiles. Clicking a
   tile opens the real video in the Mac's default player; hovering shows a small
   ✕ that soft-deletes the file (with undo). */

import { state } from './state.js';
import {
  $photoGrid, $gridContainer, $actionBar,
} from './dom.js';
import { getPagedVideos } from './ui.js';
import { renderPagination } from './grid.js';
import { observeTile, resetPlayback } from './playback.js';
import { openVideo, deleteVideo } from './api.js';

// Build the URL that serves one preview asset (the animated preview or the still
// poster) from the backend. Both go through the same /api/clip route.
function previewUrl(assetPath) {
  return `/api/clip?file=${encodeURIComponent(assetPath)}`;
}

// Create a single video tile element for one VideoItem.
function createVideoTile(video) {
  const tile = document.createElement('div');
  tile.className = 'video-tile';
  tile.dataset.stem = video.stem;
  tile.title = video.path;

  if (video.preview) {
    // One <img> per tile. It starts on the still poster; the playback observer
    // swaps it to the animated preview when the tile scrolls into view and back
    // to the poster when it leaves. Both URLs are stashed on the tile for that
    // observer. If there's no separate poster, the preview doubles as the still.
    const img = document.createElement('img');
    img.className = 'video-preview';
    img.alt = video.stem;
    img.decoding = 'async';

    const animUrl = previewUrl(video.preview);
    const stillUrl = previewUrl(video.poster || video.preview);
    img.src = stillUrl;
    img.dataset.showing = 'poster';

    tile._img = img;
    tile._previewUrl = animUrl;
    tile._posterUrl = stillUrl;
    tile.appendChild(img);
  } else {
    // No preview on disk yet — show a placeholder until generation finishes.
    const placeholder = document.createElement('div');
    placeholder.className = 'video-placeholder';
    placeholder.textContent = 'generating…';
    tile.appendChild(placeholder);
  }

  // While a video is still being generated, show a thin progress bar across the
  // full tile width, just above the filename. It fills as that video's clips
  // finish (driven by updateVideoTileProgress from the progress stream).
  if (!video.clipsReady) {
    const progress = document.createElement('div');
    progress.className = 'video-progress';
    const bar = document.createElement('div');
    bar.className = 'video-progress-bar';
    progress.appendChild(bar);
    tile.appendChild(progress);
  }

  // Filename label along the bottom, same look as photo tiles.
  const name = document.createElement('div');
  name.className = 'video-name';
  name.textContent = video.stem;
  tile.appendChild(name);

  // "Opened N times" counter (top-left). Reflects the persisted stats file and
  // ticks up each time this tile is opened.
  const opens = document.createElement('div');
  opens.className = 'video-opens';
  opens.title = 'Times opened';
  opens.textContent = `▶ ${video.opens || 0}`;
  tile.appendChild(opens);

  // Small ✕ delete button, shown on hover via CSS.
  const del = document.createElement('button');
  del.className = 'video-delete';
  del.type = 'button';
  del.textContent = '✕';
  del.title = 'Delete video';
  del.addEventListener('click', (e) => {
    // Don't let the click also open the video.
    e.stopPropagation();
    deleteVideo(video);
  });
  tile.appendChild(del);

  // Click anywhere else on the tile opens the original in the default player and
  // bumps the open counter (both in memory and the on-screen badge).
  tile.addEventListener('click', async () => {
    const res = await openVideo(video.path);
    if (res && typeof res.opens === 'number') {
      video.opens = res.opens;
      opens.textContent = `▶ ${res.opens}`;
    }
  });

  return tile;
}

// Draw the whole video grid for the current page.
export function renderVideoGrid() {
  resetPlayback(); // stop watching the previous page's tiles

  const videos = getPagedVideos();
  $gridContainer.innerHTML = '';
  // Keep the shared zoom level in sync (Cmd/Ctrl+scroll updates state.tileSize).
  $photoGrid.style.setProperty('--tile-size', `${state.tileSize}px`);

  for (const video of videos) {
    const tile = createVideoTile(video);
    $gridContainer.appendChild(tile);
    observeTile(tile);
  }

  $photoGrid.classList.remove('hidden');
  // The keep/delete action bar belongs to photo mode only.
  $actionBar.classList.add('hidden');
  renderPagination();
}

// Update one video tile's progress bar as its clips are generated. Touches only
// the bar's width, so a generating tile never re-renders (no flicker). Tiles not
// on the current page are simply skipped.
export function updateVideoTileProgress(stem, clipsDone, clipsTotal) {
  const sel = `.video-tile[data-stem="${CSS.escape(stem)}"] .video-progress-bar`;
  const bar = $gridContainer.querySelector(sel);
  if (!bar) return;
  const pct = clipsTotal > 0 ? Math.round((clipsDone / clipsTotal) * 100) : 0;
  bar.style.width = `${pct}%`;
}

// Re-render a single video tile in place. Used when background generation
// reports that one video's clips just became ready, turning its placeholder
// into a live preview without redrawing the whole grid.
export function refreshVideoTile(stem) {
  const sel = `.video-tile[data-stem="${CSS.escape(stem)}"]`;
  const oldTile = $gridContainer.querySelector(sel);
  if (!oldTile) return;

  // Find the up-to-date VideoItem (clips were filled in by the scan).
  const video = state.videos.find((v) => v.stem === stem);
  if (!video) return;
  const newTile = createVideoTile(video);
  oldTile.replaceWith(newTile);
  observeTile(newTile);
}
