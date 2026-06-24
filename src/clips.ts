import { Effect } from 'effect';
import {
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
  readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  VideoProbeError,
  FFmpegError,
  ClipGenerationError,
} from './errors';
import {
  VIDEO_EXTENSIONS,
  expectedClipCount,
  CLIP_META_FILE,
  CLIPS_FOLDER,
  CLIP_INTERVAL_SECS,
} from './scanner';
import type { VideoItem } from './types';

// Each preview clip is 1 second long; one is cut every CLIP_INTERVAL_SECS
// (5 minutes) of the source video, starting at t=0. The clips-folder name and
// the interval are imported from the scanner so there is one source of truth.
const CLIP_DURATION_SECS = 1;

// How many videos may be processed at the same time. Clips inside one video
// are always cut one after another; this limit is across different videos.
const MAX_PARALLEL_VIDEOS = 10;

// A progress update for the clip-generation run.
//   stem        — the video this event is about ("" for run-level events)
//   status      — "start"   a video began (clipsDone is 0, clipsTotal known)
//                 "clip"    one more of that video's clips just finished
//                 "done"    that video's whole clip set is ready
//                 "error"   generation for that video failed
//                 "stopped" the user stopped the whole run (terminal)
//                 "complete" every video was processed (terminal)
//   clipsDone   — clips finished so far for this video (for its tile's bar)
//   clipsTotal  — clips this video needs in total
//   videosDone  — how many videos have finished overall (success or failure)
//   videosTotal — how many videos this run is generating clips for
export interface ClipProgress {
  stem: string;
  status: 'start' | 'clip' | 'done' | 'error' | 'stopped' | 'complete';
  clipsDone: number;
  clipsTotal: number;
  videosDone: number;
  videosTotal: number;
  // On a "done" event, the absolute paths of that video's clips, so the UI can
  // turn its tile into a live preview immediately without waiting for a rescan.
  clips?: string[];
}

type ProgressSubscriber = (event: ClipProgress) => void;

/**
 * ClipEngine generates short muted preview clips from video files so the UI
 * can show a moving preview of a long video without playing the whole file.
 *
 * For each video it:
 *   1. reads the video length with ffprobe,
 *   2. works out how many 1-second clips are needed (one every 5 minutes),
 *   3. cuts any clips that are missing with ffmpeg, writing to a temp name
 *      first and renaming only after a clip finishes (so a half-written file
 *      is never served),
 *   4. records the measured duration in a small meta.json so a later scan can
 *      tell the clip set is complete without probing the video again.
 *
 * Videos that already have all their clips are skipped. Up to ten videos are
 * processed at once; the clips within one video are cut in order.
 *
 * Other parts of the app can watch progress by passing a callback to
 * subscribe(); the server uses this to stream Server-Sent Events.
 */
export class ClipEngine {
  private readonly subscribers = new Set<ProgressSubscriber>();

  // The ffmpeg child processes currently cutting clips, so stop() can kill them
  // right away. `running` guards against starting a second run on top of an
  // active one; `cancelled` asks the worker loop and any in-flight clip to wind
  // down (set by stop()).
  private readonly activeProcs = new Set<ReturnType<typeof Bun.spawn>>();
  private running = false;
  private cancelled = false;

  // Whether Apple's VideoToolbox GPU decoding is available. Probed once and
  // cached; falls back to plain CPU decoding when it is not.
  private hwaccelChecked = false;
  private useVideoToolbox = false;

  // Register a callback that receives every progress update. Returns an
  // unsubscribe function so the caller can stop listening (e.g. when an SSE
  // client disconnects).
  subscribe(fn: ProgressSubscriber): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  private emit(event: ClipProgress): void {
    for (const fn of this.subscribers) {
      try {
        fn(event);
      } catch {
        // A broken subscriber must not stop generation or other subscribers.
      }
    }
  }

  // Stop an in-progress run. Asks the worker loop to stop pulling new work and
  // kills any ffmpeg processes mid-clip. Clips already finished stay on disk, so
  // a later run resumes where this one left off. No-op if nothing is running.
  stop(): { stopped: boolean } {
    if (!this.running) return { stopped: false };
    this.cancelled = true;
    for (const proc of this.activeProcs) {
      try {
        proc.kill();
      } catch {
        // Already exited; nothing to kill.
      }
    }
    return { stopped: true };
  }

  // The timestamps (in seconds) at which clips should be cut for a video of
  // the given length: 0, 300, 600, ... one per expected clip.
  private clipTimestamps(duration: number): number[] {
    return Array.from(
      { length: expectedClipCount(duration) },
      (_, i) => i * CLIP_INTERVAL_SECS,
    );
  }

  // Read a video's duration in seconds with ffprobe.
  private probeDuration(
    videoPath: string,
  ): Effect.Effect<number, VideoProbeError> {
    return Effect.tryPromise({
      try: async () => {
        const proc = Bun.spawn(
          [
            'ffprobe',
            '-v',
            'error',
            '-show_entries',
            'format=duration',
            '-of',
            'default=noprint_wrappers=1:nokey=1',
            videoPath,
          ],
          { stdout: 'pipe', stderr: 'pipe' },
        );
        const exitCode = await proc.exited;
        const stdout = await new Response(proc.stdout).text();
        const stderr = await new Response(proc.stderr).text();
        if (exitCode !== 0) {
          throw new Error(stderr || `ffprobe exited with code ${exitCode}`);
        }
        const seconds = parseFloat(stdout.trim());
        if (!Number.isFinite(seconds)) {
          throw new Error(`could not parse duration: "${stdout.trim()}"`);
        }
        return seconds;
      },
      catch: (error) => new VideoProbeError(videoPath, String(error)),
    });
  }

  // Probe once whether Apple VideoToolbox hardware decoding is listed by the
  // local ffmpeg. The result is cached for the life of the engine. On any
  // problem we simply leave it off and use CPU decoding.
  private ensureHwaccel(): Effect.Effect<void, never> {
    return Effect.gen(this, function* (_) {
      if (this.hwaccelChecked) return;
      this.hwaccelChecked = true;
      const result = yield* _(
        Effect.either(
          Effect.tryPromise({
            try: async () => {
              const proc = Bun.spawn(['ffmpeg', '-hide_banner', '-hwaccels'], {
                stdout: 'pipe',
                stderr: 'pipe',
              });
              await proc.exited;
              const out = await new Response(proc.stdout).text();
              return out.includes('videotoolbox');
            },
            catch: (error) => new FFmpegError('ffmpeg -hwaccels', String(error)),
          }),
        ),
      );
      this.useVideoToolbox = result._tag === 'Right' ? result.right : false;
    });
  }

  // Cut a single 1-second clip starting at timestamp `t` from `videoPath`.
  // The clip is written to a temp file first and renamed to its final
  // clip-NNN.mp4 name only after ffmpeg succeeds, so readers never see a
  // partially written file.
  private generateOneClip(
    videoPath: string,
    finalPath: string,
    t: number,
  ): Effect.Effect<void, FFmpegError> {
    return Effect.tryPromise({
      try: async () => {
        const tmpPath = `${finalPath}.tmp-${process.pid}-${Date.now()}.mp4`;
        const args = ['ffmpeg', '-hide_banner', '-loglevel', 'error'];
        if (this.useVideoToolbox) {
          args.push('-hwaccel', 'videotoolbox');
        }
        args.push(
          '-ss',
          String(t),
          '-i',
          videoPath,
          '-t',
          String(CLIP_DURATION_SECS),
          '-an', // drop audio: previews are muted
          '-vf',
          'scale=480:-2',
          '-c:v',
          'libx264',
          '-preset',
          'veryfast',
          '-pix_fmt',
          'yuv420p',
          '-movflags',
          '+faststart',
          '-y',
          tmpPath,
        );

        const proc = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe' });
        // Track the process so stop() can kill it mid-clip; always untrack it.
        this.activeProcs.add(proc);
        let exitCode: number;
        try {
          exitCode = await proc.exited;
        } finally {
          this.activeProcs.delete(proc);
        }
        const stderr = await new Response(proc.stderr).text();
        if (exitCode !== 0) {
          // Clean up the partial temp file so it is not left behind.
          try {
            if (existsSync(tmpPath)) rmSync(tmpPath);
          } catch {
            // Ignore cleanup failures.
          }
          throw new Error(stderr || `ffmpeg exited with code ${exitCode}`);
        }
        renameSync(tmpPath, finalPath);
      },
      catch: (error) => new FFmpegError(videoPath, String(error)),
    });
  }

  // Remove half-written temp clips (clip-NNN.mp4.tmp-*) left behind by a run
  // that was killed or stopped mid-clip, so they don't pile up as junk. Never
  // fails the run — a missing/unreadable folder just means nothing to sweep.
  private sweepTempClips(clipDir: string): void {
    try {
      for (const name of readdirSync(clipDir)) {
        if (/^clip-\d+\.mp4\.tmp-/.test(name)) {
          try {
            rmSync(join(clipDir, name));
          } catch {
            // Ignore a single file we couldn't delete.
          }
        }
      }
    } catch {
      // Folder doesn't exist yet or can't be read; nothing to sweep.
    }
  }

  // Generate all missing clips for one video. Clips are cut in order; an
  // already-present clip file is left untouched so re-running is cheap.
  // `onClip(clipsDone, clipsTotal)` is called once with clipsDone=0 when the
  // clip count is known, then after each clip (whether freshly cut or already
  // present), so the UI can fill that video's progress bar.
  private generateForVideo(
    folderPath: string,
    video: VideoItem,
    onClip: (clipsDone: number, clipsTotal: number) => void,
  ): Effect.Effect<string[], ClipGenerationError> {
    return Effect.gen(this, function* (_) {
      const clipPaths: string[] = [];
      const duration = yield* _(
        this.probeDuration(video.path).pipe(
          Effect.mapError(
            (e) => new ClipGenerationError(video.path, e.reason),
          ),
        ),
      );

      const clipDir = join(folderPath, CLIPS_FOLDER, video.stem);
      yield* _(
        Effect.try({
          try: () => {
            if (!existsSync(clipDir)) {
              mkdirSync(clipDir, { recursive: true });
            }
          },
          catch: (error) =>
            new ClipGenerationError(video.path, String(error)),
        }),
      );

      // Clear leftovers from any previously interrupted run before cutting.
      yield* _(Effect.sync(() => this.sweepTempClips(clipDir)));

      const timestamps = this.clipTimestamps(duration);
      const clipsTotal = timestamps.length;
      onClip(0, clipsTotal); // emits "start" now that clipsTotal is known

      for (let i = 0; i < timestamps.length; i++) {
        // Stop pulling more clips the moment a stop was requested. The video is
        // left without its meta.json, so it stays "not ready" and resumes later.
        if (this.cancelled) return clipPaths;

        const clipName = `clip-${String(i + 1).padStart(3, '0')}.mp4`;
        const finalPath = join(clipDir, clipName);
        if (!existsSync(finalPath)) {
          yield* _(
            this.generateOneClip(video.path, finalPath, timestamps[i]).pipe(
              Effect.mapError(
                (e) => new ClipGenerationError(video.path, e.reason),
              ),
            ),
          );
        }
        clipPaths.push(finalPath);
        onClip(i + 1, clipsTotal); // emits "clip"
      }

      // Record the duration so a later scan can confirm the clip set is
      // complete without re-probing the video.
      yield* _(
        Effect.try({
          try: () => {
            writeFileSync(
              join(clipDir, CLIP_META_FILE),
              JSON.stringify({ duration }),
            );
          },
          catch: (error) =>
            new ClipGenerationError(video.path, String(error)),
        }),
      );

      return clipPaths;
    });
  }

  // Decide which of the given videos still need work. A video needs work when
  // it is not already marked ready by the scan.
  private videosNeedingWork(videos: VideoItem[]): VideoItem[] {
    return videos.filter((v) => !v.clipsReady);
  }

  /**
   * Start generating clips for every video in the folder that is not already
   * complete. Returns immediately with how many videos need work; the actual
   * cutting runs in the background and reports through subscribers.
   *
   * `total` in returned value and in progress events is the number of videos
   * that needed work in this run.
   */
  start(
    folderPath: string,
    videos: VideoItem[],
  ): { started: boolean; total: number; running: boolean } {
    // Only one run at a time; a second start() while busy is a no-op, but report
    // running:true so the caller knows a run is active and keeps listening to it.
    if (this.running) {
      return { started: false, total: 0, running: true };
    }

    const pending = this.videosNeedingWork(videos);
    const total = pending.length;
    if (total === 0) {
      // Nothing to do and nothing running — the caller's view may be stale and
      // should resync from disk rather than wait for events that won't come.
      return { started: false, total: 0, running: false };
    }

    this.running = true;
    this.cancelled = false;
    // Run in the background; do not await here so the HTTP handler can return.
    void this.runPool(folderPath, pending, total);
    return { started: true, total, running: true };
  }

  // Worker pool: keep up to MAX_PARALLEL_VIDEOS videos in flight at once,
  // pulling the next video as each finishes. Emits start/done/error events.
  private async runPool(
    folderPath: string,
    pending: VideoItem[],
    total: number,
  ): Promise<void> {
    await Effect.runPromise(Effect.either(this.ensureHwaccel()));

    let nextIndex = 0;
    let done = 0;

    const worker = async (): Promise<void> => {
      while (true) {
        if (this.cancelled) return;
        const index = nextIndex++;
        if (index >= pending.length) return;
        const video = pending[index];

        // Per-clip progress for this video's tile bar. clipsDone === 0 means the
        // video just started; reads the shared `done` for the run-level counts.
        const onClip = (clipsDone: number, clipsTotal: number) => {
          this.emit({
            stem: video.stem,
            status: clipsDone === 0 ? 'start' : 'clip',
            clipsDone,
            clipsTotal,
            videosDone: done,
            videosTotal: total,
          });
        };

        const result = await Effect.runPromise(
          Effect.either(this.generateForVideo(folderPath, video, onClip)),
        );

        // If a stop landed during this video, don't report done/error for it —
        // the terminal "stopped" event below covers the run.
        if (this.cancelled) return;

        done++;
        this.emit({
          stem: video.stem,
          status: result._tag === 'Right' ? 'done' : 'error',
          clips: result._tag === 'Right' ? result.right : [],
          clipsDone: 0,
          clipsTotal: 0,
          videosDone: done,
          videosTotal: total,
        });
      }
    };

    const workerCount = Math.min(MAX_PARALLEL_VIDEOS, pending.length);
    const workers: Promise<void>[] = [];
    for (let i = 0; i < workerCount; i++) {
      workers.push(worker());
    }
    await Promise.all(workers);

    // Run finished (either everything processed, or a stop wound it down).
    const wasCancelled = this.cancelled;
    this.running = false;
    this.cancelled = false;
    this.activeProcs.clear();
    this.emit({
      stem: '',
      status: wasCancelled ? 'stopped' : 'complete',
      clipsDone: 0,
      clipsTotal: 0,
      videosDone: done,
      videosTotal: total,
    });
  }
}

// A single shared engine instance for the whole server process so SSE
// subscribers and generation runs use the same pub/sub.
export const clipEngine = new ClipEngine();

// Re-export so callers can reason about video extensions from one place.
export { VIDEO_EXTENSIONS };
