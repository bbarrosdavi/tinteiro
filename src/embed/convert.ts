import type { InkCanvasSnapshot, InkMode, InkStroke } from '../model/types';
import { WRITING_MIN_PAGE_HEIGHT, WRITING_PAGE_WIDTH } from '../model/constants';
import { contentBounds } from '../model/format';
import type { EmbedParams } from '../obsidian/embed-syntax';
import { newDrawingParams } from '../obsidian/embed-syntax';

/**
 * Drawing ↔ writing. Drawing to writing scales the content (never up) to fit the page between
 * its 5 % margins, starting half a line down; writing to drawing keeps every coordinate and
 * frames the content.
 */
export function convertStrokes(
	snapshot: InkCanvasSnapshot,
	from: InkMode,
	to: InkMode,
	lineHeight: number,
): { strokes: InkStroke[]; snapshot: Omit<InkCanvasSnapshot, 'strokes'>; params: EmbedParams } {
	const { strokes, ...rest } = snapshot;
	if (from === to) return { strokes, snapshot: rest, params: {} };
	const bounds = contentBounds(strokes);

	if (to === 'writing') {
		const meta = { ...rest, writingLineHeight: lineHeight };
		delete meta.camera;
		if (!bounds) return { strokes, snapshot: meta, params: {} };
		const margin = WRITING_PAGE_WIDTH * 0.05;
		const contentWidth = WRITING_PAGE_WIDTH - 2 * margin;
		const topY = lineHeight * 0.5;
		const w = bounds.maxX - bounds.minX;
		const h = bounds.maxY - bounds.minY;
		let scale = Math.min(w > 0 ? contentWidth / w : 1, 1);
		const projected = topY + h * scale;
		const page = Math.max((Math.ceil(projected / lineHeight) + 0.5) * lineHeight, WRITING_MIN_PAGE_HEIGHT);
		if (h * scale > page - topY) scale = Math.min(scale, (page - topY) / h);
		const tx = margin + (contentWidth - w * scale) / 2 - bounds.minX * scale;
		const ty = topY - bounds.minY * scale;
		const out = strokes.map(s => ({
			...s,
			points: s.points.map(([x, y, p]) => [x * scale, y * scale, p] as [number, number, number]),
			offset: { x: s.offset.x * scale + tx, y: s.offset.y * scale + ty },
			style: { ...s.style, size: s.style.size * scale },
		}));
		return { strokes: out, snapshot: meta, params: {} };
	}

	const meta = { ...rest };
	delete meta.writingLineHeight;
	const params = newDrawingParams();
	if (bounds) {
		const pad = 32;
		const w = bounds.maxX - bounds.minX + pad * 2;
		const h = bounds.maxY - bounds.minY + pad * 2;
		params.aspectRatio = Math.max(0.5, Math.min(3, w / h));
		const vw = Math.max(w, h * params.aspectRatio);
		params.viewBox = { x: bounds.minX - pad, y: bounds.minY - pad, width: vw, height: vw / params.aspectRatio };
	}
	return { strokes, snapshot: meta, params };
}
