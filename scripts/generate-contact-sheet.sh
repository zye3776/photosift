#!/usr/bin/env bash
# ============================================================================
# generate-contact-sheet.sh — Generates collages from selected thumbnails
# Scans ./thumbnails, identifies groups per video, and creates contact sheets.
# Stores results in ./thumbnails/contact-sheets.
#
# Usage:
#   ./generate-contact-sheet.sh
# ============================================================================

set -euo pipefail

# --- Configuration -----------------------------------------------------------
THUMBNAIL_DIR="./thumbnails"
CONTACT_SHEET_DIR="./thumbnails/contact-sheets"
LOG_FILE="./generate-contact-sheet.log"
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

# --- Generate Contact Sheet --------------------------------------------------
process_group() {
    local name="$1"
    local contact_sheet="$CONTACT_SHEET_DIR/$name.jpg"
    local prefix="$2"
    
    # Use bash glob to find thumbnails (supports 2 or 3 digits)
    local thumbs=("$THUMBNAIL_DIR/$name"-[0-9]*.???)
    if [[ ! -e "${thumbs[0]}" ]]; then
        return 0
    fi
    local count=${#thumbs[@]}
    if (( count > 6 )); then
        log_skip "$prefix ${DIM}$name${NC} — ignored ($count thumbnails)"
        return 0
    fi

    # Skip if contact sheet already exists
    if [[ -f "$contact_sheet" ]]; then
        log_skip "$prefix ${DIM}$name${NC} — contact sheet already exists"
        return 0
    fi

    # Determine command (ImageMagick v7 uses 'magick montage')
    local cmd="montage"
    local has_im=true
    if ! command -v montage &> /dev/null; then
        if command -v magick &> /dev/null; then
            cmd="magick montage"
        else
            has_im=false
        fi
    fi

    log_info "$prefix ${BOLD}$name${NC}"

    case $count in
        1)
            log_info "      ${DIM}├─ 🖼  Single frame kept, copying...${NC}"
            cp "${thumbs[0]}" "$contact_sheet"
            ;;
        '6' | '5' | '4')
            if [ "$has_im" = true ]; then
                log_info "      ${DIM}├─ 🎨 Generating grid collage ($count tiles)...${NC}"
                $cmd -background none -define jpeg:size=400x400 -geometry +0+0 -resize 200x200 -crop 160x200+20+0 -tile 2x "${thumbs[@]}" -strip "$contact_sheet" || log_err "      ${DIM}├─ ✗ Collage generation failed${NC}"
            else
                log_warn "      ${DIM}├─ ⚠ Skip grid: ImageMagick missing${NC}"
            fi
            ;;
        '3' | '2')
            if [ "$has_im" = true ]; then
                log_info "      ${DIM}├─ 🎨 Generating vertical stack ($count tiles)...${NC}"
                $cmd -background none -define jpeg:size=400x400 -geometry +0+0 -tile 1x "${thumbs[@]}" -strip "$contact_sheet" || log_err "      ${DIM}├─ ✗ Stack generation failed${NC}"
            else
                # Fallback to ffmpeg for vertical stacking (very fast)
                log_info "      ${DIM}├─ ⚡ Generating stack ($count tiles) via FFmpeg...${NC}"
                local inputs=""
                for t in "${thumbs[@]}"; do inputs="$inputs -i $t"; done
                ffmpeg -y -hide_banner -loglevel error $inputs -filter_complex "vstack=inputs=$count" "$contact_sheet" || log_err "      ${DIM}├─ ✗ FFmpeg stack failed${NC}"
            fi
            ;;
        *)
            log_warn "      ${DIM}├─ ⚠ Unexpected thumbnail count: $count${NC}"
            ;;
    esac
    
    if [[ -f "$contact_sheet" ]]; then
        log_ok "      ${DIM}└─ ✓ Success${NC}"
        log_to_file "OK $name ($count tiles)"
    fi
}

# --- Main --------------------------------------------------------------------
main() {
    echo ""
    echo -e "${BOLD}╔══════════════════════════════════════════╗${NC}"
    echo -e "${BOLD}║   🎨 Generate Contact Sheets              ║${NC}"
    echo -e "${BOLD}╚══════════════════════════════════════════╝${NC}"
    echo ""

    # Ensure directories exist
    mkdir -p "$CONTACT_SHEET_DIR"
    
    # Initialize log
    : >> "$LOG_FILE"
    log_to_file "--- session start ---"

    # Check dependencies
    if ! command -v ffmpeg &> /dev/null; then
        log_err "ffmpeg not found. Please install it."
        exit 1
    fi

    # Identify unique video names from thumbnails
    # Pattern: name-[0-9]*.jpg
    log_info "Scanning thumbnails..."
    local names=()
    while IFS= read -r f; do
        # Extract name by removing the suffix -[0-9]*.jpg
        local n
        n=$(echo "$f" | sed -E 's/-[0-9]+\.[a-zA-Z0-9]+$//')
        names+=("$n")
    done < <(find "$THUMBNAIL_DIR" -maxdepth 1 -name "*-[0-9]*.*" -not -name "._*" -exec basename {} \; | sort -u)

    local total=${#names[@]}

    if ((total == 0)); then
        log_warn "No grouped thumbnails found in $THUMBNAIL_DIR"
        exit 0
    fi

    log_info "Found $total video groups. Processing with $PARALLEL_JOBS jobs..."
    echo ""

    local results_dir
    results_dir=$(mktemp -d)

    for i in "${!names[@]}"; do
        local idx=$((i + 1))
        local prefix="${DIM}[${idx}/${total}]${NC}"
        
        # Run in background
        (
            process_group "${names[$i]}" "$prefix"
        ) &
        
        # Batch control
        if (( (i + 1) % PARALLEL_JOBS == 0 )); then
            wait
        fi
    done
    wait

    rm -rf "$results_dir"

    log_ok "Processing complete. Contact sheets saved in $CONTACT_SHEET_DIR"
    log_to_file "=== COMPLETE: $total groups ==="
}

main
