import type { InkCanvasSnapshot, InkMode, InkStroke, InkStrokeStyle } from './types';
import {
	INK_CANVAS_FORMAT_VERSION,
	SVG_PRIMARY_STROKE,
	SVG_STROKE_CLASS,
	SVG_STROKE_CUSTOM_CLASS,
	SVG_WRITING_LINE,
	SVG_WRITING_LINE_CLASS,
	WRITING_LINE_HEIGHT,
	WRITING_MIN_PAGE_HEIGHT,
} from './constants';
import { strokeSvgPath, num2 } from '../geom/outline';
import { approxStrokeBounds, unionRect } from '../geom/bounds';
import { isThemeAdaptiveColor, normaliseInkColor } from '../geom/ink-colors';
import { imageStrokeLocalRect, isImageStroke, orderImagesFirst } from '../geom/ink-images';
import type { PageRect } from './types';
import { drawingFromTldraw, writingFromTldraw, type TldrawDocument } from '../geom/legacy-tldraw';

/**
 * The file is an SVG: the strokes drawn as paths (any viewer, the note preview without the
 * plugin, rsvg for the tutor) plus the stroke data as JSON in `<metadata><ink-canvas>`,
 * the same tag Ink 0.5 reads. Numbers are written rounded (0.01 page unit, pressure 0.001),
 * which is invisible at any zoom and roughly halves the file.
 */

const META_RE = /<ink-canvas version="[^"]*">([\s\S]*?)<\/ink-canvas>/;

export class InkFormatError extends Error {}

const TLDRAW_RE = /<tldraw version="[^"]*">([\s\S]*?)<\/tldraw>/;

/**
 * Reads an ink file: the current `<ink-canvas>` SVG, an older SVG that carried tldraw data,
 * or a pre-0.5 `.writing`/`.drawing` JSON file (both converted on the fly, read-only until saved).
 */
export function parseInkFile(text: string, mode: InkMode = 'drawing'): InkCanvasSnapshot {
	const match = META_RE.exec(text);
	if (!match) {
		const legacy = TLDRAW_RE.exec(text);
		if (legacy) return fromTldraw(JSON.parse(unescapeXml(legacy[1])), mode);
		const trimmed = text.trimStart();
		if (trimmed.startsWith('{')) {
			const json = JSON.parse(trimmed) as { tldraw?: TldrawDocument };
			if (json.tldraw) return fromTldraw(json.tldraw, mode);
		}
		throw new InkFormatError('Arquivo sem dados do Ink');
	}
	const snapshot = JSON.parse(unescapeXml(match[1])) as InkCanvasSnapshot;
	if (!snapshot || !Array.isArray(snapshot.strokes)) throw new InkFormatError('Dados do Ink corrompidos');
	snapshot.strokes = snapshot.strokes.filter(isValidStroke);
	for (const s of snapshot.strokes) if (!s.offset) s.offset = { x: 0, y: 0 };
	return snapshot;
}

function fromTldraw(data: TldrawDocument, mode: InkMode): InkCanvasSnapshot {
	return mode === 'writing' ? writingFromTldraw(data) : drawingFromTldraw(data);
}

export function isInkFileText(text: string): boolean {
	return text.includes('<ink-canvas version=');
}

function isValidStroke(s: InkStroke): boolean {
	return !!s && Array.isArray(s.points) && s.points.length > 0 && !!s.style
		&& s.points.every(p => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]));
}

export function emptySnapshot(mode: InkMode, gridEnabled: boolean): InkCanvasSnapshot {
	return mode === 'writing'
		? { version: 1, strokes: [], gridEnabled, writingLineHeight: WRITING_LINE_HEIGHT }
		: { version: 1, strokes: [], gridEnabled };
}

// Writing
//////////

function round(v: number, k: number): number {
	return Math.round(v * k) / k;
}

function compactStyle(style: InkStrokeStyle): InkStrokeStyle {
	const out: InkStrokeStyle = {
		...style,
		size: round(style.size, 1000),
		thinning: round(style.thinning, 10000),
		smoothing: round(style.smoothing, 10000),
		streamline: round(style.streamline, 10000),
	};
	if (style.captureZoom !== undefined) out.captureZoom = round(style.captureZoom, 10000);
	if (style.opacity !== undefined) out.opacity = round(style.opacity, 1000);
	return out;
}

const jsonCache = new WeakMap<InkStroke, string>();

/**
 * A stroke's rounded, escaped JSON, made once per stroke object (strokes are immutable), so a
 * save only serialises what changed since the last one.
 */
function strokeJsonXml(stroke: InkStroke): string {
	let c = jsonCache.get(stroke);
	if (c === undefined) {
		c = escapeXml(JSON.stringify(compactStrokeUncached(stroke)));
		jsonCache.set(stroke, c);
	}
	return c;
}

/** Fills the save caches of one stroke ahead of time. */
export function warmStroke(stroke: InkStroke): void {
	strokeJsonXml(stroke);
	if (!stroke.image) strokeSvgPath(stroke);
}

function compactStrokeUncached(stroke: InkStroke): InkStroke {
	return {
		...stroke,
		points: stroke.points.map(p => [round(p[0], 100), round(p[1], 100), round(p[2], 1000)]),
		style: compactStyle(stroke.style),
		offset: { x: round(stroke.offset.x, 100), y: round(stroke.offset.y, 100) },
	};
}

export function contentBounds(strokes: InkStroke[]): PageRect | null {
	let r: PageRect | null = null;
	for (const s of strokes) r = unionRect(r, approxStrokeBounds(s));
	return r;
}

/** Page height a writing section needs for its strokes (at least the minimum page). */
export function writingContentHeight(strokes: InkStroke[], lineHeight: number): number {
	const bounds = contentBounds(strokes);
	if (!bounds) return WRITING_MIN_PAGE_HEIGHT;
	const filled = Math.ceil(bounds.maxY / lineHeight);
	return Math.max((filled + 0.5) * lineHeight, WRITING_MIN_PAGE_HEIGHT);
}

export function serializeInkFile(snapshot: InkCanvasSnapshot, mode: InkMode, pageWidth: number): string {
	const strokes = snapshot.strokes;
	let viewBox: string;
	let guides = '';
	if (mode === 'writing') {
		const lineHeight = snapshot.writingLineHeight ?? WRITING_LINE_HEIGHT;
		const height = writingContentHeight(strokes, lineHeight);
		const margin = pageWidth * 0.05;
		const lines: string[] = [];
		for (let i = 1; i <= Math.floor(height / lineHeight); i++) {
			const y = i * lineHeight;
			lines.push(`<line x1="${margin}" y1="${y}" x2="${pageWidth - margin}" y2="${y}" stroke="${SVG_WRITING_LINE}" stroke-opacity="0.5" class="${SVG_WRITING_LINE_CLASS}" />`);
		}
		guides = lines.join('\n') + (lines.length ? '\n' : '');
		viewBox = `0 0 ${pageWidth} ${num2(height)}`;
	} else {
		const bounds = contentBounds(strokes);
		const pad = 16;
		viewBox = bounds
			? [bounds.minX - pad, bounds.minY - pad, bounds.maxX - bounds.minX + pad * 2, bounds.maxY - bounds.minY + pad * 2].map(num2).join(' ')
			: '0 0 1 1';
	}

	const body: string[] = [];
	for (const stroke of orderImagesFirst(strokes)) {
		body.push(isImageStroke(stroke) ? imageMarkup(stroke) : pathMarkup(stroke));
	}

	const { strokes: _omit, ...rest } = snapshot;
	const head = escapeXml(JSON.stringify({ ...rest, strokes: 0 }));
	const marker = escapeXml('"strokes":0');
	const at = head.indexOf(marker);
	const metaXml = head.slice(0, at) + escapeXml('"strokes":[') + strokes.map(strokeJsonXml).join(',') + ']' + head.slice(at + marker.length);
	const themeAttr = snapshot.canvasTheme ? ` data-ink-canvas-theme="${snapshot.canvasTheme}"` : '';
	return [
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}"${themeAttr}>`,
		`<metadata>`,
		`<ink-canvas version="${INK_CANVAS_FORMAT_VERSION}">${metaXml}</ink-canvas>`,
		`</metadata>`,
		guides + body.join(''),
		`</svg>`,
	].join('\n');
}

function pathMarkup(stroke: InkStroke): string {
	const d = strokeSvgPath(stroke);
	if (!d) return '';
	const style = stroke.style;
	const custom = !isThemeAdaptiveColor(style.color);
	const fill = custom ? (normaliseInkColor(style.color) ?? SVG_PRIMARY_STROKE) : SVG_PRIMARY_STROKE;
	const cls = custom ? SVG_STROKE_CUSTOM_CLASS : SVG_STROKE_CLASS;
	const op = style.opacity !== undefined && style.opacity < 1 ? ` fill-opacity="${style.opacity}"` : '';
	const attrs = `d="${d}" fill="${fill}"${op} class="${cls}"`;
	const { x, y } = stroke.offset;
	return x !== 0 || y !== 0
		? `<g transform="translate(${num2(x)},${num2(y)})"><path ${attrs} /></g>\n`
		: `<path ${attrs} />\n`;
}

function imageMarkup(stroke: InkStroke & { image: { src: string } }): string {
	const r = imageStrokeLocalRect(stroke);
	const attrs = `href="${escapeXml(stroke.image.src)}" x="${num2(r.x)}" y="${num2(r.y)}" width="${num2(r.width)}" height="${num2(r.height)}" preserveAspectRatio="none"`;
	const { x, y } = stroke.offset;
	return x !== 0 || y !== 0
		? `<g transform="translate(${num2(x)},${num2(y)})"><image ${attrs} /></g>\n`
		: `<image ${attrs} />\n`;
}

function escapeXml(str: string): string {
	return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function unescapeXml(str: string): string {
	return str
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
		.replace(/&amp;/g, '&');
}
