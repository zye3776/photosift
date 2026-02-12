#!/bin/bash

# Loop through all files with the .ts extension
for file in ./*.ts; do
    # Extract the file name without the extension
    fileName=$(basename "$file" .ts)
    # Run ffmpeg command to convert the TS file to MP4
    ffmpeg -i "$file" "${fileName}.mp4"
done
