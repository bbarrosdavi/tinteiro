import type { ImageRect, ImageStroke } from './ink-images';

///////////////////////////
///////////////////////////

/**
 * Resizing a pasted image (handnotes fork): four corner handles on a single selected
 * image. Dragging one scales the image from the opposite corner, aspect ratio kept.
 * Pure geometry here; the select tool drives the gesture.
 */

export type ResizeCorner = 'nw' | 'ne' | 'sw' | 'se';

export const IMAGE_RESIZE_CORNERS: ResizeCorner[] = ['nw', 'ne', 'sw', 'se'];

/** Drawn radius of a handle, in screen pixels. */
export const IMAGE_HANDLE_RADIUS_PX = 6;
/** How close a press must land to a handle to grab it, in screen pixels (pen friendly). */
export const IMAGE_HANDLE_HIT_PX = 16;
/** Smallest side an image can be resized down to, in screen pixels. */
export const MIN_IMAGE_SIDE_PX = 16;

export function imageCornerPoint(rect: ImageRect, corner: ResizeCorner): { x: number; y: number } {
	return {
		x: corner === 'ne' || corner === 'se' ? rect.x + rect.width : rect.x,
		y: corner === 'sw' || corner === 'se' ? rect.y + rect.height : rect.y,
	};
}

const OPPOSITE: Record<ResizeCorner, ResizeCorner> = { nw: 'se', ne: 'sw', sw: 'ne', se: 'nw' };

/** The handle under a page-space point, if any; the nearest wins when they overlap. */
export function hitImageHandle(point: { x: number; y: number }, rect: ImageRect, zoom: number): ResizeCorner | null {
	const reach = IMAGE_HANDLE_HIT_PX / (zoom > 0 ? zoom : 1);
	let best: ResizeCorner | null = null;
	let bestDistance = Infinity;
	for (const corner of IMAGE_RESIZE_CORNERS) {
		const c = imageCornerPoint(rect, corner);
		const distance = Math.hypot(point.x - c.x, point.y - c.y);
		if (distance <= reach && distance < bestDistance) {
			best = corner;
			bestDistance = distance;
		}
	}
	return best;
}

/**
 * New rectangle while dragging `corner` to `pointer`. The opposite corner stays put and
 * the aspect ratio of `start` is kept, following whichever axis was dragged further.
 * The image never flips and never shrinks below {@link MIN_IMAGE_SIDE_PX} on screen.
 */
export function resizeImageRect(
	start: ImageRect,
	corner: ResizeCorner,
	pointer: { x: number; y: number },
	zoom: number,
): ImageRect {
	const anchor = imageCornerPoint(start, OPPOSITE[corner]);
	const signX = corner === 'ne' || corner === 'se' ? 1 : -1;
	const signY = corner === 'sw' || corner === 'se' ? 1 : -1;
	const minSide = MIN_IMAGE_SIDE_PX / (zoom > 0 ? zoom : 1);

	const wantedWidth = (pointer.x - anchor.x) * signX;
	const wantedHeight = (pointer.y - anchor.y) * signY;
	const scale = Math.max(wantedWidth / start.width, wantedHeight / start.height);
	const minScale = minSide / Math.min(start.width, start.height);
	const finalScale = Math.max(scale, minScale);

	const width = start.width * finalScale;
	const height = start.height * finalScale;
	return {
		x: signX > 0 ? anchor.x : anchor.x - width,
		y: signY > 0 ? anchor.y : anchor.y - height,
		width,
		height,
	};
}

/** Same image with a new page-space rectangle; the select-and-move offset is preserved. */
export function imageStrokeWithRect(stroke: ImageStroke, rect: ImageRect): ImageStroke {
	const [a, b] = stroke.points;
	return {
		...stroke,
		points: [
			[rect.x - stroke.offset.x, rect.y - stroke.offset.y, a[2]],
			[rect.x + rect.width - stroke.offset.x, rect.y + rect.height - stroke.offset.y, b[2]],
		],
	};
}
