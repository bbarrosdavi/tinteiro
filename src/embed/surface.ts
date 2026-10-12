import { Notice } from 'obsidian';
import type { InkHost, ActiveSurface } from '../plugin-api';
import type { DocEntry } from './doc-store';
import { InkEditor } from '../engine/editor';
import { Toolbar, type ToolbarHost } from '../ui/toolbar';
import type { InkMode, InkStroke, InkTool } from '../model/types';
import { DOT_DENSITY_SCALE, type InkSettings } from '../settings';
import { paletteFor } from './palette';
import { WRITING_LINE_HEIGHT, WRITING_PAGE_WIDTH } from '../model/constants';
import { clipboardHasImageSync, getClipboardImageFile, readClipboardImageBlob } from '../geom/ink-images';

const STROKES_MARKER = 'tinteiro:strokes';

/**
 * An editor wired to the plugin: document, settings, palette, toolbar and keys.
 * Embeds wrap it with locking and sizing; the full view uses it as is.
 */
export class InkSurface implements ActiveSurface {
	readonly editor: InkEditor;
	toolbar: Toolbar | null = null;
	private hovered = false;
	private unsubs: Array<() => void> = [];
	private lastSettings: InkSettings;
	onFramingChange?: () => void;
	onPageHeight?: (height: number) => void;
	/** Locked previews show the page colour stored in the file. */
	locked = false;
	/** Embed-specific toolbar actions, filled by the owner. */
	actions: Partial<ToolbarHost> = {};

	constructor(
		readonly host: InkHost,
		readonly root: HTMLElement,
		readonly stage: HTMLElement,
		readonly entry: DocEntry,
		readonly mode: InkMode,
		readonly embedded: boolean,
		private scroller: () => HTMLElement | null,
	) {
		this.lastSettings = { ...host.settings };
		this.editor = new InkEditor(stage, entry.doc, mode, {
			settings: () => this.host.settings,
			onEdit: () => {
				// The page colour in force when the file is written travels with it (locked previews use it).
				const t = this.host.settings.canvasTheme;
				this.entry.doc.snapshot.canvasTheme = t === 'auto' ? undefined : t;
			},
			onState: () => this.toolbar?.update(),
			onCamera: () => {
				this.onFramingChange?.();
				this.toolbar?.update();
			},
			onPageHeight: h => this.onPageHeight?.(h),
			onActivate: () => this.host.setActiveSurface(this),
			scroller: this.scroller,
		});
		this.editor.embedded = embedded;
		this.unsubs.push(host.docs.addBusyCheck(entry, () => this.editor.isBusy));
		this.unsubs.push(host.onSettingsChange(() => this.applySettings()));
		const enter = () => { this.hovered = true; };
		const leave = () => { this.hovered = false; };
		stage.addEventListener('pointerenter', enter);
		stage.addEventListener('pointerleave', leave);
		this.unsubs.push(() => {
			stage.removeEventListener('pointerenter', enter);
			stage.removeEventListener('pointerleave', leave);
		});
		this.applySettings(true);
	}

	dispose(): void {
		if (this.host.activeSurface() === this) this.host.setActiveSurface(null);
		this.hideToolbar();
		for (const u of this.unsubs) u();
		this.editor.dispose();
	}

	// Settings and look
	//////////

	applySettings(initial = false): void {
		const s = this.host.settings;
		const prev = this.lastSettings;
		this.lastSettings = { ...s };
		// The plugin swaps the curve and drops cached outlines; each surface just repaints.
		if (!initial && prev.pressureCurve !== s.pressureCurve) this.editor.renderer.invalidate();
		this.editor.zoomLocked = this.mode === 'drawing' && s.zoomLocked;
		// A width or colour change must not repaint the page: only look-related keys do.
		const look: Array<keyof InkSettings> = ['canvasTheme', 'writingLayout', 'drawingLayout', 'writingLineHeight', 'dotDensity'];
		if (initial || look.some(k => prev[k] !== s[k])) this.applyLook();
		this.editor.updateStageClasses();
		if (this.toolbar) {
			if (prev.toolbarPlacement !== s.toolbarPlacement || prev.toolbarSwatches !== s.toolbarSwatches
				|| (s.toolbarSwatches && prev.recentColors.join() !== s.recentColors.join())) {
				this.hideToolbar();
				this.showToolbar();
			} else {
				this.toolbar.update();
			}
		}
		if (prev.eraserSize !== s.eraserSize || prev.eraserMode !== s.eraserMode) this.editor.syncOverlays();
	}

	/** Theme, paper and page colour for the renderer and the shadow root. */
	applyLook(): void {
		const s = this.host.settings;
		const docTheme = this.entry.doc.snapshot.canvasTheme;
		const theme = this.locked ? (docTheme ?? s.canvasTheme) : s.canvasTheme;
		const pal = paletteFor(theme);
		this.editor.renderer.setPalette(pal);
		this.root.classList.toggle('theme-light', theme === 'light');
		this.root.classList.toggle('theme-dark', theme === 'dark');
		this.root.style.setProperty('--inkf-accent-canvas', pal.accent);
		const layout = this.mode === 'writing' ? s.writingLayout : s.drawingLayout;
		const showGrid = this.mode === 'writing' || this.entry.doc.snapshot.gridEnabled !== false;
		const lineHeight = this.entry.doc.snapshot.writingLineHeight ?? (this.mode === 'writing' ? WRITING_LINE_HEIGHT : s.writingLineHeight);
		this.editor.renderer.setBackground(showGrid
			? { layout, lineHeight, mode: this.mode, pageWidth: WRITING_PAGE_WIDTH, pageHeight: this.mode === 'writing' ? this.editor.pageHeight || undefined : undefined, dotScale: DOT_DENSITY_SCALE[s.dotDensity] }
			: null);
	}

	/** Locked previews may hide the rulings ("lines when locked" off). */
	setBackgroundVisible(visible: boolean): void {
		if (visible) this.applyLook();
		else this.editor.renderer.setBackground(null);
	}

	// Toolbar
	//////////

	showToolbar(): void {
		if (this.toolbar) return;
		this.toolbar = new Toolbar(this.toolbarHost(), this.root);
	}

	hideToolbar(): void {
		this.toolbar?.dispose();
		this.toolbar = null;
	}

	private toolbarHost(): ToolbarHost {
		const ed = this.editor;
		const h = this.host;
		return {
			mode: this.mode,
			embedded: this.embedded,
			settings: () => h.settings,
			updateSettings: patch => h.updateSettings(patch),
			tool: () => ed.effectiveTool,
			setTool: (t: InkTool) => ed.setTool(t),
			canUndo: () => ed.doc.canUndo(),
			canRedo: () => ed.doc.canRedo(),
			undo: () => { ed.undo(); },
			redo: () => { ed.redo(); },
			selectionCount: () => ed.selection.size,
			deleteSelection: () => ed.deleteSelection(),
			duplicateSelection: () => ed.duplicateSelection(),
			copySelection: () => { this.copySelection(); },
			pasteStrokes: () => {
				ed.pasteStrokes(h.strokeClipboard);
				return h.strokeClipboard.length > 0;
			},
			hasCopiedStrokes: () => h.strokeClipboard.length > 0,
			recolorSelection: c => ed.recolorSelection(c),
			selectAll: () => ed.selectAll(),
			pasteImage: () => { void this.pasteImageButton(); },
			eraseAll: () => this.eraseAll(),
			done: () => this.actions.done?.(),
			framingDirty: () => this.actions.framingDirty?.() ?? false,
			saveFraming: () => this.actions.saveFraming?.(),
			openFullView: this.actions.openFullView,
			copyAsImage: () => { void this.copyAsImage(); },
			convert: this.actions.convert,
			inkColor: () => ed.renderer.palette.ink,
			gridEnabled: () => ed.doc.snapshot.gridEnabled !== false,
			setGridEnabled: on => {
				ed.doc.snapshot.gridEnabled = on;
				h.docs.touch(this.entry);
				this.applyLook();
				this.toolbar?.update();
			},
			addLines: this.actions.addLines,
			copyEmbed: this.actions.copyEmbed,
			deleteEmbed: this.actions.deleteEmbed,
		};
	}

	// Actions
	//////////

	eraseAll(): void {
		if (!this.editor.doc.strokes.length) return;
		this.editor.doc.clear();
		new Notice('Tudo apagado. Desfazer traz de volta.', 2500);
	}

	copySelection(): boolean {
		const strokes = this.editor.selectedStrokes();
		if (!strokes.length) return false;
		this.host.copyStrokes(strokes.map(cloneStroke));
		try {
			void navigator.clipboard.writeText(STROKES_MARKER);
		} catch {
			// Clipboard unavailable: the in-app copy still works.
		}
		this.toolbar?.update();
		return true;
	}

	async pasteImageButton(): Promise<void> {
		const blob = await readClipboardImageBlob();
		if (!blob) {
			new Notice('Nenhuma imagem na área de transferência');
			return;
		}
		await this.editor.insertImage(blob);
	}

	async copyAsImage(): Promise<void> {
		const blob = await this.editor.renderer.toBlob();
		if (!blob) return;
		try {
			// eslint-disable-next-line @typescript-eslint/no-require-imports
			const electron = (window as unknown as { require?: (m: string) => unknown }).require?.('electron') as
				{ clipboard?: { writeImage(img: unknown): void }; nativeImage?: { createFromBuffer(b: Buffer): unknown } } | undefined;
			if (electron?.clipboard && electron.nativeImage) {
				const buf = Buffer.from(await blob.arrayBuffer());
				electron.clipboard.writeImage(electron.nativeImage.createFromBuffer(buf));
			} else {
				await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
			}
			new Notice('Imagem copiada');
		} catch {
			new Notice('Não deu para copiar a imagem');
		}
	}

	// ActiveSurface
	//////////

	undo(): boolean {
		return this.editor.undo();
	}

	redo(): boolean {
		return this.editor.redo();
	}

	canUndo(): boolean {
		return this.editor.doc.canUndo();
	}

	deleteSelection(): boolean {
		if (!this.editor.selection.size) return false;
		this.editor.deleteSelection();
		return true;
	}

	async pasteFromClipboard(e: ClipboardEvent | KeyboardEvent): Promise<boolean> {
		const file = 'clipboardData' in e ? getClipboardImageFile(e.clipboardData) : null;
		if (file) {
			await this.editor.insertImage(file, this.editor.lastPagePoint() ?? undefined);
			return true;
		}
		if (!('clipboardData' in e) && clipboardHasImageSync()) {
			const blob = await readClipboardImageBlob();
			if (blob) {
				await this.editor.insertImage(blob, this.editor.lastPagePoint() ?? undefined);
				return true;
			}
		}
		const text = 'clipboardData' in e ? e.clipboardData?.getData('text/plain') : undefined;
		if (text === STROKES_MARKER && this.host.strokeClipboard.length) {
			this.editor.pasteStrokes(this.host.strokeClipboard);
			return true;
		}
		return false;
	}

	modifierDown(): void {
		this.editor.modifierDown();
	}

	modifierCancel(): void {
		this.editor.modifierCancel();
	}

	selectAll(): void {
		this.editor.selectAll();
	}

	escape(): boolean {
		if (this.editor.selection.size) {
			this.editor.clearSelection();
			return true;
		}
		return false;
	}

	isHovered(): boolean {
		return this.hovered;
	}

	isAttached(): boolean {
		return this.stage.isConnected;
	}
}

function cloneStroke(s: InkStroke): InkStroke {
	return { ...s, points: s.points.map(p => [p[0], p[1], p[2]]), style: { ...s.style }, offset: { ...s.offset } };
}
