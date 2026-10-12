import type { InkStroke } from '../model/types';
import type { PageRect } from '../model/types';
import { approxStrokeBounds as computeApproxStrokePageBounds } from './bounds';

///////////////////////////
///////////////////////////

/**
 * Grab area of a selection (handnotes fork).
 *
 * Ink only started a drag when the pointer lands exactly on a selected stroke's
 * rendered path. With handwriting that means hitting a hairline, often several tries.
 * Here the whole box around the selection, padded by a few screen pixels, grabs it.
 */

/** Padding around the selection box, in screen pixels (divided by zoom for page units). */
export const SELECTION_GRAB_TOLERANCE_PX = 16;

/** A press that moves less than this (screen pixels) is a tap, not a drag. */
export const SELECTION_TAP_SLOP_PX = 4;

/** Union of the selected strokes' page bounds (cheap point bounds, offsets included). */
export function computeSelectionBounds(strokes: InkStroke[]): PageRect | null {
	let bounds: PageRect | null = null;
	for (const stroke of strokes) {
		if (stroke.points.length === 0) continue;
		const b = computeApproxStrokePageBounds(stroke);
		bounds = bounds
			? {
				minX: Math.min(bounds.minX, b.minX),
				minY: Math.min(bounds.minY, b.minY),
				maxX: Math.max(bounds.maxX, b.maxX),
				maxY: Math.max(bounds.maxY, b.maxY),
			}
			: b;
	}
	return bounds;
}

/** The selection box grown by the grab tolerance, in page units at the given zoom. */
export function computeSelectionGrabRect(
	strokes: InkStroke[],
	zoom: number,
	tolerancePx: number = SELECTION_GRAB_TOLERANCE_PX,
): PageRect | null {
	const bounds = computeSelectionBounds(strokes);
	if (!bounds) return null;
	const pad = tolerancePx / (zoom > 0 ? zoom : 1);
	return {
		minX: bounds.minX - pad,
		minY: bounds.minY - pad,
		maxX: bounds.maxX + pad,
		maxY: bounds.maxY + pad,
	};
}

export function isPointInRect(point: { x: number; y: number }, rect: PageRect | null): boolean {
	if (!rect) return false;
	return point.x >= rect.minX && point.x <= rect.maxX && point.y >= rect.minY && point.y <= rect.maxY;
}
