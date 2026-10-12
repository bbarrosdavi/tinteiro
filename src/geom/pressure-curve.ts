///////////////////////////
///////////////////////////

/** A control point on the pressure response curve. Both axes are normalised 0..1. */
export interface CurvePoint {
	/** Raw pressure reported by the stylus. */
	x: number;
	/** Pressure the stroke should be drawn with. */
	y: number;
}

export interface PressureCurve {
	/** Ordered by x. Always contains at least two points. */
	points: CurvePoint[];
}

/** Straight line: the stylus pressure is used exactly as reported. */
export const LINEAR_PRESSURE_CURVE: PressureCurve = {
	points: [
		{ x: 0, y: 0 },
		{ x: 1, y: 1 },
	],
};

/**
 * Default curve — matches the built-in `penStrokePressureEasing` closely enough that
 * existing strokes keep their feel when the feature is left untouched.
 * (`t * 0.65 + sin(t * PI / 2) * 0.35` sampled at 0, 0.25, 0.5, 0.75, 1.)
 */
export const DEFAULT_PRESSURE_CURVE: PressureCurve = {
	points: [
		{ x: 0, y: 0 },
		{ x: 0.25, y: 0.297 },
		{ x: 0.5, y: 0.573 },
		{ x: 0.75, y: 0.81 },
		{ x: 1, y: 1 },
	],
};

/** Presets offered in settings, so the curve is usable without dragging points. */
export const PRESSURE_CURVE_PRESETS: Record<string, PressureCurve> = {
	linear: LINEAR_PRESSURE_CURVE,
	default: DEFAULT_PRESSURE_CURVE,
	/** Reaches full width early — for light-handed writers. */
	light: {
		points: [
			{ x: 0, y: 0 },
			{ x: 0.2, y: 0.45 },
			{ x: 0.5, y: 0.8 },
			{ x: 1, y: 1 },
		],
	},
	/** Stays thin until pressed hard — for heavy-handed writers. */
	heavy: {
		points: [
			{ x: 0, y: 0 },
			{ x: 0.5, y: 0.22 },
			{ x: 0.8, y: 0.6 },
			{ x: 1, y: 1 },
		],
	},
};

///////////////////////////

/** Sorts by x, drops duplicate x values, and guarantees at least two usable points. */
export function normaliseCurve(curve: PressureCurve | undefined | null): PressureCurve {
	const raw = curve?.points;
	if (!Array.isArray(raw) || raw.length < 2) return LINEAR_PRESSURE_CURVE;

	const cleaned: CurvePoint[] = [];
	for (const point of raw) {
		if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
		cleaned.push({ x: clamp01(point.x), y: clamp01(point.y) });
	}
	cleaned.sort((a, b) => a.x - b.x);

	const deduped: CurvePoint[] = [];
	for (const point of cleaned) {
		const previous = deduped[deduped.length - 1];
		// Equal x would make the segment slope infinite — keep the later point only.
		if (previous && Math.abs(previous.x - point.x) < 1e-6) {
			deduped[deduped.length - 1] = point;
			continue;
		}
		deduped.push(point);
	}

	if (deduped.length < 2) return LINEAR_PRESSURE_CURVE;
	return { points: deduped };
}

/**
 * Monotone cubic Hermite interpolation (Fritsch–Carlson).
 *
 * Plain cubic splines overshoot, which on a pressure curve shows up as a stroke that
 * gets *thinner* when you press harder between two control points. Fritsch–Carlson
 * limits the tangents so the interpolation can never reverse direction.
 */
export function interpolateCurve(curve: PressureCurve, x: number): number {
	const points = curve.points;
	const n = points.length;
	if (n === 0) return x;
	if (x <= points[0].x) return points[0].y;
	if (x >= points[n - 1].x) return points[n - 1].y;

	// Secant slopes between consecutive points.
	const secants: number[] = [];
	for (let i = 0; i < n - 1; i++) {
		secants.push((points[i + 1].y - points[i].y) / (points[i + 1].x - points[i].x));
	}

	// Initial tangents: average of neighbouring secants, one-sided at the ends.
	const tangents: number[] = new Array(n);
	tangents[0] = secants[0];
	tangents[n - 1] = secants[n - 2];
	for (let i = 1; i < n - 1; i++) {
		if (secants[i - 1] * secants[i] <= 0) {
			// Local extremum — flat tangent keeps the segment monotone.
			tangents[i] = 0;
		} else {
			tangents[i] = (secants[i - 1] + secants[i]) / 2;
		}
	}

	// Fritsch–Carlson limiter.
	for (let i = 0; i < n - 1; i++) {
		const secant = secants[i];
		if (secant === 0) {
			tangents[i] = 0;
			tangents[i + 1] = 0;
			continue;
		}
		const alpha = tangents[i] / secant;
		const beta = tangents[i + 1] / secant;
		const magnitude = Math.hypot(alpha, beta);
		if (magnitude > 3) {
			const scale = 3 / magnitude;
			tangents[i] = scale * alpha * secant;
			tangents[i + 1] = scale * beta * secant;
		}
	}

	let i = 0;
	while (i < n - 2 && points[i + 1].x < x) i++;

	const x0 = points[i].x;
	const x1 = points[i + 1].x;
	const y0 = points[i].y;
	const y1 = points[i + 1].y;
	const h = x1 - x0;
	const t = (x - x0) / h;
	const t2 = t * t;
	const t3 = t2 * t;

	return (
		(2 * t3 - 3 * t2 + 1) * y0
		+ (t3 - 2 * t2 + t) * h * tangents[i]
		+ (-2 * t3 + 3 * t2) * y1
		+ (t3 - t2) * h * tangents[i + 1]
	);
}

/**
 * Builds the easing function handed to perfect-freehand.
 * The result is always clamped to 0..1 — perfect-freehand multiplies it by the
 * stroke size, and a negative value would invert the outline.
 */
export function buildPressureEasing(curve: PressureCurve): (t: number) => number {
	const normalised = normaliseCurve(curve);
	return (t: number) => clamp01(interpolateCurve(normalised, clamp01(t)));
}

/** Samples the curve for drawing it in the settings editor. */
export function samplePressureCurve(curve: PressureCurve, sampleCount = 64): CurvePoint[] {
	const normalised = normaliseCurve(curve);
	const samples: CurvePoint[] = [];
	for (let i = 0; i <= sampleCount; i++) {
		const x = i / sampleCount;
		samples.push({ x, y: clamp01(interpolateCurve(normalised, x)) });
	}
	return samples;
}

function clamp01(value: number): number {
	if (!Number.isFinite(value)) return 0;
	if (value < 0) return 0;
	if (value > 1) return 1;
	return value;
}
