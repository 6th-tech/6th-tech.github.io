#!/usr/bin/env bash
set -euo pipefail

# Usage: ./generate.sh /path/to/dir
DIR="${1:-.}"

# Check dependencies
command -v ffmpeg >/dev/null 2>&1 || { echo "ffmpeg not found in PATH"; exit 1; }

echo "Scanning WAV files in: $DIR"
# Find .wav (case-insensitive), handle spaces safely
while IFS= read -r -d '' wav; do
  base="${wav%.*}"                  # strip extension
  flac_out="${base}.flac"
  m4a_out="${base}.m4a"

  # Create FLAC if missing (lossless; higher compression = smaller file, same quality)
  if [[ ! -e "$flac_out" ]]; then
    echo "→ FLAC  : $(basename "$wav") → $(basename "$flac_out")"
    ffmpeg -y -i "$wav" \
      -map_metadata 0 \
      -c:a flac -compression_level 12 \
      "$flac_out"
  else
    echo "✓ FLAC exists: $(basename "$flac_out")"
  fi

  # Create ALAC if missing (lossless Apple Lossless inside .m4a)
  if [[ ! -e "$m4a_out" ]]; then
    echo "→ ALAC  : $(basename "$wav") → $(basename "$m4a_out")"
    ffmpeg -y -i "$wav" \
      -map_metadata 0 \
      -c:a alac \
      "$m4a_out"
  else
    echo "✓ ALAC exists: $(basename "$m4a_out")"
  fi

done < <(find "$DIR" -type f \( -iname '*.wav' \) -print0)

echo "Done."

