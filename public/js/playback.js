/* PhotoSift — Video Tile Playback Control
   Only the video tiles you can actually see should play, to keep things light.
   This uses an IntersectionObserver (a browser tool that tells you when an
   element scrolls into or out of view) to .play() tiles that enter the viewport
   and .pause() tiles that leave it. */

import { $photoGrid } from './dom.js';

// A single shared observer, created once and reused for the life of the page.
// Each render calls resetPlayback() to stop watching the previous page's tiles,
// then observes the new ones — the observer instance itself is never rebuilt.
let observer = null;

function ensureObserver() {
  if (observer) return observer;

  observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        // Each watched tile holds its <video> as the first child.
        const videoEl = entry.target.querySelector('video');
        if (!videoEl) continue;

        if (entry.isIntersecting) {
          // Mark it as "should be playing" so the ended->next-clip handler in
          // video-grid.js keeps the sequence going while on screen.
          videoEl.dataset.shouldPlay = 'true';
          videoEl.play().catch(() => {});
        } else {
          videoEl.dataset.shouldPlay = 'false';
          videoEl.pause();
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
