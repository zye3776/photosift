#!/usr/bin/env bun
//
// Standalone preview-clip generator.
//
// Scans a folder for videos and builds their looping previews using the very
// same engine the PhotoSift web app uses (src/clips.ts + src/scanner.ts), then
// exits. Handy for pre-warming a big folder without opening the browser UI.
//
// Usage:
//   bun run scripts/generate-clips.ts <folder> [--clean]
//
//   <folder>   the folder containing the video files
//   --clean    delete the folder's existing .clips/ first, so every video is
//              regenerated from scratch (e.g. after changing preview settings)
//
// Previews land in <folder>/.clips/<video-stem>/preview.webp (+ poster.jpg) and
// a meta.json is written per video so a later scan knows the preview is
// complete. Up to 10 videos are processed at once.

import { Effect } from 'effect';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { scanFolder, CLIPS_FOLDER } from '../src/scanner';
import { clipEngine, type ClipProgress } from '../src/clips';

const argv = process.argv.slice(2);
const clean = argv.includes('--clean');
const folder = argv.find((a) => !a.startsWith('--'));

if (!folder) {
  console.error('Usage: bun run scripts/generate-clips.ts <folder> [--clean]');
  process.exit(1);
}

if (!existsSync(folder)) {
  console.error(`Folder not found: ${folder}`);
  process.exit(1);
}

if (clean) {
  const clipsDir = join(folder, CLIPS_FOLDER);
  if (existsSync(clipsDir)) {
    console.log(`Removing existing clips: ${clipsDir}`);
    // Use `rm -rf` rather than fs.rmSync: on external exFAT/NTFS drives the
    // Node/Bun remover can silently skip files it can't delete (e.g. macOS
    // AppleDouble ._ sidecars), leaving stale clip folders behind. `rm -rf`
    // clears them reliably.
    Bun.spawnSync(['rm', '-rf', clipsDir]);
    if (existsSync(clipsDir)) {
      console.error(`Failed to fully remove ${clipsDir}; aborting.`);
      process.exit(1);
    }
  }
}

const scan = await Effect.runPromise(Effect.either(scanFolder(folder)));
if (scan._tag === 'Left') {
  console.error(`Scan failed: ${scan.left._tag}`);
  process.exit(1);
}

const { videos } = scan.right;
const notReady = videos.filter((v) => !v.clipsReady);
console.log(
  `Found ${videos.length} video(s); ${notReady.length} need clips.`,
);
if (notReady.length === 0) {
  console.log('Nothing to generate.');
  process.exit(0);
}

const startedAt = Date.now();
let finished = 0;
let failed = 0;

// Wait for the whole run by listening to progress events. We subscribe before
// calling start() so no events are missed.
await new Promise<void>((resolve) => {
  const unsubscribe = clipEngine.subscribe((e: ClipProgress) => {
    if (e.status === 'done') {
      finished = e.videosDone;
      console.log(`✓ [${e.videosDone}/${e.videosTotal}] ${e.stem}`);
    } else if (e.status === 'error') {
      finished = e.videosDone;
      failed += 1;
      console.log(`✗ [${e.videosDone}/${e.videosTotal}] ${e.stem} (failed)`);
    } else if (e.status === 'complete' || e.status === 'stopped') {
      unsubscribe();
      resolve();
    }
  });

  const { started, total } = clipEngine.start(folder, videos);
  if (!started) {
    unsubscribe();
    resolve();
    return;
  }
  console.log(`Generating clips for ${total} video(s) (up to 10 in parallel)…`);
});

const secs = Math.round((Date.now() - startedAt) / 1000);
console.log(
  `Done in ${secs}s. ${finished} processed${failed ? `, ${failed} failed` : ''}.`,
);
process.exit(0);
