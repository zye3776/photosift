#/bin/bash

set -eE -o functrace

# https://superuser.com/questions/597945/set-mp4-thumbnail

sh ./contact-sheet.sh

if [[ ! -d "./corrected" ]]; then
	mkdir corrected
fi

if [[ ! -d "./backup" ]]; then
	mkdir backup
fi

numberOfVideo=$1
numberOfVideo=$(( numberOfVideo == 0 ? 1000 : numberOfVideo))
echo "numberOfVideo $numberOfVideo"

count=0


echo "numberOfVideo: $numberOfVideo"

for video in ./*.mp4; do
	nameWithPath=${video%.mp4};
	name=${nameWithPath: 2};
	outputFilePathAndName="./corrected/$name.mp4"

	if [[ -f $outputFilePathAndName ]]; then
		echo "Skip $outputFilePathAndName"
		mv -v "$name.mp4" backup
		continue
	fi

	thumbnailToUse=`ls ./thumbnails/$name-[0-9][0-9]*.??? | sort -V | head -n 1`
	echo "Thumnail to use: $thumbnailToUse"

	if [[ ! -f $thumbnailToUse ]]; then
		echo "Missing thumbnails for $name"
		continue;
	fi


	if [[ $numberOfVideo = $count ]]; then
		echo "numberOfVideo = count $numberOfVideo"
		break;
	else
		count=$((count + 1))
		ffmpeg -y -i "$name.mp4" -i $thumbnailToUse -vcodec libx265 -map 0 -map 1 -c copy -c:v:1 png -disposition:v:1 attached_pic $outputFilePathAndName
		# ffmpeg -y -i "$name.mp4" -i $thumbnailToUse -map 0 -map 1 -c copy -c:v:1 png -disposition:v:1 attached_pic $outputFilePathAndName
		rm -f $thumbnailToUse
		mv -v "$name.mp4" backup
	fi
done
