import type { CameraState, InkPoint, InkStroke, InkStrokeStyle, PageRect } from '../model/types';
import { isThemeAdaptiveColor } from '../geom/ink-colors';
import { sharedRaster, type GlRaster } from './gl-raster';
import { InkRenderer2D } from './renderer-2d';
import type { InkLayout } from '../geom/background-layouts';

/**
 * The page and its ink. On the GPU path (WebGL2, the normal case) every repaint is the whole
 * page, done by the shared rasterizer in well under a millisecond and handed over as a bitmap;
 * the 2D layer above only carries the selection outline, the lasso and the eraser ring.
 * Without WebGL2 the Canvas2D renderer takes over with the same interface.
 */

export interface Palette {
	ink: string;
	rule: string;
	accent: string;
}

export interface Background {
	layout: InkLayout;
	lineHeight: number;
	pageWidth?: number;
	pageHeight?: number;
	mode: 'writing' | 'drawing';
	/** Dot spacing multiplier (dotted paper only). */
	dotScale?: number;
}

export type OverlayPainter = (ctx: CanvasRenderingContext2D, r: InkRenderer) => PageRect | null;

export interface InkRenderer {
	readonly base: HTMLCanvasElement;
	readonly live: HTMLCanvasElement;
	cssWidth: number;
	cssHeight: number;
	camera: CameraState;
	palette: Palette;
	background: Background | null;
	hidden: ReadonlySet<InkStroke>;
	onFrame?: () => void;
	dispose(): void;
	setPanMargin(fraction: number): void;
	setSize(cssWidth: number, cssHeight: number): void;
	setCamera(camera: CameraState): void;
	setPalette(palette: Palette): void;
	setBackground(background: Background | null): void;
	pageToCss(x: number, y: number): { x: number; y: number };
	cssToPage(x: number, y: number): { x: number; y: number };
	visiblePageRect(): PageRect;
	setStrokes(strokes: readonly InkStroke[]): void;
	appendStrokes(all: readonly InkStroke[], added: InkStroke[]): void;
	updateStrokes(all: readonly InkStroke[], changed: PageRect | null): void;
	setHidden(hidden: ReadonlySet<InkStroke>, region?: PageRect | null): void;
	invalidate(): void;
	setLiveStroke(points: InkPoint[] | null, style?: InkStrokeStyle): void;
	setLiveStrokes(strokes: InkStroke[]): void;
	setFloating(floating: { strokes: InkStroke[]; dx: number; dy: number } | null): void;
	setOverlays(overlays: OverlayPainter[]): void;
	requestLive(): void;
	flush(): void;
	colorOf(style: InkStrokeStyle): string;
	toBlob(): Promise<Blob | null>;
}

const MAX_LAYER_PIXELS = 16_000_000;
const LIVE_MARGIN_PX = 4;

export function createRenderer(host: HTMLElement): InkRenderer {
	const gl = sharedRaster();
	if (gl) return new InkRendererGL(host, gl);
	return new InkRenderer2D(host) as unknown as InkRenderer;
}

const glRenderers = new Set<InkRendererGL>();

class InkRendererGL implements InkRenderer {
	readonly base: HTMLCanvasElement;
	readonly live: HTMLCanvasElement;
	private bitmapCtx: ImageBitmapRenderingContext;
	private liveCtx: CanvasRenderingContext2D;
	cssWidth = 0;
	cssHeight = 0;
	private dpr = 1;
	camera: CameraState = { x: 0, y: 0, zoom: 1 };
	palette: Palette = { ink: '#1c1c1e', rule: '#cfcfc7', accent: '#4a7cff' };
	background: Background | null = null;
	hidden: ReadonlySet<InkStroke> = new Set();
	private strokes: readonly InkStroke[] = [];
	private liveStrokes: InkStroke[] = [];
	private floating: { strokes: InkStroke[]; dx: number; dy: number } | null = null;
	private overlays: OverlayPainter[] = [];
	private pageDirty = true;
	private frame = 0;
	private liveBox: { x: number; y: number; w: number; h: number } | null = null;
	private disposed = false;
	onFrame?: () => void;

	constructor(host: HTMLElement, private gl: GlRaster) {
		const doc = host.ownerDocument;
		this.base = doc.createElement('canvas');
		this.live = doc.createElement('canvas');
		this.base.className = 'layer layer--base';
		this.live.className = 'layer layer--live';
		host.append(this.base, this.live);
		this.bitmapCtx = this.base.getContext('bitmaprenderer')!;
		this.liveCtx = this.live.getContext('2d', { alpha: true, desynchronized: true })!;
		glRenderers.add(this);
		gl.onNeedsRepaint = () => {
			for (const r of glRenderers) r.invalidate();
		};
	}

	dispose(): void {
		this.disposed = true;
		glRenderers.delete(this);
		if (this.frame) cancelAnimationFrame(this.frame);
		this.base.width = this.base.height = 0;
		this.live.width = this.live.height = 0;
		this.base.remove();
		this.live.remove();
	}

	/** Panning repaints the whole page each frame here; no margin is needed. */
	setPanMargin(): void {
		// Intentionally empty.
	}

	setSize(cssWidth: number, cssHeight: number): void {
		const w = Math.max(1, Math.round(cssWidth));
		const h = Math.max(1, Math.round(cssHeight));
		if (w === this.cssWidth && h === this.cssHeight) return;
		this.cssWidth = w;
		this.cssHeight = h;
		let dpr = window.devicePixelRatio || 1;
		if (w * h * dpr * dpr > MAX_LAYER_PIXELS) dpr = Math.sqrt(MAX_LAYER_PIXELS / (w * h));
		this.dpr = dpr;
		for (const c of [this.base, this.live]) {
			c.width = Math.round(w * dpr);
			c.height = Math.round(h * dpr);
			c.style.width = `${w}px`;
			c.style.height = `${h}px`;
		}
		this.liveBox = null;
		this.invalidate();
	}

	setCamera(camera: CameraState): void {
		const c = this.camera;
		if (c.x === camera.x && c.y === camera.y && c.zoom === camera.zoom) return;
		this.camera = { ...camera };
		if (this.liveBox) this.liveBox = { x: 0, y: 0, w: this.live.width, h: this.live.height };
		this.invalidate();
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

	setStrokes(strokes: readonly InkStroke[]): void {
		this.strokes = strokes;
		this.invalidate();
	}

	appendStrokes(all: readonly InkStroke[]): void {
		this.setStrokes(all);
	}

	updateStrokes(all: readonly InkStroke[]): void {
		this.setStrokes(all);
	}

	setHidden(hidden: ReadonlySet<InkStroke>): void {
		this.hidden = hidden;
		this.invalidate();
	}

	invalidate(): void {
		this.pageDirty = true;
		this.schedule();
	}

	setLiveStroke(points: InkPoint[] | null, style?: InkStrokeStyle): void {
		this.setLiveStrokes(points && style ? [{ id: 'live', points, style, offset: { x: 0, y: 0 } }] : []);
	}

	setLiveStrokes(strokes: InkStroke[]): void {
		if (strokes.length === 0 && this.liveStrokes.length === 0) return;
		this.liveStrokes = strokes;
		this.invalidate();
	}

	setFloating(floating: { strokes: InkStroke[]; dx: number; dy: number } | null): void {
		if (!floating && !this.floating) return;
		this.floating = floating;
		this.invalidate();
	}

	setOverlays(overlays: OverlayPainter[]): void {
		this.overlays = overlays;
		this.schedule();
	}

	requestLive(): void {
		this.schedule();
	}

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
		if (this.pageDirty && this.cssWidth > 0) {
			this.pageDirty = false;
			const bmp = this.renderBitmap();
			if (bmp) this.bitmapCtx.transferFromImageBitmap(bmp);
			else this.pageDirty = true; // context lost: retried when it comes back
		}
		this.paintOverlays();
		this.onFrame?.();
	}

	private renderBitmap(): ImageBitmap | null {
		return this.gl.render(this.base.width, this.base.height, {
			camera: this.camera,
			dpr: this.dpr,
			palette: this.palette,
			background: this.background,
			docKey: this,
			strokes: this.strokes,
			hidden: this.hidden,
			floating: this.floating,
			live: this.liveStrokes,
		});
	}

	private applyTransform(ctx: CanvasRenderingContext2D): void {
		const { zoom, x, y } = this.camera;
		const k = this.dpr * zoom;
		ctx.setTransform(k, 0, 0, k, x * k, y * k);
	}

	private paintOverlays(): void {
		const ctx = this.liveCtx;
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		if (this.liveBox) {
			const b = this.liveBox;
			ctx.clearRect(b.x, b.y, b.w, b.h);
			this.liveBox = null;
		}
		let box: PageRect | null = null;
		for (const overlay of this.overlays) {
			ctx.save();
			this.applyTransform(ctx);
			const r = overlay(ctx, this);
			ctx.restore();
			if (!r) continue;
			const k = this.dpr;
			const a = this.pageToCss(r.minX, r.minY);
			const b = this.pageToCss(r.maxX, r.maxY);
			const d = { minX: a.x * k, minY: a.y * k, maxX: b.x * k, maxY: b.y * k };
			box = box ? { minX: Math.min(box.minX, d.minX), minY: Math.min(box.minY, d.minY), maxX: Math.max(box.maxX, d.maxX), maxY: Math.max(box.maxY, d.maxY) } : d;
		}
		const b = box as PageRect | null;
		if (b) {
			const m = LIVE_MARGIN_PX * this.dpr;
			const x = Math.max(0, Math.floor(b.minX - m));
			const y = Math.max(0, Math.floor(b.minY - m));
			this.liveBox = { x, y, w: Math.min(this.live.width, Math.ceil(b.maxX + m)) - x, h: Math.min(this.live.height, Math.ceil(b.maxY + m)) - y };
		}
	}

	colorOf(style: InkStrokeStyle): string {
		return isThemeAdaptiveColor(style.color) ? this.palette.ink : style.color;
	}

	async toBlob(): Promise<Blob | null> {
		const bmp = this.renderBitmap();
		if (!bmp) return null;
		const out = document.createElement('canvas');
		out.width = bmp.width;
		out.height = bmp.height;
		out.getContext('2d')?.drawImage(bmp, 0, 0);
		bmp.close();
		return new Promise(resolve => out.toBlob(resolve, 'image/png'));
	}
}
