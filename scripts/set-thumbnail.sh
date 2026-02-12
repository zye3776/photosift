#!/usr/bin/env bash
# ============================================================================
# set-thumbnail.sh — Embeds thumbnails into MP4 video files
# Sets the cover art (thumbnail) for MP4 files using FFmpeg.
# Moves processed files to ./corrected and originals to ./backup.
#
# Usage:
#   ./set-thumbnail.sh                 # Process up to 1000 videos
#   ./set-thumbnail.sh --video-max 50  # Process only 50 videos
# ============================================================================

set -euo pipefail

# --- Configuration -----------------------------------------------------------
THUMBNAIL_DIR="./thumbnails"
CORRECTED_DIR="./corrected"
BACKUP_DIR="./backup"
LOG_FILE="./set-thumbnail.log"
VIDEO_MAX=1000              # Default limit from original script (0 = all)
PARALLEL_JOBS=4             # Process multiple videos in parallel

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

# --- Process a Single Video --------------------------------------------------
process_video() {
    local video="$1"
    local video_index="$2"
    local video_total="$3"
    
    local name
    name=$(basename "$video" .mp4)
    local output_file="$CORRECTED_DIR/$name.mp4"
    local prefix="${DIM}[${video_index}/${video_total}]${NC}"

    # Check if already processed
    if [[ -f "$output_file" ]]; then
        log_skip "$prefix ${DIM}$name.mp4${NC} — already exists in $CORRECTED_DIR"
        log_to_file "SKIP $name.mp4 (already exists in corrected)"
        
        # Move original to backup if output exists (matching original script behavior)
        if [[ -f "$video" ]]; then
            log_info "      ${DIM}Moving original to backup...${NC}"
            mv "$video" "$BACKUP_DIR/"
        fi
        return
    fi

    # Find thumbnail
    # Logic: ls ./thumbnails/$name-[0-9][0-9]*.??? | sort -V | head -n 1
    local thumb_pattern="$THUMBNAIL_DIR/$name-[0-9][0-9]*.???"
    local thumbnail_to_use=""
    
    # Use find/sort to safely locate the file or handle no match
    thumbnail_to_use=$(ls $thumb_pattern 2>/dev/null | sort -V | head -n 1 || true)

    if [[ -z "$thumbnail_to_use" || ! -f "$thumbnail_to_use" ]]; then
        log_warn "$prefix ${YELLOW}$name.mp4${NC} — no matching thumbnails found"
        log_to_file "WARN $name.mp4 (no thumbnails found)"
        return
    fi

    log_info "$prefix ${BOLD}$name.mp4${NC}"
    log_info "      ${DIM}├─ Thumbnail: $(basename "$thumbnail_to_use")${NC}"

    local start_time
    start_time=$(date +%s)
    
    # Run ffmpeg
    # Original command:
    # ffmpeg -y -i "$name.mp4" -i $thumbnailToUse -vcodec libx265 -map 0 -map 1 -c copy -c:v:1 png -disposition:v:1 attached_pic $outputFilePathAndName
    
    local error_log
    error_log=$(mktemp)
    
    if ! ffmpeg -y -hide_banner -loglevel error \
         -i "$video" \
         -i "$thumbnail_to_use" \
         -map 0 -map 1 \
         -c copy \
         -c:v:1 copy \
         -disposition:v:1 attached_pic \
         "$output_file" 2>"$error_log"; then
        
        log_err "$prefix ${RED}Failed to set thumbnail for $name.mp4${NC}"
        cat "$error_log" >&2
        log_to_file "ERROR $name.mp4 (ffmpeg failed)"
        rm -f "$error_log"
        return 1
    fi
    rm -f "$error_log"

    local end_time duration
    end_time=$(date +%s)
    duration=$((end_time - start_time))
    
    local filesize
    filesize=$(stat -f%z "$output_file" 2>/dev/null || stat -c%s "$output_file" 2>/dev/null || echo "0")
    
    log_ok "      ${DIM}└─ ${GREEN}Success${NC}${DIM} in ${duration}s → $(format_bytes "$filesize")${NC}"
    log_to_file "OK $name.mp4 in ${duration}s"

    # Cleanup actions from original script
    rm -f "$thumbnail_to_use"
    mv "$video" "$BACKUP_DIR/"
}

# --- Main --------------------------------------------------------------------
main() {
    echo ""
    echo -e "${BOLD}╔══════════════════════════════════════════╗${NC}"
    echo -e "${BOLD}║   🖼  Set Video Thumbnail                 ║${NC}"
    echo -e "${BOLD}╚══════════════════════════════════════════╝${NC}"
    echo ""

    # Ensure directories exist
    mkdir -p "$CORRECTED_DIR"
    mkdir -p "$BACKUP_DIR"
    mkdir -p "$THUMBNAIL_DIR"
    
    # Initialize log
    : >> "$LOG_FILE"
    log_to_file "--- session start ---"

    # Check dependencies
    if ! command -v ffmpeg &> /dev/null; then
        log_err "ffmpeg not found. Please install it."
        exit 1
    fi

    # Run contact-sheet script first (as per original logic)
    if [[ -f "./contact-sheet.sh" ]]; then
        log_info "Running contact-sheet.sh..."
        sh ./contact-sheet.sh
    else
        log_warn "contact-sheet.sh not found, skipping..."
    fi

    # Find videos
    local videos=()
    while IFS= read -r -d '' f; do
        videos+=("$f")
    done < <(find . -maxdepth 1 -name "*.mp4" -not -name "._*" -print0 | sort -z)

    local found=${#videos[@]}

    if ((found == 0)); then
        log_warn "No .mp4 files found in current directory"
        exit 0
    fi

    # Apply limit
    local total=$found
    if ((VIDEO_MAX > 0 && VIDEO_MAX < found)); then
        # Check if first argument was passed as number (legacy support)
        # But we handle CLI args below, so VIDEO_MAX is set.
        videos=("${videos[@]:0:$VIDEO_MAX}")
        total=$VIDEO_MAX
    fi

    echo ""
    log_info "Configuration"
    log_info "  ${DIM}├─ Videos found:    ${NC}${BOLD}$found${NC}"
    if ((VIDEO_MAX > 0)); then
        log_info "  ${DIM}├─ Limit:           ${NC}${YELLOW}$VIDEO_MAX${NC} (processing $total of $found)"
    fi
    log_info "  ${DIM}├─ Output dir:      ${NC}$CORRECTED_DIR"
    log_info "  ${DIM}└─ Backup dir:      ${NC}$BACKUP_DIR"
    echo ""

    local start_total=$(date +%s)
    local results_dir
    results_dir=$(mktemp -d)

    log_info "Processing with $PARALLEL_JOBS parallel jobs..."

    for i in "${!videos[@]}"; do
        local idx=$((i + 1))
        
        # Run in background
        (
            if process_video "${videos[$i]}" "$idx" "$total"; then
                touch "$results_dir/done_$idx"
            else
                touch "$results_dir/fail_$idx"
            fi
        ) &
        
        # Batch control: wait if we reached PARALLEL_JOBS
        if (( (i + 1) % PARALLEL_JOBS == 0 )); then
            wait
        fi
    done
    wait # Wait for the last batch

    local processed failed
    processed=$(find "$results_dir" -name "done_*" | wc -l | xargs)
    failed=$(find "$results_dir" -name "fail_*" | wc -l | xargs)
    rm -rf "$results_dir"

    local end_total=$(($(date +%s)))
    local elapsed=$((end_total - start_total))

    # Summary
    echo ""
    echo -e "${BOLD}╔══════════════════════════════════════════╗${NC}"
    echo -e "${BOLD}║   📊 Summary                            ║${NC}"
    echo -e "${BOLD}╚══════════════════════════════════════════╝${NC}"
    echo ""
    log_ok "Videos processed:  ${BOLD}$processed${NC} / $total"
    if ((failed > 0)); then
        log_err "Failed:            ${RED}$failed${NC}"
    fi
    log_ok "Total time:        ${BOLD}$(format_duration $elapsed)${NC}"
    log_ok "Log file:          ${DIM}$LOG_FILE${NC}"
    echo ""
    
    log_to_file "=== COMPLETE: $processed videos in ${elapsed}s ==="
}

# --- Parse CLI flags ---------------------------------------------------------
# Support legacy usage: ./set-thumbnail.sh [number]
if [[ $# -gt 0 && "$1" =~ ^[0-9]+$ ]]; then
    VIDEO_MAX="$1"
    shift
fi

while [[ $# -gt 0 ]]; do
    case $1 in
        --video-max)
            VIDEO_MAX="$2"
            shift 2
            ;;
        *)
            log_err "Unknown option: $1"
            echo "Usage: $(basename "$0") [limit] [--video-max N]"
            exit 1
            ;;
    esac
done

main
