import { Effect } from 'effect';
import { join, resolve, sep } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { scanFolder } from './scanner';
import { generateThumbnail } from './thumbnail';
import { deleteFiles, restoreFiles, restoreGroup } from './trash';
import { pickFolder } from './folder-picker';
import { clipEngine, type ClipProgress } from './clips';
import { incrementOpen } from './stats';
import type { DeleteRequest } from './types';
import type { Server } from 'bun';

const PORT = parseInt(Bun.env.PORT || '3000');
const PUBLIC_DIR = join(import.meta.dir, '..', 'public');

function serveStatic(filePath: string): Response {
  const fullPath = join(PUBLIC_DIR, filePath);
  if (!existsSync(fullPath)) {
    return new Response('Not Found', { status: 404 });
  }

  const content = readFileSync(fullPath);
  const ext = filePath.split('.').pop() ?? '';
  const contentTypes: Record<string, string> = {
    html: 'text/html',
    css: 'text/css',
    js: 'application/javascript',
    json: 'application/json',
    png: 'image/png',
    jpg: 'image/jpeg',
    svg: 'image/svg+xml',
  };

  return new Response(content, {
    headers: { 'Content-Type': contentTypes[ext] ?? 'application/octet-stream' },
  });
}

async function handleApiScan(url: URL): Promise<Response> {
  const folder = url.searchParams.get('folder');
  if (!folder) {
    return Response.json({ error: 'Missing folder parameter' }, { status: 400 });
  }

  const result = await Effect.runPromise(
    Effect.either(scanFolder(folder)),
  );

  if (result._tag === 'Left') {
    return Response.json({ error: result.left._tag, message: result.left.path }, { status: 400 });
  }

  return Response.json(result.right);
}

async function handleApiThumbnail(url: URL): Promise<Response> {
  const file = url.searchParams.get('file');
  if (!file) {
    return Response.json({ error: 'Missing file parameter' }, { status: 400 });
  }

  const result = await Effect.runPromise(
    Effect.either(generateThumbnail(file)),
  );

  if (result._tag === 'Left') {
    const error = result.left;
    const message = error._tag === 'FileNotFoundError' ? error.path : error.filePath;
    return Response.json({ error: error._tag, message }, { status: 400 });
  }

  const body = new ArrayBuffer(result.right.byteLength);
  new Uint8Array(body).set(result.right);
  return new Response(body, {
    headers: {
      'Content-Type': 'image/jpeg',
      'Cache-Control': 'max-age=3600',
    },
  });
}

async function handleApiPhoto(url: URL): Promise<Response> {
  const file = url.searchParams.get('file');
  if (!file) {
    return Response.json({ error: 'Missing file parameter' }, { status: 400 });
  }

  if (!existsSync(file)) {
    return Response.json({ error: 'File not found' }, { status: 404 });
  }

  const bunFile = Bun.file(file);
  return new Response(bunFile, {
    headers: { 'Content-Type': 'image/jpeg' },
  });
}

async function handleApiDelete(request: Request): Promise<Response> {
  const body = (await request.json()) as DeleteRequest;
  if (!body.files || !Array.isArray(body.files)) {
    return Response.json({ error: 'Missing files array' }, { status: 400 });
  }

  const result = await Effect.runPromise(deleteFiles(body.files));
  return Response.json(result);
}

async function handleApiRestore(request: Request): Promise<Response> {
  const body = (await request.json()) as DeleteRequest;
  if (!body.files || !Array.isArray(body.files)) {
    return Response.json({ error: 'Missing files array' }, { status: 400 });
  }

  const result = await Effect.runPromise(restoreFiles(body.files));
  return Response.json(result);
}

async function handleApiRestoreGroup(request: Request): Promise<Response> {
  const body = (await request.json()) as { folder: string; group: string };
  if (!body.folder || !body.group) {
    return Response.json({ error: 'Missing folder or group parameter' }, { status: 400 });
  }

  const result = await Effect.runPromise(restoreGroup(body.folder, body.group));
  return Response.json(result);
}

async function handleApiPickFolder(): Promise<Response> {
  const result = await Effect.runPromise(
    Effect.either(pickFolder()),
  );

  if (result._tag === 'Left') {
    const error = result.left;
    if (error._tag === 'FolderPickerCancelledError') {
      return Response.json({ cancelled: true });
    }
    return Response.json(
      { error: error._tag, message: error.reason },
      { status: 500 },
    );
  }

  return Response.json({ folder: result.right });
}

// POST /api/generate-clips { folder }
// Kicks off background preview-clip generation for every video in the folder
// that is not already complete. Returns right away; progress is streamed by
// the /api/progress route. `total` is how many videos needed work.
async function handleApiGenerateClips(request: Request): Promise<Response> {
  const body = (await request.json()) as { folder?: string };
  if (!body.folder) {
    return Response.json({ error: 'Missing folder parameter' }, { status: 400 });
  }

  // Re-scan to get the current video list (and which already have clips). This
  // is the cheap, ffmpeg-free scan; generation itself runs in the background.
  const scan = await Effect.runPromise(Effect.either(scanFolder(body.folder)));
  if (scan._tag === 'Left') {
    return Response.json(
      { error: scan.left._tag, message: scan.left.path },
      { status: 400 },
    );
  }

  const { started, total, running } = clipEngine.start(
    body.folder,
    scan.right.videos,
  );
  return Response.json({ started, total, running });
}

// GET /api/progress
// Server-Sent Events stream of clip-generation progress. Each message is a
// JSON object { stem, done, total, status } where status is start | done |
// error and done/total are overall video counts for the current run.
function handleApiProgress(): Response {
  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;

  const stream = new ReadableStream({
    start(controller) {
      const send = (event: ClipProgress) => {
        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
          );
        } catch {
          // Client went away mid-write; stop listening.
          if (unsubscribe) unsubscribe();
        }
      };
      unsubscribe = clipEngine.subscribe(send);
    },
    cancel() {
      // Browser closed the EventSource; drop our subscription.
      if (unsubscribe) unsubscribe();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}

// GET /api/clip?file=<abs path>
// Serve a generated preview clip as video/mp4 with HTTP Range support so the
// browser can seek and stream. Responds 206 (partial) when the request carries
// a Range header, otherwise 200 with the whole file.
async function handleApiClip(request: Request, url: URL): Promise<Response> {
  const file = url.searchParams.get('file');
  if (!file) {
    return Response.json({ error: 'Missing file parameter' }, { status: 400 });
  }

  // Only ever serve generated preview clips. Every clip lives inside a `.clips`
  // folder and is an .mp4 file, so requiring both blocks path-traversal attempts
  // such as ?file=../../etc/passwd. resolve() first collapses any `..` segments,
  // so a crafted path cannot escape the `.clips` check by walking up the tree.
  const resolved = resolve(file);
  if (!resolved.includes(`${sep}.clips${sep}`) || !resolved.toLowerCase().endsWith('.mp4')) {
    return Response.json({ error: 'Forbidden' }, { status: 403 });
  }
  if (!existsSync(resolved)) {
    return Response.json({ error: 'File not found' }, { status: 404 });
  }

  const bunFile = Bun.file(resolved);
  const size = bunFile.size;
  const rangeHeader = request.headers.get('range');

  if (rangeHeader) {
    // Parse a single "bytes=start-end" range. The pattern is anchored so a
    // malformed header (e.g. "bytes=  -  ") is rejected with 416 instead of
    // silently falling through and serving the whole file. start or end may be
    // omitted, but not both.
    const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
    if (!match || (match[1] === '' && match[2] === '')) {
      return new Response('Range Not Satisfiable', {
        status: 416,
        headers: { 'Content-Range': `bytes */${size}` },
      });
    }

    let start: number;
    let end: number;
    if (match[1] === '') {
      // Suffix range "bytes=-N": serve the last N bytes of the file.
      const suffix = parseInt(match[2], 10);
      start = Math.max(0, size - suffix);
      end = size - 1;
    } else {
      // "bytes=start-" (open-ended) defaults end to the last byte.
      start = parseInt(match[1], 10);
      end = match[2] ? parseInt(match[2], 10) : size - 1;
    }

    if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= size) {
      return new Response('Range Not Satisfiable', {
        status: 416,
        headers: { 'Content-Range': `bytes */${size}` },
      });
    }
    if (end >= size) end = size - 1;

    // slice(start, end) is end-exclusive, so add 1 to include the last byte.
    const chunk = bunFile.slice(start, end + 1);
    return new Response(chunk, {
      status: 206,
      headers: {
        'Content-Type': 'video/mp4',
        'Accept-Ranges': 'bytes',
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Content-Length': String(end - start + 1),
      },
    });
  }

  return new Response(bunFile, {
    status: 200,
    headers: {
      'Content-Type': 'video/mp4',
      'Accept-Ranges': 'bytes',
      'Content-Length': String(size),
    },
  });
}

// POST /api/open { file }
// Open the original video in the macOS default player via `open`.
async function handleApiOpen(request: Request): Promise<Response> {
  const body = (await request.json()) as { file?: string };
  if (!body.file) {
    return Response.json({ error: 'Missing file parameter' }, { status: 400 });
  }
  if (!existsSync(body.file)) {
    return Response.json({ error: 'File not found' }, { status: 404 });
  }

  Bun.spawn(['open', body.file]);
  // Record the open in the stats file and report the new count back to the UI.
  const opens = incrementOpen(body.file);
  return Response.json({ ok: true, opens });
}

// POST /api/stop-clips
// Stop the in-progress clip-generation run. Clips already finished are kept, so
// a later run resumes from where this one left off. Returns whether a run was
// actually stopped (false if nothing was running).
function handleApiStopClips(): Response {
  const { stopped } = clipEngine.stop();
  return Response.json({ stopped });
}

const server = Bun.serve({
  port: PORT,
  async fetch(request: Request, server: Server<undefined>): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/' || path === '/index.html') {
      return serveStatic('index.html');
    }

    if (path.startsWith('/public/')) {
      return serveStatic(path.replace('/public/', ''));
    }

    if (path === '/api/pick-folder' && request.method === 'GET') {
      // The native folder dialog blocks until the user chooses, which can take
      // far longer than the default 10s idle limit. Disabling the timeout for
      // this request stops Bun from resetting the connection mid-dialog — a
      // reset makes the browser auto-retry the GET and pop a second dialog.
      server.timeout(request, 0);
      return handleApiPickFolder();
    }

    if (path === '/api/scan' && request.method === 'GET') {
      return handleApiScan(url);
    }

    if (path === '/api/thumbnail' && request.method === 'GET') {
      return handleApiThumbnail(url);
    }

    if (path === '/api/photo' && request.method === 'GET') {
      return handleApiPhoto(url);
    }

    if (path === '/api/delete' && request.method === 'POST') {
      return handleApiDelete(request);
    }

    if (path === '/api/restore' && request.method === 'POST') {
      return handleApiRestore(request);
    }

    if (path === '/api/restore-group' && request.method === 'POST') {
      return handleApiRestoreGroup(request);
    }

    if (path === '/api/generate-clips' && request.method === 'POST') {
      return handleApiGenerateClips(request);
    }

    if (path === '/api/progress' && request.method === 'GET') {
      // A progress stream is quiet between videos, so it would hit the 10s idle
      // limit and drop. Disable the timeout to keep the stream open until
      // generation finishes (or the client disconnects).
      server.timeout(request, 0);
      return handleApiProgress();
    }

    if (path === '/api/clip' && request.method === 'GET') {
      return handleApiClip(request, url);
    }

    if (path === '/api/stop-clips' && request.method === 'POST') {
      return handleApiStopClips();
    }

    if (path === '/api/open' && request.method === 'POST') {
      return handleApiOpen(request);
    }

    return new Response('Not Found', { status: 404 });
  },
});

console.log(`PhotoSift running at http://localhost:${server.port}`);
