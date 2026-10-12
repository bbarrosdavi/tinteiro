import type { InkPoint, InkStrokeStyle, StrokeInputKind } from '../model/types';
import { conditionPenPressure, HOVER_PRESSURE, PRESSURE_SLEW_PER_SIZE, PRESSURE_SMOOTHING } from '../geom/pen-model';

/**
 * Turns pen samples into stroke points, with the treatment Ink always applied (pressure gain
 * and start floor, smoothing, a per-distance slew limit, merging samples closer than one
 * screen pixel). Pure: no DOM, no rendering.
 */

/** A slow pen still adds a point after this long, instead of dragging the tip along. */
const SLOW_DRAW_APPEND_MS = 40;

export interface Sample {
	/** Page coordinates. */
	x: number;
	y: number;
	/** Raw pressure as reported by the browser. */
	pressure: number;
	/** Event time, ms. */
	t: number;
	isPen: boolean;
}

export class StrokeCapture {
	readonly points: InkPoint[] = [];
	/** Every accepted sample, so the stroke can be rebuilt for the detected input kind. */
	readonly samples: Array<{ sample: Sample; final: boolean }> = [];
	private pathLength = 0;
	private smoothed = 0.5;
	private lastAppendT = 0;
	private readonly mergeSq: number;

	constructor(
		readonly kind: StrokeInputKind,
		private readonly style: InkStrokeStyle,
		cameraZoom: number,
	) {
		const merge = 1 / cameraZoom;
		this.mergeSq = merge * merge;
	}

	add(sample: Sample, final = false): void {
		if (sample.isPen && !final && this.points.length > 0 && sample.pressure <= HOVER_PRESSURE) return;
		this.samples.push({ sample, final });
		let pressure = sample.pressure;
		if (this.kind !== 'pen' && pressure === 0) pressure = 0.5;

		const pts = this.points;
		if (pts.length === 0) {
			if (sample.isPen) pressure = conditionPenPressure(sample.pressure, 0, this.style.size);
			this.smoothed = pressure;
			pts.push([sample.x, sample.y, pressure]);
			this.lastAppendT = sample.t;
			return;
		}

		const last = pts[pts.length - 1];
		const dx = sample.x - last[0];
		const dy = sample.y - last[1];
		const dist = Math.hypot(dx, dy);
		const merge = !final && this.shouldMerge(sample);

		if (sample.isPen) {
			pressure = conditionPenPressure(sample.pressure, this.pathLength, this.style.size);
			if (merge) {
				pressure = Math.max(last[2], pressure);
			} else {
				const eased = this.smoothed + (pressure - this.smoothed) * PRESSURE_SMOOTHING;
				const slew = this.style.size > 0 ? PRESSURE_SLEW_PER_SIZE * (dist / this.style.size) : 1;
				pressure = Math.min(this.smoothed + slew, Math.max(this.smoothed - slew, eased));
			}
			this.smoothed = pressure;
		}

		this.pathLength += dist;
		if (final || merge) {
			pts[pts.length - 1] = [sample.x, sample.y, Math.max(last[2], pressure)];
		} else {
			pts.push([sample.x, sample.y, pressure]);
			this.lastAppendT = sample.t;
		}
	}

	private shouldMerge(sample: Sample): boolean {
		const pts = this.points;
		const tip = pts[pts.length - 1];
		if ((sample.x - tip[0]) ** 2 + (sample.y - tip[1]) ** 2 >= this.mergeSq) return false;
		if (pts.length >= 2) {
			const anchor = pts[pts.length - 2];
			const nearAnchor = (sample.x - anchor[0]) ** 2 + (sample.y - anchor[1]) ** 2 < this.mergeSq;
			if (!nearAnchor && sample.t - this.lastAppendT >= SLOW_DRAW_APPEND_MS) return false;
		}
		return true;
	}

	/** A pen whose every sample reported the same pressure is a mouse in disguise. */
	detectedKind(): StrokeInputKind {
		const raw = this.samples.filter(s => !s.final).map(s => s.sample.pressure);
		if (raw.length === 0) return 'mouse';
		return raw.every(p => p === raw[0]) ? 'mouse' : 'pen';
	}

	/** The same samples captured again as another input kind. */
	rebuild(kind: StrokeInputKind, style: InkStrokeStyle, cameraZoom: number): StrokeCapture {
		const next = new StrokeCapture(kind, style, cameraZoom);
		for (const { sample, final } of this.samples) next.add({ ...sample, isPen: kind === 'pen' }, final);
		return next;
	}
}
