import type { InkCanvasSnapshot, InkPoint, InkStroke, InkStrokeStyle } from '../model/types';
import { DEFAULT_STROKE_STYLE } from '../model/types';
import { WRITING_LINE_HEIGHT } from '../model/constants';
import { BASE_ZOOM } from './pen-model';

/**
 * Reads drawings saved by Ink before 0.5, when it was built on tldraw: either a `.writing` /
 * `.drawing` JSON file or an SVG whose metadata carried the tldraw document. Only freehand
 * shapes become strokes; each keeps its points (z is the pen pressure), its id and its
 * position as the stroke offset. The size follows tldraw's own rule for freehand width
 * (1 + 1.5 × the size step), with the default smoothing so the strokes look as they did.
 */

export interface TldrawDocument {
	store?: Record<string, unknown>;
	document?: { store?: Record<string, unknown> };
	session?: { isGridMode?: boolean };
}

interface FreehandShape {
	id: string;
	x: number;
	y: number;
	props: {
		size: string;
		isPen: boolean;
		segments: Array<{ points: Array<{ x: number; y: number; z?: number }> }>;
	};
}

/** tldraw size steps, in its stroke units. */
const SIZE_STEP: Record<string, number> = { s: 2, m: 3.5, l: 5, xl: 10 };

function recordsOf(doc: TldrawDocument): Record<string, Record<string, unknown>> | null {
	const store = doc.store ?? doc.document?.store;
	return (store as Record<string, Record<string, unknown>> | undefined) ?? null;
}

function isFreehand(record: Record<string, unknown>): boolean {
	return record.typeName === 'shape' && record.type === 'draw';
}

function strokeFromShape(shape: FreehandShape): InkStroke | null {
	const points: InkPoint[] = [];
	for (const segment of shape.props.segments) {
		for (const p of segment.points) points.push([p.x, p.y, p.z ?? 0.5]);
	}
	if (!points.length) return null;
	const step = SIZE_STEP[shape.props.size] ?? SIZE_STEP.m;
	const style: InkStrokeStyle = {
		...DEFAULT_STROKE_STYLE,
		size: 1 + step * 1.5,
		color: 'currentColor',
		simulatePressure: !shape.props.isPen,
		inputKind: shape.props.isPen ? 'pen' : 'mouse',
		captureZoom: BASE_ZOOM,
	};
	return { id: shape.id, points, style, offset: { x: shape.x, y: shape.y } };
}

function collectStrokes(records: Record<string, Record<string, unknown>>): InkStroke[] {
	const strokes: InkStroke[] = [];
	for (const key of Object.keys(records)) {
		const record = records[key];
		if (!isFreehand(record)) continue;
		const stroke = strokeFromShape(record as unknown as FreehandShape);
		if (stroke) strokes.push(stroke);
	}
	return strokes;
}

export function drawingFromTldraw(doc: TldrawDocument): InkCanvasSnapshot {
	const snapshot: InkCanvasSnapshot = { version: 1, strokes: [], gridEnabled: doc.session?.isGridMode !== false };
	const records = recordsOf(doc);
	if (records) snapshot.strokes = collectStrokes(records);
	return snapshot;
}

export function writingFromTldraw(doc: TldrawDocument, fallbackLineHeight: number = WRITING_LINE_HEIGHT): InkCanvasSnapshot {
	const snapshot: InkCanvasSnapshot = { version: 1, strokes: [], gridEnabled: false, writingLineHeight: fallbackLineHeight };
	const records = recordsOf(doc);
	if (!records) return snapshot;
	const meta = (records['document:document'] as { meta?: { writingLineHeight?: unknown } } | undefined)?.meta;
	if (typeof meta?.writingLineHeight === 'number' && meta.writingLineHeight > 0) snapshot.writingLineHeight = meta.writingLineHeight;
	snapshot.strokes = collectStrokes(records);
	return snapshot;
}
