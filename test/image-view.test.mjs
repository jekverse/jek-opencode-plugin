import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_ZOOM,
  MIN_ZOOM,
  canDrag,
  clampZoom,
  imageScale,
  isMoved,
  panBy,
  resetImageView,
  wheelZoomFactor,
  zoomAt,
  zoomLabel,
} from "./.build/image-view.mjs";

test("reset starts at 100% with no offset", () => {
  assert.deepEqual(resetImageView(), { zoom: 1, x: 0, y: 0 });
  assert.equal(isMoved(resetImageView()), false);
});

test("zoom scales the original image using the fitted size as its baseline", () => {
  const source = { width: 1200, height: 1600 };
  const stage = { width: 600, height: 400 };
  assert.equal(imageScale(source, stage, 1), 0.25);
  assert.equal(imageScale(source, stage, 4), 1);
  assert.equal(imageScale(source, stage, 8), 2);
  assert.equal(imageScale({ width: 100, height: 100 }, stage, 1), 1);
});

test("zoomAt keeps the point under the cursor fixed", () => {
  const view = { zoom: 1, x: 0, y: 0 };
  const point = { x: 120, y: -40 };
  const next = zoomAt(view, point, 2);

  assert.equal(next.zoom, 2);
  // The same local pixel must still land on the same screen point.
  const local = {
    x: (point.x - view.x) / view.zoom,
    y: (point.y - view.y) / view.zoom,
  };
  assert.ok(Math.abs(next.x + next.zoom * local.x - point.x) < 1e-9);
  assert.ok(Math.abs(next.y + next.zoom * local.y - point.y) < 1e-9);
});

test("zoomAt accumulates on an already panned view", () => {
  const view = { zoom: 2, x: 30, y: -12 };
  const point = { x: -75, y: 48 };
  const next = zoomAt(view, point, 1.25);
  const local = {
    x: (point.x - view.x) / view.zoom,
    y: (point.y - view.y) / view.zoom,
  };
  assert.ok(Math.abs(next.x + next.zoom * local.x - point.x) < 1e-9);
  assert.ok(Math.abs(next.y + next.zoom * local.y - point.y) < 1e-9);
});

test("zoom is clamped to the supported range", () => {
  assert.equal(clampZoom(0.0001), MIN_ZOOM);
  assert.equal(clampZoom(1000), MAX_ZOOM);
  assert.equal(clampZoom(Number.NaN), 1);
  assert.equal(zoomAt({ zoom: MAX_ZOOM, x: 0, y: 0 }, { x: 0, y: 0 }, 2).zoom, MAX_ZOOM);
  assert.equal(zoomAt({ zoom: MIN_ZOOM, x: 0, y: 0 }, { x: 0, y: 0 }, 0.5).zoom, MIN_ZOOM);
});

test("wheelZoomFactor zooms in on scroll up and out on scroll down", () => {
  assert.ok(wheelZoomFactor(-100) > 1);
  assert.ok(wheelZoomFactor(100) < 1);
  assert.equal(wheelZoomFactor(0), 1);
  assert.equal(wheelZoomFactor(Number.NaN), 1);
});

test("panBy moves in screen pixels and isMoved tracks any change", () => {
  const moved = panBy(resetImageView(), -40, 25);
  assert.deepEqual(moved, { zoom: 1, x: -40, y: 25 });
  assert.equal(isMoved(moved), true);
});

test("canDrag turns on once the view leaves its centred 100% state", () => {
  assert.equal(canDrag(resetImageView()), false);
  assert.equal(canDrag({ zoom: 1.5, x: 0, y: 0 }), true);
  assert.equal(canDrag({ zoom: 0.5, x: 0, y: 0 }), true);
  assert.equal(canDrag({ zoom: 1, x: 8, y: 0 }), true);
});

test("zoomLabel rounds to whole percent", () => {
  assert.equal(zoomLabel(1), "100%");
  assert.equal(zoomLabel(0.456), "46%");
  assert.equal(zoomLabel(2.5), "250%");
});
