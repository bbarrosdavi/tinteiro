import type { InkPoint, InkStroke, InkStrokeStyle } from '../model/types';

///////////////////////////
///////////////////////////

/** Shape tools that draw a figure from a drag rather than from freehand input. */
export type PlotShapeKind =
	| 'line'
	| 'arrow'
	| 'spline'
	| 'ellipse'
	| 'rect'
	| 'plot2d'
	| 'axes3d'
	| 'cube';

export interface PlotPoint {
	x: number;
	y: number;
}

export interface PlotShapeOptions {
	/** Drag origin in page units. */
	start: PlotPoint;
	/** Current/last drag position in page units. */
	end: PlotPoint;
	/** Style the strokes are drawn with (colour and size come from the toolbar). */
	style: InkStrokeStyle;
	/** Hold shift: line snaps to 15°, ellipse becomes a circle, plots stay square. */
	constrain?: boolean;
	/** Number of ticks per half-axis on `plot2d`. */
	tickCount?: number;
}

/** Pressure written into generated points — constant, so figures have an even width. */
const FIGURE_PRESSURE = 0.5;

const ELLIPSE_SEGMENTS = 96;
const LINE_SEGMENTS = 12;
const DEFAULT_TICK_COUNT = 5;
/** Arrow head length as a fraction of the axis half-length. Small: an axis marker, not a dart. */
const ARROW_HEAD_RATIO = 0.07;
const MIN_ARROW_HEAD = 4;
/** Isometric axes sit 30° below the horizon. */
const ISOMETRIC_AXIS_ANGLE = Math.PI / 6;
/** Tick half-length in page units, scaled by stroke size so it stays visible. */
const TICK_HALF_LENGTH = 4;
/** Samples along a spline. */
const SPLINE_SEGMENTS = 48;

///////////////////////////

/**
 * Builds the strokes for a figure.
 *
 * Figures are ordinary {@link InkStroke}s: they erase, move, undo, export and
 * re-render exactly like handwriting, and the file format does not change. The
 * trade-off is that a figure is not re-editable as a parametric object once drawn.
 */
export function buildPlotShapeStrokes(kind: PlotShapeKind, options: PlotShapeOptions): InkStroke[] {
	const style = figureStyle(options.style);
	switch (kind) {
		case 'line':
			return [strokeFrom(buildLinePoints(options), style)];
		case 'arrow':
			return buildArrowStrokes(options, style);
		case 'spline':
			return [strokeFrom(buildSplinePoints(options), style)];
		case 'ellipse':
			return [strokeFrom(buildEllipsePoints(options), style)];
		case 'rect':
			return [strokeFrom(buildRectPoints(options), style)];
		case 'plot2d':
			return buildCartesianPlaneStrokes(options, style);
		case 'axes3d':
			return buildAxes3dStrokes(options, style);
		case 'cube':
			return buildCubeStrokes(options, style);
	}
}

/** A figure never tapers with pressure and is not smoothed like handwriting. */
export function figureStyle(style: InkStrokeStyle): InkStrokeStyle {
	const figure: InkStrokeStyle = {
		...style,
		thinning: 0,
		smoothing: 0.5,
		streamline: 0,
		simulatePressure: false,
		inputKind: 'mouse',
	};
	delete figure.captureZoom;
	return figure;
}

///////////////////////////
// Geometry

export function buildLinePoints(options: PlotShapeOptions): InkPoint[] {
	const end = options.constrain ? snapToAngle(options.start, options.end) : options.end;
	return samplePolyline([options.start, end], LINE_SEGMENTS);
}

export function buildEllipsePoints(options: PlotShapeOptions): InkPoint[] {
	const { start } = options;
	const end = options.constrain ? squareOff(start, options.end) : options.end;

	const cx = (start.x + end.x) / 2;
	const cy = (start.y + end.y) / 2;
	const rx = Math.abs(end.x - start.x) / 2;
	const ry = Math.abs(end.y - start.y) / 2;

	const points: InkPoint[] = [];
	for (let i = 0; i <= ELLIPSE_SEGMENTS; i++) {
		const angle = (i / ELLIPSE_SEGMENTS) * Math.PI * 2;
		points.push([cx + rx * Math.cos(angle), cy + ry * Math.sin(angle), FIGURE_PRESSURE]);
	}
	return points;
}

/**
 * Cartesian plane: two axes crossing at the drag origin, each with an arrow head and
 * evenly spaced ticks. The drag defines the half-extent, so the origin stays where the
 * pen went down.
 */
export function buildCartesianPlaneStrokes(options: PlotShapeOptions, style: InkStrokeStyle): InkStroke[] {
	const { start } = options;
	const end = options.constrain ? squareOff(start, options.end) : options.end;

	const halfWidth = Math.abs(end.x - start.x);
	const halfHeight = Math.abs(end.y - start.y);
	if (halfWidth < 1 || halfHeight < 1) return [];

	const strokes: InkStroke[] = [];

	// Axes.
	const xAxis: PlotPoint[] = [{ x: start.x - halfWidth, y: start.y }, { x: start.x + halfWidth, y: start.y }];
	const yAxis: PlotPoint[] = [{ x: start.x, y: start.y + halfHeight }, { x: start.x, y: start.y - halfHeight }];
	strokes.push(strokeFrom(samplePolyline(xAxis, LINE_SEGMENTS), style));
	strokes.push(strokeFrom(samplePolyline(yAxis, LINE_SEGMENTS), style));

	// Arrow heads at the positive ends (right and up).
	strokes.push(...arrowHeadStrokes(xAxis[1], { x: 1, y: 0 }, halfWidth, style));
	strokes.push(...arrowHeadStrokes(yAxis[1], { x: 0, y: -1 }, halfHeight, style));

	// Ticks.
	const tickCount = Math.max(0, options.tickCount ?? DEFAULT_TICK_COUNT);
	const tickHalf = TICK_HALF_LENGTH * Math.max(1, style.size / 8);
	for (let i = 1; i <= tickCount; i++) {
		const dx = (halfWidth * i) / (tickCount + 1);
		const dy = (halfHeight * i) / (tickCount + 1);
		for (const sign of [-1, 1]) {
			strokes.push(strokeFrom(samplePolyline([
				{ x: start.x + sign * dx, y: start.y - tickHalf },
				{ x: start.x + sign * dx, y: start.y + tickHalf },
			], 2), style));
			strokes.push(strokeFrom(samplePolyline([
				{ x: start.x - tickHalf, y: start.y + sign * dy },
				{ x: start.x + tickHalf, y: start.y + sign * dy },
			], 2), style));
		}
	}

	return strokes;
}

/**
 * Isometric 3D axes: z straight up, x and y below the horizon, each drawn through the
 * origin so the figure has **six semi-axes**.
 *
 * The drag controls the perspective, like the 2D plane: its width sets the horizontal
 * reach of the diagonal axes and its height sets the z half-length AND the diagonals'
 * vertical drop — so a wide drag flattens the axes and a tall one steepens them. A
 * square drag (or shift) gives the canonical ±30°.
 *
 * Arrow heads mark the three positive ends. Ticks sit on the positive halves only and
 * are short — six full-length tick rows crossing at the origin read as a snowflake.
 */
export function buildAxes3dStrokes(options: PlotShapeOptions, style: InkStrokeStyle): InkStroke[] {
	const { start } = options;
	const end = options.constrain ? squareOff(start, options.end) : options.end;
	const halfWidth = Math.abs(end.x - start.x);
	const halfHeight = Math.abs(end.y - start.y);
	if (halfWidth < 1 || halfHeight < 1) return [];

	// Square drag: drop/halfWidth = tan(30°), the standard axonometric angle.
	const drop = halfHeight * Math.tan(ISOMETRIC_AXIS_ANGLE);

	// Positive semi-axis endpoints, relative to the origin.
	const axes: PlotPoint[] = [
		{ x: 0, y: -halfHeight },     // z, up
		{ x: halfWidth, y: drop },    // y, right and down
		{ x: -halfWidth, y: drop },   // x, left and down
	];

	const tickCount = Math.max(0, options.tickCount ?? DEFAULT_TICK_COUNT);
	const tickHalf = TICK_HALF_LENGTH * 0.6 * Math.max(1, style.size / 8);

	const strokes: InkStroke[] = [];
	for (const axis of axes) {
		const length = Math.hypot(axis.x, axis.y);
		const direction = { x: axis.x / length, y: axis.y / length };
		const positiveTip = { x: start.x + axis.x, y: start.y + axis.y };
		const negativeTip = { x: start.x - axis.x, y: start.y - axis.y };

		strokes.push(strokeFrom(samplePolyline([negativeTip, positiveTip], LINE_SEGMENTS), style));
		strokes.push(...arrowHeadStrokes(positiveTip, direction, length, style));
		strokes.push(...axisTickStrokes(start, direction, length, tickCount, tickHalf, style));
	}
	return strokes;
}

/** Ticks along the positive half of an axis, drawn perpendicular to its direction. */
function axisTickStrokes(
	origin: PlotPoint,
	direction: PlotPoint,
	length: number,
	tickCount: number,
	tickHalf: number,
	style: InkStrokeStyle,
): InkStroke[] {
	const normal = { x: -direction.y, y: direction.x };
	const strokes: InkStroke[] = [];

	for (let i = 1; i <= tickCount; i++) {
		const distance = (length * i) / (tickCount + 1);
		const centre = {
			x: origin.x + direction.x * distance,
			y: origin.y + direction.y * distance,
		};
		strokes.push(strokeFrom(samplePolyline([
			{ x: centre.x - normal.x * tickHalf, y: centre.y - normal.y * tickHalf },
			{ x: centre.x + normal.x * tickHalf, y: centre.y + normal.y * tickHalf },
		], 2), style));
	}

	return strokes;
}

/** A straight shaft with an arrow head at the drag end. */
export function buildArrowStrokes(options: PlotShapeOptions, style: InkStrokeStyle): InkStroke[] {
	const { start } = options;
	const end = options.constrain ? snapToAngle(start, options.end) : options.end;
	const length = Math.hypot(end.x - start.x, end.y - start.y);
	if (length < 1) return [];

	const direction = { x: (end.x - start.x) / length, y: (end.y - start.y) / length };
	return [
		strokeFrom(samplePolyline([start, end], LINE_SEGMENTS), style),
		...arrowHeadStrokes(end, direction, length, style),
	];
}

/**
 * S-curve between the drag ends: a cubic Bézier whose tangents run along the drag's
 * dominant axis, so a mostly-horizontal drag gives the familiar connector shape and a
 * vertical drag gives its rotated twin.
 */
export function buildSplinePoints(options: PlotShapeOptions): InkPoint[] {
	const { start, end } = options;
	const dx = end.x - start.x;
	const dy = end.y - start.y;

	const horizontal = Math.abs(dx) >= Math.abs(dy);
	const control1: PlotPoint = horizontal
		? { x: start.x + dx * 0.45, y: start.y }
		: { x: start.x, y: start.y + dy * 0.45 };
	const control2: PlotPoint = horizontal
		? { x: end.x - dx * 0.45, y: end.y }
		: { x: end.x, y: end.y - dy * 0.45 };

	const points: InkPoint[] = [];
	for (let i = 0; i <= SPLINE_SEGMENTS; i++) {
		const t = i / SPLINE_SEGMENTS;
		const u = 1 - t;
		points.push([
			u * u * u * start.x + 3 * u * u * t * control1.x + 3 * u * t * t * control2.x + t * t * t * end.x,
			u * u * u * start.y + 3 * u * u * t * control1.y + 3 * u * t * t * control2.y + t * t * t * end.y,
			FIGURE_PRESSURE,
		]);
	}
	return points;
}

/** Axis-aligned rectangle over the drag bounding box; shift makes it a square. */
export function buildRectPoints(options: PlotShapeOptions): InkPoint[] {
	const { start } = options;
	const end = options.constrain ? squareOff(start, options.end) : options.end;

	const corners: PlotPoint[] = [
		{ x: start.x, y: start.y },
		{ x: end.x, y: start.y },
		{ x: end.x, y: end.y },
		{ x: start.x, y: end.y },
		{ x: start.x, y: start.y },
	];
	return samplePolyline(corners, 8);
}

/**
 * Isometric cube wireframe. The unit cube's 8 vertices are projected with the standard
 * axonometric mapping and scaled so the figure roughly fills the drag; all 12 edges are
 * drawn, one stroke each, so partial erasing works edge by edge.
 */
export function buildCubeStrokes(options: PlotShapeOptions, style: InkStrokeStyle): InkStroke[] {
	const { start, end } = options;
	const span = Math.max(Math.abs(end.x - start.x), Math.abs(end.y - start.y));
	if (span < 2) return [];

	// Projected height of an edge-e cube is 2e (e from z, plus e from x+y foreshortening).
	const edge = span / 2;
	const cos = Math.cos(ISOMETRIC_AXIS_ANGLE);
	const sin = Math.sin(ISOMETRIC_AXIS_ANGLE);
	const project = (x: number, y: number, z: number): PlotPoint => ({
		x: (x - y) * cos * edge,
		y: (x + y) * sin * edge - z * edge,
	});

	// Centre the projected figure on the midpoint of the drag.
	const vertices: PlotPoint[] = [];
	for (let x = 0; x <= 1; x++) for (let y = 0; y <= 1; y++) for (let z = 0; z <= 1; z++) {
		vertices.push(project(x, y, z));
	}
	const minX = Math.min(...vertices.map(v => v.x));
	const maxX = Math.max(...vertices.map(v => v.x));
	const minY = Math.min(...vertices.map(v => v.y));
	const maxY = Math.max(...vertices.map(v => v.y));
	const centre = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
	const offsetX = centre.x - (minX + maxX) / 2;
	const offsetY = centre.y - (minY + maxY) / 2;

	const at = (x: number, y: number, z: number): PlotPoint => {
		const p = project(x, y, z);
		return { x: p.x + offsetX, y: p.y + offsetY };
	};

	// The 12 edges of the unit cube, as vertex-coordinate pairs.
	const edges: Array<[number[], number[]]> = [];
	for (let x = 0; x <= 1; x++) for (let y = 0; y <= 1; y++) for (let z = 0; z <= 1; z++) {
		if (x === 0) edges.push([[0, y, z], [1, y, z]]);
		if (y === 0) edges.push([[x, 0, z], [x, 1, z]]);
		if (z === 0) edges.push([[x, y, 0], [x, y, 1]]);
	}

	return edges.map(([a, b]) => strokeFrom(
		samplePolyline([at(a[0], a[1], a[2]), at(b[0], b[1], b[2])], 4),
		style,
	));
}

///////////////////////////
// Helpers

/** Two short strokes forming a V at `tip`, opening back along `direction`. */
function arrowHeadStrokes(
	tip: PlotPoint,
	direction: PlotPoint,
	axisLength: number,
	style: InkStrokeStyle,
): InkStroke[] {
	const headLength = Math.max(MIN_ARROW_HEAD, axisLength * ARROW_HEAD_RATIO);
	const angle = Math.atan2(direction.y, direction.x);
	const spread = Math.PI / 7;

	const wings: PlotPoint[] = [
		{
			x: tip.x - headLength * Math.cos(angle - spread),
			y: tip.y - headLength * Math.sin(angle - spread),
		},
		{
			x: tip.x - headLength * Math.cos(angle + spread),
			y: tip.y - headLength * Math.sin(angle + spread),
		},
	];

	return wings.map(wing => strokeFrom(samplePolyline([tip, wing], 2), style));
}

/** Samples a polyline into evenly spaced points so the outline generator has enough to work with. */
export function samplePolyline(points: PlotPoint[], segmentsPerEdge: number): InkPoint[] {
	const sampled: InkPoint[] = [];
	const segments = Math.max(1, Math.floor(segmentsPerEdge));

	for (let i = 0; i < points.length - 1; i++) {
		const from = points[i];
		const to = points[i + 1];
		for (let s = 0; s < segments; s++) {
			const t = s / segments;
			sampled.push([
				from.x + (to.x - from.x) * t,
				from.y + (to.y - from.y) * t,
				FIGURE_PRESSURE,
			]);
		}
	}

	const last = points[points.length - 1];
	sampled.push([last.x, last.y, FIGURE_PRESSURE]);
	return sampled;
}

/** Shift-drag: snap the segment to the nearest 15°. */
export function snapToAngle(start: PlotPoint, end: PlotPoint, stepDegrees = 15): PlotPoint {
	const dx = end.x - start.x;
	const dy = end.y - start.y;
	const length = Math.hypot(dx, dy);
	if (length === 0) return end;

	const step = (stepDegrees * Math.PI) / 180;
	const snapped = Math.round(Math.atan2(dy, dx) / step) * step;
	return {
		x: start.x + Math.cos(snapped) * length,
		y: start.y + Math.sin(snapped) * length,
	};
}

/** Shift-drag: force the bounding box square, keeping the drag direction. */
export function squareOff(start: PlotPoint, end: PlotPoint): PlotPoint {
	const dx = end.x - start.x;
	const dy = end.y - start.y;
	const size = Math.max(Math.abs(dx), Math.abs(dy));
	return {
		x: start.x + Math.sign(dx || 1) * size,
		y: start.y + Math.sign(dy || 1) * size,
	};
}

let figureIdCounter = 0;

function strokeFrom(points: InkPoint[], style: InkStrokeStyle): InkStroke {
	figureIdCounter += 1;
	return {
		id: `f_${Date.now()}_${figureIdCounter}`,
		authoringSource: 'local',
		points,
		style: { ...style },
		offset: { x: 0, y: 0 },
		startedAt: Date.now(),
		finishedAt: Date.now(),
	};
}
