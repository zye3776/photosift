# 🎬 PhotoSift Script Workflow Guide

This guide explains how to use the scripts provided in the `scripts/` folder to process your video collection from frame extraction to thumbnail embedding.

## 🚀 Recommended Workflow Order

Follow these steps in order to process your videos effectively:

### 1. Generate Thumbnails
**Script:** `generate-thumbnail.sh`
- **When to use:** Use this to extract potential frames for your video covers from `.mp4` files.
- **What it does:** Scans your `.mp4` files and extracts a frame every 2 minutes. It saves these into a `./thumbnails` folder.
- **Command:** `./generate-thumbnail.sh`

### 2. Sift & Select (The PhotoSift Step)
**Tool:** PhotoSift Web UI
- **Action:**
    1. Open the PhotoSift application.
    2. Point it to your folder.
    3. Ensure **Group Mode** is enabled. It will group thumbnails by the video filename.
    4. Select the best frame(s) for each video.
    5. Delete the unselected thumbnails. 
- **Result:** Only your favorite frames remain in the `./thumbnails` folder.

### 3. Embed Thumbnails
**Script:** `set-thumbnail.sh`
- **When to use:** Once you have selected the best thumbnails.
- **What it does:** 
    - **Automatically generates a contact sheet/collage** if you kept multiple frames (2-6) for a single video.
    - Embeds the best frame (or the generated collage) into the MP4 file as cover art.
    - Moves the "corrected" videos (with thumbnails) to the `./corrected` folder.
    - Moves the original videos to the `./backup` folder.
    - **Saves the selected thumbnail** in `./thumbnails/selected/` for your records.
- **Command:** `./set-thumbnail.sh`

### 4. Final Cleanup
**Script:** `remove-corrected.sh`
- **When to use:** After you have verified your links in the `./corrected` folder.
- **What it does:** Moves any original videos that have been successfully processed and moved to `./corrected` into a `./removed` folder for safe deletion.

---

## 🛠 Prerequisites
Ensure you have the following installed on your system:
- `ffmpeg` (for video processing)
- `imagemagick` (required for generating collages / `montage`)

## 💡 Pro Tips
- Most scripts support a `--video-max N` flag (e.g., `./generate-thumbnail.sh --video-max 5`) to test the process on a small batch first.
- Always check the `generate.log` or `set-thumbnail.log` if a script fails.
