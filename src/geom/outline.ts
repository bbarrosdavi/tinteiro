import { getStroke, type StrokeOptions } from 'perfect-freehand';
import type { InkPoint, InkStroke, InkStrokeStyle } from '../model/types';
import { usesPenEasing, linearEasing, defaultPenEasing } from './pen-model';
import { buildPressureEasing, type PressureCurve } from './pressure-curve';

/**
 * Outline of a stroke: perfect-freehand, with the same options Ink always used, so old
 * strokes keep their exact shape. The pressure curve is a pen-feel preference applied at
 * render time (it restyles existing pen strokes too, as before).
 */

let penEasing: (t: number) => number = defaultPenEasing;

export function setPressureCurve(curve: PressureCurve | null | undefined): void {
	penEasing = curve ? buildPressureEasing(curve) : defaultPenEasing;
}

export function strokeOptions(style: InkStrokeStyle): StrokeOptions {
	return {
		size: style.size,
		thinning: style.thinning,
		smoothing: style.smoothing,
		streamline: style.streamline,
		simulatePressure: style.simulatePressure,
		easing: usesPenEasing(style) ? penEasing : linearEasing,
		last: true,
		start: { cap: true, taper: 0 },
		end: { cap: true, taper: 0 },
	};
}

export function strokeOutline(points: InkPoint[], style: InkStrokeStyle): number[][] {
	return getStroke(points, strokeOptions(style));
}

/**
 * Traces the outline as quadratic curves through the midpoints, the same curve the SVG
 * `M Q T` path describes, onto any path sink (Path2D or a canvas context).
 */
export function traceOutline(sink: Path2D | CanvasRenderingContext2D, pts: number[][]): boolean {
	const len = pts.length;
	if (len < 4) return false;
	sink.moveTo(pts[0][0], pts[0][1]);
	sink.quadraticCurveTo(pts[1][0], pts[1][1], (pts[1][0] + pts[2][0]) / 2, (pts[1][1] + pts[2][1]) / 2);
	for (let i = 2; i < len - 1; i++) {
		const a = pts[i];
		const b = pts[i + 1];
		sink.quadraticCurveTo(a[0], a[1], (a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
	}
	sink.closePath();
	return true;
}

/** Rounds to two decimals and prints the shortest form (`12.5`, not `12.50`). */
export function num2(v: number): string {
	return String(Math.round(v * 100) / 100);
}

function num1(v: number): string {
	return String(Math.round(v * 10) / 10);
}

/**
 * SVG path data for an outline; same curve as {@link traceOutline}. One decimal: the path is
 * only for viewers without the plugin (the plugin draws from the points), and 0.1 page unit
 * is a fraction of a pixel at any zoom a preview is shown at.
 */
export function outlineToSvgPath(pts: number[][]): string {
	const len = pts.length;
	if (len < 4) return '';
	const mid = (a: number, b: number) => num1((a + b) / 2);
	const d = `M${num1(pts[0][0])},${num1(pts[0][1])}Q${num1(pts[1][0])},${num1(pts[1][1])} ${mid(pts[1][0], pts[2][0])},${mid(pts[1][1], pts[2][1])}T`;
	const parts: string[] = [];
	for (let i = 2; i < len - 1; i++) {
		parts.push(`${mid(pts[i][0], pts[i + 1][0])},${mid(pts[i][1], pts[i + 1][1])}`);
	}
	return d + parts.join(' ') + 'Z';
}

/**
 * Per-stroke cache: the outline is computed once per stroke object, never per frame.
 * Strokes are immutable; any edit (move, erase, resize) produces a new object.
 */
interface StrokeGeometry {
	path: Path2D | null;
	outline: number[][] | null;
	d?: string;
}

const geometryCache = new WeakMap<InkStroke, StrokeGeometry>();
let cacheEpoch = 0;
const epochOf = new WeakMap<InkStroke, number>();

/** Drops every cached outline (the pressure curve changed). */
export function invalidateAllGeometry(): void {
	cacheEpoch++;
}

function geometry(stroke: InkStroke): StrokeGeometry {
	const cached = geometryCache.get(stroke);
	if (cached && epochOf.get(stroke) === cacheEpoch) return cached;
	const outline = strokeOutline(stroke.points, stroke.style);
	const path = new Path2D();
	const ok = traceOutline(path, outline);
	const g: StrokeGeometry = { path: ok ? path : null, outline: ok ? outline : null };
	geometryCache.set(stroke, g);
	epochOf.set(stroke, cacheEpoch);
	return g;
}

export function strokePath(stroke: InkStroke): Path2D | null {
	return geometry(stroke).path;
}

/** SVG path data, built on the first save and kept; the outline array is released then. */
export function strokeSvgPath(stroke: InkStroke): string {
	const g = geometry(stroke);
	if (g.d === undefined) {
		g.d = g.outline ? outlineToSvgPath(g.outline) : '';
		g.outline = null;
	}
	return g.d;
}
