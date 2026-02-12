/* PhotoSift — Grid Rendering */

import { state } from './state.js';
import {
  $photoGrid, $gridContainer, $pagination, $actionBar,
} from './dom.js';
import {
  getPagedPhotos, getTotalPages, updateSelectionCount,
} from './ui.js';

export function renderPagination() {
  const totalPages = getTotalPages();
  $pagination.innerHTML = '';

  if (totalPages <= 1) {
    $pagination.classList.add('hidden');
    return;
  }

  $pagination.classList.remove('hidden');

  const btnPrev = document.createElement('button');
  btnPrev.className = 'secondary';
  btnPrev.textContent = '\u2190 Prev';
  btnPrev.disabled = state.currentPage === 0;
  btnPrev.addEventListener('click', () => {
    state.currentPage--;
    renderGrid();
    $photoGrid.scrollTop = 0;
  });

  const info = document.createElement('span');
  info.className = 'page-info';
  info.textContent = `Page ${state.currentPage + 1} of ${totalPages}`;

  const btnNext = document.createElement('button');
  btnNext.className = 'secondary';
  btnNext.textContent = 'Next \u2192';
  btnNext.disabled = state.currentPage >= totalPages - 1;
  btnNext.addEventListener('click', () => {
    state.currentPage++;
    renderGrid();
    $photoGrid.scrollTop = 0;
  });

  $pagination.appendChild(btnPrev);
  $pagination.appendChild(info);
  $pagination.appendChild(btnNext);
}

export function renderGrid() {
  const photos = getPagedPhotos();
  $gridContainer.innerHTML = '';
  $photoGrid.style.setProperty('--tile-size', `${state.tileSize}px`);

  for (const photo of photos) {
    const tile = document.createElement('div');
    tile.className = 'photo-tile';
    if (state.selectedKeepers.has(photo.stem)) {
      tile.classList.add('selected');
    }
    tile.dataset.stem = photo.stem;

    const img = document.createElement('img');
    img.src = `/api/thumbnail?file=${encodeURIComponent(photo.jpgPath)}`;
    img.alt = photo.stem;
    img.loading = 'lazy';

    const check = document.createElement('div');
    check.className = 'check-overlay';
    check.textContent = '\u2713';

    const name = document.createElement('div');
    name.className = 'photo-name';
    name.textContent = photo.stem;

    tile.appendChild(img);
    tile.appendChild(check);
    tile.appendChild(name);

    if (photo.rafPath) {
      const badge = document.createElement('div');
      badge.className = 'raf-badge';
      badge.textContent = 'RAF';
      tile.appendChild(badge);
    }

    tile.addEventListener('click', () => toggleSelection(photo.stem));
    $gridContainer.appendChild(tile);
  }

  $photoGrid.classList.remove('hidden');
  $actionBar.classList.remove('hidden');
  renderPagination();
  updateSelectionCount();
}

export function toggleSelection(stem) {
  if (state.selectedKeepers.has(stem)) {
    state.selectedKeepers.delete(stem);
  } else {
    state.selectedKeepers.add(stem);
  }

  const sel = `[data-stem="${CSS.escape(stem)}"]`;
  const tile = $gridContainer.querySelector(sel);
  if (tile) {
    tile.classList.toggle('selected', state.selectedKeepers.has(stem));
  }
  updateSelectionCount();
}
