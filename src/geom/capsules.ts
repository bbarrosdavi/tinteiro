import { getStrokePoints } from 'perfect-freehand';
import type { InkPoint, InkStroke, InkStrokeStyle } from '../model/types';
import { strokeOptions } from './outline';

/**
 * A stroke as a chain of nodes (x, y, radius): the pen tip's disc at every sample. The ink is
 * the union of the capsules between consecutive nodes, the exact envelope of a round nib whose
 * size follows the pressure. The radius at each node is computed exactly as perfect-freehand
 * computes it for its outline (same smoothed points, simulated or real pressure, easing,
 * thinning, end-noise skip), so strokes keep their weight; only the outline's vertex
 * thinning is left out.
 */

const RATE_OF_PRESSURE_CHANGE = 0.275;
const END_NOISE_THRESHOLD = 3;
const MIN_RADIUS = 0.01;

function simulatePressure(prev: number, distance: number, size: number): number {
	const sp = Math.min(1, distance / size);
	const rp = Math.min(1, 1 - sp);
	return Math.min(1, prev + (rp - prev) * (sp * RATE_OF_PRESSURE_CHANGE));
}

/** Nodes in page units, offset not applied: [x0, y0, r0, x1, y1, r1, …]. */
export function computeNodes(points: InkPoint[], style: InkStrokeStyle): Float32Array {
	const opts = strokeOptions(style);
	const size = opts.size ?? 16;
	if (!points.length || size <= 0) return new Float32Array(0);
	const thinning = opts.thinning ?? 0.5;
	const easing = opts.easing ?? ((t: number) => t);
	const simulate = opts.simulatePressure ?? true;
	const pts = getStrokePoints(points, opts);
	if (!pts.length) return new Float32Array(0);

	const total = pts[pts.length - 1].runningLength;
	// Averaged start pressure, so a stroke does not start fat (as perfect-freehand does).
	let prevPressure = pts.slice(0, 10).reduce((acc, cur) => {
		const p = simulate ? simulatePressure(acc, cur.distance, size) : cur.pressure;
		return (acc + p) / 2;
	}, pts[0].pressure);

	const out: number[] = [];
	for (let i = 0; i < pts.length; i++) {
		const p = pts[i];
		const isLast = i === pts.length - 1;
		if (!isLast && total - p.runningLength < END_NOISE_THRESHOLD) continue;
		let radius: number;
		if (thinning) {
			const pressure = simulate ? simulatePressure(prevPressure, p.distance, size) : p.pressure;
			radius = size * easing(0.5 - thinning * (0.5 - pressure));
			prevPressure = pressure;
		} else {
			radius = size / 2;
		}
		out.push(p.point[0], p.point[1], Math.max(MIN_RADIUS, radius));
	}
	return smoothNodes(out);
}

/** Largest gap between the smoothed centreline and its capsule chain, in page units. */
const FLATTEN_TOLERANCE = 0.05;

/**
 * The samples are one per frame, so joining them with straight capsules shows corners on
 * fast curves. The centreline runs instead through a centripetal Catmull-Rom spline: it passes
 * through every sample, so the ink is exactly where the pen was (no corner cutting), and the
 * centripetal knots keep sharp turns from overshooting or looping. Each span is cut into just
 * enough capsules to stay within {@link FLATTEN_TOLERANCE} of the curve, so it is smooth at any
 * zoom. The radius is interpolated linearly along each span, so it never ripples.
 */
function smoothNodes(raw: number[]): Float32Array {
	const n = raw.length / 3;
	if (n < 3) return new Float32Array(raw);
	const X = (i: number) => raw[Math.max(0, Math.min(n - 1, i)) * 3];
	const Y = (i: number) => raw[Math.max(0, Math.min(n - 1, i)) * 3 + 1];
	const out: number[] = [raw[0], raw[1], raw[2]];
	for (let i = 0; i < n - 1; i++) {
		const p1x = X(i), p1y = Y(i), p2x = X(i + 1), p2y = Y(i + 1);
		// Phantom end points mirror the first and last span.
		const p0x = i > 0 ? X(i - 1) : 2 * p1x - p2x, p0y = i > 0 ? Y(i - 1) : 2 * p1y - p2y;
		const p3x = i + 2 < n ? X(i + 2) : 2 * p2x - p1x, p3y = i + 2 < n ? Y(i + 2) : 2 * p2y - p1y;
		const d01 = Math.max(1e-4, Math.sqrt(Math.hypot(p1x - p0x, p1y - p0y)));
		const d12 = Math.max(1e-4, Math.sqrt(Math.hypot(p2x - p1x, p2y - p1y)));
		const d23 = Math.max(1e-4, Math.sqrt(Math.hypot(p3x - p2x, p3y - p2y)));
		// Hermite tangents of the centripetal spline (Barry–Goldman), scaled to this span.
		const m1x = d12 * ((p1x - p0x) / d01 - (p2x - p0x) / (d01 + d12) + (p2x - p1x) / d12);
		const m1y = d12 * ((p1y - p0y) / d01 - (p2y - p0y) / (d01 + d12) + (p2y - p1y) / d12);
		const m2x = d12 * ((p2x - p1x) / d12 - (p3x - p1x) / (d12 + d23) + (p3x - p2x) / d23);
		const m2y = d12 * ((p2y - p1y) / d12 - (p3y - p1y) / (d12 + d23) + (p3y - p2y) / d23);
		const b1x = p1x + m1x / 3, b1y = p1y + m1y / 3;
		const b2x = p2x - m2x / 3, b2y = p2y - m2y / 3;
		// Flattening a cubic: n pieces stay within 3/4 · max|second difference| / n².
		const ddx = Math.max(Math.abs(p1x - 2 * b1x + b2x), Math.abs(b1x - 2 * b2x + p2x));
		const ddy = Math.max(Math.abs(p1y - 2 * b1y + b2y), Math.abs(b1y - 2 * b2y + p2y));
		const dd = Math.hypot(ddx, ddy);
		const pieces = Math.min(32, Math.max(1, Math.ceil(Math.sqrt((0.75 * dd) / FLATTEN_TOLERANCE))));
		const r1 = raw[i * 3 + 2], r2 = raw[(i + 1) * 3 + 2];
		for (let k = 1; k <= pieces; k++) {
			const t = k / pieces;
			const u = 1 - t;
			const w0 = u * u * u, w1 = 3 * u * u * t, w2 = 3 * u * t * t, w3 = t * t * t;
			out.push(
				w0 * p1x + w1 * b1x + w2 * b2x + w3 * p2x,
				w0 * p1y + w1 * b1y + w2 * b2y + w3 * p2y,
				r1 + (r2 - r1) * t,
			);
		}
	}
	return new Float32Array(out);
}

const nodeCache = new WeakMap<InkStroke, Float32Array>();
let epoch = 0;
const epochOf = new WeakMap<InkStroke, number>();

export function invalidateNodes(): void {
	epoch++;
}

export function strokeNodes(stroke: InkStroke): Float32Array {
	const cached = nodeCache.get(stroke);
	if (cached && epochOf.get(stroke) === epoch) return cached;
	const nodes = stroke.image ? new Float32Array(0) : computeNodes(stroke.points, stroke.style);
	nodeCache.set(stroke, nodes);
	epochOf.set(stroke, epoch);
	return nodes;
}

/** Signed distance from a point to the ink of a stroke (negative inside). */
export function strokeDistance(stroke: InkStroke, x: number, y: number): number {
	const n = strokeNodes(stroke);
	const px = x - stroke.offset.x;
	const py = y - stroke.offset.y;
	let best = Infinity;
	if (n.length === 3) return Math.hypot(px - n[0], py - n[1]) - n[2];
	for (let i = 0; i + 5 < n.length; i += 3) {
		const d = capsuleDistance(px, py, n[i], n[i + 1], n[i + 2], n[i + 3], n[i + 4], n[i + 5]);
		if (d < best) best = d;
	}
	return best;
}

/** Distance to a capsule whose radius varies linearly along the segment (conservative). */
function capsuleDistance(px: number, py: number, ax: number, ay: number, ra: number, bx: number, by: number, rb: number): number {
	const dx = bx - ax;
	const dy = by - ay;
	const l2 = dx * dx + dy * dy;
	const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
	const cx = ax + dx * t;
	const cy = ay + dy * t;
	return Math.hypot(px - cx, py - cy) - (ra + (rb - ra) * t);
}
