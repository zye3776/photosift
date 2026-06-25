/* PhotoSift — Video Tile Playback Control
   Only the video tiles you can actually see should animate, to keep things
   light. This uses an IntersectionObserver (a browser tool that tells you when
   an element scrolls into or out of view) to point each tile's <img> at its
   animated preview when it enters the viewport, and back at its still poster
   when it leaves. The animated file stays in the browser cache, so a tile that
   scrolls back into view resumes instantly without re-downloading. */

import { $photoGrid } from './dom.js';

// A single shared observer, created once and reused for the life of the page.
// Each render calls resetPlayback() to stop watching the previous page's tiles,
// then observes the new ones — the observer instance itself is never rebuilt.
let observer = null;

// Point a tile's <img> at its animated preview (when on screen) or its still
// poster (when off screen). The dataset flag avoids re-setting the same src on
// every observer callback, which would otherwise restart the download/animation.
function showPreview(tile) {
  const img = tile._img;
  if (!img || !tile._previewUrl || img.dataset.showing === 'preview') return;
  img.dataset.showing = 'preview';
  img.src = tile._previewUrl;
}

function showPoster(tile) {
  const img = tile._img;
  if (!img || !tile._posterUrl || img.dataset.showing === 'poster') return;
  img.dataset.showing = 'poster';
  img.src = tile._posterUrl;
}

function ensureObserver() {
  if (observer) return observer;

  observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        // Tiles still showing the "generating…" placeholder have no _img yet.
        if (!entry.target._img) continue;
        if (entry.isIntersecting) {
          showPreview(entry.target);
        } else {
          showPoster(entry.target);
        }
      }
    },
    {
      // Treat tiles as visible a little before they fully enter, for smoothness.
      root: $photoGrid,
      rootMargin: '100px',
      threshold: 0.1,
    },
  );

  return observer;
}

// Start watching one tile element.
export function observeTile(tile) {
  ensureObserver().observe(tile);
}

// Forget all currently watched tiles. Called at the start of each render so a
// fresh page of tiles isn't mixed with stale ones from the previous page.
export function resetPlayback() {
  // disconnect() stops watching every tile from the previous render but keeps
  // the observer instance, so the next render reuses it instead of building
  // a fresh observer each time.
  if (observer) observer.disconnect();
}
