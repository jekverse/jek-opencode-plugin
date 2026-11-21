// Media preview routing for the window half. Plain string checks only: the
// browser bundle has no node:path.
import { extension } from "./links";

export type MediaKind = "image" | "audio" | "video";

/**
 * A preview keeps the whole file in memory as a Blob URL, so this is the size
 * the panel will hold. Bigger files are refused with an explanation instead of
 * freezing the window.
 */
export const MAX_MEDIA_BYTES = 64 * 1024 * 1024;

// One table so the kind and the MIME type can never disagree. The list is
// limited to what the window's <img>, <audio> and <video> can actually show;
// archives and documents stay on the "not a text file" path.
const MEDIA_TYPES: Readonly<Record<string, readonly [MediaKind, string]>> = {
  // Images
  apng: ["image", "image/apng"],
  avif: ["image", "image/avif"],
  bmp: ["image", "image/bmp"],
  cur: ["image", "image/x-icon"],
  gif: ["image", "image/gif"],
  heic: ["image", "image/heic"],
  heif: ["image", "image/heif"],
  ico: ["image", "image/x-icon"],
  jfif: ["image", "image/jpeg"],
  jpe: ["image", "image/jpeg"],
  jpeg: ["image", "image/jpeg"],
  jpg: ["image", "image/jpeg"],
  png: ["image", "image/png"],
  svg: ["image", "image/svg+xml"],
  tif: ["image", "image/tiff"],
  tiff: ["image", "image/tiff"],
  webp: ["image", "image/webp"],
  // Audio
  aac: ["audio", "audio/aac"],
  aif: ["audio", "audio/aiff"],
  aiff: ["audio", "audio/aiff"],
  amr: ["audio", "audio/amr"],
  flac: ["audio", "audio/flac"],
  m4a: ["audio", "audio/mp4"],
  mp3: ["audio", "audio/mpeg"],
  oga: ["audio", "audio/ogg"],
  ogg: ["audio", "audio/ogg"],
  opus: ["audio", "audio/ogg"],
  wav: ["audio", "audio/wav"],
  wave: ["audio", "audio/wav"],
  wma: ["audio", "audio/x-ms-wma"],
  // Video
  "3g2": ["video", "video/3gpp2"],
  "3gp": ["video", "video/3gpp"],
  avi: ["video", "video/x-msvideo"],
  flv: ["video", "video/x-flv"],
  m2ts: ["video", "video/mp2t"],
  m4v: ["video", "video/mp4"],
  mkv: ["video", "video/x-matroska"],
  mov: ["video", "video/quicktime"],
  mp4: ["video", "video/mp4"],
  mpe: ["video", "video/mpeg"],
  mpeg: ["video", "video/mpeg"],
  mpg: ["video", "video/mpeg"],
  mts: ["video", "video/mp2t"],
  ogv: ["video", "video/ogg"],
  vob: ["video", "video/dvd"],
  webm: ["video", "video/webm"],
  wmv: ["video", "video/x-ms-wmv"],
};

/** What preview a path can use, or undefined for text and other binaries. */
export function mediaKind(path: string): MediaKind | undefined {
  return MEDIA_TYPES[extension(path)]?.[0];
}

/** The MIME type to give the Blob that backs a preview. */
export function mediaMime(path: string) {
  return MEDIA_TYPES[extension(path)]?.[1] ?? "application/octet-stream";
}

/** A file size a status line can read at a glance. */
export function formatMediaSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes < 0) return "unknown size";
  if (bytes < 1024) return `${Math.round(bytes)} B`;

  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = value < 10 ? value.toFixed(1) : Math.round(value).toString();
  return `${rounded} ${units[unit]}`;
}
