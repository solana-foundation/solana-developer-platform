type FilmKey = "dvp" | "v1";

type Film = {
  key: FilmKey;
  src: string;
  poster: string;
  /** The caption track (WebVTT). */
  captions: string;
  /**
   * The captions are also burned into the picture, so the track stays available in the
   * player's captions menu but is not shown by default (it would print every line twice).
   */
  burnedIn: boolean;
  seconds: number;
};

/** The walkthroughs, in the order the list shows them; the first one is loaded first. */
export const FILMS: readonly Film[] = [
  {
    key: "dvp",
    src: "/homepage/video/dvp-demo.mp4",
    poster: "/homepage/posters/dvp.jpg",
    // The DvP recording has its captions burned in (its recorder metadata says so).
    captions: "/homepage/video/dvp-demo.vtt",
    burnedIn: true,
    seconds: 28,
  },
  {
    key: "v1",
    src: "/homepage/video/v1-changes.mp4",
    poster: "/homepage/posters/v1.jpg",
    captions: "/homepage/video/v1-changes.vtt",
    burnedIn: false,
    seconds: 28,
  },
];

/** A running time as the list prints it: `0:28`, `1:05`. */
export function formatDuration(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}
