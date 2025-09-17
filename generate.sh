#!/usr/bin/env bash
set -euo pipefail

# Usage:
#   ./generate.sh [-v] /path/to/dir
#   ./generate.sh /path/with~tilde
VERBOSE=0
if [[ "${1:-}" == "-v" ]]; then
  VERBOSE=1
  shift
fi

DIR_RAW="${1:-.}"

# Expand ~ and variables, then cd (portable, no GNU realpath needed)
DIR_EXPANDED="$(eval echo "$DIR_RAW")"
cd -P -- "$DIR_EXPANDED" || { echo "Directory not found: $DIR_EXPANDED"; exit 1; }

command -v ffmpeg >/dev/null 2>&1 || { echo "ffmpeg not found in PATH"; exit 1; }

(( VERBOSE )) && echo "Working directory: $PWD"

# Collect files first so we can show a friendly message if none
mapfile -d '' -t WAVS < <(find . -type f \( -iname '*.wav' -o -iname '*.wave' \) -print0)

if (( ${#WAVS[@]} == 0 )); then
  echo "No WAV files found in: $PWD"
  exit 0
fi

for wav_raw in "${WAVS[@]}"; do
  # Strip any stray trailing CR (\r) that sometimes sneaks in from copies
  wav="${wav_raw%$'\r'}"
  base="${wav%.*}"
  flac_out="${base}.flac"
  m4a_out="${base}.m4a"

  (( VERBOSE )) && echo "Processing: ${wav#./}"

  if [[ ! -e "$flac_out" ]]; then
    echo "→ FLAC : ${wav#./}"
    (( VERBOSE )) && echo "ffmpeg -y -i \"$wav\" -map_metadata 0 -c:a flac -compression_level 12 \"$flac_out\""
    ffmpeg -y -i "$wav" -map_metadata 0 -c:a flac -compression_level 12 "$flac_out"
  else
    echo "✓ FLAC exists: ${flac_out#./}"
  fi

  if [[ ! -e "$m4a_out" ]]; then
    echo "→ ALAC : ${wav#./}"
    (( VERBOSE )) && echo "ffmpeg -y -i \"$wav\" -map_metadata 0 -c:a alac \"$m4a_out\""
    ffmpeg -y -i "$wav" -map_metadata 0 -c:a alac "$m4a_out"
  else
    echo "✓ ALAC exists: ${m4a_out#./}"
  fi
done