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
  clipTimestamps,
  CLIP_META_FILE,
  CLIPS_FOLDER,
  PREVIEW_WEBP_FILE,
  PREVIEW_GIF_FILE,
  POSTER_FILE,
} from './scanner';
import type { VideoItem } from './types';

// Each sampled moment contributes a CLIP_DURATION_SECS-long burst of motion to
// the looping preview. Bursts are taken at the timestamps the scanner picks
// (one every few minutes, skipping intro/outro), then stitched into a single
// animated image that loops forever.
const CLIP_DURATION_SECS = 1;

// Preview quality — kept deliberately low so the grid can show many looping
// previews at once without taxing the machine. Previews are shown small, so
// this is plenty:
//   CLIP_WIDTH        — output width in px (height auto, kept even).
//   CLIP_FPS          — frames per second of the preview (low = cheap + small).
//   PREVIEW_WEBP_Q    — img2webp lossy quality (0 worst … 100 best); low = tiny.
//   GIF_MAX_COLORS    — palette size for the gif fallback (fewer = smaller).
//   POSTER_JPEG_Q     — ffmpeg -q:v for the still poster (2 best … 31 worst).
const CLIP_WIDTH = 240;
const CLIP_FPS = 10;
const PREVIEW_WEBP_Q = 35;
const GIF_MAX_COLORS = 64;
const POSTER_JPEG_Q = 6;

// At most this many moments are sampled into one preview, no matter how long the
// video is. A long film would otherwise produce a huge, many-second loop; this
// caps the loop length (and file size) by spreading the sample points evenly.
const MAX_PREVIEW_POINTS = 12;

// How many videos may be processed at the same time. The two assets for one
// video (poster, then preview) are always built one after another; this limit
// is across different videos.
const MAX_PARALLEL_VIDEOS = 10;

// A progress update for the preview-generation run.
//   stem        — the video this event is about ("" for run-level events)
//   status      — "start"   a video began (clipsDone is 0, clipsTotal known)
//                 "clip"    one more build step for that video finished
//                 "done"    that video's preview is ready
//                 "error"   generation for that video failed
//                 "stopped" the user stopped the whole run (terminal)
//                 "complete" every video was processed (terminal)
//   clipsDone   — build steps finished so far for this video (for its tile bar)
//   clipsTotal  — build steps this video needs in total (poster + preview = 2)
//   videosDone  — how many videos have finished overall (success or failure)
//   videosTotal — how many videos this run is generating previews for
export interface ClipProgress {
  stem: string;
  status: 'start' | 'clip' | 'done' | 'error' | 'stopped' | 'complete';
  clipsDone: number;
  clipsTotal: number;
  videosDone: number;
  videosTotal: number;
  // On a "done" event, the absolute paths of that video's freshly built preview
  // and poster, so the UI can turn its tile into a live preview immediately
  // without waiting for a rescan.
  preview?: string;
  poster?: string;
}

type ProgressSubscriber = (event: ClipProgress) => void;

// Pick at most MAX_PREVIEW_POINTS timestamps, evenly spread across the full set,
// so a very long video doesn't produce an enormous preview. Always keeps the
// first and last sampled moment.
function pickPreviewPoints(timestamps: number[]): number[] {
  if (timestamps.length <= MAX_PREVIEW_POINTS) return timestamps;
  const picked: number[] = [];
  const step = (timestamps.length - 1) / (MAX_PREVIEW_POINTS - 1);
  for (let i = 0; i < MAX_PREVIEW_POINTS; i++) {
    picked.push(timestamps[Math.round(i * step)]);
  }
  return picked;
}

/**
 * ClipEngine builds a short looping preview for each video so the UI can show a
 * moving preview of a long video without playing the whole file.
 *
 * For each video it:
 *   1. reads the video length with ffprobe,
 *   2. works out a handful of moments to sample (one every few minutes, capped),
 *   3. writes a still poster.jpg (the first sampled frame) with ffmpeg,
 *   4. writes an animated preview that stitches a 1-second motion burst from
 *      each sampled moment. ffmpeg on macOS often lacks a WebP encoder, so the
 *      animation is assembled from frames by the `img2webp` command-line tool
 *      (preview.webp); when those WebP tools aren't installed it falls back to a
 *      ffmpeg-only animated GIF (preview.gif),
 *   5. records the measured duration in a small meta.json, written LAST, so a
 *      later scan can tell the preview is complete without probing the video.
 *
 * Videos that already have a preview are skipped. Up to ten videos are processed
 * at once. Assets are written to a temp name first and renamed only after the
 * tool succeeds, so a half-written file is never served.
 *
 * Other parts of the app can watch progress by passing a callback to
 * subscribe(); the server uses this to stream Server-Sent Events.
 */
export class ClipEngine {
  private readonly subscribers = new Set<ProgressSubscriber>();

  // The child processes currently building previews, so stop() can kill them
  // right away. `running` guards against starting a second run on top of an
  // active one; `cancelled` asks the worker loop and any in-flight build to wind
  // down (set by stop()).
  private readonly activeProcs = new Set<ReturnType<typeof Bun.spawn>>();
  private running = false;
  private cancelled = false;

  // Whether Apple's VideoToolbox GPU decoding is available. Probed once and
  // cached; falls back to plain CPU decoding when it is not.
  private hwaccelChecked = false;
  private useVideoToolbox = false;

  // Whether the WebP command-line tools (img2webp) are installed. Probed once
  // and cached; when false we build an animated GIF with ffmpeg instead.
  private webpChecked = false;
  private hasWebpTools = false;

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
  // kills any tool processes mid-build. Assets already finished stay on disk, so
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

  // Probe once whether the `img2webp` tool is on PATH. Cached for the life of
  // the engine. When absent we build the gif fallback instead of webp.
  private ensureWebpTools(): Effect.Effect<void, never> {
    return Effect.gen(this, function* (_) {
      if (this.webpChecked) return;
      this.webpChecked = true;
      const result = yield* _(
        Effect.either(
          Effect.tryPromise({
            try: async () => {
              const proc = Bun.spawn(['which', 'img2webp'], {
                stdout: 'pipe',
                stderr: 'pipe',
              });
              const code = await proc.exited;
              return code === 0;
            },
            catch: () => new FFmpegError('which img2webp', 'probe failed'),
          }),
        ),
      );
      this.hasWebpTools = result._tag === 'Right' ? result.right : false;
    });
  }

  // Run a child process, tracking it so stop() can kill it mid-build, and throw
  // a descriptive error if it exits non-zero. Always untracks the process.
  private async runProc(args: string[], label: string): Promise<void> {
    const proc = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe' });
    this.activeProcs.add(proc);
    let exitCode: number;
    try {
      exitCode = await proc.exited;
    } finally {
      this.activeProcs.delete(proc);
    }
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(stderr || `${label} exited with code ${exitCode}`);
    }
  }

  // The ffmpeg input arguments for one sampled moment: an optional GPU-decode
  // hint, then seek to the timestamp and read CLIP_DURATION_SECS of footage.
  private inputArgsFor(timestamps: number[], videoPath: string): string[] {
    const args: string[] = [];
    for (const t of timestamps) {
      if (this.useVideoToolbox) args.push('-hwaccel', 'videotoolbox');
      args.push('-ss', String(t), '-t', String(CLIP_DURATION_SECS), '-i', videoPath);
    }
    return args;
  }

  // An ffmpeg filtergraph that scales every sampled moment to CLIP_WIDTH at
  // CLIP_FPS and concatenates them into a single stream labelled [v]. With one
  // moment there's nothing to concatenate, so a plain scale chain is used.
  private buildConcatFilter(count: number): string {
    const scale = `fps=${CLIP_FPS},scale=${CLIP_WIDTH}:-2,setsar=1`;
    if (count === 1) return `[0:v]${scale}[v]`;
    const parts: string[] = [];
    for (let i = 0; i < count; i++) parts.push(`[${i}:v]${scale}[v${i}]`);
    const labels = Array.from({ length: count }, (_, i) => `[v${i}]`).join('');
    return `${parts.join(';')};${labels}concat=n=${count}:v=1:a=0[v]`;
  }

  // Write the still poster.jpg: a single frame grabbed at the first sampled
  // moment, scaled to the preview width.
  private async generatePoster(
    videoPath: string,
    finalPath: string,
    t: number,
  ): Promise<void> {
    const tmpPath = `${finalPath}.tmp-${process.pid}-${Date.now()}.jpg`;
    const args = ['ffmpeg', '-hide_banner', '-loglevel', 'error'];
    if (this.useVideoToolbox) args.push('-hwaccel', 'videotoolbox');
    args.push(
      '-ss',
      String(t),
      '-i',
      videoPath,
      '-frames:v',
      '1',
      '-an',
      '-vf',
      `scale=${CLIP_WIDTH}:-2`,
      '-q:v',
      String(POSTER_JPEG_Q),
      '-y',
      tmpPath,
    );
    await this.runProc(args, 'ffmpeg poster');
    renameSync(tmpPath, finalPath);
  }

  // Write the animated preview.webp by extracting frames with ffmpeg into a
  // temp folder and assembling them with img2webp (ffmpeg here has no WebP
  // encoder). The temp folder and any partial output are cleaned up.
  private async generatePreviewWebp(
    videoPath: string,
    clipDir: string,
    finalPath: string,
    timestamps: number[],
  ): Promise<void> {
    const framesDir = join(clipDir, `.frames-${process.pid}-${Date.now()}`);
    const tmpPath = `${finalPath}.tmp-${process.pid}-${Date.now()}.webp`;
    mkdirSync(framesDir, { recursive: true });
    try {
      // 1. ffmpeg → numbered PNG frames for every sampled moment, in order.
      const ffArgs = [
        'ffmpeg',
        '-hide_banner',
        '-loglevel',
        'error',
        ...this.inputArgsFor(timestamps, videoPath),
        '-filter_complex',
        this.buildConcatFilter(timestamps.length),
        '-map',
        '[v]',
        '-an',
        '-y',
        join(framesDir, 'f-%04d.png'),
      ];
      await this.runProc(ffArgs, 'ffmpeg frames');

      // 2. img2webp → one looping animated webp. -d is each frame's on-screen
      //    time in ms (1000/fps); -loop 0 loops forever; -lossy -q keeps it tiny.
      const frames = readdirSync(framesDir)
        .filter((n) => /^f-\d+\.png$/.test(n))
        .sort()
        .map((n) => join(framesDir, n));
      if (frames.length === 0) {
        throw new Error('no frames were extracted for the preview');
      }
      const webpArgs = [
        'img2webp',
        '-loop',
        '0',
        '-d',
        String(Math.round(1000 / CLIP_FPS)),
        '-lossy',
        '-q',
        String(PREVIEW_WEBP_Q),
        ...frames,
        '-o',
        tmpPath,
      ];
      await this.runProc(webpArgs, 'img2webp');
      renameSync(tmpPath, finalPath);
    } finally {
      try {
        rmSync(framesDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup of the temp frames folder.
      }
      try {
        if (existsSync(tmpPath)) rmSync(tmpPath);
      } catch {
        // Best-effort cleanup of a partial webp.
      }
    }
  }

  // Fallback when the WebP tools aren't installed: build an animated GIF with
  // ffmpeg alone. A two-pass palette (palettegen → paletteuse) keeps the colours
  // acceptable despite GIF's 256-colour limit.
  private async generatePreviewGif(
    videoPath: string,
    finalPath: string,
    timestamps: number[],
  ): Promise<void> {
    const tmpPath = `${finalPath}.tmp-${process.pid}-${Date.now()}.gif`;
    // Reuse the scale/concat graph, then split it: one copy builds the palette,
    // the other is recoloured using that palette.
    const base = this.buildConcatFilter(timestamps.length); // ends in [v]
    const filter =
      `${base};[v]split[s0][s1];` +
      `[s0]palettegen=max_colors=${GIF_MAX_COLORS}[p];` +
      `[s1][p]paletteuse[out]`;
    const args = [
      'ffmpeg',
      '-hide_banner',
      '-loglevel',
      'error',
      ...this.inputArgsFor(timestamps, videoPath),
      '-filter_complex',
      filter,
      '-map',
      '[out]',
      '-an',
      '-loop',
      '0',
      '-y',
      tmpPath,
    ];
    try {
      await this.runProc(args, 'ffmpeg gif');
      renameSync(tmpPath, finalPath);
    } finally {
      try {
        if (existsSync(tmpPath)) rmSync(tmpPath);
      } catch {
        // Best-effort cleanup of a partial gif.
      }
    }
  }

  // Remove half-written temp files (poster/preview *.tmp-* and stale .frames-*
  // folders) left behind by a run that was killed mid-build, so they don't pile
  // up. Never fails the run — a missing/unreadable folder means nothing to sweep.
  private sweepTempFiles(clipDir: string): void {
    try {
      for (const name of readdirSync(clipDir)) {
        const isTemp = /\.tmp-\d/.test(name) || /^\.frames-/.test(name);
        if (!isTemp) continue;
        try {
          rmSync(join(clipDir, name), { recursive: true, force: true });
        } catch {
          // Ignore a single entry we couldn't delete.
        }
      }
    } catch {
      // Folder doesn't exist yet or can't be read; nothing to sweep.
    }
  }

  // Build the poster and animated preview for one video. The poster is written
  // first, then the preview, then meta.json (the completion marker). `onStep`
  // is called with (0, 2) once the work is known, then after the poster (1, 2)
  // and after the preview (2, 2), so the UI can fill that video's progress bar.
  private generateForVideo(
    folderPath: string,
    video: VideoItem,
    onStep: (done: number, total: number) => void,
  ): Effect.Effect<{ preview: string; poster: string }, ClipGenerationError> {
    return Effect.gen(this, function* (_) {
      const duration = yield* _(
        this.probeDuration(video.path).pipe(
          Effect.mapError((e) => new ClipGenerationError(video.path, e.reason)),
        ),
      );

      const clipDir = join(folderPath, CLIPS_FOLDER, video.stem);
      yield* _(
        Effect.try({
          try: () => {
            if (!existsSync(clipDir)) mkdirSync(clipDir, { recursive: true });
          },
          catch: (error) => new ClipGenerationError(video.path, String(error)),
        }),
      );

      // Clear leftovers from any previously interrupted run before building.
      yield* _(Effect.sync(() => this.sweepTempFiles(clipDir)));

      const timestamps = pickPreviewPoints(clipTimestamps(duration));
      onStep(0, 2); // emits "start" now that the work is known

      // 1. Poster — the still frame shown when the tile is off screen.
      const posterPath = join(clipDir, POSTER_FILE);
      yield* _(
        Effect.tryPromise({
          try: () => this.generatePoster(video.path, posterPath, timestamps[0]),
          catch: (error) =>
            new ClipGenerationError(video.path, String(error)),
        }),
      );
      onStep(1, 2);

      // 2. Animated preview — webp when the tools are present, gif otherwise.
      const previewPath = join(
        clipDir,
        this.hasWebpTools ? PREVIEW_WEBP_FILE : PREVIEW_GIF_FILE,
      );
      yield* _(
        Effect.tryPromise({
          try: () =>
            this.hasWebpTools
              ? this.generatePreviewWebp(
                  video.path,
                  clipDir,
                  previewPath,
                  timestamps,
                )
              : this.generatePreviewGif(video.path, previewPath, timestamps),
          catch: (error) =>
            new ClipGenerationError(video.path, String(error)),
        }),
      );
      onStep(2, 2);

      // Record the duration LAST so a later scan only treats the preview as
      // complete once everything above succeeded.
      yield* _(
        Effect.try({
          try: () => {
            writeFileSync(
              join(clipDir, CLIP_META_FILE),
              JSON.stringify({ duration }),
            );
          },
          catch: (error) => new ClipGenerationError(video.path, String(error)),
        }),
      );

      return { preview: previewPath, poster: posterPath };
    });
  }

  // Decide which of the given videos still need work. A video needs work when
  // it is not already marked ready by the scan.
  private videosNeedingWork(videos: VideoItem[]): VideoItem[] {
    return videos.filter((v) => !v.clipsReady);
  }

  /**
   * Start generating previews for every video in the folder that is not already
   * complete. Returns immediately with how many videos need work; the actual
   * building runs in the background and reports through subscribers.
   *
   * `total` in the returned value and in progress events is the number of videos
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
    await Effect.runPromise(Effect.either(this.ensureWebpTools()));

    let nextIndex = 0;
    let done = 0;

    const worker = async (): Promise<void> => {
      while (true) {
        if (this.cancelled) return;
        const index = nextIndex++;
        if (index >= pending.length) return;
        const video = pending[index];

        // Per-step progress for this video's tile bar. step === 0 means the
        // video just started; reads the shared `done` for the run-level counts.
        const onStep = (step: number, steps: number) => {
          this.emit({
            stem: video.stem,
            status: step === 0 ? 'start' : 'clip',
            clipsDone: step,
            clipsTotal: steps,
            videosDone: done,
            videosTotal: total,
          });
        };

        const result = await Effect.runPromise(
          Effect.either(this.generateForVideo(folderPath, video, onStep)),
        );

        // If a stop landed during this video, don't report done/error for it —
        // the terminal "stopped" event below covers the run.
        if (this.cancelled) return;

        done++;
        this.emit({
          stem: video.stem,
          status: result._tag === 'Right' ? 'done' : 'error',
          preview: result._tag === 'Right' ? result.right.preview : undefined,
          poster: result._tag === 'Right' ? result.right.poster : undefined,
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
