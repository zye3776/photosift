/* PhotoSift — Clip Sequence Player
   Plays a video's short preview clips one after another, looping the whole
   sequence forever. The tricky part is the hand-off between clips: a single
   <video> element goes black for a moment whenever you change its `src`, because
   the browser throws away the current picture and has to load + decode the new
   clip from scratch. With 1-second clips that black flash shows up on every
   single change.

   To avoid it we keep TWO stacked <video> elements ("double buffering"): one is
   visible and playing, the other is hidden and quietly pre-loading the NEXT clip
   in the background. The moment the visible clip ends we simply reveal the hidden
   one — its first frame is already decoded, so there is no black gap — then start
   pre-loading the following clip into the element we just hid. The two elements
   trade roles back and forth for the life of the tile. */

// Build the URL that streams one preview clip from the backend. The backend
// serves it as video/mp4 with HTTP Range support so seeking/looping is smooth.
function clipUrl(clipPath) {
  return `/api/clip?file=${encodeURIComponent(clipPath)}`;
}

export class ClipSequencePlayer {
  constructor(clips) {
    this.clips = clips;
    this.index = 0; // which clip the visible element is currently showing
    this.shouldPlay = false; // set by the on-screen/off-screen observer

    // The container both <video> elements live inside. Tiles append this.
    this.root = document.createElement('div');
    this.root.className = 'clip-player';

    this.a = this.#makeVideo();
    this.b = this.#makeVideo();
    this.root.append(this.a, this.b);

    // `active` is the visible, playing element; `standby` is hidden and
    // pre-loading the next clip. They swap on every clip change.
    this.active = this.a;
    this.standby = this.b;

    this.active.classList.add('is-active');
    this.active.src = clipUrl(clips[this.index]);

    if (clips.length === 1) {
      // Only one clip: let the browser loop it seamlessly — no hand-off, no
      // black frame, and the second element stays unused.
      this.active.loop = true;
    } else {
      // Pre-load the next clip into the standby element right away.
      this.#preloadNext();
    }
  }

  #makeVideo() {
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.preload = 'auto'; // buffer eagerly so the first frame is ready before we show it
    v.loop = false; // we loop the whole sequence ourselves, not one clip
    // Both elements share one ended handler; it ignores events from whichever
    // element is currently hidden (standby), so only the visible clip advances.
    v.addEventListener('ended', () => this.#onEnded(v));
    return v;
  }

  // The clip the standby element should be holding ready.
  get #nextIndex() {
    return (this.index + 1) % this.clips.length;
  }

  // Point the hidden standby element at the next clip and start buffering it.
  #preloadNext() {
    this.standby.src = clipUrl(this.clips[this.#nextIndex]);
    this.standby.load();
  }

  #onEnded(el) {
    // A clip just finished. Ignore the event unless it came from the element
    // that's actually on screen (the standby fires no `ended`, but guard anyway).
    if (el !== this.active) return;

    const finished = this.active;
    const upcoming = this.standby; // already buffered the next clip

    // Reveal the pre-loaded clip and hide the one that just ended — instant, no
    // reload, so no black frame even when the sequence wraps to the start.
    upcoming.classList.add('is-active');
    finished.classList.remove('is-active');
    finished.pause();

    this.index = this.#nextIndex;
    this.active = upcoming;
    this.standby = finished;

    if (this.shouldPlay) this.active.play().catch(() => {});

    // Now quietly pre-load the clip AFTER this one into the freed-up element.
    this.#preloadNext();
  }

  // Called by the playback observer when the tile scrolls into view.
  play() {
    this.shouldPlay = true;
    this.active.play().catch(() => {});
  }

  // Called when the tile scrolls out of view.
  pause() {
    this.shouldPlay = false;
    this.active.pause();
    this.standby.pause();
  }
}
