#!/usr/bin/env bash
set -euo pipefail

# Usage:
#   ./generate.sh [-v] [-f] /path/to/dir
#   ./generate.sh /path/with~tilde
#   -v  verbose
#   -f  re-encode even when the FLAC/ALAC already exists (after re-rendering a WAV)
#
# Backgrounds for the app's audio modes (<name>.bg.wav from regen-sessions.js --stems)
# become Ogg Vorbis only (quality 6, ~160-190 kbps), with the sibling <name>.tones.json
# embedded as the SIXTH_TONES Vorbis comment. The app synthesises the tones from it, so
# the background no longer needs a lossless format.
VERBOSE=0
FORCE=0
while [[ "${1:-}" == -* ]]; do
  case "$1" in
    -v) VERBOSE=1 ;;
    -f) FORCE=1 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
  shift
done

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

  if [[ "$base" == *.bg ]]; then
    recipe="${base%.bg}.tones.json"
    [[ -f "$recipe" ]] || { echo "✗ Missing ${recipe#./} for ${wav#./}"; exit 1; }
    ogg_out="${base}.ogg"
    if (( FORCE )) || [[ ! -e "$ogg_out" ]]; then
      echo "→ Ogg Vorbis + recipe : ${wav#./}"
      ffmpeg -y -loglevel error -i "$wav" -map_metadata -1 -metadata SIXTH_TONES="$(tr -d '\n' < "$recipe")" -c:a libvorbis -q:a 6 "$ogg_out"
    else
      echo "✓ Ogg exists: ${ogg_out#./}"
    fi
    continue
  fi

  if (( FORCE )) || [[ ! -e "$flac_out" ]]; then
    echo "→ FLAC : ${wav#./}"
    (( VERBOSE )) && echo "ffmpeg -y -i \"$wav\" -map_metadata 0 -c:a flac -compression_level 12 \"$flac_out\""
    ffmpeg -y -i "$wav" -map_metadata 0 -c:a flac -compression_level 12 "$flac_out"
  else
    echo "✓ FLAC exists: ${flac_out#./}"
  fi

  if (( FORCE )) || [[ ! -e "$m4a_out" ]]; then
    echo "→ ALAC : ${wav#./}"
    (( VERBOSE )) && echo "ffmpeg -y -i \"$wav\" -map_metadata 0 -c:a alac \"$m4a_out\""
    ffmpeg -y -i "$wav" -map_metadata 0 -c:a alac "$m4a_out"
  else
    echo "✓ ALAC exists: ${m4a_out#./}"
  fi
done