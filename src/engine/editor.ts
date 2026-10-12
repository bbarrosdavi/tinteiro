import type { CameraState, InkMode, InkPoint, InkStroke, InkStrokeStyle, InkTool, PageRect, StrokeInputKind } from '../model/types';
import { isInkShapeTool } from '../model/types';
import { WRITING_LINE_HEIGHT, WRITING_PAGE_WIDTH } from '../model/constants';
import { InkDocument, type DocChange } from './document';
import { createRenderer, type InkRenderer, type OverlayPainter } from './renderer';
import { StrokeCapture, type Sample } from './capture';
import { strokeDistance } from '../geom/capsules';
import { approxStrokeBounds, rectsOverlap, unionRect } from '../geom/bounds';
import { clampZoom, strokeStyleFor, eraserRadiusOnScreen } from '../geom/pen-model';
import { PEN_PRESETS, sizeForTool, type PenPreset } from '../geom/tool-presets';
import { eraseFromStroke, type EraserPoint } from '../geom/ink-eraser';
import { buildPlotShapeStrokes } from '../geom/plot-shapes';
import { computeSelectionBounds, isPointInRect, SELECTION_GRAB_TOLERANCE_PX, SELECTION_TAP_SLOP_PX } from '../geom/selection-grab';
import { buildImageStroke, imageStrokeRect, isImageStroke, placeImageRect, readPastedImage, type ImageRect } from '../geom/ink-images';
import { hitImageHandle, IMAGE_HANDLE_RADIUS_PX, IMAGE_RESIZE_CORNERS, imageCornerPoint, imageStrokeWithRect, resizeImageRect, type ResizeCorner } from '../geom/image-resize';
import type { InkSettings } from '../settings';

/**
 * One open ink surface (an unlocked embed or a full view): input, tools, camera.
 *
 * Every pointer sample is handled with plain arithmetic and a request for the next frame;
 * nothing in the hot path touches the DOM except the two canvases. The only DOM writes are
 * class flips on the stage (cursor, touch-action), which live inside the embed's shadow
 * root and so never reach the note's editor.
 */

export interface EditorCallbacks {
	settings(): InkSettings;
	/** A change to the strokes (autosave picks it up). */
	onEdit(): void;
	/** Tool, selection or history changed: refresh the toolbar. */
	onState(): void;
	/** Camera moved by the user (drawing framing). */
	onCamera?(): void;
	/** Writing page needs another height (page units). */
	onPageHeight?(height: number): void;
	/** Pen or finger lifted (the autosave waits for it). */
	onLift?(): void;
	/** Pointer touched the surface: this editor is now the one keys go to. */
	onActivate?(): void;
	/** The scroll container of the note, for finger scrolling and the palm lock. */
	scroller?(): HTMLElement | null;
}

type Gesture =
	| { kind: 'draw'; id: number; capture: StrokeCapture; style: InkStrokeStyle; started: number; lastT: number }
	| { kind: 'erase'; id: number; original: readonly InkStroke[]; working: InkStroke[]; last: EraserPoint | null; changed: boolean }
	| { kind: 'shape'; id: number; start: { x: number; y: number }; end: { x: number; y: number }; constrain: boolean }
	| { kind: 'lasso'; id: number; points: Array<{ x: number; y: number }>; additive: boolean; startCss: { x: number; y: number }; travel: number }
	| { kind: 'move'; id: number; startPage: { x: number; y: number }; startCss: { x: number; y: number }; dx: number; dy: number; moved: boolean; onStroke: boolean }
	| { kind: 'resize'; id: number; image: InkStroke; corner: ResizeCorner; start: ImageRect; rect: ImageRect }
	| { kind: 'pan'; id: number; last: { x: number; y: number }; zoomDrag: boolean; anchor: { x: number; y: number }; startCam: CameraState; startCss: { x: number; y: number }; history: Array<{ x: number; y: number; t: number }> }
	| { kind: 'scroll'; id: number; lastY: number; history: Array<{ y: number; t: number }> };

const FRAME_GAP_MS = 25;
const COALESCED_MIN_SPACING_PX = 6;
const PREDICTION_MAX_MS = 20;
const MOD_ERASE_ARM_MS = 180;
const TAP_MAX_MS = 300;
const TAP_MAX_TRAVEL_PX = 12;
const TAP_EXTRA_FINGER_MS = 150;
const MOMENTUM = { minVelocity: 100, friction: 0.92, maxVelocity: 4000, stopVelocity: 15, windowMs: 120 };
const WHEEL_ZOOM_FACTOR = 1.08;

let idCounter = 0;
function strokeId(): string {
	return `s_${Date.now()}_${idCounter++}`;
}

export class InkEditor {
	readonly renderer: InkRenderer;
	tool: InkTool = 'draw';
	selection = new Set<InkStroke>();
	camera: CameraState = { x: 0, y: 0, zoom: 1 };
	/** Writing page height in page units. */
	pageHeight = 0;
	zoomLocked = false;
	private _interactive = true;

	get interactive(): boolean {
		return this._interactive;
	}

	/** Editing on or off. A drawing being edited keeps a margin around the view for panning. */
	set interactive(on: boolean) {
		this._interactive = on;
		this.renderer.setPanMargin(on && this.mode === 'drawing' ? 0.5 : 0);
		if (!on) this.cancelGesture();
	}

	private gesture: Gesture | null = null;
	private touches = new Map<number, { x: number; y: number; sx: number; sy: number; t: number }>();
	private pinch: { dist: number; mid: { x: number; y: number }; cam: CameraState } | null = null;
	private tap = { start: 0, max: 0, bad: false };
	private tempTool: InkTool | null = null;
	private modTimer = 0;
	private modArmed = false;
	private hover: { x: number; y: number; pen: boolean } | null = null;
	private predicted: InkPoint[] = [];
	private momentumFrame = 0;
	private penNear = false;
	private penAwayTimer = 0;
	private lastInputKind: StrokeInputKind = 'pen';
	private unsubscribeDoc: () => void;
	private disposers: Array<() => void> = [];
	private rect: DOMRect | null = null;

	constructor(
		readonly stage: HTMLElement,
		public doc: InkDocument,
		readonly mode: InkMode,
		private readonly cb: EditorCallbacks,
	) {
		this.renderer = createRenderer(stage);
		this.renderer.setStrokes(doc.strokes);
		this.unsubscribeDoc = doc.onChange(change => this.onDocChange(change));
		this.listen(stage, 'pointerdown', e => this.onPointerDown(e as PointerEvent));
		this.listen(stage, 'pointermove', e => this.onPointerMove(e as PointerEvent));
		this.listen(stage, 'pointerup', e => this.onPointerUp(e as PointerEvent));
		this.listen(stage, 'pointercancel', e => this.onPointerCancel(e as PointerEvent));
		this.listen(stage, 'pointerenter', e => this.onPointerEnter(e as PointerEvent));
		this.listen(stage, 'pointerleave', e => this.onPointerLeave(e as PointerEvent));
		this.listen(stage, 'wheel', e => this.onWheel(e as WheelEvent), { passive: false });
		this.listen(stage, 'contextmenu', e => e.preventDefault());
		this.updateStageClasses();
		this.syncOverlays();
	}

	private listen(target: EventTarget, type: string, fn: (e: Event) => void, options?: AddEventListenerOptions): void {
		target.addEventListener(type, fn, options);
		this.disposers.push(() => target.removeEventListener(type, fn, options));
	}

	dispose(): void {
		this.cancelGesture();
		this.stopMomentum();
		this.releasePalmLock();
		window.clearTimeout(this.modTimer);
		this.unsubscribeDoc();
		for (const d of this.disposers) d();
		this.renderer.dispose();
	}

	// Document
	//////////

	setDocument(doc: InkDocument): void {
		this.unsubscribeDoc();
		this.doc = doc;
		this.selection.clear();
		this.unsubscribeDoc = doc.onChange(change => this.onDocChange(change));
		this.renderer.setStrokes(doc.strokes);
		this.cb.onState();
	}

	private onDocChange(change: DocChange): void {
		if (change.appendOnly) this.renderer.appendStrokes(this.doc.strokes, change.added);
		else this.renderer.updateStrokes(this.doc.strokes, changeRegion(change.added, change.removed));
		if (change.removed.length) {
			for (const s of change.removed) this.selection.delete(s);
		}
		this.syncOverlays();
		if (this.mode === 'writing') this.cb.onPageHeight?.(this.writingHeightFor(true));
		this.cb.onEdit();
		this.cb.onState();
	}

	/** Page height for writing: content plus buffer lines while editing, tight when locked. */
	writingHeightFor(editing: boolean): number {
		const s = this.cb.settings();
		const lh = this.doc.snapshot.writingLineHeight ?? WRITING_LINE_HEIGHT;
		let maxY = 0;
		for (const st of this.doc.strokes) maxY = Math.max(maxY, approxStrokeBounds(st).maxY - (st.image ? 0 : st.style.size));
		const lines = Math.ceil(maxY / lh) + (editing ? s.writingBufferLines : 0);
		return Math.max((lines + 0.5) * lh, lh * 2.5);
	}

	undo(): boolean {
		if (this.gesture) return false;
		return this.doc.undo();
	}

	redo(): boolean {
		if (this.gesture) return false;
		return this.doc.redo();
	}

	// View
	//////////

	resize(cssWidth: number, cssHeight: number): void {
		this.rect = null;
		this.renderer.setSize(cssWidth, cssHeight);
		if (this.mode === 'writing') this.setCamera({ x: 0, y: 0, zoom: cssWidth / WRITING_PAGE_WIDTH }, false);
	}

	setCamera(camera: CameraState, byUser = true): void {
		this.camera = { ...camera };
		this.renderer.setCamera(this.camera);
		if (byUser) this.cb.onCamera?.();
	}

	private stageRect(): DOMRect {
		// Cached per gesture: reading layout in the middle of a stroke would force a reflow.
		if (!this.rect) this.rect = this.stage.getBoundingClientRect();
		return this.rect;
	}

	private toCss(e: { clientX: number; clientY: number }): { x: number; y: number } {
		const r = this.stageRect();
		return { x: e.clientX - r.left, y: e.clientY - r.top };
	}

	private toPage(e: { clientX: number; clientY: number }): { x: number; y: number } {
		const c = this.toCss(e);
		return this.renderer.cssToPage(c.x, c.y);
	}

	// Tools and style
	//////////

	setTool(tool: InkTool): void {
		if (this.gesture) this.finishGesture(null);
		this.tempTool = null;
		this.tool = tool;
		if (tool !== 'select') this.clearSelection();
		this.updateStageClasses();
		this.syncOverlays();
		this.cb.onState();
	}

	get effectiveTool(): InkTool {
		return this.tempTool ?? this.tool;
	}

	private penPreset(): PenPreset {
		return PEN_PRESETS[this.cb.settings().activePen];
	}

	private baseStyle(): InkStrokeStyle {
		const s = this.cb.settings();
		return {
			size: sizeForTool(s.activePen, s.penSizes),
			thinning: 0.5,
			smoothing: 0.5,
			streamline: 0.5,
			simulatePressure: true,
			color: s.color,
		};
	}

	private styleFor(kind: StrokeInputKind): InkStrokeStyle {
		return strokeStyleFor(this.baseStyle(), kind, this.camera.zoom, this.penPreset());
	}

	private resolveKind(e: PointerEvent): StrokeInputKind {
		if (e.pointerType === 'touch') return 'mouse';
		const pref = this.cb.settings().strokeInputTreatAs;
		if (pref !== 'auto') return pref;
		if (e.pointerType === 'pen') return 'pen';
		return this.lastInputKind;
	}

	updateStageClasses(): void {
		const s = this.cb.settings();
		const tool = this.effectiveTool;
		const cl = this.stage.classList;
		const set = (name: string, on: boolean) => {
			if (cl.contains(name) !== on) cl.toggle(name, on);
		};
		set('is-draw', tool === 'draw');
		set('is-erase', tool === 'erase');
		set('is-select', tool === 'select');
		set('is-pan', tool === 'pan');
		set('is-shape', isInkShapeTool(tool));
		set('finger-draws', s.fingerDrawing);
		set('pen-near', this.penNear);
		set('is-drawing-mode', this.mode === 'drawing');
	}

	// Pointer routing
	//////////

	private onPointerEnter(e: PointerEvent): void {
		if (e.pointerType === 'pen') this.setPenNear(true);
	}

	private onPointerLeave(e: PointerEvent): void {
		if (e.pointerType === 'pen') this.setPenNear(false);
		if (this.hover) {
			this.hover = null;
			this.renderer.requestLive();
		}
	}

	/**
	 * While the pen hovers over the page, touches cannot scroll the note: a resting palm
	 * would otherwise drag the page under the nib. Released shortly after the pen leaves.
	 */
	private setPenNear(near: boolean): void {
		window.clearTimeout(this.penAwayTimer);
		if (near) {
			if (this.penNear) return;
			this.penNear = true;
			this.updateStageClasses();
			const scroller = this.cb.scroller?.();
			if (scroller) scroller.style.touchAction = 'none';
			return;
		}
		this.penAwayTimer = window.setTimeout(() => {
			if (this.gesture?.kind === 'draw') return;
			this.penNear = false;
			this.updateStageClasses();
			this.releasePalmLock();
		}, 300);
	}

	private releasePalmLock(): void {
		const scroller = this.cb.scroller?.();
		if (scroller && scroller.style.touchAction) scroller.style.touchAction = '';
	}

	private onPointerDown(e: PointerEvent): void {
		if (!this.interactive) return;
		this.rect = null;
		this.stopMomentum();
		this.cb.onActivate?.();
		if (e.pointerType === 'touch') {
			this.onTouchDown(e);
			return;
		}
		if (this.gesture) return;

		const isPen = e.pointerType === 'pen';
		// Pen: the tip bit decides, so a flaky barrel button never turns a stroke into a pan.
		if (isPen && (e.buttons & 32)) {
			this.begin(e, 'erase');
			return;
		}
		if (isPen && !(e.buttons & 1)) return;
		if (!isPen) {
			if (e.button === 1 || (e.button === 2 && (this.mode === 'drawing' || !this.embedded))) {
				this.beginPan(e, e.button === 2 && (e.ctrlKey || e.metaKey) && this.mode === 'drawing' && !this.zoomLocked);
				return;
			}
			if (e.button !== 0) return;
		}
		this.begin(e, this.effectiveTool);
	}

	/** Embeds leave right-drag to the note in writing mode; full views pan with it. */
	embedded = true;

	private begin(e: PointerEvent, tool: InkTool): void {
		e.preventDefault();
		try {
			this.stage.setPointerCapture(e.pointerId);
		} catch {
			// Pointer already gone.
		}
		const page = this.toPage(e);
		if (tool === 'draw') this.beginDraw(e, page);
		else if (tool === 'erase') this.beginErase(e, page);
		else if (tool === 'select') this.beginSelect(e, page);
		else if (tool === 'pan') this.beginPan(e, false);
		else this.gesture = { kind: 'shape', id: e.pointerId, start: page, end: page, constrain: e.shiftKey };
		this.syncOverlays();
	}

	private onPointerMove(e: PointerEvent): void {
		if (e.pointerType === 'touch') {
			this.onTouchMove(e);
			return;
		}
		this.lastPointer = null;
		const g = this.gesture;
		if (!g) {
			this.lastHoverEvent = e;
			this.trackHover(e);
			return;
		}
		if (g.id !== e.pointerId) return;
		switch (g.kind) {
			case 'draw': this.moveDraw(e, g); break;
			case 'erase': this.moveErase(e, g); break;
			case 'shape':
				g.end = this.toPage(e);
				g.constrain = e.shiftKey;
				this.renderer.setLiveStrokes(this.shapeStrokes(g));
				break;
			case 'lasso': this.moveLasso(e, g); break;
			case 'move': this.moveSelection(e, g); break;
			case 'resize': this.moveResize(e, g); break;
			case 'pan': this.movePan(e, g); break;
			case 'scroll': this.moveScroll(e, g); break;
		}
		if (g.kind === 'erase') this.trackHover(e);
	}

	private onPointerUp(e: PointerEvent): void {
		if (e.pointerType === 'touch') {
			this.onTouchUp(e);
			return;
		}
		if (this.gesture && this.gesture.id === e.pointerId) this.finishGesture(e);
	}

	private onPointerCancel(e: PointerEvent): void {
		if (e.pointerType === 'touch') {
			this.touches.delete(e.pointerId);
			this.tap.bad = true;
			if (this.touches.size < 2) this.pinch = null;
		}
		if (this.gesture && this.gesture.id === e.pointerId) this.cancelGesture();
	}

	private trackHover(e: PointerEvent): void {
		const tool = this.effectiveTool;
		if (tool !== 'erase') {
			if (this.hover) {
				this.hover = null;
				this.renderer.requestLive();
			}
			return;
		}
		const c = this.toCss(e);
		this.hover = { x: c.x, y: c.y, pen: e.pointerType === 'pen' };
		this.renderer.requestLive();
	}

	private finishGesture(e: PointerEvent | null): void {
		const g = this.gesture;
		if (!g) return;
		switch (g.kind) {
			case 'draw': this.finishDraw(e, g); break;
			case 'erase': this.finishErase(g); break;
			case 'shape': this.finishShape(g); break;
			case 'lasso': this.finishLasso(e, g); break;
			case 'move': this.finishMove(e, g); break;
			case 'resize': this.finishResize(g); break;
			case 'pan': this.finishPan(g); break;
			case 'scroll': this.finishScroll(g); break;
		}
		this.gesture = null;
		this.predicted = [];
		this.syncOverlays();
		this.cb.onLift?.();
	}

	cancelGesture(): void {
		const g = this.gesture;
		if (!g) return;
		if (g.kind === 'draw' || g.kind === 'shape' || g.kind === 'resize') this.renderer.setLiveStrokes([]);
		if (g.kind === 'erase') this.renderer.updateStrokes(this.doc.strokes, null);
		if (g.kind === 'move') this.renderer.setFloating(null);
		if (g.kind === 'move' || g.kind === 'resize') this.renderer.setHidden(new Set(), null);
		this.gesture = null;
		this.predicted = [];
		this.syncOverlays();
		this.cb.onLift?.();
	}

	get isBusy(): boolean {
		return this.gesture !== null;
	}

	// Draw
	//////////

	private sampleOf(e: PointerEvent, isPen: boolean): Sample {
		const p = this.toPage(e);
		return { x: p.x, y: p.y, pressure: e.pressure, t: e.timeStamp, isPen };
	}

	private beginDraw(e: PointerEvent, _page: { x: number; y: number }): void {
		const kind = this.resolveKind(e);
		const style = this.styleFor(kind);
		const capture = new StrokeCapture(kind, style, this.camera.zoom);
		capture.add(this.sampleOf(e, e.pointerType === 'pen'));
		this.gesture = { kind: 'draw', id: e.pointerId, capture, style, started: Date.now(), lastT: e.timeStamp };
		this.renderer.setLiveStroke(capture.points, style);
	}

	/**
	 * Uses the dispatched sample, one per frame: dense raw digitizer samples trace jitter
	 * into the faithful outline. When frames were missed (the main thread was busy), the
	 * coalesced samples fill the gap, spaced at least 6 px, so a stall never becomes a chord.
	 */
	private moveDraw(e: PointerEvent, g: Extract<Gesture, { kind: 'draw' }>): void {
		const isPen = e.pointerType === 'pen';
		if (isPen && !(e.buttons & 1)) {
			this.finishGesture(e);
			return;
		}
		if (e.timeStamp - g.lastT > FRAME_GAP_MS && typeof e.getCoalescedEvents === 'function') {
			const r = this.stageRect();
			let lastX = (g.capture.points[g.capture.points.length - 1][0] + this.camera.x) * this.camera.zoom + r.left;
			let lastY = (g.capture.points[g.capture.points.length - 1][1] + this.camera.y) * this.camera.zoom + r.top;
			const minSq = COALESCED_MIN_SPACING_PX ** 2;
			for (const c of e.getCoalescedEvents()) {
				if ((c.clientX - lastX) ** 2 + (c.clientY - lastY) ** 2 < minSq) continue;
				if ((c.clientX - e.clientX) ** 2 + (c.clientY - e.clientY) ** 2 < minSq) continue;
				g.capture.add(this.sampleOf(c, isPen));
				lastX = c.clientX;
				lastY = c.clientY;
			}
		}
		g.capture.add(this.sampleOf(e, isPen));
		g.lastT = e.timeStamp;

		this.predicted = [];
		if (this.cb.settings().strokePrediction && typeof e.getPredictedEvents === 'function') {
			const pred = e.getPredictedEvents();
			const pts = g.capture.points;
			const tip = pts[pts.length - 1];
			for (const p of pred) {
				if (p.timeStamp - e.timeStamp > PREDICTION_MAX_MS) break;
				const pp = this.toPage(p);
				this.predicted.push([pp.x, pp.y, tip[2]]);
			}
			// Never let the prediction run further than the last real segment.
			if (this.predicted.length && pts.length >= 2) {
				const prev = pts[pts.length - 2];
				const maxLen = Math.hypot(tip[0] - prev[0], tip[1] - prev[1]) * 1.5;
				this.predicted = this.predicted.filter(p => Math.hypot(p[0] - tip[0], p[1] - tip[1]) <= maxLen);
			}
		}
		this.renderer.setLiveStroke(
			this.predicted.length ? g.capture.points.concat(this.predicted) : g.capture.points,
			g.style,
		);
	}

	private finishDraw(e: PointerEvent | null, g: Extract<Gesture, { kind: 'draw' }>): void {
		let capture = g.capture;
		if (e) capture.add(this.sampleOf(e, e.pointerType === 'pen'), true);
		let style = g.style;
		const isFinger = e?.pointerType === 'touch';
		if (!isFinger && this.cb.settings().strokeInputTreatAs === 'auto') {
			const detected = capture.detectedKind();
			this.lastInputKind = detected;
			if (detected !== capture.kind) {
				style = this.styleFor(detected);
				capture = capture.rebuild(detected, style, this.camera.zoom);
			}
		}
		const stroke: InkStroke = {
			id: strokeId(),
			authoringSource: 'local',
			points: capture.points,
			style,
			offset: { x: 0, y: 0 },
			startedAt: g.started,
			finishedAt: Date.now(),
		};
		// Hand the stroke from the live layer to the base layer in the same frame.
		this.renderer.setLiveStroke(null);
		this.doc.add([stroke]);
		this.renderer.flush();
	}

	// Erase
	//////////

	private eraserRadiusPage(): number {
		return eraserRadiusOnScreen(this.camera.zoom, this.cb.settings().eraserSize) / this.camera.zoom;
	}

	private beginErase(e: PointerEvent, page: { x: number; y: number }): void {
		this.gesture = { kind: 'erase', id: e.pointerId, original: this.doc.strokes, working: [...this.doc.strokes], last: null, changed: false };
		this.eraseAt(page);
		this.trackHover(e);
	}

	private moveErase(e: PointerEvent, g: Extract<Gesture, { kind: 'erase' }>): void {
		const samples = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
		for (const s of samples.length ? samples : [e]) this.eraseAt(this.toPage(s));
		void g;
	}

	private eraseAt(p: { x: number; y: number }): void {
		const g = this.gesture;
		if (!g || g.kind !== 'erase') return;
		const radius = this.eraserRadiusPage();
		const path: EraserPoint[] = g.last ? [g.last, p] : [p];
		g.last = p;
		const box: PageRect = {
			minX: Math.min(path[0].x, p.x) - radius,
			minY: Math.min(path[0].y, p.y) - radius,
			maxX: Math.max(path[0].x, p.x) + radius,
			maxY: Math.max(path[0].y, p.y) + radius,
		};
		const inkMode = this.cb.settings().eraserMode === 'ink';
		let region: PageRect | null = null;
		const next: InkStroke[] = [];
		for (const s of g.working) {
			if (isImageStroke(s) || !rectsOverlap(approxStrokeBounds(s), box)) {
				next.push(s);
				continue;
			}
			const pieces = eraseFromStroke(s, path, radius + s.style.size / 4);
			if (!pieces) {
				next.push(s);
				continue;
			}
			region = unionRect(region, approxStrokeBounds(s));
			if (inkMode) next.push(...pieces);
		}
		if (region) {
			g.working = next;
			g.changed = true;
			this.renderer.updateStrokes(next, region);
		}
	}

	private finishErase(g: Extract<Gesture, { kind: 'erase' }>): void {
		if (!g.changed) return;
		this.doc.replaceAll(g.working);
	}

	// Figures
	//////////

	private shapeStrokes(g: Extract<Gesture, { kind: 'shape' }>): InkStroke[] {
		const tool = this.effectiveTool;
		if (!isInkShapeTool(tool)) return [];
		return buildPlotShapeStrokes(tool, { start: g.start, end: g.end, style: this.styleFor('mouse'), constrain: g.constrain });
	}

	private finishShape(g: Extract<Gesture, { kind: 'shape' }>): void {
		const strokes = this.shapeStrokes(g);
		this.renderer.setLiveStrokes([]);
		if (strokes.length && Math.hypot(g.end.x - g.start.x, g.end.y - g.start.y) >= 4 / this.camera.zoom) {
			this.doc.add(strokes);
		}
	}

	// Select
	//////////

	private beginSelect(e: PointerEvent, page: { x: number; y: number }): void {
		const css = this.toCss(e);
		const image = this.singleSelectedImage();
		if (image) {
			const rect = imageStrokeRect(image as InkStroke & { image: { src: string } });
			const corner = hitImageHandle(page, rect, this.camera.zoom);
			if (corner) {
				this.gesture = { kind: 'resize', id: e.pointerId, image, corner, start: rect, rect };
				this.renderer.setHidden(new Set([image]), approxStrokeBounds(image));
				return;
			}
		}
		if (this.selection.size) {
			const hit = this.hitStroke(page);
			const onStroke = !!hit && this.selection.has(hit);
			const grab = this.selectionGrabRect();
			if (onStroke || (!e.shiftKey && isPointInRect(page, grab))) {
				this.gesture = { kind: 'move', id: e.pointerId, startPage: page, startCss: css, dx: 0, dy: 0, moved: false, onStroke };
				return;
			}
		}
		if (!e.shiftKey && this.selection.size) this.clearSelection();
		this.gesture = { kind: 'lasso', id: e.pointerId, points: [page], additive: e.shiftKey, startCss: css, travel: 0 };
	}

	private moveLasso(e: PointerEvent, g: Extract<Gesture, { kind: 'lasso' }>): void {
		const c = this.toCss(e);
		g.travel = Math.max(g.travel, Math.hypot(c.x - g.startCss.x, c.y - g.startCss.y));
		g.points.push(this.toPage(e));
		this.renderer.requestLive();
	}

	private finishLasso(e: PointerEvent | null, g: Extract<Gesture, { kind: 'lasso' }>): void {
		// A closed lasso ends where it began: what makes it a tap is never going anywhere.
		if (g.points.length < 3 || g.travel < SELECTION_TAP_SLOP_PX) {
			this.tapSelect(g.points[0], g.additive);
			return;
		}
		for (const s of this.doc.strokes) {
			const b = approxStrokeBounds(s);
			const pad = s.image ? 0 : s.style.size;
			const cx = (b.minX + b.maxX) / 2;
			const cy = (b.minY + b.maxY) / 2 + 0 * pad;
			if (pointInPolygon(cx, cy, g.points)) this.selection.add(s);
		}
		this.cb.onState();
	}

	private tapSelect(p: { x: number; y: number }, additive: boolean): void {
		const hit = this.hitStroke(p);
		if (hit) {
			if (additive) {
				if (this.selection.has(hit)) this.selection.delete(hit);
				else this.selection.add(hit);
			} else {
				this.selection = new Set([hit]);
			}
		} else if (!additive) {
			this.selection.clear();
		}
		this.cb.onState();
	}

	private moveSelection(e: PointerEvent, g: Extract<Gesture, { kind: 'move' }>): void {
		const css = this.toCss(e);
		if (!g.moved) {
			if (Math.hypot(css.x - g.startCss.x, css.y - g.startCss.y) < SELECTION_TAP_SLOP_PX) return;
			g.moved = true;
			this.renderer.setHidden(this.selection, computeSelectionBounds([...this.selection]));
		}
		const p = this.toPage(e);
		g.dx = p.x - g.startPage.x;
		g.dy = p.y - g.startPage.y;
		this.renderer.setFloating({ strokes: this.selectedStrokes(), dx: g.dx, dy: g.dy });
		this.renderer.requestLive();
	}

	private finishMove(e: PointerEvent | null, g: Extract<Gesture, { kind: 'move' }>): void {
		if (!g.moved) {
			if (!g.onStroke && e) this.tapSelect(g.startPage, e.shiftKey);
			return;
		}
		const moved = new Map<InkStroke, InkStroke[]>();
		const next = new Set<InkStroke>();
		for (const s of this.selection) {
			const m = { ...s, offset: { x: s.offset.x + g.dx, y: s.offset.y + g.dy } };
			moved.set(s, [m]);
			next.add(m);
		}
		this.selection = next;
		this.renderer.setFloating(null);
		this.renderer.hidden = new Set();
		this.doc.replace(moved);
	}

	private moveResize(e: PointerEvent, g: Extract<Gesture, { kind: 'resize' }>): void {
		g.rect = resizeImageRect(g.start, g.corner, this.toPage(e), this.camera.zoom);
		this.renderer.setLiveStrokes([imageStrokeWithRect(g.image as InkStroke & { image: { src: string } }, g.rect)]);
	}

	private finishResize(g: Extract<Gesture, { kind: 'resize' }>): void {
		this.renderer.setLiveStrokes([]);
		if (g.rect === g.start) {
			this.renderer.setHidden(new Set(), approxStrokeBounds(g.image));
			return;
		}
		this.renderer.hidden = new Set();
		const resized = imageStrokeWithRect(g.image as InkStroke & { image: { src: string } }, g.rect);
		this.selection = new Set([resized]);
		this.doc.replace(new Map([[g.image, [resized]]]));
	}

	private singleSelectedImage(): InkStroke | null {
		if (this.selection.size !== 1) return null;
		const [s] = this.selection;
		return isImageStroke(s) ? s : null;
	}

	selectionGrabRect(): PageRect | null {
		const b = computeSelectionBounds([...this.selection]);
		if (!b) return null;
		const pad = SELECTION_GRAB_TOLERANCE_PX / this.camera.zoom;
		return { minX: b.minX - pad, minY: b.minY - pad, maxX: b.maxX + pad, maxY: b.maxY + pad };
	}

	/** Topmost stroke under a page point, with a few pixels of reach for thin lines. */
	hitStroke(p: { x: number; y: number }): InkStroke | null {
		const reach = 6 / this.camera.zoom;
		const strokes = this.doc.strokes;
		for (let i = strokes.length - 1; i >= 0; i--) {
			const s = strokes[i];
			const b = approxStrokeBounds(s);
			if (p.x < b.minX - reach || p.x > b.maxX + reach || p.y < b.minY - reach || p.y > b.maxY + reach) continue;
			if (isImageStroke(s)) return s;
			if (strokeDistance(s, p.x, p.y) <= reach) return s;
		}
		return null;
	}

	clearSelection(): void {
		if (this.selection.size === 0) return;
		this.selection = new Set();
		this.syncOverlays();
		this.cb.onState();
	}

	selectAll(): void {
		this.selection = new Set(this.doc.strokes);
		if (this.tool !== 'select') this.setTool('select');
		this.syncOverlays();
		this.cb.onState();
	}

	deleteSelection(): void {
		if (!this.selection.size) return;
		const gone = this.selection;
		this.selection = new Set();
		this.doc.remove(gone);
	}

	/** Copies of the selection, a little down and right, selected. */
	duplicateSelection(): void {
		if (!this.selection.size) return;
		const shift = 24 / this.camera.zoom;
		const copies = this.doc.strokes
			.filter(s => this.selection.has(s))
			.map(s => ({ ...s, id: strokeId(), offset: { x: s.offset.x + shift, y: s.offset.y + shift } }));
		this.selection = new Set(copies);
		this.doc.add(copies);
	}

	/** Recolours the selected ink (images are left alone). */
	recolorSelection(color: string): void {
		const map = new Map<InkStroke, InkStroke[]>();
		const next = new Set<InkStroke>();
		for (const s of this.selection) {
			if (isImageStroke(s)) {
				next.add(s);
				continue;
			}
			const c = { ...s, style: { ...s.style, color } };
			map.set(s, [c]);
			next.add(c);
		}
		this.selection = next;
		this.doc.replace(map);
	}

	selectedStrokes(): InkStroke[] {
		return this.doc.strokes.filter(s => this.selection.has(s));
	}

	/** Pastes strokes copied from any canvas, centred in view, selected. */
	pasteStrokes(strokes: InkStroke[]): void {
		if (!strokes.length) return;
		let b: PageRect | null = null;
		for (const s of strokes) b = unionRect(b, approxStrokeBounds(s));
		const view = this.renderer.visiblePageRect();
		const dx = (view.minX + view.maxX) / 2 - (b!.minX + b!.maxX) / 2;
		const dy = (view.minY + view.maxY) / 2 - (b!.minY + b!.maxY) / 2;
		const copies = strokes.map(s => ({ ...s, id: strokeId(), offset: { x: s.offset.x + dx, y: s.offset.y + dy } }));
		this.setTool('select');
		this.selection = new Set(copies);
		this.doc.add(copies);
	}

	// Pan and zoom
	//////////

	private beginPan(e: PointerEvent, zoomDrag: boolean): void {
		if (this.mode === 'writing') {
			// A writing page has no camera: panning scrolls whatever holds the page.
			this.gesture = { kind: 'scroll', id: e.pointerId, lastY: e.clientY, history: [{ y: e.clientY, t: e.timeStamp }] };
			try { this.stage.setPointerCapture(e.pointerId); } catch { /* gone */ }
			return;
		}
		e.preventDefault();
		try { this.stage.setPointerCapture(e.pointerId); } catch { /* gone */ }
		const css = this.toCss(e);
		this.gesture = {
			kind: 'pan', id: e.pointerId, last: { x: e.clientX, y: e.clientY }, zoomDrag,
			anchor: css, startCam: { ...this.camera }, startCss: { x: e.clientX, y: e.clientY },
			history: [{ x: e.clientX, y: e.clientY, t: e.timeStamp }],
		};
	}

	private movePan(e: PointerEvent, g: Extract<Gesture, { kind: 'pan' }>): void {
		if (g.zoomDrag) {
			const delta = (g.startCss.y - e.clientY) + (e.clientX - g.startCss.x);
			const zoom = clampZoom(g.startCam.zoom * (1 + delta * 0.015));
			this.zoomTo(zoom, g.anchor, g.startCam);
			return;
		}
		const dx = e.clientX - g.last.x;
		const dy = e.clientY - g.last.y;
		g.last = { x: e.clientX, y: e.clientY };
		pushHistory(g.history, { x: e.clientX, y: e.clientY, t: e.timeStamp });
		this.panBy(dx, dy);
	}

	private finishPan(g: Extract<Gesture, { kind: 'pan' }>): void {
		if (g.zoomDrag) return;
		const v = releaseVelocity(g.history);
		if (v) this.startMomentum(v.x, v.y, (dx, dy) => this.panBy(dx, dy));
	}

	panBy(dxCss: number, dyCss: number): void {
		const z = this.camera.zoom;
		this.setCamera({ x: this.camera.x + dxCss / z, y: this.camera.y + dyCss / z, zoom: z });
	}

	/** Zoom keeping the page point under `anchor` (stage css px) fixed. */
	zoomTo(zoom: number, anchor: { x: number; y: number }, from: CameraState = this.camera): void {
		if (this.mode !== 'drawing' || this.zoomLocked) return;
		const z = clampZoom(zoom);
		const px = anchor.x / from.zoom - from.x;
		const py = anchor.y / from.zoom - from.y;
		this.setCamera({ x: anchor.x / z - px, y: anchor.y / z - py, zoom: z });
	}

	private onWheel(e: WheelEvent): void {
		if (this.mode !== 'drawing') return;
		if (e.ctrlKey || e.metaKey) {
			// Trackpad pinch arrives as ctrl+wheel too.
			e.preventDefault();
			if (this.zoomLocked) return;
			this.rect = null;
			const c = this.toCss(e);
			const steps = -e.deltaY / (e.deltaMode === 1 ? 3 : 100);
			this.zoomTo(this.camera.zoom * Math.pow(WHEEL_ZOOM_FACTOR, steps), c);
			return;
		}
		if (!this.embedded) {
			e.preventDefault();
			this.panBy(-e.deltaX, -e.deltaY);
		}
	}

	private moveScroll(e: PointerEvent, g: Extract<Gesture, { kind: 'scroll' }>): void {
		const scroller = this.cb.scroller?.();
		const dy = e.clientY - g.lastY;
		g.lastY = e.clientY;
		pushHistory(g.history, { y: e.clientY, t: e.timeStamp });
		if (scroller) scroller.scrollTop -= dy;
	}

	private finishScroll(g: Extract<Gesture, { kind: 'scroll' }>): void {
		const v = releaseVelocity(g.history.map(h => ({ x: 0, y: h.y, t: h.t })));
		const scroller = this.cb.scroller?.();
		if (v && scroller) this.startMomentum(0, v.y, (_dx, dy) => { scroller.scrollTop -= dy; });
	}

	private startMomentum(vx: number, vy: number, apply: (dx: number, dy: number) => void): void {
		this.stopMomentum();
		let last = performance.now();
		const step = (now: number) => {
			const dt = Math.min(64, now - last) / 1000;
			last = now;
			apply(vx * dt, vy * dt);
			const decay = Math.pow(MOMENTUM.friction, dt * 60);
			vx *= decay;
			vy *= decay;
			if (Math.hypot(vx, vy) < MOMENTUM.stopVelocity) {
				this.momentumFrame = 0;
				return;
			}
			this.momentumFrame = requestAnimationFrame(step);
		};
		this.momentumFrame = requestAnimationFrame(step);
	}

	private stopMomentum(): void {
		if (this.momentumFrame) cancelAnimationFrame(this.momentumFrame);
		this.momentumFrame = 0;
	}

	// Touch
	//////////

	private onTouchDown(e: PointerEvent): void {
		const now = e.timeStamp;
		if (this.touches.size === 0) this.tap = { start: now, max: 0, bad: false };
		else if (now - this.tap.start > TAP_EXTRA_FINGER_MS) this.tap.bad = true;
		this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, t: now });
		this.tap.max = Math.max(this.tap.max, this.touches.size);
		if (this.touches.size > 3) this.tap.bad = true;

		const s = this.cb.settings();
		if (this.touches.size === 1) {
			if (s.fingerDrawing) {
				this.begin(e, this.effectiveTool);
			} else if (this.mode === 'drawing') {
				// One finger on a drawing scrolls the note (the page uses touch-action: none here).
				this.gesture = { kind: 'scroll', id: e.pointerId, lastY: e.clientY, history: [{ y: e.clientY, t: now }] };
			}
			return;
		}
		// A second finger: whatever the first one started becomes a two-finger gesture.
		if (this.gesture && this.gesture.id !== e.pointerId) {
			if (this.gesture.kind === 'draw') {
				this.renderer.setLiveStroke(null);
				this.gesture = null;
			} else {
				this.cancelGesture();
			}
		}
		if (this.touches.size === 2) this.startPinch();
	}

	private startPinch(): void {
		const [a, b] = [...this.touches.values()];
		const r = this.stageRect();
		this.pinch = {
			dist: Math.hypot(a.x - b.x, a.y - b.y),
			mid: { x: (a.x + b.x) / 2 - r.left, y: (a.y + b.y) / 2 - r.top },
			cam: { ...this.camera },
		};
	}

	private onTouchMove(e: PointerEvent): void {
		const t = this.touches.get(e.pointerId);
		if (!t) return;
		t.x = e.clientX;
		t.y = e.clientY;
		if (Math.hypot(t.x - t.sx, t.y - t.sy) > TAP_MAX_TRAVEL_PX) this.tap.bad = true;
		if (this.touches.size >= 2 && this.pinch) {
			const [a, b] = [...this.touches.values()];
			const r = this.stageRect();
			const mid = { x: (a.x + b.x) / 2 - r.left, y: (a.y + b.y) / 2 - r.top };
			if (this.mode === 'drawing') {
				const dist = Math.hypot(a.x - b.x, a.y - b.y);
				const p0 = this.pinch;
				const zoom = this.zoomLocked ? p0.cam.zoom : clampZoom(p0.cam.zoom * (dist / Math.max(1, p0.dist)));
				// Page point under the starting midpoint follows the current midpoint.
				const px = p0.mid.x / p0.cam.zoom - p0.cam.x;
				const py = p0.mid.y / p0.cam.zoom - p0.cam.y;
				this.setCamera({ x: mid.x / zoom - px, y: mid.y / zoom - py, zoom });
			} else {
				const scroller = this.cb.scroller?.();
				if (scroller) scroller.scrollTop -= mid.y - this.pinch.mid.y;
				this.pinch.mid = mid;
			}
			return;
		}
		const g = this.gesture;
		if (g && g.id === e.pointerId) this.onPointerMoveGesture(e, g);
	}

	private onPointerMoveGesture(e: PointerEvent, g: Gesture): void {
		switch (g.kind) {
			case 'draw': this.moveDraw(e, g); break;
			case 'erase': this.moveErase(e, g); break;
			case 'shape': g.end = this.toPage(e); this.renderer.setLiveStrokes(this.shapeStrokes(g)); break;
			case 'lasso': this.moveLasso(e, g); break;
			case 'move': this.moveSelection(e, g); break;
			case 'resize': this.moveResize(e, g); break;
			case 'pan': this.movePan(e, g); break;
			case 'scroll': this.moveScroll(e, g); break;
		}
	}

	private onTouchUp(e: PointerEvent): void {
		this.touches.delete(e.pointerId);
		if (this.touches.size < 2) this.pinch = null;
		if (this.gesture && this.gesture.id === e.pointerId) this.finishGesture(e);
		if (this.touches.size === 0) {
			const fingers = this.tap.max;
			const ok = !this.tap.bad && fingers >= 2 && e.timeStamp - this.tap.start <= TAP_MAX_MS;
			if (ok && fingers === 2) this.undo();
			if (ok && fingers === 3) this.redo();
		}
	}

	// Keyboard (called by the plugin's capture-phase handler for the active editor)
	//////////

	/** Ctrl/Cmd alone, held, arms the eraser; anything pressed with it is a shortcut. */
	modifierDown(): void {
		if (this.modTimer || this.modArmed) return;
		this.modTimer = window.setTimeout(() => {
			this.modTimer = 0;
			if (this.effectiveTool === 'erase') return;
			this.modArmed = true;
			this.tempTool = 'erase';
			this.updateStageClasses();
			this.cb.onState();
		}, MOD_ERASE_ARM_MS);
	}

	modifierCancel(): void {
		window.clearTimeout(this.modTimer);
		this.modTimer = 0;
		if (this.modArmed) {
			this.modArmed = false;
			this.tempTool = null;
			this.updateStageClasses();
			this.cb.onState();
		}
	}

	// Images
	//////////

	async insertImage(blob: Blob, at?: { x: number; y: number }): Promise<void> {
		const { src, width, height } = await readPastedImage(blob);
		const view = this.renderer.visiblePageRect();
		const center = at ?? { x: (view.minX + view.maxX) / 2, y: (view.minY + view.maxY) / 2 };
		const maxWidth = this.mode === 'writing' ? WRITING_PAGE_WIDTH * 0.9 : (view.maxX - view.minX) * 0.6;
		const rect = placeImageRect(center, width, height, this.camera.zoom, maxWidth);
		const image = buildImageStroke(src, rect);
		this.doc.addUnder([image]);
		// Arrives selected, so it can be moved and resized right away.
		if (this.tool !== 'select') this.setTool('select');
		this.selection = new Set([image]);
		this.syncOverlays();
		this.cb.onState();
	}

	/** Last pointer position over the stage in page units, for pasting under the cursor. */
	lastPagePoint(): { x: number; y: number } | null {
		if (!this.lastPointer && this.lastHoverEvent) {
			this.rect = null;
			this.lastPointer = this.toPage(this.lastHoverEvent);
		}
		return this.lastPointer;
	}

	private lastPointer: { x: number; y: number } | null = null;
	private lastHoverEvent: PointerEvent | null = null;

	// Overlays (live layer)
	//////////

	syncOverlays(): void {
		const overlays: OverlayPainter[] = [];
		overlays.push((ctx, r) => this.paintGestureOverlay(ctx, r));
		if (this.selection.size) overlays.push((ctx) => this.paintSelection(ctx));
		overlays.push((ctx, r) => this.paintEraserRing(ctx, r));
		this.renderer.setOverlays(overlays);
	}

	private paintGestureOverlay(ctx: CanvasRenderingContext2D, r: InkRenderer): PageRect | null {
		const g = this.gesture;
		if (!g || g.kind !== 'lasso' || g.points.length < 2) return null;
		const zoom = this.camera.zoom;
		ctx.beginPath();
		ctx.moveTo(g.points[0].x, g.points[0].y);
		let box: PageRect = { minX: g.points[0].x, minY: g.points[0].y, maxX: g.points[0].x, maxY: g.points[0].y };
		for (const p of g.points) {
			ctx.lineTo(p.x, p.y);
			box = unionRect(box, { minX: p.x, minY: p.y, maxX: p.x, maxY: p.y });
		}
		ctx.closePath();
		ctx.fillStyle = withAlpha(r.palette.accent, 0.08);
		ctx.fill();
		ctx.strokeStyle = withAlpha(r.palette.accent, 0.7);
		ctx.lineWidth = 1.25 / zoom;
		ctx.setLineDash([5 / zoom, 4 / zoom]);
		ctx.stroke();
		return box;
	}

	private paintSelection(ctx: CanvasRenderingContext2D): PageRect | null {
		const g = this.gesture;
		if (g && (g.kind === 'move' && g.moved || g.kind === 'resize')) return null;
		const b = computeSelectionBounds([...this.selection]);
		if (!b) return null;
		const zoom = this.camera.zoom;
		const pad = 6 / zoom;
		const box = { minX: b.minX - pad, minY: b.minY - pad, maxX: b.maxX + pad, maxY: b.maxY + pad };
		ctx.strokeStyle = withAlpha(this.renderer.palette.accent, 0.85);
		ctx.lineWidth = 1.25 / zoom;
		ctx.setLineDash([6 / zoom, 4 / zoom]);
		ctx.strokeRect(box.minX, box.minY, box.maxX - box.minX, box.maxY - box.minY);
		ctx.setLineDash([]);
		const image = this.singleSelectedImage();
		if (image) {
			const rect = imageStrokeRect(image as InkStroke & { image: { src: string } });
			ctx.fillStyle = '#fff';
			for (const corner of IMAGE_RESIZE_CORNERS) {
				const c = imageCornerPoint(rect, corner);
				ctx.beginPath();
				ctx.arc(c.x, c.y, IMAGE_HANDLE_RADIUS_PX / zoom, 0, Math.PI * 2);
				ctx.fill();
				ctx.stroke();
			}
			const hp = (IMAGE_HANDLE_RADIUS_PX + 2) / zoom;
			return { minX: Math.min(box.minX, rect.x - hp), minY: Math.min(box.minY, rect.y - hp), maxX: Math.max(box.maxX, rect.x + rect.width + hp), maxY: Math.max(box.maxY, rect.y + rect.height + hp) };
		}
		return box;
	}

	private paintEraserRing(ctx: CanvasRenderingContext2D, r: InkRenderer): PageRect | null {
		if (!this.hover || this.effectiveTool !== 'erase' && this.gesture?.kind !== 'erase') return null;
		const p = r.cssToPage(this.hover.x, this.hover.y);
		const radius = this.eraserRadiusPage();
		ctx.beginPath();
		ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
		ctx.lineWidth = 1.25 / this.camera.zoom;
		ctx.strokeStyle = withAlpha(r.palette.ink, 0.55);
		ctx.stroke();
		return { minX: p.x - radius, minY: p.y - radius, maxX: p.x + radius, maxY: p.y + radius };
	}
}

/** Page area a change touched: everything that left and everything that arrived. */
function changeRegion(added: InkStroke[], removed: InkStroke[]): PageRect | null {
	let r: PageRect | null = null;
	for (const s of added) r = unionRect(r, approxStrokeBounds(s));
	for (const s of removed) r = unionRect(r, approxStrokeBounds(s));
	return r;
}

function pushHistory<T extends { t: number }>(history: T[], item: T): void {
	history.push(item);
	while (history.length > 2 && item.t - history[0].t > MOMENTUM.windowMs) history.shift();
}

function releaseVelocity(history: Array<{ x: number; y: number; t: number }>): { x: number; y: number } | null {
	if (history.length < 2) return null;
	const a = history[0];
	const b = history[history.length - 1];
	const dt = (b.t - a.t) / 1000;
	if (dt <= 0) return null;
	let vx = (b.x - a.x) / dt;
	let vy = (b.y - a.y) / dt;
	const speed = Math.hypot(vx, vy);
	if (speed < MOMENTUM.minVelocity) return null;
	if (speed > MOMENTUM.maxVelocity) {
		vx *= MOMENTUM.maxVelocity / speed;
		vy *= MOMENTUM.maxVelocity / speed;
	}
	return { x: vx, y: vy };
}

function pointInPolygon(x: number, y: number, poly: Array<{ x: number; y: number }>): boolean {
	let inside = false;
	for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
		const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
		if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
	}
	return inside;
}

export function withAlpha(color: string, alpha: number): string {
	if (color.startsWith('#') && (color.length === 7 || color.length === 4)) {
		const hex = color.length === 4 ? color.slice(1).split('').map(c => c + c).join('') : color.slice(1);
		const n = parseInt(hex, 16);
		return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
	}
	return color;
}
