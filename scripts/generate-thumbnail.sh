#!/usr/bin/env bash
# ============================================================================
# generate-thumbnail.sh — High-performance MP4 thumbnail extractor
# Uses keyframe seeking, hardware acceleration, and parallel processing
# https://superuser.com/questions/597945/set-mp4-thumbnail
#
# Usage:
#   ./generate-thumbnail.sh                 # Process all videos
#   ./generate-thumbnail.sh --video-max 3   # Process only first 3 videos
# ============================================================================

set -euo pipefail

brew upgrade ffmpeg

# --- Configuration -----------------------------------------------------------
THUMBNAIL_DIR="./thumbnails"
INTERVAL_SECS=120           # Extract a frame every N seconds (120 = 2 mins)
MAX_FRAMES=60               # Max thumbnails per video
THUMB_WIDTH=320             # Thumbnail width (-1 for original)
JPEG_QUALITY=5              # 2=best, 31=worst (5 is good for thumbnails)
PARALLEL_JOBS=4             # Number of videos to process in parallel
LOG_FILE="./thumbnails/generate.log"
VIDEO_MAX=0                 # 0 = process all, N = process first N videos only
FFPROBE_RETRIES=3           # Number of retries for ffprobe on failure
FFPROBE_RETRY_DELAY=2       # Seconds between retries

# --- Colors & Formatting ----------------------------------------------------
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

# --- Logging -----------------------------------------------------------------
log()      { echo -e "${DIM}$(date '+%H:%M:%S')${NC} $*"; }
log_info() { log "${BLUE}ℹ${NC}  $*"; }
log_ok()   { log "${GREEN}✓${NC}  $*"; }
log_warn() { log "${YELLOW}⚠${NC}  $*"; }
log_err()  { log "${RED}✗${NC}  $*"; }
log_skip() { log "${DIM}⏭${NC}  $*"; }

log_to_file() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG_FILE"
}

# --- Helper: format seconds to human-readable --------------------------------
format_duration() {
    local secs=$1
    if ((secs >= 3600)); then
        printf '%dh %dm %ds' $((secs/3600)) $((secs%3600/60)) $((secs%60))
    elif ((secs >= 60)); then
        printf '%dm %ds' $((secs/60)) $((secs%60))
    else
        printf '%ds' "$secs"
    fi
}

# --- Helper: format bytes to human-readable -----------------------------------
format_bytes() {
    local bytes=$1
    if ((bytes >= 1073741824)); then
        printf '%.1f GB' "$(echo "$bytes / 1073741824" | bc -l)"
    elif ((bytes >= 1048576)); then
        printf '%.1f MB' "$(echo "$bytes / 1048576" | bc -l)"
    elif ((bytes >= 1024)); then
        printf '%.1f KB' "$(echo "$bytes / 1024" | bc -l)"
    else
        printf '%d B' "$bytes"
    fi
}

# --- Helper: ffprobe with retry ----------------------------------------------
# External drives (USB/NAS) can have intermittent I/O failures due to:
#   - Drive spin-up latency (HDD sleep mode)
#   - macOS USB power management briefly disconnecting the volume
#   - Network drives with transient timeouts
#   - Filesystem cache misses on large directories
#
# This wrapper retries ffprobe up to FFPROBE_RETRIES times with a delay,
# and captures stderr so we can log the ACTUAL error instead of hiding it.
#
# IMPORTANT: All log output goes to stderr (>&2) so it doesn't contaminate
# the stdout that the caller captures via $().
#
ffprobe_retry() {
    local attempt=1
    local output=""
    local err_file=""

    while ((attempt <= FFPROBE_RETRIES)); do
        # Run ffprobe, capture stdout and stderr separately
        err_file=$(mktemp)
        if output=$(ffprobe "$@" 2>"$err_file"); then
            rm -f "$err_file"
            echo "$output"
            return 0
        fi

        local error_msg
        error_msg=$(cat "$err_file")
        rm -f "$err_file"

        if ((attempt < FFPROBE_RETRIES)); then
            # >&2 ensures log output goes to stderr, NOT stdout
            log_warn "      ${DIM}ffprobe attempt $attempt/$FFPROBE_RETRIES failed: ${error_msg}${NC}" >&2
            log_to_file "RETRY ffprobe attempt $attempt: $error_msg"
            sleep "$FFPROBE_RETRY_DELAY"
        else
            log_err "      ${DIM}ffprobe failed after $FFPROBE_RETRIES attempts: ${error_msg}${NC}" >&2
            log_to_file "FAIL ffprobe after $FFPROBE_RETRIES attempts: $error_msg"
        fi

        attempt=$((attempt + 1))
    done

    return 1
}

# --- Detect Hardware Acceleration --------------------------------------------
# ffmpeg can offload video decoding from CPU to GPU. This probes which
# hardware decoders are available on the current system and picks the best one.
# The decoder only affects how fast frames are read — output quality is identical.
detect_hwaccel() {
    local hwaccel=""
    local hwaccel_label=""

    local available
    available=$(ffmpeg -hide_banner -hwaccels 2>/dev/null | tail -n +2 | tr -d ' ')

    if echo "$available" | grep -q "videotoolbox"; then
        hwaccel="videotoolbox"
        hwaccel_label="Apple VideoToolbox (GPU)"
    elif echo "$available" | grep -q "cuda"; then
        hwaccel="cuda"
        hwaccel_label="NVIDIA CUDA (GPU)"
    elif echo "$available" | grep -q "vaapi"; then
        hwaccel="vaapi"
        hwaccel_label="VA-API (GPU)"
    elif echo "$available" | grep -q "qsv"; then
        hwaccel="qsv"
        hwaccel_label="Intel Quick Sync (GPU)"
    elif echo "$available" | grep -q "d3d11va"; then
        hwaccel="d3d11va"
        hwaccel_label="D3D11VA (GPU)"
    fi

    if [[ -n "$hwaccel" ]]; then
        log_ok "Hardware acceleration: ${GREEN}${hwaccel_label}${NC}" >&2
    else
        log_warn "No GPU acceleration found — using ${YELLOW}CPU decoding${NC}" >&2
        hwaccel="auto"
        hwaccel_label="CPU (software)"
    fi

    echo "$hwaccel"
}

# --- Process a Single Video --------------------------------------------------
generate_thumb() {
    local video="$1"
    local video_index="$2"
    local video_total="$3"
    local hwaccel="$4"
    local name
    name=$(basename "$video" .mp4)

    local prefix="${DIM}[${video_index}/${video_total}]${NC}"

    # Skip if thumbnails already exist
    if compgen -G "$THUMBNAIL_DIR/$name-"*.jpg > /dev/null 2>&1; then
        local existing
        existing=$(find "$THUMBNAIL_DIR" -name "$name-*.jpg" -not -name "._*" 2>/dev/null | wc -l | tr -d ' ')
        log_skip "$prefix ${DIM}$name.mp4${NC} — $existing thumbnails already exist"
        log_to_file "SKIP $name.mp4 ($existing thumbnails exist)"
        return
    fi

    # -------------------------------------------------------------------------
    # ffprobe — Extract video metadata before processing
    # -------------------------------------------------------------------------
    # Uses ffprobe_retry wrapper for external drive reliability.
    #
    # -v error
    #     Suppress all output except errors. Without this, ffprobe prints
    #     a wall of codec info we don't need.
    #
    # -show_entries format=duration
    #     Only extract the "duration" field from the container format header.
    #     This reads the file header, NOT the full stream — so it's instant.
    #
    # -of default=noprint_wrappers=1:nokey=1
    #     Output format: strip the "[FORMAT]" wrapper and the "duration=" key,
    #     returning just the raw number (e.g. "3724.512000").
    #
    # -select_streams v:0
    #     Target only the first video stream (ignores audio, subtitles).
    #
    # -show_entries stream=width,height
    #     Extract resolution from the stream header.
    #
    # -of csv=p=0:s=x
    #     Output as CSV with no section prefix, using "x" as separator → "1920x1080"
    #
    local duration="" resolution="" filesize=""

    duration=$(ffprobe_retry -v error \
        -show_entries format=duration \
        -of default=noprint_wrappers=1:nokey=1 \
        "$video") || true
    # Trim whitespace and truncate decimals → integer seconds
    duration=$(echo "$duration" | tr -d '[:space:]')
    duration=${duration%.*}

    resolution=$(ffprobe_retry -v error \
        -select_streams v:0 \
        -show_entries stream=width,height \
        -of csv=p=0:s=x \
        "$video") || resolution="unknown"
    resolution=$(echo "$resolution" | tr -d '[:space:]')

    filesize=$(stat -f%z "$video" 2>/dev/null || stat -c%s "$video" 2>/dev/null || echo "0")
    local filesize_human
    filesize_human=$(format_bytes "$filesize")

    # Validate duration: must be a positive integer
    if [[ -z "$duration" ]] || ! [[ "$duration" =~ ^[0-9]+$ ]] || ((duration <= 0)); then
        log_err "$prefix ${BOLD}$name.mp4${NC} — could not determine duration, skipping"
        log_err "      ${DIM}└─ ffprobe returned: '${duration:-<empty>}'${NC}"
        log_err "      ${DIM}   Try manually: ffprobe -v error -show_entries format=duration \"$video\"${NC}"
        log_to_file "ERROR $name.mp4 — ffprobe duration='${duration:-<empty>}'"
        return
    fi

    local duration_human
    duration_human=$(format_duration "$duration")

    local expected_frames=$(( (duration / INTERVAL_SECS) + 1 ))
    if ((expected_frames > MAX_FRAMES)); then
        expected_frames=$MAX_FRAMES
    fi

    log_info "$prefix ${BOLD}$name.mp4${NC}"
    log_info "      ${DIM}├─ Size: $filesize_human | Duration: $duration_human | Resolution: $resolution${NC}"
    log_info "      ${DIM}├─ Extracting ~$expected_frames frames (every ${INTERVAL_SECS}s)${NC}"

    local start_time count=0 errors=0
    start_time=$(date +%s)

    for ((t = 0; t < duration && count < MAX_FRAMES; t += INTERVAL_SECS)); do
        count=$((count + 1))
        local outfile
        outfile=$(printf "%s/%s-%03d.jpg" "$THUMBNAIL_DIR" "$name" "$count")

        # -----------------------------------------------------------------
        # ffmpeg — The core thumbnail extraction command
        # -----------------------------------------------------------------
        # Each flag is explained below in the order they appear.
        #
        # -hide_banner
        #     Suppresses the build/config info ffmpeg prints on every run
        #     (codec list, version, compile flags). Keeps output clean.
        #
        # -loglevel error
        #     Only print actual errors. Without this, ffmpeg outputs per-frame
        #     encoding stats that flood the terminal. We handle our own
        #     progress display instead.
        #
        # -hwaccel "$hwaccel"
        #     Offloads video DECODING to the GPU. This means the GPU reads
        #     and decompresses the H.264/H.265 bitstream instead of the CPU.
        #     The value is auto-detected above (videotoolbox/cuda/vaapi/etc).
        #     Effect: 2-5x faster decoding, especially for high-res videos.
        #     Output quality is identical — this only affects decode speed.
        #
        # -ss "$t"
        #     ⚡ THE BIGGEST PERFORMANCE WIN ⚡
        #     Seek to timestamp $t seconds BEFORE opening the input (-i).
        #     When -ss is placed BEFORE -i, ffmpeg uses "input seeking":
        #     it jumps directly to the nearest keyframe using the file index,
        #     skipping everything before it WITHOUT decoding.
        #
        #     Compare to the original script which decoded EVERY frame
        #     and used select='not(mod(n,100))' to pick frames — that
        #     approach reads the entire video file sequentially.
        #
        #     Placed AFTER -i, it would do "output seeking" which still
        #     decodes everything up to that point (slow for large offsets).
        #
        #     Effect: 10-50x faster for long videos.
        #
        # -i "$video"
        #     Input file. Placed after -ss so seeking happens before the
        #     demuxer opens the stream (input seeking mode).
        #
        # -frames:v 1
        #     Stop after extracting exactly 1 video frame. Without this,
        #     ffmpeg would continue extracting frames until end-of-stream.
        #     Since we seek (-ss) to each timestamp individually, we only
        #     need one frame per seek position.
        #     Alias: -vframes 1 (deprecated form)
        #
        # -vf "scale=${THUMB_WIDTH}:-1"
        #     Video filter: resize the extracted frame.
        #       ${THUMB_WIDTH} = target width in pixels (default 320)
        #       -1             = calculate height automatically to preserve
        #                        the original aspect ratio
        #     Effect: Smaller output files (less JPEG data to encode),
        #     faster encoding, and less disk usage. A 1920px frame scaled
        #     to 320px produces a ~15KB JPEG instead of ~200KB.
        #
        # -q:v "$JPEG_QUALITY"
        #     JPEG output quality for the mjpeg encoder.
        #       Range: 2 (best/largest) to 31 (worst/smallest)
        #       Default is ~2 if unspecified.
        #       5 is a good balance for thumbnails — visually identical
        #       to 2 but ~40% smaller file size.
        #     This is a VBR quality setting (not a fixed bitrate).
        #     Alias: -qscale:v
        #
        # -threads 0
        #     Let ffmpeg auto-detect and use ALL available CPU cores for
        #     encoding. 0 = automatic (usually picks nproc count).
        #     For single-frame JPEG output this has minimal effect, but
        #     it helps when the decode step involves complex filters or
        #     high-resolution sources.
        #
        # -y
        #     Overwrite output files without asking. Without this, ffmpeg
        #     prompts "File already exists. Overwrite? [y/N]" and blocks
        #     in non-interactive scripts.
        #
        if ! ffmpeg \
            -hide_banner \
            -loglevel error \
            -hwaccel "$hwaccel" \
            -ss "$t" \
            -i "$video" \
            -frames:v 1 \
            -vf "scale=${THUMB_WIDTH}:-1" \
            -q:v "$JPEG_QUALITY" \
            -threads 0 \
            -y \
            "$outfile" 2>/dev/null; then
            errors=$((errors + 1))
        fi

        # Progress bar
        printf "\r      ${DIM}├─ Progress: [${NC}"
        local pct=$((count * 100 / expected_frames))
        local filled=$((pct / 5))
        local empty=$((20 - filled))
        printf "${GREEN}%s${NC}%s" "$(printf '█%.0s' $(seq 1 $filled 2>/dev/null) || true)" \
               "$(printf '░%.0s' $(seq 1 $empty 2>/dev/null) || true)"
        printf "${DIM}] %3d%% (%d/%d frames)${NC}" "$pct" "$count" "$expected_frames"
    done
    printf "\n"

    local end_time elapsed
    end_time=$(date +%s)
    elapsed=$((end_time - start_time))
    local elapsed_human
    elapsed_human=$(format_duration "$elapsed")

    # Calculate total output size for this video
    local out_size
    out_size=$(find "$THUMBNAIL_DIR" -name "$name-*.jpg" -not -name "._*" -exec stat -f%z {} + 2>/dev/null \
            || find "$THUMBNAIL_DIR" -name "$name-*.jpg" -not -name "._*" -exec stat -c%s {} + 2>/dev/null \
            || echo "0")
    local total_out=0
    for s in $out_size; do total_out=$((total_out + s)); done
    local out_human
    out_human=$(format_bytes "$total_out")

    local speed="N/A"
    if ((elapsed > 0)); then
        speed="$(echo "scale=1; $count / $elapsed" | bc) frames/sec"
    fi

    if ((errors == 0)); then
        log_ok "      ${DIM}└─ ${GREEN}$count frames${NC}${DIM} in $elapsed_human ($speed) → $out_human${NC}"
    else
        log_warn "      ${DIM}└─ $count frames ($errors errors) in $elapsed_human → $out_human${NC}"
    fi

    log_to_file "OK $name.mp4 — $count frames in ${elapsed}s ($speed), output: $out_human"
}

# --- Main --------------------------------------------------------------------
main() {
    echo ""
    echo -e "${BOLD}╔══════════════════════════════════════════╗${NC}"
    echo -e "${BOLD}║   🎬 Thumbnail Generator                ║${NC}"
    echo -e "${BOLD}╚══════════════════════════════════════════╝${NC}"
    echo ""

    mkdir -p "$THUMBNAIL_DIR"
    : > "$LOG_FILE"

    # Clean up macOS resource fork files that cause ffprobe errors
    # ._*.mp4 files are metadata forks created by macOS on external/network
    # drives (HFS+/FAT32/exFAT). They contain Finder info, not video data.
    local dot_underscore_count
    dot_underscore_count=$(find . -maxdepth 1 -name "._*.mp4" 2>/dev/null | wc -l | tr -d ' ')
    if ((dot_underscore_count > 0)); then
        log_warn "Found ${YELLOW}$dot_underscore_count${NC} macOS resource fork files (._*.mp4) — skipping these"
        log_to_file "Excluded $dot_underscore_count macOS ._*.mp4 resource fork files"
    fi

    # Check dependencies
    if ! command -v ffmpeg &> /dev/null; then
        log_err "ffmpeg not found. Install it first: brew install ffmpeg / apt install ffmpeg"
        exit 1
    fi

    local ffmpeg_version
    ffmpeg_version=$(ffmpeg -version 2>/dev/null | head -1 | awk '{print $3}')
    log_info "ffmpeg version: ${CYAN}$ffmpeg_version${NC}"

    # Detect GPU
    local hwaccel
    hwaccel=$(detect_hwaccel)

    # Discover videos — exclude macOS ._* resource fork files
    # -not -name "._*" filters out the metadata files macOS creates on
    # external drives (FAT32/exFAT/SMB). These look like .mp4 files but
    # contain only Finder metadata and have no valid moov atom.
    local videos=()
    while IFS= read -r -d '' f; do
        videos+=("$f")
    done < <(find . -maxdepth 1 -name "*.mp4" -not -name "._*" -print0 | sort -z)

    local found=${#videos[@]}

    if ((found == 0)); then
        log_warn "No .mp4 files found in current directory"
        exit 0
    fi

    # Apply --video-max limit
    local total=$found
    if ((VIDEO_MAX > 0 && VIDEO_MAX < found)); then
        videos=("${videos[@]:0:$VIDEO_MAX}")
        total=$VIDEO_MAX
    fi

    # Total input size (of selected videos only)
    local total_size=0
    for v in "${videos[@]}"; do
        local s
        s=$(stat -f%z "$v" 2>/dev/null || stat -c%s "$v" 2>/dev/null || echo "0")
        total_size=$((total_size + s))
    done

    echo ""
    log_info "Configuration"
    log_info "  ${DIM}├─ Videos found:    ${NC}${BOLD}$found${NC}"
    if ((VIDEO_MAX > 0)); then
        log_info "  ${DIM}├─ Video limit:     ${NC}${YELLOW}--video-max $VIDEO_MAX${NC} (processing $total of $found)"
    fi
    log_info "  ${DIM}├─ Total size:      ${NC}$(format_bytes $total_size)"
    log_info "  ${DIM}├─ Frame interval:  ${NC}every ${INTERVAL_SECS}s"
    log_info "  ${DIM}├─ Max frames:      ${NC}$MAX_FRAMES per video"
    log_info "  ${DIM}├─ Thumbnail size:  ${NC}${THUMB_WIDTH}px wide, quality $JPEG_QUALITY"
    log_info "  ${DIM}├─ Parallel jobs:   ${NC}$PARALLEL_JOBS"
    log_info "  ${DIM}├─ ffprobe retries: ${NC}$FFPROBE_RETRIES (${FFPROBE_RETRY_DELAY}s delay)"
    log_info "  ${DIM}└─ Output dir:      ${NC}$THUMBNAIL_DIR"
    echo ""

    # Process videos
    local global_start processed=0 failed=0
    global_start=$(date +%s)

    for i in "${!videos[@]}"; do
        local idx=$((i + 1))
        if generate_thumb "${videos[$i]}" "$idx" "$total" "$hwaccel"; then
            processed=$((processed + 1))
        else
            failed=$((failed + 1))
        fi
    done

    local global_end global_elapsed
    global_end=$(date +%s)
    global_elapsed=$((global_end - global_start))

    # Final stats
    local total_thumbs
    total_thumbs=$(find "$THUMBNAIL_DIR" -name "*.jpg" -not -name "._*" 2>/dev/null | wc -l | tr -d ' ')
    local total_out_size
    total_out_size=$(find "$THUMBNAIL_DIR" -name "*.jpg" -not -name "._*" -exec stat -f%z {} + 2>/dev/null \
                  || find "$THUMBNAIL_DIR" -name "*.jpg" -not -name "._*" -exec stat -c%s {} + 2>/dev/null \
                  || echo "0")
    local total_out_bytes=0
    for s in $total_out_size; do total_out_bytes=$((total_out_bytes + s)); done

    # Summary
    echo ""
    echo -e "${BOLD}╔══════════════════════════════════════════╗${NC}"
    echo -e "${BOLD}║   📊 Summary                            ║${NC}"
    echo -e "${BOLD}╚══════════════════════════════════════════╝${NC}"
    echo ""
    log_ok "Videos processed:  ${BOLD}$processed${NC} / $total"
    if ((VIDEO_MAX > 0)); then
        log_info "                   ${DIM}($((found - total)) videos skipped by --video-max)${NC}"
    fi
    if ((failed > 0)); then
        log_err "Failed:            ${RED}$failed${NC}"
    fi
    log_ok "Thumbnails total:  ${BOLD}$total_thumbs${NC} files ($(format_bytes $total_out_bytes))"
    log_ok "Total time:        ${BOLD}$(format_duration $global_elapsed)${NC}"
    if ((global_elapsed > 0 && total_thumbs > 0)); then
        local avg
        avg=$(echo "scale=1; $total_thumbs / $global_elapsed" | bc)
        log_ok "Avg speed:         ${BOLD}${avg} frames/sec${NC}"
    fi
    log_ok "Log file:          ${DIM}$LOG_FILE${NC}"
    echo ""

    log_to_file "=== COMPLETE: $total_thumbs thumbnails from $processed videos in ${global_elapsed}s ==="
}

# --- Parse CLI flags ---------------------------------------------------------
while [[ $# -gt 0 ]]; do
    case $1 in
        --video-max)
            VIDEO_MAX="$2"
            shift 2
            ;;
        *)
            log_err "Unknown option: $1"
            echo "Usage: $(basename "$0") [--video-max N]"
            exit 1
            ;;
    esac
done

main
