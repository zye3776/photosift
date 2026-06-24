// PhotoSift — open-count stats
//
// A tiny "database" that records how many times each video has been opened. It
// is a single JSON text file in the user's home folder. Everything here is
// best-effort: if the file is missing it is treated as empty (all counts zero),
// and it is recreated automatically the next time a video is opened. Deleting
// the file simply resets every count — the app keeps working.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

// The single text file that stores the stats, keyed by a video's absolute path.
const STATS_FILE = join(homedir(), '.photosift-stats.json');

type OpenCounts = Record<string, number>;

// Read the whole { videoPath: openCount } map. Returns an empty map if the file
// is missing or unreadable, so a deleted file just means "no opens yet".
export function readStats(): OpenCounts {
  try {
    if (!existsSync(STATS_FILE)) return {};
    const data = JSON.parse(readFileSync(STATS_FILE, 'utf-8'));
    return data && typeof data === 'object' ? (data as OpenCounts) : {};
  } catch {
    return {};
  }
}

// Add one to a video's open count and save. Recreates the file if it was
// deleted. Returns the new count; never throws (stats are not critical).
export function incrementOpen(videoPath: string): number {
  const stats = readStats();
  const next = (stats[videoPath] || 0) + 1;
  stats[videoPath] = next;
  try {
    writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));
  } catch {
    // Couldn't persist — return the count we computed anyway.
  }
  return next;
}
