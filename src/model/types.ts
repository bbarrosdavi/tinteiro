/**
 * Data model. Field for field the same as the files Ink 0.5.x writes, so every existing
 * drawing opens here and every file written here still opens in the old plugin.
 */

/** One pen sample: page x, page y, pressure 0..1. */
export type InkPoint = [x: number, y: number, pressure: number];

export interface InkStrokeStyle {
	/** Base diameter in page units. */
	size: number;
	thinning: number;
	smoothing: number;
	streamline: number;
	simulatePressure: boolean;
	inputKind?: 'pen' | 'mouse';
	/** CSS colour, or `currentColor` for ink that follows the theme. */
	color: string;
	/** 0..1, omitted at full strength. */
	opacity?: number;
	/** Camera zoom when the stroke was drawn. */
	captureZoom?: number;
}

export interface InkStrokeImage {
	/** Data URL, so the file stays self-contained. */
	src: string;
}

export interface InkStroke {
	id: string;
	authoringSource?: 'local' | 'boox';
	points: InkPoint[];
	style: InkStrokeStyle;
	offset: { x: number; y: number };
	startedAt?: number;
	finishedAt?: number;
	/** A pasted image: the two points are its corners. */
	image?: InkStrokeImage;
}

export interface CameraState {
	x: number;
	y: number;
	zoom: number;
}

export interface InkCanvasSnapshot {
	version: 1;
	strokes: InkStroke[];
	camera?: CameraState;
	gridEnabled: boolean;
	writingLineHeight?: number;
	canvasTheme?: 'light' | 'dark';
}

export type InkMode = 'writing' | 'drawing';

export const DEFAULT_STROKE_STYLE: InkStrokeStyle = {
	size: 8,
	thinning: 0.5,
	smoothing: 0.5,
	streamline: 0.5,
	simulatePressure: true,
	color: 'currentColor',
};

export type InkTool =
	| 'draw' | 'erase' | 'select' | 'pan'
	| 'line' | 'arrow' | 'spline' | 'ellipse' | 'rect' | 'plot2d' | 'axes3d' | 'cube';

export const INK_SHAPE_TOOLS = [
	'line', 'arrow', 'spline', 'ellipse', 'rect', 'plot2d', 'axes3d', 'cube',
] as const;

export type InkShapeTool = (typeof INK_SHAPE_TOOLS)[number];

export function isInkShapeTool(tool: InkTool): tool is InkShapeTool {
	return (INK_SHAPE_TOOLS as readonly string[]).includes(tool);
}

export type StrokeInputKind = 'pen' | 'mouse';

export interface PageRect {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
}
