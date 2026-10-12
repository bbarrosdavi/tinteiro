import type { InkStroke, PageRect } from '../model/types';

/** Bounds of the raw points, padded by the stroke size; cheap enough for every frame. */
export function approxStrokeBounds(stroke: InkStroke): PageRect {
	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	for (const p of stroke.points) {
		if (p[0] < minX) minX = p[0];
		if (p[1] < minY) minY = p[1];
		if (p[0] > maxX) maxX = p[0];
		if (p[1] > maxY) maxY = p[1];
	}
	if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
	const pad = stroke.image ? 0 : Math.max(stroke.style.size, 1);
	return {
		minX: minX + stroke.offset.x - pad,
		minY: minY + stroke.offset.y - pad,
		maxX: maxX + stroke.offset.x + pad,
		maxY: maxY + stroke.offset.y + pad,
	};
}

export function unionRect(a: PageRect | null, b: PageRect): PageRect {
	if (!a) return { ...b };
	return {
		minX: Math.min(a.minX, b.minX),
		minY: Math.min(a.minY, b.minY),
		maxX: Math.max(a.maxX, b.maxX),
		maxY: Math.max(a.maxY, b.maxY),
	};
}

export function rectsOverlap(a: PageRect, b: PageRect): boolean {
	return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}
