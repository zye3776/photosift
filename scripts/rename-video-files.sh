for video in ./*.mp4; do
	newFileName=`openssl rand -hex 12`
	mv $video "$newFileName.mp4"
done