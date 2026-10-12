import type { CameraState, InkPoint, InkStroke, InkStrokeStyle, PageRect } from '../model/types';
import { strokeOutline, strokePath, traceOutline } from '../geom/outline';
import { approxStrokeBounds, rectsOverlap } from '../geom/bounds';
import { isThemeAdaptiveColor } from '../geom/ink-colors';
import { imageStrokeRect, isImageStroke } from '../geom/ink-images';
import { buildLayoutGeometry, resolveSpacing, type InkLayout } from '../geom/background-layouts';

/**
 * Two stacked canvases, the niri-scribe split:
 *
 * - **base**: paper and every committed stroke, rasterised once. A new stroke is painted on
 *   top of what is there; an erase or undo repaints only the rectangle it touched.
 *   While editing a drawing the base is larger than the view (a margin on every side) and
 *   panning moves it with a CSS transform, which the compositor does on the GPU without
 *   repainting anything; it is painted again only when the view leaves the margin. Pinch and
 *   wheel zoom scale the same bitmap and repaint it sharp once the zoom rests.
 * - **live**: the stroke under the pen and the overlays (selection, eraser ring, figure
 *   preview). Each frame clears only the box it painted the frame before.
 *
 * Canvas pixels never touch the DOM tree, so painting does not wake CodeMirror's
 * MutationObserver or restyle the note, which is where the old SVG engine lost its frames.
 */

import type { Palette, Background, OverlayPainter, InkRenderer } from './renderer';

const LIVE_MARGIN_PX = 4;
/** Sharp repaint after the zoom has been still this long. */
const ZOOM_SETTLE_MS = 120;
/** Backing-store budget per layer, in device pixels. */
const MAX_LAYER_PIXELS = 16_000_000;

export class InkRenderer2D implements InkRenderer {
	readonly base: HTMLCanvasElement;
	readonly live: HTMLCanvasElement;
	private baseCtx: CanvasRenderingContext2D;
	private liveCtx: CanvasRenderingContext2D;

	cssWidth = 0;
	cssHeight = 0;
	private dpr = 1;
	private baseDpr = 1;
	/** Margin of the base layer around the view, as a fraction of the view size. */
	private margin = 0;
	private wantMargin = 0;
	/** Camera of the input and the live layer. */
	camera: CameraState = { x: 0, y: 0, zoom: 1 };
	/** Camera the base bitmap was painted with. */
	private baseCamera: CameraState = { x: 0, y: 0, zoom: 1 };
	private transformCss = '';
	private zoomTimer = 0;
	palette: Palette = { ink: '#1c1c1e', rule: '#cfcfc7', accent: '#4a7cff' };
	background: Background | null = null;

	private strokes: readonly InkStroke[] = [];
	/** Strokes left out of the base layer (e.g. being dragged, which the live layer paints). */
	hidden: ReadonlySet<InkStroke> = new Set();
	private baseDirty = true;
	private dirtyRegions: PageRect[] = [];
	private frame = 0;
	private liveBox: { x: number; y: number; w: number; h: number } | null = null;
	private liveStrokes: InkStroke[] = [];
	private floating: { strokes: InkStroke[]; dx: number; dy: number } | null = null;
	private overlays: OverlayPainter[] = [];
	private images = new Map<string, HTMLImageElement>();
	private disposed = false;
	onFrame?: () => void;

	constructor(host: HTMLElement) {
		this.base = host.ownerDocument.createElement('canvas');
		this.live = host.ownerDocument.createElement('canvas');
		this.base.className = 'layer layer--base';
		this.live.className = 'layer layer--live';
		host.append(this.base, this.live);
		this.baseCtx = this.base.getContext('2d', { alpha: true })!;
		// Low-latency path where the platform has one (front-buffer rendering).
		this.liveCtx = this.live.getContext('2d', { alpha: true, desynchronized: true })!;
	}

	dispose(): void {
		this.disposed = true;
		if (this.frame) cancelAnimationFrame(this.frame);
		window.clearTimeout(this.zoomTimer);
		// Release the GPU backing right away instead of waiting for GC.
		this.base.width = this.base.height = 0;
		this.live.width = this.live.height = 0;
		this.base.remove();
		this.live.remove();
	}

	// Geometry
	//////////

	/**
	 * Base-layer margin for panning without repainting (0 for pages that never pan: writing,
	 * locked previews).
	 */
	setPanMargin(fraction: number): void {
		if (fraction === this.wantMargin) return;
		this.wantMargin = fraction;
		this.applySize();
	}

	setSize(cssWidth: number, cssHeight: number): void {
		const w = Math.max(1, Math.round(cssWidth));
		const h = Math.max(1, Math.round(cssHeight));
		if (w === this.cssWidth && h === this.cssHeight) return;
		this.cssWidth = w;
		this.cssHeight = h;
		this.applySize();
	}

	private applySize(): void {
		const w = this.cssWidth;
		const h = this.cssHeight;
		if (!w || !h) return;
		let dpr = window.devicePixelRatio || 1;
		// A very long writing section would need a huge backing store; trade sharpness for it.
		if (w * h * dpr * dpr > MAX_LAYER_PIXELS) dpr = Math.sqrt(MAX_LAYER_PIXELS / (w * h));
		this.dpr = dpr;
		this.live.width = Math.round(w * dpr);
		this.live.height = Math.round(h * dpr);
		this.live.style.width = `${w}px`;
		this.live.style.height = `${h}px`;

		let m = this.wantMargin;
		const area = (k: number) => w * h * (1 + 2 * k) ** 2 * dpr * dpr;
		while (m > 0 && area(m) > MAX_LAYER_PIXELS) m = Math.max(0, m - 0.1);
		this.margin = m;
		this.baseDpr = dpr;
		const bw = w * (1 + 2 * m);
		const bh = h * (1 + 2 * m);
		this.base.width = Math.round(bw * dpr);
		this.base.height = Math.round(bh * dpr);
		this.base.style.width = `${bw}px`;
		this.base.style.height = `${bh}px`;
		this.base.style.left = `${-m * w}px`;
		this.base.style.top = `${-m * h}px`;
		this.base.style.transformOrigin = `${m * w}px ${m * h}px`;
		this.liveBox = null;
		this.invalidate();
	}

	setCamera(camera: CameraState): void {
		const c = this.camera;
		if (c.x === camera.x && c.y === camera.y && c.zoom === camera.zoom) return;
		this.camera = { ...camera };
		// Live overlays were drawn for the old camera: clear the whole live layer next frame.
		if (this.liveBox) this.liveBox = { x: 0, y: 0, w: this.live.width, h: this.live.height };
		if (this.baseDirty) {
			this.schedule();
			return;
		}
		const b = this.baseCamera;
		const s = camera.zoom / b.zoom;
		const tx = (camera.x - b.x) * camera.zoom;
		const ty = (camera.y - b.y) * camera.zoom;
		if (s === 1) {
			const mx = this.margin * this.cssWidth;
			const my = this.margin * this.cssHeight;
			if (Math.abs(tx) <= mx && Math.abs(ty) <= my) {
				this.setBaseTransform(tx, ty, 1);
				this.schedule();
				return;
			}
			this.invalidate();
			return;
		}
		// Zooming: scale the bitmap now, paint it sharp when the zoom rests.
		this.setBaseTransform(tx, ty, s);
		window.clearTimeout(this.zoomTimer);
		this.zoomTimer = window.setTimeout(() => this.invalidate(), ZOOM_SETTLE_MS);
		this.schedule();
	}

	private setBaseTransform(tx: number, ty: number, s: number): void {
		const css = tx === 0 && ty === 0 && s === 1 ? '' : `translate(${tx}px, ${ty}px) scale(${s})`;
		if (css !== this.transformCss) {
			this.transformCss = css;
			this.base.style.transform = css;
		}
	}

	setPalette(palette: Palette): void {
		const p = this.palette;
		if (p.ink === palette.ink && p.rule === palette.rule && p.accent === palette.accent) return;
		this.palette = palette;
		this.invalidate();
	}

	setBackground(background: Background | null): void {
		const a = this.background;
		if (a === background || (a && background && a.layout === background.layout && a.lineHeight === background.lineHeight
			&& a.mode === background.mode && a.pageWidth === background.pageWidth && a.pageHeight === background.pageHeight
			&& a.dotScale === background.dotScale)) return;
		this.background = background;
		this.invalidate();
	}

	pageToCss(x: number, y: number): { x: number; y: number } {
		const c = this.camera;
		return { x: (x + c.x) * c.zoom, y: (y + c.y) * c.zoom };
	}

	cssToPage(x: number, y: number): { x: number; y: number } {
		const c = this.camera;
		return { x: x / c.zoom - c.x, y: y / c.zoom - c.y };
	}

	visiblePageRect(): PageRect {
		const a = this.cssToPage(0, 0);
		const b = this.cssToPage(this.cssWidth, this.cssHeight);
		return { minX: a.x, minY: a.y, maxX: b.x, maxY: b.y };
	}

	/** Page area the base bitmap covers (view plus margins), in its own camera. */
	private basePageRect(): PageRect {
		const c = this.baseCamera;
		const mx = this.margin * this.cssWidth;
		const my = this.margin * this.cssHeight;
		return {
			minX: -mx / c.zoom - c.x,
			minY: -my / c.zoom - c.y,
			maxX: (this.cssWidth + mx) / c.zoom - c.x,
			maxY: (this.cssHeight + my) / c.zoom - c.y,
		};
	}

	// Content
	//////////

	setStrokes(strokes: readonly InkStroke[]): void {
		this.strokes = strokes;
		this.invalidate();
	}

	/** Paints strokes that were appended on top, without repainting the page. */
	appendStrokes(all: readonly InkStroke[], added: InkStroke[]): void {
		this.strokes = all;
		if (this.baseDirty) return;
		if (added.some(isImageStroke)) {
			for (const s of added) this.invalidateRegion(approxStrokeBounds(s));
			return;
		}
		const ctx = this.baseCtx;
		this.applyBaseTransform(ctx);
		const view = this.basePageRect();
		for (const s of added) this.paintStroke(ctx, s, view);
	}

	/** New stroke list where only the given page area changed (erase, undo, move). */
	updateStrokes(all: readonly InkStroke[], changed: PageRect | null): void {
		this.strokes = all;
		if (changed) this.invalidateRegion(changed);
		else this.invalidate();
	}

	setHidden(hidden: ReadonlySet<InkStroke>, region?: PageRect | null): void {
		this.hidden = hidden;
		if (region) this.invalidateRegion(region);
		else this.invalidate();
	}

	invalidate(): void {
		this.baseDirty = true;
		this.dirtyRegions = [];
		this.schedule();
	}

	invalidateRegion(r: PageRect): void {
		if (this.baseDirty) return;
		this.dirtyRegions.push(r);
		this.schedule();
	}

	// Live layer
	//////////

	setLiveStroke(points: InkPoint[] | null, style?: InkStrokeStyle): void {
		this.liveStrokes = points && style ? [{ id: 'live', points, style, offset: { x: 0, y: 0 } }] : [];
		this.schedule();
	}

	setLiveStrokes(strokes: InkStroke[]): void {
		this.liveStrokes = strokes;
		this.schedule();
	}

	setFloating(floating: { strokes: InkStroke[]; dx: number; dy: number } | null): void {
		this.floating = floating;
		this.schedule();
	}

	setOverlays(overlays: OverlayPainter[]): void {
		this.overlays = overlays;
		this.schedule();
	}

	requestLive(): void {
		this.schedule();
	}

	/** Paints now instead of on the next frame. */
	flush(): void {
		if (this.frame) {
			cancelAnimationFrame(this.frame);
			this.frame = 0;
		}
		this.paint();
	}

	private schedule(): void {
		if (this.frame || this.disposed) return;
		this.frame = requestAnimationFrame(() => {
			this.frame = 0;
			this.paint();
		});
	}

	private paint(): void {
		if (this.disposed) return;
		if (this.baseDirty) this.paintBase();
		else if (this.dirtyRegions.length) this.paintRegions();
		this.paintLive();
		this.onFrame?.();
	}

	private applyTransform(ctx: CanvasRenderingContext2D): void {
		const { zoom, x, y } = this.camera;
		const k = this.dpr * zoom;
		ctx.setTransform(k, 0, 0, k, x * k, y * k);
	}

	/** Page → base bitmap pixels (its camera, its margin). */
	private applyBaseTransform(ctx: CanvasRenderingContext2D): void {
		const { zoom, x, y } = this.baseCamera;
		const k = this.baseDpr * zoom;
		const ox = this.margin * this.cssWidth * this.baseDpr;
		const oy = this.margin * this.cssHeight * this.baseDpr;
		ctx.setTransform(k, 0, 0, k, x * k + ox, y * k + oy);
	}

	private paintBase(): void {
		this.baseDirty = false;
		this.dirtyRegions = [];
		window.clearTimeout(this.zoomTimer);
		this.baseCamera = { ...this.camera };
		this.setBaseTransform(0, 0, 1);
		const ctx = this.baseCtx;
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.clearRect(0, 0, this.base.width, this.base.height);
		const area = this.basePageRect();
		this.paintBackground(ctx, area);
		this.applyBaseTransform(ctx);
		for (const s of this.strokes) {
			if (this.hidden.has(s)) continue;
			this.paintStroke(ctx, s, area);
		}
		ctx.globalAlpha = 1;
	}

	/** Repaints only the rectangles that changed, clipped, in stacking order. */
	private paintRegions(): void {
		const regions = this.dirtyRegions;
		this.dirtyRegions = [];
		let r = regions[0];
		for (const q of regions) {
			r = { minX: Math.min(r.minX, q.minX), minY: Math.min(r.minY, q.minY), maxX: Math.max(r.maxX, q.maxX), maxY: Math.max(r.maxY, q.maxY) };
		}
		const area = this.basePageRect();
		if (!rectsOverlap(r, area)) return;
		const ctx = this.baseCtx;
		// Device-pixel box, snapped outward so no half-cleared edge pixels remain.
		this.applyBaseTransform(ctx);
		const m = ctx.getTransform();
		const x0 = Math.max(0, Math.floor(m.a * r.minX + m.e) - 2);
		const y0 = Math.max(0, Math.floor(m.d * r.minY + m.f) - 2);
		const x1 = Math.min(this.base.width, Math.ceil(m.a * r.maxX + m.e) + 2);
		const y1 = Math.min(this.base.height, Math.ceil(m.d * r.maxY + m.f) + 2);
		if (x1 <= x0 || y1 <= y0) return;
		const k = 1 / (m.a || 1);
		const clipPage: PageRect = {
			minX: (x0 - m.e) * k, minY: (y0 - m.f) * k, maxX: (x1 - m.e) * k, maxY: (y1 - m.f) * k,
		};
		ctx.save();
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.beginPath();
		ctx.rect(x0, y0, x1 - x0, y1 - y0);
		ctx.clip();
		ctx.clearRect(x0, y0, x1 - x0, y1 - y0);
		this.paintBackground(ctx, clipPage);
		this.applyBaseTransform(ctx);
		for (const s of this.strokes) {
			if (this.hidden.has(s)) continue;
			this.paintStroke(ctx, s, clipPage);
		}
		ctx.restore();
		ctx.globalAlpha = 1;
	}

	paintStroke(ctx: CanvasRenderingContext2D, s: InkStroke, view: PageRect | null): void {
		if (view && !rectsOverlap(approxStrokeBounds(s), view)) return;
		if (isImageStroke(s)) {
			this.paintImage(ctx, s);
			return;
		}
		const path = strokePath(s);
		if (!path) return;
		ctx.fillStyle = this.colorOf(s.style);
		ctx.globalAlpha = s.style.opacity ?? 1;
		const { x, y } = s.offset;
		if (x !== 0 || y !== 0) {
			ctx.translate(x, y);
			ctx.fill(path);
			ctx.translate(-x, -y);
		} else {
			ctx.fill(path);
		}
		ctx.globalAlpha = 1;
	}

	private paintImage(ctx: CanvasRenderingContext2D, s: InkStroke & { image: { src: string } }): void {
		let img = this.images.get(s.image.src);
		if (!img) {
			img = new Image();
			img.decoding = 'async';
			img.src = s.image.src;
			this.images.set(s.image.src, img);
			img.decode().then(() => this.invalidateRegion(approxStrokeBounds(s)), () => undefined);
			return;
		}
		if (!img.complete || img.naturalWidth === 0) return;
		const r = imageStrokeRect(s);
		ctx.drawImage(img, r.x, r.y, r.width, r.height);
	}

	colorOf(style: InkStrokeStyle): string {
		return isThemeAdaptiveColor(style.color) ? this.palette.ink : style.color;
	}

	/** Paper inside `area` (page units), on the base bitmap. */
	private paintBackground(ctx: CanvasRenderingContext2D, area: PageRect): void {
		const bg = this.background;
		if (!bg || bg.layout === 'blank') return;
		const { zoom } = this.baseCamera;
		ctx.strokeStyle = this.palette.rule;
		ctx.fillStyle = this.palette.rule;

		if (bg.mode === 'drawing') {
			let spacing = resolveSpacing(bg.layout, { lineHeight: bg.lineHeight }) * (bg.layout === 'dot' ? bg.dotScale ?? 1 : 1);
			if (bg.layout === 'dot') {
				// Too dense to read at this zoom: every other dot, until it reads again.
				while (spacing * zoom < 6) spacing *= 2;
				this.paintDots(ctx, area, spacing, 1.25, 0.4);
				return;
			}
			if (spacing * zoom <= 1) return;
			this.paintLines(ctx, bg.layout, area, { spacing }, 0.5);
			return;
		}

		// Writing page: rulings in page space, inside the page, the top rule dropped.
		const width = bg.pageWidth ?? 2000;
		const height = bg.pageHeight ?? area.maxY;
		const dot = bg.layout === 'dot';
		const rect = {
			minX: Math.max(area.minX, dot ? 0 : width * 0.05),
			minY: Math.max(0, area.minY),
			maxX: Math.min(area.maxX, dot ? width : width * 0.95),
			maxY: Math.min(height, area.maxY),
		};
		if (rect.maxX <= rect.minX || rect.maxY <= rect.minY) return;
		if (dot) {
			this.paintDots(ctx, rect, resolveSpacing('dot', { lineHeight: bg.lineHeight }) * (bg.dotScale ?? 1), 1.25, 0.5);
			return;
		}
		this.paintLines(ctx, bg.layout, rect, { lineHeight: bg.lineHeight }, 0.5);
	}

	private paintLines(
		ctx: CanvasRenderingContext2D,
		layout: InkLayout,
		rect: PageRect,
		options: { lineHeight?: number; spacing?: number },
		alpha: number,
	): void {
		const geo = buildLayoutGeometry(layout, rect, options);
		if (geo.lines.length === 0) return;
		this.applyBaseTransform(ctx);
		ctx.globalAlpha = alpha;
		ctx.lineWidth = 1 / this.baseCamera.zoom;
		ctx.beginPath();
		for (const l of geo.lines) {
			if (l.y1 === 0 && l.y2 === 0) continue;
			ctx.moveTo(l.x1, l.y1);
			ctx.lineTo(l.x2, l.y2);
		}
		ctx.stroke();
		ctx.globalAlpha = 1;
	}

	/**
	 * Dots as a repeating tile: one dot drawn once, repeated by the GPU in a single fill.
	 * Thousands of arcs per repaint (the drawing grid at low zoom) cost more than the ink.
	 */
	private paintDots(ctx: CanvasRenderingContext2D, rect: PageRect, spacing: number, radiusPx: number, alpha: number): void {
		if (!(spacing > 0)) return;
		this.applyBaseTransform(ctx);
		const m = ctx.getTransform();
		const sp = spacing * m.a;
		if (sp < 2) return;
		const r = radiusPx * this.baseDpr;
		const pattern = this.dotPattern(ctx, sp, r);
		if (!pattern) return;
		// Grid point at page (0, 0) lands on device (m.e, m.f); the tile has its dot centred.
		pattern.setTransform(new DOMMatrix([sp / this.dotTileSize, 0, 0, sp / this.dotTileSize, m.e - sp / 2, m.f - sp / 2]));
		const x0 = m.a * rect.minX + m.e;
		const y0 = m.d * rect.minY + m.f;
		const x1 = m.a * rect.maxX + m.e;
		const y1 = m.d * rect.maxY + m.f;
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.globalAlpha = alpha;
		ctx.fillStyle = pattern;
		// Half a spacing of slack so dots on the rect edge are not cut.
		ctx.fillRect(x0 - sp / 2, y0 - sp / 2, x1 - x0 + sp, y1 - y0 + sp);
		ctx.globalAlpha = 1;
	}

	private dotTile: { key: string; pattern: CanvasPattern } | null = null;
	private dotTileSize = 64;

	private dotPattern(ctx: CanvasRenderingContext2D, sp: number, r: number): CanvasPattern | null {
		// A fixed 64 px tile scaled to the spacing keeps the dot round and the grid exact.
		const T = this.dotTileSize;
		const rr = r * (T / sp);
		const key = `${rr.toFixed(3)}|${this.palette.rule}`;
		if (this.dotTile?.key === key) return this.dotTile.pattern;
		const tile = document.createElement('canvas');
		tile.width = T;
		tile.height = T;
		const t = tile.getContext('2d');
		if (!t) return null;
		t.fillStyle = this.palette.rule;
		t.beginPath();
		t.arc(T / 2, T / 2, rr, 0, Math.PI * 2);
		t.fill();
		const pattern = ctx.createPattern(tile, 'repeat');
		if (!pattern) return null;
		this.dotTile = { key, pattern };
		return pattern;
	}

	private paintLive(): void {
		const ctx = this.liveCtx;
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		if (this.liveBox) {
			const b = this.liveBox;
			ctx.clearRect(b.x, b.y, b.w, b.h);
			this.liveBox = null;
		}
		let box: PageRect | null = null;
		const grow = (r: PageRect | null) => {
			if (!r) return;
			box = box
				? { minX: Math.min(box.minX, r.minX), minY: Math.min(box.minY, r.minY), maxX: Math.max(box.maxX, r.maxX), maxY: Math.max(box.maxY, r.maxY) }
				: r;
		};

		this.applyTransform(ctx);
		for (const st of this.liveStrokes) {
			if (isImageStroke(st)) {
				this.paintStroke(ctx, st, null);
				grow(this.pageRectToDevice(approxStrokeBounds(st)));
				continue;
			}
			const outline = strokeOutline(st.points, st.style);
			ctx.beginPath();
			if (!traceOutline(ctx, outline)) continue;
			ctx.fillStyle = this.colorOf(st.style);
			ctx.globalAlpha = st.style.opacity ?? 1;
			ctx.fill();
			ctx.globalAlpha = 1;
			let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
			for (const p of outline) {
				if (p[0] < minX) minX = p[0];
				if (p[1] < minY) minY = p[1];
				if (p[0] > maxX) maxX = p[0];
				if (p[1] > maxY) maxY = p[1];
			}
			grow(this.pageRectToDevice({ minX, minY, maxX, maxY }));
		}
		const f = this.floating;
		if (f) {
			ctx.translate(f.dx, f.dy);
			for (const st of f.strokes) {
				this.paintStroke(ctx, st, null);
				const b = approxStrokeBounds(st);
				grow(this.pageRectToDevice({ minX: b.minX + f.dx, minY: b.minY + f.dy, maxX: b.maxX + f.dx, maxY: b.maxY + f.dy }));
			}
			ctx.translate(-f.dx, -f.dy);
		}

		for (const overlay of this.overlays) {
			ctx.save();
			this.applyTransform(ctx);
			const r = overlay(ctx, this as unknown as InkRenderer);
			ctx.restore();
			if (r) grow(this.pageRectToDevice(r));
		}

		const b = box as PageRect | null;
		if (b) {
			const m = LIVE_MARGIN_PX * this.dpr;
			const x = Math.max(0, Math.floor(b.minX - m));
			const y = Math.max(0, Math.floor(b.minY - m));
			this.liveBox = {
				x, y,
				w: Math.min(this.live.width, Math.ceil(b.maxX + m)) - x,
				h: Math.min(this.live.height, Math.ceil(b.maxY + m)) - y,
			};
		}
	}

	/** Page rect to device pixels on the live layer. */
	private pageRectToDevice(r: PageRect): PageRect {
		const k = this.dpr;
		const a = this.pageToCss(r.minX, r.minY);
		const b = this.pageToCss(r.maxX, r.maxY);
		return { minX: a.x * k, minY: a.y * k, maxX: b.x * k, maxY: b.y * k };
	}

	/** Renders the visible page to a PNG (copy as image), at device resolution. */
	async toBlob(): Promise<Blob | null> {
		// Align the bitmap with the current view (it may be shifted by a pan transform).
		this.invalidate();
		this.flush();
		const out = document.createElement('canvas');
		out.width = Math.round(this.cssWidth * this.dpr);
		out.height = Math.round(this.cssHeight * this.dpr);
		const ctx = out.getContext('2d');
		if (!ctx) return null;
		const ox = this.margin * this.cssWidth * this.baseDpr;
		const oy = this.margin * this.cssHeight * this.baseDpr;
		ctx.drawImage(this.base, ox, oy, out.width, out.height, 0, 0, out.width, out.height);
		return new Promise(resolve => out.toBlob(resolve, 'image/png'));
	}
}
