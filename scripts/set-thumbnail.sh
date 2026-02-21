#!/usr/bin/env bash
# ============================================================================
# set-thumbnail.sh — Embeds thumbnails into MP4 video files
# Sets the cover art (thumbnail) for MP4 files using FFmpeg.
# Displays a mapping of videos to contact sheets before processing,
# and offers to clean up orphaned contact sheets.
#
# Usage:
#   ./set-thumbnail.sh                 # Process up to 1000 videos
#   ./set-thumbnail.sh --video-max 50  # Process only 50 videos
# ============================================================================

set -euo pipefail

# --- Configuration -----------------------------------------------------------
THUMBNAIL_DIR="./thumbnails"
CONTACT_SHEET_DIR="./thumbnails/contact-sheets"
CORRECTED_DIR="./corrected"
LOG_FILE="./set-thumbnail.log"
VIDEO_MAX=1000              # Default limit from original script (0 = all)
PARALLEL_JOBS=4             # Process multiple videos in parallel

# --- Colors & Formatting ----------------------------------------------------
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
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
        awk "BEGIN {printf \"%.1f GB\", $bytes / 1073741824}"
    elif ((bytes >= 1048576)); then
        awk "BEGIN {printf \"%.1f MB\", $bytes / 1048576}"
    elif ((bytes >= 1024)); then
        awk "BEGIN {printf \"%.1f KB\", $bytes / 1024}"
    else
        printf '%d B' "$bytes"
    fi
}

# --- Display Mapping Table ---------------------------------------------------
# Populates global READY_VIDEOS array with videos that have a contact sheet
# and haven't been processed yet.
READY_VIDEOS=()

display_mapping() {
    local videos=("$@")
    local ready=0 done=0 nosheet=0
    READY_VIDEOS=()

    echo -e "${BOLD}  VIDEO                              STATUS       CONTACT SHEET${NC}"
    echo -e "  ${DIM}──────────────────────────────────  ───────────  ─────────────────────${NC}"

    for video in "${videos[@]}"; do
        local name="${video##*/}"
        name="${name%.mp4}"
        local sheet="$CONTACT_SHEET_DIR/$name.jpg"
        local output="$CORRECTED_DIR/$name.mp4"

        local display_name="$name.mp4"
        # Pad or truncate to 34 chars
        if ((${#display_name} > 34)); then
            display_name="${display_name:0:31}..."
        fi

        if [[ -f "$output" ]]; then
            printf "  ${DIM}%-34s  %-11s  %s${NC}\n" "$display_name" "done" "—"
            ((done++)) || true
        elif [[ -f "$sheet" ]]; then
            printf "  %-34s  ${GREEN}%-11s${NC}  %s\n" "$display_name" "ready" "${sheet##*/}"
            ((ready++)) || true
            READY_VIDEOS+=("$video")
        else
            printf "  %-34s  ${YELLOW}%-11s${NC}  %s\n" "$display_name" "no sheet" "—"
            ((nosheet++)) || true
        fi
    done

    echo ""
    echo -e "  ${GREEN}ready${NC}: $ready    ${DIM}done${NC}: $done    ${YELLOW}no sheet${NC}: $nosheet"
    echo ""

    if ((ready == 0)); then
        log_warn "No videos ready to process."
        exit 0
    fi

    printf "  Proceed with %d videos? [y/N]: " "$ready"
    read -r answer
    if [[ "$answer" != "y" && "$answer" != "Y" ]]; then
        log_info "Aborted by user."
        exit 0
    fi
    echo ""
}

# --- Handle Orphaned Contact Sheets -----------------------------------------
handle_orphaned_sheets() {
    local videos=("$@")

    # Write known video stems to a temp file (avoids per-iteration echo|grep)
    local stems_file
    stems_file=$(mktemp)

    # Stems from current directory videos
    for video in "${videos[@]}"; do
        local stem="${video##*/}"
        echo "${stem%.mp4}"
    done >> "$stems_file"

    # Stems from already-corrected videos
    if [[ -d "$CORRECTED_DIR" ]]; then
        while IFS= read -r -d '' f; do
            local stem="${f##*/}"
            echo "${stem%.mp4}"
        done < <(find "$CORRECTED_DIR" -maxdepth 1 -name "*.mp4" -not -name "._*" -print0 2>/dev/null) >> "$stems_file"
    fi

    # Deduplicate in place
    sort -u -o "$stems_file" "$stems_file"

    # Find orphaned contact sheets
    local orphans=()
    if [[ -d "$CONTACT_SHEET_DIR" ]]; then
        while IFS= read -r -d '' sheet; do
            local stem="${sheet##*/}"
            stem="${stem%.jpg}"
            if ! grep -qxF "$stem" "$stems_file"; then
                orphans+=("$sheet")
            fi
        done < <(find "$CONTACT_SHEET_DIR" -maxdepth 1 -name "*.jpg" -not -name "._*" -print0 2>/dev/null)
    fi

    rm -f "$stems_file"

    if ((${#orphans[@]} == 0)); then
        log_info "No orphaned contact sheets."
        echo ""
        return
    fi

    log_warn "Found ${#orphans[@]} orphaned contact sheet(s) (no matching video):"
    for orphan in "${orphans[@]}"; do
        echo -e "    ${DIM}${orphan##*/}${NC}"
    done
    echo ""

    printf "  Delete these orphaned contact sheets? [y/N]: "
    read -r answer
    if [[ "$answer" == "y" || "$answer" == "Y" ]]; then
        for orphan in "${orphans[@]}"; do
            rm -f "$orphan"
            log_to_file "DELETE orphan: ${orphan##*/}"
        done
        log_ok "Deleted ${#orphans[@]} orphaned contact sheet(s)."
    else
        log_info "Keeping orphaned contact sheets."
    fi
    echo ""
}

# --- Process a Single Video --------------------------------------------------
process_video() {
    local video="$1"
    local video_index="$2"
    local video_total="$3"

    local name="${video##*/}"
    name="${name%.mp4}"
    local output_file="$CORRECTED_DIR/$name.mp4"
    local prefix="${DIM}[${video_index}/${video_total}]${NC}"

    # Check if already processed
    if [[ -f "$output_file" ]]; then
        log_skip "$prefix ${DIM}$name.mp4${NC} — already exists in $CORRECTED_DIR"
        log_to_file "SKIP $name.mp4 (already exists in corrected)"

        return
    fi

    # Log start of processing
    log_info "$prefix ${BOLD}$name.mp4${NC}"

    # 1. Find pre-generated contact sheet
    local thumbnail_to_use="$CONTACT_SHEET_DIR/$name.jpg"

    if [[ ! -f "$thumbnail_to_use" ]]; then
        log_warn "      ${DIM}├─ ⚠ No contact sheet found in $CONTACT_SHEET_DIR, skipping${NC}"
        log_to_file "WARN $name.mp4 (no contact sheet found)"
        return
    fi

    log_info "      ${DIM}├─ 🖼  Using cover: ${thumbnail_to_use##*/}${NC}"

    local start_time
    start_time=$(date +%s)
    
    # Run ffmpeg
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
    mkdir -p "$THUMBNAIL_DIR"
    
    # Initialize log
    : >> "$LOG_FILE"
    log_to_file "--- session start ---"

    # Check dependencies
    if ! command -v ffmpeg &> /dev/null; then
        log_err "ffmpeg not found. Please install it."
        exit 1
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
    log_info "  ${DIM}└─ Output dir:      ${NC}$CORRECTED_DIR"
    echo ""

    display_mapping "${videos[@]}"
    handle_orphaned_sheets "${videos[@]}"

    # Process only ready videos (filtered by display_mapping)
    local ready_total=${#READY_VIDEOS[@]}

    local start_total=$(date +%s)
    local results_dir
    results_dir=$(mktemp -d)

    log_info "Processing $ready_total videos with $PARALLEL_JOBS parallel jobs..."

    for i in "${!READY_VIDEOS[@]}"; do
        local idx=$((i + 1))

        # Run in background
        (
            if process_video "${READY_VIDEOS[$i]}" "$idx" "$ready_total"; then
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

    # Count results using bash globbing instead of find|wc|xargs
    local processed=0 failed=0
    local done_files=("$results_dir"/done_*)
    [[ -e "${done_files[0]}" ]] && processed=${#done_files[@]}
    local fail_files=("$results_dir"/fail_*)
    [[ -e "${fail_files[0]}" ]] && failed=${#fail_files[@]}
    rm -rf "$results_dir"

    local end_total=$(($(date +%s)))
    local elapsed=$((end_total - start_total))

    # Summary
    echo ""
    echo -e "${BOLD}╔══════════════════════════════════════════╗${NC}"
    echo -e "${BOLD}║   📊 Summary                            ║${NC}"
    echo -e "${BOLD}╚══════════════════════════════════════════╝${NC}"
    echo ""
    log_ok "Videos processed:  ${BOLD}$processed${NC} / $ready_total"
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
