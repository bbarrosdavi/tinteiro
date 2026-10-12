import { Menu, Notice, TFile } from 'obsidian';
import type { InkHost } from '../plugin-api';
import type { DocEntry } from './doc-store';
import { InkSurface } from './surface';
import { adoptEmbedStyles } from '../ui/styles';
import { iconSvg } from '../ui/icons';
import type { InkMode } from '../model/types';
import { WRITING_PAGE_WIDTH } from '../model/constants';
import { buildEmbedMarkdown, withDrawingDefaults, type EmbedParams } from '../obsidian/embed-syntax';
import { removeEmbedFlow } from '../obsidian/remove-embed';
import { convertStrokes } from './convert';

/**
 * One embed in a note (Live Preview or Reading view). The light-DOM host only holds a shadow
 * root, so nothing the embed does inside (canvas, toolbar, class flips) is visible to the
 * note's editor and its MutationObserver.
 *
 * Locked: the page is painted once and the GPU memory is released when it scrolls far away.
 * Editing: the same canvases come alive; there is no repaint when switching.
 */

export interface EmbedContext {
	host: InkHost;
	mode: InkMode;
	/** Link path as written in the note. */
	linkPath: string;
	sourcePath: string;
	params: EmbedParams;
	/** Rewrites this embed's markdown (new params, new path, new mode). */
	rewrite(update: { params?: EmbedParams; path?: string; mode?: InkMode }): void;
	/** Removes this embed's markdown. */
	remove?(): void;
}

/** One observer for every embed: visibility drives loading and releasing. */
let sharedObserver: IntersectionObserver | null = null;
const observed = new WeakMap<Element, (visible: boolean, far: boolean) => void>();

function observe(el: Element, cb: (visible: boolean, far: boolean) => void): void {
	if (!sharedObserver) {
		sharedObserver = new IntersectionObserver(entries => {
			for (const e of entries) observed.get(e.target)?.(e.isIntersecting, !e.isIntersecting);
		}, { rootMargin: '150% 0px 150% 0px' });
	}
	observed.set(el, cb);
	sharedObserver.observe(el);
}

function unobserve(el: Element): void {
	observed.delete(el);
	sharedObserver?.unobserve(el);
}

const live = new Set<InkEmbed>();

/**
 * Rewriting the note (new size, framing, path) makes Reading view render the section again,
 * which replaces this embed. The replacement reopens for editing if it shows up right away.
 */
const reopen = new Map<string, number>();
const REOPEN_WINDOW_MS = 3000;

/** A freshly inserted embed opens ready to write. */
export function openOnMount(sourcePath: string, path: string): void {
	reopen.set(`${sourcePath}|${path}`, Date.now());
}

/** Embeds currently mounted (the plugin locks them on unload). */
export function liveEmbeds(): Iterable<InkEmbed> {
	return live;
}

export class InkEmbed {
	readonly el: HTMLDivElement;
	private shadow: ShadowRoot;
	private root: HTMLDivElement;
	private stage: HTMLDivElement;
	private bannerEl: HTMLDivElement | null = null;
	private entry: DocEntry | null = null;
	private surface: InkSurface | null = null;
	private file: TFile | null = null;
	private state: 'idle' | 'loading' | 'locked' | 'editing' | 'missing' | 'error' = 'idle';
	private visible = false;
	private width = 0;
	private resizeObs: ResizeObserver | null = null;
	private resizeHandle: HTMLDivElement | null = null;
	private extraLines = 0;
	private disposed = false;
	private unsubs: Array<() => void> = [];

	constructor(private ctx: EmbedContext) {
		this.el = document.createElement('div');
		this.el.className = 'inkf-host';
		this.el.dataset.inkMode = ctx.mode;
		this.shadow = this.el.attachShadow({ mode: 'open' });
		adoptEmbedStyles(this.shadow);
		this.root = document.createElement('div');
		this.root.className = `embed is-locked mode-${ctx.mode}`;
		this.stage = document.createElement('div');
		this.stage.className = 'stage';
		this.root.append(this.stage);
		this.shadow.append(this.root);
		this.reserveHeight();
		this.wireLockedTap();
		live.add(this);
		const rewrite = ctx.rewrite;
		ctx.rewrite = update => {
			if (this.state === 'editing') reopen.set(this.key(update.path), Date.now());
			rewrite(update);
		};
	}

	private key(path?: string): string {
		return `${this.ctx.sourcePath}|${path ?? this.ctx.linkPath}`;
	}

	get mode(): InkMode {
		return this.ctx.mode;
	}

	get filePath(): string | null {
		return this.file?.path ?? null;
	}

	/** Starts watching visibility; call once the host is in the document. */
	mount(): void {
		observe(this.el, visible => this.onVisibility(visible));
		this.resizeObs = new ResizeObserver(entries => {
			const w = Math.round(entries[0].contentRect.width);
			if (w && w !== this.width) {
				this.width = w;
				this.layout();
			}
		});
		this.resizeObs.observe(this.el);
	}

	/** Called when the markdown changed but this embed stays (e.g. new framing written). */
	update(ctx: EmbedContext): void {
		const rewrite = ctx.rewrite;
		ctx.rewrite = update => {
			if (this.state === 'editing') reopen.set(this.key(update.path), Date.now());
			rewrite(update);
		};
		const pathChanged = ctx.linkPath !== this.ctx.linkPath || ctx.mode !== this.ctx.mode;
		this.ctx = ctx;
		if (pathChanged) {
			this.unload();
			this.state = 'idle';
			if (this.visible) void this.load();
			return;
		}
		if (this.state === 'locked') this.layout();
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		live.delete(this);
		unobserve(this.el);
		this.resizeObs?.disconnect();
		for (const u of this.unsubs) u();
		this.unload();
	}

	// Loading
	//////////

	private resolveFile(): TFile | null {
		const app = this.ctx.host.app;
		const direct = app.vault.getAbstractFileByPath(this.ctx.linkPath);
		if (direct instanceof TFile) return direct;
		return app.metadataCache.getFirstLinkpathDest(this.ctx.linkPath, this.ctx.sourcePath);
	}

	private onVisibility(visible: boolean): void {
		this.visible = visible;
		if (visible && this.state === 'idle') void this.load();
		// Far off-screen and locked: give the canvas memory back; the parsed file stays cached.
		if (!visible && this.state === 'locked') this.unload();
	}

	private async load(): Promise<void> {
		if (this.state !== 'idle' || this.disposed) return;
		this.state = 'loading';
		const file = this.resolveFile();
		if (!file) {
			this.state = 'missing';
			this.showMissing();
			return;
		}
		this.file = file;
		try {
			this.entry = await this.ctx.host.docs.acquire(file, this.ctx.mode, this.ctx.host.settings.drawingGridEnabledByDefault);
		} catch (err) {
			console.error('Tinteiro: could not read', file.path, err);
			this.state = 'error';
			this.showBanner('Não foi possível ler este arquivo de tinta.', []);
			return;
		}
		if (this.disposed || this.state !== 'loading') {
			if (this.entry) this.ctx.host.docs.release(this.entry);
			this.entry = null;
			return;
		}
		this.clearBanner();
		const surface = new InkSurface(this.ctx.host, this.root, this.stage, this.entry, this.ctx.mode, true, () => this.scroller());
		surface.locked = true;
		surface.editor.interactive = false;
		surface.onPageHeight = () => this.layout();
		surface.onFramingChange = () => undefined;
		surface.actions = {
			done: () => this.lock(),
			framingDirty: () => this.framingDirty(),
			saveFraming: () => this.saveFraming(),
			openFullView: () => { void this.openFullView(); },
			convert: () => { void this.convert(); },
			addLines: this.ctx.mode === 'writing' ? () => { this.extraLines += 3; this.layout(); } : undefined,
			copyEmbed: () => this.copyEmbed(),
			deleteEmbed: this.ctx.remove ? () => this.deleteEmbed() : undefined,
		};
		this.surface = surface;
		this.state = 'locked';
		this.applyLockedLook();
		this.layout();
		if (this.ctx.params.pendingPaste) this.showPendingPaste();
		const t = reopen.get(this.key());
		if (t !== undefined) {
			reopen.delete(this.key());
			if (Date.now() - t < REOPEN_WINDOW_MS) this.unlock();
		}
	}

	/** Drops the canvases and the document reference (state back to idle). */
	private unload(): void {
		if (this.state === 'editing') this.lock();
		this.surface?.dispose();
		this.surface = null;
		this.resizeHandle?.remove();
		this.resizeHandle = null;
		if (this.entry) this.ctx.host.docs.release(this.entry);
		this.entry = null;
		if (this.state !== 'missing' && this.state !== 'error') this.state = 'idle';
	}

	private scroller(): HTMLElement | null {
		return this.el.closest('.cm-scroller, .markdown-preview-view, .markdown-reading-view') as HTMLElement | null;
	}

	// Size
	//////////

	private reserveHeight(): void {
		const w = this.el.clientWidth || 600;
		const h = this.computeHeight(w, false);
		if (h) this.el.style.minHeight = `${Math.round(h)}px`;
	}

	private displayWidth(available: number): number {
		if (this.ctx.mode === 'writing') return available;
		const p = withDrawingDefaults(this.ctx.params);
		return Math.min(p.width, available);
	}

	private computeHeight(available: number, editing: boolean): number {
		const w = this.displayWidth(available);
		if (this.ctx.mode === 'drawing') return w / withDrawingDefaults(this.ctx.params).aspectRatio;
		if (this.surface) {
			const pageH = this.surface.editor.writingHeightFor(editing) + (editing ? this.extraLines * (this.entry?.doc.snapshot.writingLineHeight ?? 150) : 0);
			return pageH * (w / WRITING_PAGE_WIDTH);
		}
		const ar = this.ctx.params.aspectRatio;
		return ar ? w / ar : 0;
	}

	/** Sizes the stage to the note column and frames the page. */
	layout(): void {
		const surface = this.surface;
		if (!surface) return;
		const available = this.width || this.el.clientWidth;
		if (!available) return;
		const editing = this.state === 'editing';
		const w = Math.round(this.displayWidth(available));
		const h = Math.max(1, Math.round(this.computeHeight(available, editing)));
		this.stage.style.width = `${w}px`;
		this.stage.style.height = `${h}px`;
		// The embed is as wide as its page, so the resize handle sits on the page's corner.
		this.root.style.width = `${w}px`;
		this.el.style.minHeight = '';
		surface.editor.resize(w, h);
		if (this.ctx.mode === 'writing') {
			surface.editor.pageHeight = h / (w / WRITING_PAGE_WIDTH);
			surface.applyLook();
		} else if (!editing || !this.cameraTouched) {
			surface.editor.setCamera(this.savedCamera(w), false);
		}
	}

	private cameraTouched = false;

	private savedCamera(displayWidth: number): { x: number; y: number; zoom: number } {
		const vb = withDrawingDefaults(this.ctx.params).viewBox;
		const zoom = displayWidth / vb.width;
		return { x: -vb.x, y: -vb.y, zoom };
	}

	private framingDirty(): boolean {
		if (this.ctx.mode !== 'drawing' || !this.surface) return false;
		const saved = this.savedCamera(this.stage.clientWidth || 1);
		const c = this.surface.editor.camera;
		const eps = 1e-3;
		return Math.abs(c.zoom - saved.zoom) > eps * saved.zoom || Math.abs(c.x - saved.x) > 0.5 || Math.abs(c.y - saved.y) > 0.5;
	}

	private saveFraming(): void {
		if (!this.surface) return;
		const c = this.surface.editor.camera;
		const w = this.stage.clientWidth;
		const h = this.stage.clientHeight;
		const p = withDrawingDefaults(this.ctx.params);
		const params: EmbedParams = { ...p, viewBox: { x: -c.x, y: -c.y, width: w / c.zoom, height: h / c.zoom } };
		this.ctx.params = params;
		this.cameraTouched = false;
		this.ctx.rewrite({ params });
		this.surface.toolbar?.update();
	}

	// Lock / unlock
	//////////

	private wireLockedTap(): void {
		let down: { x: number; y: number; t: number; id: number } | null = null;
		const onDown = (e: PointerEvent) => {
			if (this.state !== 'locked') return;
			if (e.pointerType === 'mouse' && e.button !== 0) return;
			down = { x: e.clientX, y: e.clientY, t: e.timeStamp, id: e.pointerId };
		};
		const onUp = (e: PointerEvent) => {
			if (this.state !== 'locked' || !down || down.id !== e.pointerId) return;
			const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
			const quick = e.timeStamp - down.t < 500;
			down = null;
			if (moved < 8 && quick) {
				e.preventDefault();
				e.stopPropagation();
				this.unlock();
			}
		};
		this.stage.addEventListener('pointerdown', onDown);
		this.stage.addEventListener('pointerup', onUp);
		// Right click or long press on a locked embed: the embed's own menu.
		this.stage.addEventListener('contextmenu', e => {
			if (this.state !== 'locked' && this.state !== 'missing') return;
			e.preventDefault();
			e.stopPropagation();
			const menu = new Menu();
			if (this.state === 'locked') menu.addItem(i => i.setTitle('Editar').setIcon('pencil').onClick(() => this.unlock()));
			if (this.file) menu.addItem(i => i.setTitle('Abrir em tela cheia').setIcon('maximize-2').onClick(() => void this.openFullView()));
			menu.addItem(i => i.setTitle('Copiar embed').setIcon('copy').onClick(() => this.copyEmbed()));
			if (this.ctx.remove) menu.addItem(i => i.setTitle('Apagar embed').setIcon('trash-2').setWarning(true).onClick(() => this.deleteEmbed()));
			menu.showAtMouseEvent(e);
		});
		// Clicks inside must never move the note's cursor onto the embed's markdown.
		const stop = (e: Event) => e.stopPropagation();
		this.root.addEventListener('mousedown', stop);
		this.root.addEventListener('click', stop);
	}

	unlock(): void {
		const surface = this.surface;
		if (this.state !== 'locked' || !surface) return;
		this.state = 'editing';
		this.cameraTouched = false;
		surface.onFramingChange = () => { this.cameraTouched = true; };
		surface.locked = false;
		surface.editor.interactive = true;
		this.root.classList.remove('is-locked', 'page-plain', 'framed');
		this.root.classList.add('is-editing', 'page-filled');
		surface.applyLook();
		surface.showToolbar();
		this.ctx.host.setActiveSurface(surface);
		if (this.entry) this.ctx.host.docs.warmSaveCaches(this.entry);
		if (this.ctx.mode === 'drawing') this.addResizeHandle();
		this.layout();
	}

	lock(): void {
		const surface = this.surface;
		if (this.state !== 'editing' || !surface) return;
		surface.editor.cancelGesture();
		surface.editor.clearSelection();
		surface.hideToolbar();
		surface.editor.interactive = false;
		surface.locked = true;
		if (this.entry) void this.ctx.host.docs.flush(this.entry.path);
		this.state = 'locked';
		this.extraLines = 0;
		this.cameraTouched = false;
		this.resizeHandle?.remove();
		this.resizeHandle = null;
		this.root.classList.remove('is-editing');
		this.root.classList.add('is-locked');
		if (this.ctx.host.activeSurface() === surface) this.ctx.host.setActiveSurface(null);
		this.applyLockedLook();
		// Abandons an unsaved framing: the saved one comes back.
		this.layout();
	}

	private applyLockedLook(): void {
		const s = this.ctx.host.settings;
		const surface = this.surface;
		if (!surface) return;
		const writing = this.ctx.mode === 'writing';
		const background = writing ? s.writingBackgroundWhenLocked : s.drawingBackgroundWhenLocked;
		const lines = writing ? s.writingLinesWhenLocked : s.drawingBackgroundWhenLocked;
		const hasStrokes = (this.entry?.doc.strokes.length ?? 0) > 0;
		this.root.classList.toggle('page-filled', background && hasStrokes);
		this.root.classList.toggle('page-plain', !(background && hasStrokes));
		this.root.classList.toggle('framed', !writing && s.drawingFrameWhenLocked);
		this.root.classList.toggle('left-handed', s.dominantHand === 'left');
		surface.applyLook();
		surface.setBackgroundVisible(lines && hasStrokes);
	}

	// Drawing resize
	//////////

	private addResizeHandle(): void {
		if (this.resizeHandle) return;
		const handle = document.createElement('div');
		handle.className = 'resize';
		handle.setAttribute('aria-label', 'Redimensionar');
		this.root.append(handle);
		this.resizeHandle = handle;
		let start: { x: number; y: number; w: number; h: number; cam: { x: number; y: number; zoom: number } } | null = null;
		let frame = 0;
		let pending: { w: number; h: number } | null = null;
		const leftHanded = () => this.ctx.host.settings.dominantHand === 'left';
		handle.addEventListener('pointerdown', e => {
			if (!this.surface) return;
			e.preventDefault();
			e.stopPropagation();
			handle.setPointerCapture(e.pointerId);
			start = { x: e.clientX, y: e.clientY, w: this.stage.clientWidth, h: this.stage.clientHeight, cam: { ...this.surface.editor.camera } };
		});
		handle.addEventListener('pointermove', e => {
			if (!start) return;
			// The drawing is centred: it grows on both sides, so the edge follows the pen.
			const dx = (e.clientX - start.x) * (leftHanded() ? -1 : 1) * 2;
			const available = this.width || this.el.clientWidth;
			pending = {
				w: Math.max(120, Math.min(available, start.w + dx)),
				h: Math.max(80, start.h + (e.clientY - start.y)),
			};
			if (!frame) frame = requestAnimationFrame(() => {
				frame = 0;
				if (!pending || !this.surface || !start) return;
				const w = Math.round(pending.w);
				const h = Math.round(pending.h);
				this.stage.style.width = `${w}px`;
				this.stage.style.height = `${h}px`;
				this.root.style.width = `${w}px`;
				// Content stays put on screen: the page point at the centre stays at the centre.
				const z = start.cam.zoom;
				this.surface.editor.setCamera({ x: start.cam.x + (w - start.w) / 2 / z, y: start.cam.y, zoom: z }, false);
				this.surface.editor.resize(w, h);
			});
		});
		const end = () => {
			if (!start || !this.surface) return;
			start = null;
			if (!pending) return;
			const c = this.surface.editor.camera;
			const p = withDrawingDefaults(this.ctx.params);
			const params: EmbedParams = {
				...p,
				width: pending.w,
				aspectRatio: pending.w / pending.h,
				viewBox: { x: -c.x, y: -c.y, width: pending.w / c.zoom, height: pending.h / c.zoom },
			};
			pending = null;
			// A moved but unsaved framing stays unsaved: the size changes around the saved one.
			if (this.cameraTouched) {
				const savedZoom = p.width / p.viewBox.width;
				params.viewBox = { x: p.viewBox.x, y: p.viewBox.y, width: params.width! / savedZoom, height: params.width! / params.aspectRatio! / savedZoom };
			}
			this.ctx.params = params;
			this.ctx.rewrite({ params });
		};
		handle.addEventListener('pointerup', end);
		handle.addEventListener('pointercancel', end);
	}

	// Actions
	//////////

	private async openFullView(): Promise<void> {
		if (!this.file) return;
		const file = this.file;
		this.lock();
		await this.ctx.host.openFullView(file, this.ctx.mode);
	}

	private async convert(): Promise<void> {
		if (!this.entry || !this.file) return;
		const to: InkMode = this.ctx.mode === 'drawing' ? 'writing' : 'drawing';
		const doc = this.entry.doc;
		const { strokes, snapshot, params } = convertStrokes(doc.toSnapshot(), this.ctx.mode, to, this.ctx.host.settings.writingLineHeight);
		await this.ctx.host.docs.flush(this.entry.path);
		this.lock();
		this.ctx.host.docs.setMode(this.entry, to);
		doc.snapshot = snapshot;
		doc.replaceAll(strokes);
		await this.ctx.host.docs.flush(this.entry.path);
		this.ctx.rewrite({ mode: to, params });
		new Notice(to === 'writing' ? 'Convertido em escrita' : 'Convertido em desenho');
	}

	private copyEmbed(): void {
		const md = buildEmbedMarkdown(this.ctx.mode, this.ctx.linkPath, this.ctx.params);
		void navigator.clipboard.writeText(md).then(() => new Notice('Embed copiado'), () => new Notice('Não foi possível copiar'));
	}

	private deleteEmbed(): void {
		const remove = this.ctx.remove;
		if (!remove) return;
		if (this.state === 'editing') this.lock();
		removeEmbedFlow(this.ctx.host.app, this.file, this.ctx.mode, remove);
	}

	// Banners
	//////////

	private showBanner(text: string, buttons: Array<{ label: string; primary?: boolean; run: () => void }>): void {
		this.clearBanner();
		const b = document.createElement('div');
		b.className = 'banner glass';
		const t = document.createElement('span');
		t.textContent = text;
		const spacer = document.createElement('span');
		spacer.className = 'spacer';
		b.append(t, spacer);
		for (const btn of buttons) {
			const el = document.createElement('button');
			el.className = `text${btn.primary ? ' primary' : ''}`;
			el.textContent = btn.label;
			el.addEventListener('click', e => {
				e.stopPropagation();
				btn.run();
			});
			b.append(el);
		}
		this.root.prepend(b);
		this.bannerEl = b;
	}

	private clearBanner(): void {
		this.bannerEl?.remove();
		this.bannerEl = null;
	}

	private showMissing(): void {
		this.stage.style.height = '0px';
		this.el.style.minHeight = '';
		this.showBanner(`Arquivo não encontrado: ${this.ctx.linkPath}`, [{
			label: 'Localizar arquivo',
			primary: true,
			run: async () => {
				const file = await this.ctx.host.pickInkFile(this.ctx.mode);
				if (file) this.ctx.rewrite({ path: file.path });
			},
		}]);
		const icon = document.createElement('span');
		icon.innerHTML = iconSvg('fileOpen', 18);
		this.bannerEl?.prepend(icon);
	}

	private showPendingPaste(): void {
		this.showBanner('Embed colado: usar o mesmo arquivo ou criar uma cópia?', [
			{
				label: 'Mesmo arquivo',
				run: () => {
					const params = { ...this.ctx.params };
					delete params.pendingPaste;
					this.ctx.params = params;
					this.clearBanner();
					this.ctx.rewrite({ params });
				},
			},
			{
				label: 'Duplicar',
				primary: true,
				run: async () => {
					if (!this.file) return;
					const copy = await this.ctx.host.duplicateInkFile(this.file, this.ctx.mode, this.ctx.sourcePath);
					const params = { ...this.ctx.params };
					delete params.pendingPaste;
					this.ctx.rewrite({ path: copy.path, params });
				},
			},
		]);
	}
}
