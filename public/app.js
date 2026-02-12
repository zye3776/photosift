/* PhotoSift — Entry Point */

import { state, STORAGE_KEY } from './js/state.js';
import { $folderDisplay } from './js/dom.js';
import { scanFolder } from './js/api.js';

// Wire up all event listeners
import './js/events.js';

// Restore last folder on load
const lastFolder = localStorage.getItem(STORAGE_KEY);
if (lastFolder) {
  $folderDisplay.textContent = lastFolder;
  $folderDisplay.classList.add('active');
  state.currentFolder = lastFolder;
}
