import { describe, expect, it } from 'vitest';
import { computeNodes, strokeDistance } from '../src/geom/capsules';
import { strokeStyleFor } from '../src/geom/pen-model';
import { DEFAULT_STROKE_STYLE, type InkPoint } from '../src/model/types';

const style = strokeStyleFor({ ...DEFAULT_STROKE_STYLE, size: 6 }, 'pen', 1);

function circle(samplesPerTurn: number, R: number): InkPoint[] {
	const pts: InkPoint[] = [];
	for (let i = 0; i <= samplesPerTurn; i++) {
		const a = (i / samplesPerTurn) * Math.PI * 2;
		pts.push([R * Math.cos(a), R * Math.sin(a), 0.5]);
	}
	return pts;
}

/** Largest angle between consecutive capsule directions, in degrees. */
function maxTurn(nodes: Float32Array): number {
	let worst = 0;
	for (let i = 3; i + 5 < nodes.length; i += 3) {
		const ax = nodes[i] - nodes[i - 3], ay = nodes[i + 1] - nodes[i - 2];
		const bx = nodes[i + 3] - nodes[i], by = nodes[i + 4] - nodes[i + 1];
		if (Math.hypot(ax, ay) < 1e-6 || Math.hypot(bx, by) < 1e-6) continue;
		const cos = (ax * bx + ay * by) / (Math.hypot(ax, ay) * Math.hypot(bx, by));
		worst = Math.max(worst, (Math.acos(Math.min(1, Math.max(-1, cos))) * 180) / Math.PI);
	}
	return worst;
}

describe('capsule chain', () => {
	it('turns a coarse fast circle into a smooth chain', () => {
		const raw = circle(18, 100); // 20° between samples, a quick loop at 60 Hz
		const nodes = computeNodes(raw, style);
		// Raw samples bend 20° at every joint; the flattened spline stays far below that.
		expect(maxTurn(nodes)).toBeLessThan(6);
		expect(nodes.length / 3).toBeGreaterThan(raw.length * 2);
	});

	it('keeps the stroke weight of the old outline', () => {
		const pts: InkPoint[] = Array.from({ length: 30 }, (_, i) => [i * 4, 0, 0.5]);
		const nodes = computeNodes(pts, style);
		let max = 0;
		for (let i = 2; i < nodes.length; i += 3) max = Math.max(max, nodes[i]);
		// Radius at pressure 0.5 is size/2 through the pen easing, near 3 page units.
		expect(max).toBeGreaterThan(2);
		expect(max).toBeLessThan(4.5);
	});

	it('measures distance to the ink for hit testing', () => {
		const stroke = { id: 's', points: Array.from({ length: 20 }, (_, i) => [i * 5, 0, 0.5] as InkPoint), style, offset: { x: 10, y: 20 } };
		expect(strokeDistance(stroke, 60, 20)).toBeLessThan(0);
		expect(strokeDistance(stroke, 60, 40)).toBeGreaterThan(10);
	});

	it('handles a single tap as one disc', () => {
		const nodes = computeNodes([[5, 5, 0.5]], style);
		expect(nodes.length).toBe(3);
	});
});

describe('fidelity to the pen', () => {
	it('passes through every sample (no corner cutting)', () => {
		// A zigzag with sharp cusps, like the turn of an "n" or a "v".
		const raw: InkPoint[] = [];
		for (let i = 0; i < 12; i++) raw.push([i * 6, i % 2 ? 18 : 0, 0.5]);
		const nodes = computeNodes(raw, { ...style, streamline: 0 });
		for (const [x, y] of raw.slice(1, -1)) {
			let best = Infinity;
			for (let j = 0; j < nodes.length; j += 3) best = Math.min(best, Math.hypot(nodes[j] - x, nodes[j + 1] - y));
			expect(best).toBeLessThan(0.01);
		}
	});

	it('does not overshoot a sharp turn', () => {
		const raw: InkPoint[] = [[0, 0, 0.5], [10, 0, 0.5], [20, 0, 0.5], [20.5, 10, 0.5], [21, 20, 0.5]];
		const nodes = computeNodes(raw, { ...style, streamline: 0 });
		let maxX = -Infinity;
		for (let j = 0; j < nodes.length; j += 3) maxX = Math.max(maxX, nodes[j]);
		expect(maxX).toBeLessThan(21.5);
	});
});
