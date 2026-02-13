# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
bun run dev          # Start server with hot reload (port 3000)
bun run start        # Start server without hot reload
bun install          # Install dependencies
```

No build step — Bun runs TypeScript directly. Frontend is vanilla JS with no bundler.

## Architecture

PhotoSift is a local photo/video thumbnail management tool with two parts:

**Backend** (`src/`) — Bun + TypeScript server on port 3000 (configurable via `PORT` env var):
- `server.ts` — HTTP API and static file serving from `/public`
- `scanner.ts` — Scans folders for JPG/JPEG/RAF files, groups by stem name (regex: `/^(.+)-(\d{2,3})$/`)
- `thumbnail.ts` — Sharp-based thumbnail generation with MD5 hash caching in tmpdir
- `trash.ts` — Soft delete (moves to `_deleted` folder) with restore/undo support
- `folder-picker.ts` — macOS native folder dialog via `osascript`
- `errors.ts` — Discriminated union errors with `_tag` pattern, used with the Effect library

**Frontend** (`public/`) — Vanilla ES6 modules, no framework:
- `app.js` — Entry point, restores last folder from localStorage
- `js/state.js` — Single global state object (photos, selections, pagination, undo history)
- `js/dom.js` — DOM element references
- `js/api.js` — Fetch wrappers for backend endpoints
- `js/events.js` — All event listeners (folder picker, selection, zoom via Cmd+scroll)
- `js/ui.js` — Loading states, toasts, selection count updates
- `js/grid.js` — Photo tile rendering with lazy loading

**Scripts** (`scripts/`) — Bash utilities for video thumbnail workflow (see `scripts/GUIDE.md`):
1. `generate-thumbnail.sh` — Extract frames from MP4s every 2 minutes (FFmpeg, parallel)
2. Use PhotoSift UI to curate frames in group mode
3. `generate-contact-sheet.sh` — Create montage collages (ImageMagick)
4. `set-thumbnail.sh` — Embed cover art into MP4 files
5. `remove-corrected.sh` — Archive processed originals

## Key Patterns

- **Effect library** for error handling — uses `Effect.tryPromise`, `Either`, and tagged errors
- **Soft delete** — files move to `_deleted/` subfolder, not permanently removed
- **Group mode** — photos grouped by filename stem minus numeric suffix (e.g., `vacation-01`, `vacation-02` → group `vacation`)
- API routes all under `/api/` — `pick-folder`, `scan`, `thumbnail`, `photo`, `delete`, `restore`, `restore-group`
