if [[ ! -d "./removed" ]]; then
	mkdir removed
fi

for correctedVideo in ./corrected/*.mp4; do
	fileName=${correctedVideo##*/}

	if [[ -f $fileName ]]; then
		mv $fileName ./removed
		echo "Removed $fileName"
	fi
done
