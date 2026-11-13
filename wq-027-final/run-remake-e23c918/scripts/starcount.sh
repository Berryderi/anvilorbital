#!/bin/bash
# Count star pixels per frame in a text-free crop: gray value at or above THR (default 60 of 255).
# Usage: starcount.sh <frames dir> <times file> <crop w:h:x:y> [THR]
D=$1; T=$2; C=$3; THR=${4:-60}
while read -r f t; do
  n=$(timeout 20 ffmpeg -loglevel error -i "$D/$f" -vf "crop=$C,format=gray" -f rawvideo - | od -An -v -tu1 -w1 | awk -v th="$THR" '$1>=th{n++} END{print n+0}')
  echo "$f $t $n"
done < "$T"
