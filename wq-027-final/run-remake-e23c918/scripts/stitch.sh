#!/bin/bash
# Stitch the kit's per-screen shots (<name>-pN.png) into one tall JPG per page and width; single shots are converted.
# Usage: stitch.sh <kit shots dir> <out dir>
set -u
IN=$1; OUT=$2; mkdir -p "$OUT"
names=$(ls "$IN" | sed -E 's/(-p[0-9]+)?\.png$//' | sort -u)
for n in $names; do
  if [ -f "$IN/$n.png" ]; then
    timeout 60 ffmpeg -loglevel error -y -i "$IN/$n.png" -q:v 3 "$OUT/$n.jpg"
  else
    k=$(ls "$IN" | grep -cE "^$n-p[0-9]+\.png$")
    args=(); for i in $(seq 1 "$k"); do args+=(-i "$IN/$n-p$i.png"); done
    if [ "$k" -eq 1 ]; then timeout 60 ffmpeg -loglevel error -y "${args[@]}" -q:v 3 "$OUT/$n.jpg"
    else timeout 120 ffmpeg -loglevel error -y "${args[@]}" -filter_complex "vstack=inputs=$k" -q:v 3 "$OUT/$n.jpg"; fi
  fi
  echo "$n $?"
done
