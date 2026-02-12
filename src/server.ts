import { Effect } from 'effect';
import { join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { scanFolder } from './scanner';
import { generateThumbnail } from './thumbnail';
import { deleteFiles, restoreFiles, restoreGroup } from './trash';
import { pickFolder } from './folder-picker';
import type { DeleteRequest } from './types';

const PORT = 3000;
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

const server = Bun.serve({
  port: PORT,
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/' || path === '/index.html') {
      return serveStatic('index.html');
    }

    if (path.startsWith('/public/')) {
      return serveStatic(path.replace('/public/', ''));
    }

    if (path === '/api/pick-folder' && request.method === 'GET') {
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

    return new Response('Not Found', { status: 404 });
  },
});

console.log(`PhotoSift running at http://localhost:${server.port}`);
