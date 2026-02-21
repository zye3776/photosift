#!/usr/bin/env bash
# ============================================================================
# set-thumbnail.sh — Embeds thumbnails into MP4 video files
# Sets the cover art (thumbnail) for MP4 files using AtomicParsley.
# Modifies metadata in-place (only the covr atom), no re-muxing.
# Displays a mapping of videos to contact sheets before processing,
# and offers to clean up orphaned contact sheets.
#
# Usage:
#   ./set-thumbnail.sh                 # Process up to 1000 videos
#   ./set-thumbnail.sh --video-max 50  # Process only 50 videos
#   ./set-thumbnail.sh --yes           # Skip all confirmation prompts
#   ./set-thumbnail.sh -y              # Short form of --yes
# ============================================================================

set -euo pipefail

# --- Configuration -----------------------------------------------------------
THUMBNAIL_DIR="./thumbnails"
CONTACT_SHEET_DIR="./thumbnails/contact-sheets"
CORRECTED_DIR="./corrected"
LOG_FILE="./set-thumbnail.log"
VIDEO_MAX=1000              # Default limit from original script (0 = all)
AUTO_YES=false              # Skip confirmation prompts

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
# Scans contact sheets and classifies each by video state.
# Populates global READY_VIDEOS (video paths) and ORPHAN_SHEETS (sheet paths).
READY_VIDEOS=()
ORPHAN_SHEETS=()

display_mapping() {
    READY_VIDEOS=()
    ORPHAN_SHEETS=()
    local ready=0 done=0 orphan=0

    # Scan contact sheets
    local sheets=()
    while IFS= read -r -d '' sheet; do
        sheets+=("$sheet")
    done < <(find "$CONTACT_SHEET_DIR" -maxdepth 1 -name "*.jpg" -not -name "._*" -print0 2>/dev/null | sort -z)

    if ((${#sheets[@]} == 0)); then
        log_warn "No contact sheets found in $CONTACT_SHEET_DIR"
        exit 0
    fi

    log_info "Found ${BOLD}${#sheets[@]}${NC} contact sheets"
    echo ""
    echo -e "${BOLD}  CONTACT SHEET                      VIDEO${NC}"
    echo -e "  ${DIM}──────────────────────────────────  ────────────${NC}"

    for sheet in "${sheets[@]}"; do
        local stem="${sheet##*/}"
        stem="${stem%.jpg}"

        local display_name="$stem"
        if ((${#display_name} > 34)); then
            display_name="${display_name:0:31}..."
        fi

        if [[ -f "./$stem.mp4" ]]; then
            # Video in current dir — ready to process
            printf "  %-34s  ${GREEN}ready${NC}\n" "$display_name"
            ((ready++)) || true
            READY_VIDEOS+=("./$stem.mp4")
        else
            # Search subdirectories for the video
            local found_dir=""
            for dir in ./*/; do
                [[ -d "$dir" ]] || continue
                if [[ -f "$dir$stem.mp4" ]]; then
                    found_dir="${dir%/}"
                    found_dir="${found_dir##*/}"
                    break
                fi
            done

            if [[ -n "$found_dir" ]]; then
                printf "  ${DIM}%-34s  done (%s)${NC}\n" "$display_name" "$found_dir"
                ((done++)) || true
            else
                printf "  %-34s  ${YELLOW}no video${NC}\n" "$display_name"
                ((orphan++)) || true
                ORPHAN_SHEETS+=("$sheet")
            fi
        fi
    done

    echo ""
    echo -e "  ${GREEN}ready${NC}: $ready    ${DIM}done${NC}: $done    ${YELLOW}no video${NC}: $orphan"
    echo ""

    if ((ready == 0)); then
        log_warn "No videos ready to process."
        exit 0
    fi

    if [[ "$AUTO_YES" == true ]]; then
        log_info "Proceeding with $ready videos (--yes)"
    else
        printf "  Proceed with %d videos? [y/N]: " "$ready"
        read -r -n 1 answer < /dev/tty
        echo
        if [[ "$answer" != "y" && "$answer" != "Y" ]]; then
            log_info "Aborted by user."
            exit 0
        fi
    fi
    echo ""
}

# --- Handle Orphaned Contact Sheets -----------------------------------------
# Uses ORPHAN_SHEETS global populated by display_mapping.
handle_orphaned_sheets() {
    if ((${#ORPHAN_SHEETS[@]} == 0)); then
        return
    fi

    if [[ "$AUTO_YES" == true ]]; then
        local answer="y"
    else
        printf "  Delete %d orphaned contact sheet(s)? [y/N]: " "${#ORPHAN_SHEETS[@]}"
        read -r -n 1 answer < /dev/tty
        echo
    fi
    if [[ "$answer" == "y" || "$answer" == "Y" ]]; then
        for orphan in "${ORPHAN_SHEETS[@]}"; do
            rm -f "$orphan"
            log_to_file "DELETE orphan: ${orphan##*/}"
        done
        log_ok "Deleted ${#ORPHAN_SHEETS[@]} orphaned contact sheet(s)."
    else
        log_info "Keeping orphaned contact sheets."
    fi
    echo ""
}

# --- Process a Single Video --------------------------------------------------
PROCESSED_VIDEOS=()

process_video() {
    local video="$1"
    local video_index="$2"
    local video_total="$3"

    local name="${video##*/}"
    name="${name%.mp4}"
    local prefix="${DIM}[${video_index}/${video_total}]${NC}"

    # Check if already processed
    if [[ -f "$CORRECTED_DIR/$name.mp4" ]]; then
        log_skip "$prefix ${DIM}$name.mp4${NC} — already in $CORRECTED_DIR"
        log_to_file "SKIP $name.mp4 (already in corrected)"
        return
    fi

    # Log start of processing
    log_info "$prefix ${BOLD}$name.mp4${NC}"

    # Find pre-generated contact sheet
    local thumbnail_to_use="$CONTACT_SHEET_DIR/$name.jpg"

    if [[ ! -f "$thumbnail_to_use" ]]; then
        log_warn "      ${DIM}├─ ⚠ No contact sheet found in $CONTACT_SHEET_DIR, skipping${NC}"
        log_to_file "WARN $name.mp4 (no contact sheet found)"
        return
    fi

    log_info "      ${DIM}├─ 🖼  Using cover: ${thumbnail_to_use##*/}${NC}"

    local start_time
    start_time=$(date +%s)

    # Run AtomicParsley to embed artwork in-place
    local error_log
    error_log=$(mktemp)

    if ! AtomicParsley "$video" --artwork "$thumbnail_to_use" --overWrite 2>"$error_log"; then
        log_err "$prefix ${RED}Failed to set thumbnail for $name.mp4${NC}"
        cat "$error_log" >&2
        log_to_file "ERROR $name.mp4 (AtomicParsley failed)"
        rm -f "$error_log"
        return 1
    fi
    rm -f "$error_log"

    local end_time duration
    end_time=$(date +%s)
    duration=$((end_time - start_time))

    local filesize
    filesize=$(stat -f%z "$video" 2>/dev/null || stat -c%s "$video" 2>/dev/null || echo "0")

    # Move video to corrected folder
    mkdir -p "$CORRECTED_DIR"
    mv "$video" "$CORRECTED_DIR/$name.mp4"

    # Delete the contact sheet
    rm -f "$thumbnail_to_use"

    log_ok "      ${DIM}├─ ${GREEN}Success${NC}${DIM} in ${duration}s → $(format_bytes "$filesize")${NC}"
    log_ok "      ${DIM}└─ Moved to $CORRECTED_DIR/, deleted ${thumbnail_to_use##*/}${NC}"
    log_to_file "OK $name.mp4 in ${duration}s → $CORRECTED_DIR/, removed contact sheet"

    PROCESSED_VIDEOS+=("$video")
}


# --- Main --------------------------------------------------------------------
main() {
    echo ""
    echo -e "${BOLD}╔══════════════════════════════════════════╗${NC}"
    echo -e "${BOLD}║   🖼  Set Video Thumbnail                 ║${NC}"
    echo -e "${BOLD}╚══════════════════════════════════════════╝${NC}"
    echo ""

    # Ensure directories exist
    mkdir -p "$THUMBNAIL_DIR"

    # Initialize log
    : >> "$LOG_FILE"
    log_to_file "--- session start ---"

    # Check dependencies — auto-install AtomicParsley via Homebrew
    if ! command -v AtomicParsley &> /dev/null; then
        log_warn "AtomicParsley not found. Installing via Homebrew..."
        if ! command -v brew &> /dev/null; then
            log_err "Homebrew not found. Install AtomicParsley manually."
            exit 1
        fi
        if ! brew install atomicparsley; then
            log_err "Failed to install AtomicParsley."
            exit 1
        fi
        log_ok "AtomicParsley installed."
    fi

    echo ""
    log_info "Configuration"
    log_info "  ${DIM}├─ Sheets dir:      ${NC}$CONTACT_SHEET_DIR"
    log_info "  ${DIM}└─ Corrected dir:   ${NC}$CORRECTED_DIR"
    echo ""

    display_mapping
    handle_orphaned_sheets

    # Apply limit to ready videos
    local ready_total=${#READY_VIDEOS[@]}
    if ((VIDEO_MAX > 0 && VIDEO_MAX < ready_total)); then
        READY_VIDEOS=("${READY_VIDEOS[@]:0:$VIDEO_MAX}")
        ready_total=$VIDEO_MAX
        log_info "Limited to $ready_total videos (--video-max $VIDEO_MAX)"
    fi

    local start_total=$(date +%s)
    local processed=0 failed=0

    log_info "Processing $ready_total videos..."

    for i in "${!READY_VIDEOS[@]}"; do
        local idx=$((i + 1))
        if process_video "${READY_VIDEOS[$i]}" "$idx" "$ready_total"; then
            ((processed++)) || true
        else
            ((failed++)) || true
        fi
    done

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
    log_ok "Moved to corrected: ${BOLD}${#PROCESSED_VIDEOS[@]}${NC} video(s)"
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
        -y|--yes)
            AUTO_YES=true
            shift
            ;;
        *)
            log_err "Unknown option: $1"
            echo "Usage: $(basename "$0") [limit] [--video-max N] [-y|--yes]"
            exit 1
            ;;
    esac
done

main
