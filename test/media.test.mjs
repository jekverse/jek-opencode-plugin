import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_MEDIA_BYTES,
  formatMediaSize,
  mediaKind,
  mediaMime,
} from "./.build/media.mjs";

test("mediaKind routes images, audio and video only", () => {
  assert.equal(mediaKind("photo.JPG"), "image");
  assert.equal(mediaKind("photo.jpeg"), "image");
  assert.equal(mediaKind("clip.mp4"), "video");
  assert.equal(mediaKind("song.mp3"), "audio");
  assert.equal(mediaKind("README.md"), undefined);
  assert.equal(mediaKind("archive.zip"), undefined);
  assert.equal(mediaKind("Makefile"), undefined);
  assert.equal(mediaKind(".jpg"), undefined);
});

test("mediaMime matches the kind table", () => {
  assert.equal(mediaMime("a.png"), "image/png");
  assert.equal(mediaMime("a.jpg"), "image/jpeg");
  assert.equal(mediaMime("a.m4a"), "audio/mp4");
  assert.equal(mediaMime("a.webm"), "video/webm");
  assert.equal(mediaMime("a.txt"), "application/octet-stream");
});

test("formatMediaSize keeps byte counts readable", () => {
  assert.equal(formatMediaSize(0), "0 B");
  assert.equal(formatMediaSize(512), "512 B");
  assert.equal(formatMediaSize(2 * 1024), "2.0 KB");
  assert.equal(formatMediaSize(5 * 1024 * 1024), "5.0 MB");
  assert.equal(formatMediaSize(1024 * 1024 * 1024), "1.0 GB");
  assert.equal(formatMediaSize(MAX_MEDIA_BYTES), "64 MB");
  assert.equal(formatMediaSize(Number.NaN), "unknown size");
});
