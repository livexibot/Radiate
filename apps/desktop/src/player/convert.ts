// Streams the built-in player can't decode (MKV files, AC-3 or MP2 sound, HEVC or MPEG-2
// pictures) are converted by the bundled ffmpeg through the relay, still on the stream's one
// provider connection. Stage 1 keeps the picture as it is and converts the sound and the
// container; stage 2 converts the picture to H.264 too, which costs more processor time.

export type ConvertStage = 1 | 2;

/** The first conversion to try after the player gave up, from the picture's codec if it's known. */
export function firstStage(codec: string | null, canPlay: (mime: string) => boolean): ConvertStage {
  const c = (codec ?? "").toLowerCase();
  if (!c || c.startsWith("avc") || c.startsWith("h264")) return 1;
  if (c.startsWith("hvc") || c.startsWith("hev") || c.startsWith("h265") || c.startsWith("hevc")) {
    return canPlay('video/mp4; codecs="hvc1.1.6.L120.90"') ? 1 : 2;
  }
  return 2;
}

/** The converted stream's address; `start` seeks a movie or episode. */
export function convertSrc(base: string, stage: ConvertStage, start = 0): string {
  const q = new URLSearchParams({ v: stage === 2 ? "h264" : "copy" });
  if (start > 0) q.set("t", start.toFixed(1));
  return `${base}?${q.toString()}`;
}

/** Where the converter says how long a movie is. */
export function convertInfoUrl(base: string): string {
  return base.replace(/[^/]*$/, "info");
}
