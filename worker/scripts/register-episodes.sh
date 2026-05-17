#!/bin/bash
# Register local video episodes on the VPS without uploading them.
# Run this directly on the Mac (not via SSH) so it can access external drives.
#
# Usage:
#   ./register-episodes.sh [/path/to/episodes/dir]
#
# What it does:
#   1. Finds .mov/.mp4 files in the episodes directory
#   2. Calls VPS API to create a source entry (returns canonical storage_path like /data/sources/42/master.mov)
#   3. Creates a symlink at ~/clips-data/sources/42/master.mov → actual file
#   4. Mac worker picks it up, resolves the symlink, transcribes with large-v3 Whisper

set -euo pipefail

VPS_URL="${VPS_CLIPS_URL:-http://100.127.244.92:3002}"
LOCAL_DATA_DIR="${LOCAL_DATA_DIR:-$HOME/clips-data}"
WORKER_SECRET="${WORKER_SECRET:-bf16bb1c0bc1e3219ab52412bb69188220106744f6f09f2ab36e61f30202bd7e}"
EPISODES_DIR="${1:-/Volumes/Nice Studio Server/Davinci Resolve Media/Projects/Butternomics Content Engine/Full Episodes}"

if [ ! -d "$EPISODES_DIR" ]; then
  echo "Error: Episodes directory not found: $EPISODES_DIR"
  echo "Usage: $0 [/path/to/episodes/dir]"
  exit 1
fi

echo "Scanning: $EPISODES_DIR"
echo "VPS: $VPS_URL"
echo "Local data: $LOCAL_DATA_DIR"
echo ""

registered=0
skipped=0

while IFS= read -r -d $'\0' filepath; do
  filename=$(basename "$filepath")

  # Check if already registered (match by filename)
  existing=$(curl -s "$VPS_URL/api/sources" | python3 -c "
import sys, json
sources = json.load(sys.stdin)
for s in sources:
    if s.get('filename') == '$(echo "$filename" | sed "s/'/'\\''/g")':
        print(s['id'])
        break
" 2>/dev/null)

  if [ -n "$existing" ]; then
    echo "  SKIP  [$existing] $filename (already registered)"
    ((skipped++)) || true
    continue
  fi

  # Register with VPS — get canonical path back
  response=$(curl -s -X POST "$VPS_URL/api/sources/register-prelinked" \
    -H "Content-Type: application/json" \
    -d "{\"filename\": $(python3 -c "import json,sys; print(json.dumps(sys.argv[1]))" "$filename")}")

  source_id=$(echo "$response" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['source_id'])" 2>/dev/null)
  canonical_path=$(echo "$response" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['canonical_path'])" 2>/dev/null)

  if [ -z "$source_id" ] || [ -z "$canonical_path" ]; then
    echo "  ERROR $filename: $response"
    continue
  fi

  # Derive local path from canonical path (/data/... → ~/clips-data/...)
  local_path="$LOCAL_DATA_DIR${canonical_path#/data}"

  # Create directory and symlink BEFORE triggering transcription
  mkdir -p "$(dirname "$local_path")"
  ln -sf "$filepath" "$local_path"

  # Queue transcription now that the symlink is in place
  curl -s -X POST "$VPS_URL/api/sources/$source_id/transcribe" > /dev/null

  echo "  OK    [$source_id] $filename → $local_path"
  ((registered++)) || true

done < <(find "$EPISODES_DIR" -maxdepth 2 \( -name "*.mov" -o -name "*.mp4" -o -name "*.MOV" -o -name "*.MP4" -o -name "*.MXF" -o -name "*.mxf" \) -print0 2>/dev/null | sort -z)

echo ""
echo "Done: $registered registered, $skipped skipped."
echo "The Mac worker will begin transcribing new sources automatically."
