# brew install imagemagick

for video in ./*.mp4; do
    nameWithPath=${video%.mp4};
    name=${nameWithPath: 2};
    count=`ls ./thumbnails/$name-[0-9][0-9].??? | wc -l | xargs`

    thumbnailName="./thumbnails/$name-000.jpg"

    if [ -f $thumbnailName ]; then
        echo "Skip exit: $thumbnailName"
        continue
    fi

    case $count in
        '6' | '5' | '4')
            echo "create $video count $count"
            montage -background none -geometry +0+0 -resize 200x200 -crop 160x200+20+0 -tile 2x ./thumbnails/$name-[0-9][0-9].??? $thumbnailName
            ;;
        '3' | '2')
            echo "create $video count $count"
            montage -background none -geometry +0+0 -tile 1x ./thumbnails/$name-[0-9][0-9].??? $thumbnailName
            ;;
        *)
            echo "$count - Skip default - $video "
            continue
            ;;
    esac
done
