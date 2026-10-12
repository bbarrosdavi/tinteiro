///////////////////////////
///////////////////////////

/** Background a canvas is drawn on. `dot` is the Ink drawing grid. */
export type InkLayout =
	| 'blank'
	| 'ruled-fine'
	| 'ruled-narrow'
	| 'ruled-wide'
	| 'grid-small'
	| 'grid-large'
	| 'dot'
	| 'isometric';

export const INK_LAYOUTS: InkLayout[] = [
	'blank',
	'ruled-fine',
	'ruled-narrow',
	'ruled-wide',
	'grid-small',
	'grid-large',
	'dot',
	'isometric',
];

export const INK_LAYOUT_LABELS: Record<InkLayout, string> = {
	blank: 'Blank',
	'ruled-fine': 'Ruled (fine)',
	'ruled-narrow': 'Ruled (narrow)',
	'ruled-wide': 'Ruled (wide)',
	'grid-small': 'Grid (small)',
	'grid-large': 'Grid (large)',
	dot: 'Dots',
	isometric: 'Isometric',
};

/**
 * Spacing in page units at zoom 1.
 *
 * In writing mode these are ignored for the ruled layouts: line spacing there derives from
 * the user's `writingLineHeight` (fine ½×, narrow 1×, wide 2×), because that is what the
 * handwriting size is calibrated to.
 */
export const INK_LAYOUT_SPACING: Record<InkLayout, number> = {
	blank: 0,
	'ruled-fine': 37.5,
	'ruled-narrow': 75,
	'ruled-wide': 150,
	'grid-small': 50,
	'grid-large': 100,
	dot: 0,
	isometric: 80,
};

/** Isometric rulings run at ±30° from the horizontal, the standard axonometric angle. */
export const ISOMETRIC_ANGLE_RADIANS = Math.PI / 6;

export interface LayoutRect {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
}

export interface LayoutLine {
	x1: number;
	y1: number;
	x2: number;
	y2: number;
}

export interface LayoutDot {
	cx: number;
	cy: number;
}

export interface LayoutGeometry {
	lines: LayoutLine[];
	dots: LayoutDot[];
}

const EMPTY_GEOMETRY: LayoutGeometry = { lines: [], dots: [] };

/** Guard against a pathological spacing/rect combination producing millions of elements. */
const MAX_LAYOUT_ELEMENTS = 4000;

///////////////////////////

/**
 * Builds the background geometry for a rectangle of page space.
 *
 * Used by writing mode, where the background lives in page coordinates alongside the
 * strokes. Drawing mode uses the screen-space pattern renderer instead, which is cheaper
 * on an infinite canvas.
 */
export function buildLayoutGeometry(
	layout: InkLayout,
	rect: LayoutRect,
	options: { lineHeight?: number; spacing?: number } = {},
): LayoutGeometry {
	if (layout === 'blank') return EMPTY_GEOMETRY;

	const width = rect.maxX - rect.minX;
	const height = rect.maxY - rect.minY;
	if (!(width > 0) || !(height > 0)) return EMPTY_GEOMETRY;

	const spacing = resolveSpacing(layout, options);
	if (!(spacing > 0)) return EMPTY_GEOMETRY;

	// Rough element budget check before generating anything.
	const estimated = (width / spacing) + (height / spacing);
	if (estimated > MAX_LAYOUT_ELEMENTS) return EMPTY_GEOMETRY;

	switch (layout) {
		case 'ruled-fine':
		case 'ruled-narrow':
		case 'ruled-wide':
			return { lines: horizontalLines(rect, spacing), dots: [] };

		case 'grid-small':
		case 'grid-large':
			return {
				lines: [...horizontalLines(rect, spacing), ...verticalLines(rect, spacing)],
				dots: [],
			};

		case 'dot':
			return { lines: [], dots: dotGrid(rect, spacing || INK_LAYOUT_SPACING['grid-small']) };

		case 'isometric':
			return { lines: isometricLines(rect, spacing), dots: [] };

		default:
			return EMPTY_GEOMETRY;
	}
}

export function isRuledLayout(layout: InkLayout): boolean {
	return layout === 'ruled-fine' || layout === 'ruled-narrow' || layout === 'ruled-wide';
}

/** Ruled layouts follow the writing line height when one is supplied. */
export function resolveSpacing(
	layout: InkLayout,
	options: { lineHeight?: number; spacing?: number } = {},
): number {
	if (options.spacing !== undefined) return options.spacing;

	if (isRuledLayout(layout) && options.lineHeight !== undefined && options.lineHeight > 0) {
		// The wide variant skips every other writing line rather than inventing a new rhythm;
		// the fine one adds a rule halfway through each line, for smaller handwriting.
		if (layout === 'ruled-wide') return options.lineHeight * 2;
		if (layout === 'ruled-fine') return options.lineHeight / 2;
		return options.lineHeight;
	}

	// Dots sit at the ruled-fine height, half a writing line (handnotes fork, 2026-10-11).
	if (layout === 'dot' && options.lineHeight !== undefined && options.lineHeight > 0) {
		return options.lineHeight / 2;
	}

	return INK_LAYOUT_SPACING[layout];
}

///////////////////////////

function horizontalLines(rect: LayoutRect, spacing: number): LayoutLine[] {
	const lines: LayoutLine[] = [];
	for (let y = firstMultipleAtOrAfter(rect.minY, spacing); y <= rect.maxY; y += spacing) {
		lines.push({ x1: rect.minX, y1: y, x2: rect.maxX, y2: y });
	}
	return lines;
}

function verticalLines(rect: LayoutRect, spacing: number): LayoutLine[] {
	const lines: LayoutLine[] = [];
	for (let x = firstMultipleAtOrAfter(rect.minX, spacing); x <= rect.maxX; x += spacing) {
		lines.push({ x1: x, y1: rect.minY, x2: x, y2: rect.maxY });
	}
	return lines;
}

function dotGrid(rect: LayoutRect, spacing: number): LayoutDot[] {
	const dots: LayoutDot[] = [];
	for (let x = firstMultipleAtOrAfter(rect.minX, spacing); x <= rect.maxX; x += spacing) {
		for (let y = firstMultipleAtOrAfter(rect.minY, spacing); y <= rect.maxY; y += spacing) {
			dots.push({ cx: x, cy: y });
			if (dots.length > MAX_LAYOUT_ELEMENTS) return dots;
		}
	}
	return dots;
}

/**
 * Isometric ruling: verticals plus two families of parallel lines at ±30°.
 * Each family is generated by walking the perpendicular offset across the rectangle,
 * then clipping the infinite line to the rectangle.
 */
function isometricLines(rect: LayoutRect, spacing: number): LayoutLine[] {
	const lines = verticalLines(rect, spacing);

	for (const direction of [1, -1]) {
		const slope = Math.tan(ISOMETRIC_ANGLE_RADIANS) * direction;
		// Intercepts are spaced along y so the perpendicular gap matches `spacing`.
		const interceptStep = spacing / Math.cos(ISOMETRIC_ANGLE_RADIANS);
		const minIntercept = rect.minY - Math.abs(slope) * (rect.maxX - rect.minX);
		const maxIntercept = rect.maxY + Math.abs(slope) * (rect.maxX - rect.minX);

		for (
			let intercept = firstMultipleAtOrAfter(minIntercept, interceptStep);
			intercept <= maxIntercept;
			intercept += interceptStep
		) {
			const y1 = intercept + slope * (rect.minX - rect.minX);
			const y2 = intercept + slope * (rect.maxX - rect.minX);
			const clipped = clipSegmentToRect({ x1: rect.minX, y1, x2: rect.maxX, y2 }, rect);
			if (clipped) lines.push(clipped);
			if (lines.length > MAX_LAYOUT_ELEMENTS) return lines;
		}
	}

	return lines;
}

/** Liang–Barsky clip of a segment against an axis-aligned rectangle. */
export function clipSegmentToRect(line: LayoutLine, rect: LayoutRect): LayoutLine | null {
	const dx = line.x2 - line.x1;
	const dy = line.y2 - line.y1;

	let tMin = 0;
	let tMax = 1;

	const edges: Array<[number, number]> = [
		[-dx, line.x1 - rect.minX],
		[dx, rect.maxX - line.x1],
		[-dy, line.y1 - rect.minY],
		[dy, rect.maxY - line.y1],
	];

	for (const [p, q] of edges) {
		if (p === 0) {
			if (q < 0) return null; // Parallel and outside.
			continue;
		}
		const t = q / p;
		if (p < 0) {
			if (t > tMax) return null;
			if (t > tMin) tMin = t;
		} else {
			if (t < tMin) return null;
			if (t < tMax) tMax = t;
		}
	}

	return {
		x1: line.x1 + tMin * dx,
		y1: line.y1 + tMin * dy,
		x2: line.x1 + tMax * dx,
		y2: line.y1 + tMax * dy,
	};
}

function firstMultipleAtOrAfter(value: number, step: number): number {
	return Math.ceil(value / step) * step;
}
