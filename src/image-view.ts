// Navigation math for the image preview. Kept pure and free of DOM APIs so the
// wheel rules can be tested in Node; the panel only supplies pointer offsets.

export type ImageView = { zoom: number; x: number; y: number };
export type ImageSize = { width: number; height: number };

export const MIN_ZOOM = 0.2;
export const MAX_ZOOM = 8;

// One wheel notch reports about 100 pixels; this makes it a ~20% step.
export const WHEEL_ZOOM_SPEED = 0.002;

export function resetImageView(): ImageView {
  return { zoom: 1, x: 0, y: 0 };
}

/** Scale relative to the source pixels, with zoom 1 fitting the preview. */
export function imageScale(source: ImageSize, stage: ImageSize, zoom: number) {
  const fit = Math.min(1, stage.width / source.width, stage.height / source.height);
  return fit * zoom;
}

export function clampZoom(value: number) {
  if (!Number.isFinite(value)) return 1;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
}

/**
 * Zooms around a point measured from the preview's centre, so the pixel under
 * the cursor stays under the cursor. `factor` is the multiplier: 1.2 zooms in,
 * 0.8 zooms out.
 */
export function zoomAt(
  view: ImageView,
  point: { x: number; y: number },
  factor: number,
): ImageView {
  const zoom = clampZoom(view.zoom * factor);
  if (zoom === view.zoom) return view;

  const ratio = zoom / view.zoom;
  return {
    zoom,
    x: point.x - (point.x - view.x) * ratio,
    y: point.y - (point.y - view.y) * ratio,
  };
}

/** Wheel delta to a zoom multiplier; scrolling down zooms out. */
export function wheelZoomFactor(delta: number) {
  if (!Number.isFinite(delta)) return 1;
  return Math.exp(-delta * WHEEL_ZOOM_SPEED);
}

/** Moves the preview by a screen-space offset. */
export function panBy(view: ImageView, x: number, y: number): ImageView {
  return { ...view, x: view.x + x, y: view.y + y };
}

export function isMoved(view: ImageView) {
  return view.zoom !== 1 || view.x !== 0 || view.y !== 0;
}

/** Dragging is worth offering once the image is zoomed or shifted off centre. */
export function canDrag(view: ImageView) {
  return isMoved(view);
}

export function zoomLabel(zoom: number) {
  return `${Math.round(clampZoom(zoom) * 100)}%`;
}
