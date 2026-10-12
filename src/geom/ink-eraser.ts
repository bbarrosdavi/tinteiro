import type { InkPoint, InkStroke } from '../model/types';

///////////////////////////
///////////////////////////

export interface EraserPoint {
	x: number;
	y: number;
}

/** Minimum surviving points for a fragment to be worth keeping. */
const MIN_FRAGMENT_POINTS = 2;

/** Iterations of the bisection that finds where a segment crosses the eraser edge. */
const EDGE_REFINEMENT_STEPS = 12;

let fragmentCounter = 0;

/**
 * Erases the part of a stroke covered by the eraser, splitting it into the pieces that
 * survive. This is what makes the eraser feel like it rubs out ink rather than deleting
 * the whole line.
 *
 * Fragments are ordinary strokes carrying the original's style, so everything downstream
 * (rendering, export, selection, further erasing) treats them like any other stroke.
 *
 * Returns `null` when the eraser did not touch the stroke, so callers can skip it
 * cheaply; an empty array means the stroke was erased completely.
 */
export function eraseFromStroke(
	stroke: InkStroke,
	eraserPath: EraserPoint[],
	radius: number,
): InkStroke[] | null {
	if (eraserPath.length === 0 || radius <= 0) return null;
	if (stroke.points.length === 0) return null;

	const offsetX = stroke.offset?.x ?? 0;
	const offsetY = stroke.offset?.y ?? 0;

	const covered = stroke.points.map(point =>
		isCovered(point[0] + offsetX, point[1] + offsetY, eraserPath, radius),
	);
	if (!covered.some(Boolean)) return null;

	const fragments: InkStroke[] = [];
	let current: InkPoint[] = [];

	const flush = () => {
		if (current.length >= MIN_FRAGMENT_POINTS) {
			fragments.push(fragmentFrom(stroke, current));
		}
		current = [];
	};

	for (let i = 0; i < stroke.points.length; i++) {
		if (!covered[i]) {
			// Entering ink from an erased span: start the fragment at the eraser edge.
			if (current.length === 0 && i > 0 && covered[i - 1]) {
				current.push(edgePoint(stroke.points[i], stroke.points[i - 1], offsetX, offsetY, eraserPath, radius));
			}
			current.push(copyPoint(stroke.points[i]));
			continue;
		}

		// Leaving ink: end the fragment at the eraser edge rather than at the last
		// surviving sample, so the cut lands where the eraser actually passed.
		if (current.length > 0) {
			current.push(edgePoint(stroke.points[i - 1], stroke.points[i], offsetX, offsetY, eraserPath, radius));
		}
		flush();
	}
	flush();

	return fragments;
}

/** Distance from a point to a polyline, used for both hit-testing and edge refinement. */
export function distanceToPath(x: number, y: number, path: EraserPoint[]): number {
	if (path.length === 1) return Math.hypot(x - path[0].x, y - path[0].y);

	let best = Infinity;
	for (let i = 0; i < path.length - 1; i++) {
		const distance = distanceToSegment(x, y, path[i], path[i + 1]);
		if (distance < best) best = distance;
	}
	return best;
}

///////////////////////////

function isCovered(x: number, y: number, path: EraserPoint[], radius: number): boolean {
	return distanceToPath(x, y, path) <= radius;
}

function distanceToSegment(x: number, y: number, a: EraserPoint, b: EraserPoint): number {
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	const lengthSquared = dx * dx + dy * dy;
	if (lengthSquared === 0) return Math.hypot(x - a.x, y - a.y);

	let t = ((x - a.x) * dx + (y - a.y) * dy) / lengthSquared;
	t = Math.max(0, Math.min(1, t));
	return Math.hypot(x - (a.x + t * dx), y - (a.y + t * dy));
}

/**
 * Point on the segment `from`→`to` that sits on the eraser edge, found by bisection.
 * `from` is outside the eraser and `to` is inside it.
 */
function edgePoint(
	from: InkPoint,
	to: InkPoint,
	offsetX: number,
	offsetY: number,
	path: EraserPoint[],
	radius: number,
): InkPoint {
	let low = 0;
	let high = 1;

	for (let step = 0; step < EDGE_REFINEMENT_STEPS; step++) {
		const mid = (low + high) / 2;
		const x = from[0] + (to[0] - from[0]) * mid;
		const y = from[1] + (to[1] - from[1]) * mid;
		if (distanceToPath(x + offsetX, y + offsetY, path) <= radius) {
			high = mid;
		} else {
			low = mid;
		}
	}

	const t = low;
	return [
		from[0] + (to[0] - from[0]) * t,
		from[1] + (to[1] - from[1]) * t,
		from[2] + (to[2] - from[2]) * t,
	];
}

function fragmentFrom(stroke: InkStroke, points: InkPoint[]): InkStroke {
	fragmentCounter += 1;
	return {
		...stroke,
		id: `${stroke.id}~e${fragmentCounter}`,
		points,
		// Style, offset and timestamps are inherited: a fragment is the same ink, cut short.
		style: { ...stroke.style },
		offset: { ...stroke.offset },
	};
}

function copyPoint(point: InkPoint): InkPoint {
	return [point[0], point[1], point[2]];
}
