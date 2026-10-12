import { MarkdownView, Plugin, TFile, type Editor, type MarkdownFileInfo, type WorkspaceLeaf } from 'obsidian';
import type { InkHost, ActiveSurface } from './plugin-api';
import { DEFAULT_SETTINGS, normaliseSettings, type InkSettings } from './settings';
import { DocStore } from './embed/doc-store';
import { inkLivePreview } from './obsidian/live-preview';
import { readingModeProcessor } from './obsidian/reading-mode';
import { InkFullView, WRITING_VIEW, DRAWING_VIEW } from './obsidian/full-view';
import { buildEmbedMarkdown, findEmbeds, newDrawingParams } from './obsidian/embed-syntax';
import { createInkFile, duplicateInkFile, pickInkFile } from './obsidian/files';
import { InkSettingsTab } from './obsidian/settings-tab';
import { liveEmbeds, openOnMount } from './embed/ink-embed';
import { setPressureCurve, invalidateAllGeometry, strokePath } from './geom/outline';
import { invalidateThemePalette } from './embed/palette';
import type { InkMode, InkStroke } from './model/types';
import { isInkFileText } from './model/format';
import { WRITE_FILE_V1_EXT, DRAW_FILE_V1_EXT } from './model/constants';

const SETTINGS_SAVE_DELAY_MS = 400;

export default class TinteiroPlugin extends Plugin implements InkHost {
	settings: InkSettings = { ...DEFAULT_SETTINGS };
	docs!: DocStore;
	strokeClipboard: InkStroke[] = [];
	private active: ActiveSurface | null = null;
	private settingsListeners = new Set<() => void>();
	private saveTimer = 0;
	/** For measuring from the developer console; nothing in the plugin reads it. */
	readonly debug = { strokePath, liveEmbeds };

	async onload(): Promise<void> {
		await this.loadSettings();
		this.docs = new DocStore(this.app);

		this.registerEvent(this.app.vault.on('modify', f => {
			if (f instanceof TFile) void this.docs.onFileModified(f);
		}));
		this.registerEvent(this.app.vault.on('rename', (f, old) => {
			if (f instanceof TFile) this.docs.onFileRenamed(f, old);
		}));
		this.registerEvent(this.app.workspace.on('css-change', () => {
			invalidateThemePalette();
			this.notifySettings();
		}));

		this.registerEditorExtension(inkLivePreview(this));
		this.registerMarkdownPostProcessor(readingModeProcessor(this));
		this.registerView(WRITING_VIEW, leaf => new InkFullView(leaf, this, 'writing'));
		this.registerView(DRAWING_VIEW, leaf => new InkFullView(leaf, this, 'drawing'));
		// Pre-0.5 files open read-only, converted on the fly.
		try {
			this.registerExtensions([WRITE_FILE_V1_EXT], WRITING_VIEW);
			this.registerExtensions([DRAW_FILE_V1_EXT], DRAWING_VIEW);
		} catch {
			// Another plugin owns the extension.
		}

		this.registerCommands();
		this.registerEditorMenu();
		this.registerPasteHandler();
		this.registerKeys(document);
		this.registerEvent(this.app.workspace.on('window-open', win => this.registerKeys(win.doc)));
		this.registerSvgEditButton();
		this.addSettingTab(new InkSettingsTab(this.app, this));
	}

	async onunload(): Promise<void> {
		for (const e of [...liveEmbeds()]) e.dispose();
		await this.docs?.flushAll();
	}

	// Settings
	//////////

	private async loadSettings(): Promise<void> {
		const raw = await this.loadData();
		let legacy: unknown;
		if (!raw) {
			// First run: bring over the Ink (handnotes) settings.
			try {
				const path = `${this.app.vault.configDir}/plugins/ink-handnotes/data.json`;
				if (await this.app.vault.adapter.exists(path)) legacy = JSON.parse(await this.app.vault.adapter.read(path));
			} catch {
				legacy = undefined;
			}
		}
		this.settings = normaliseSettings(raw, legacy);
		setPressureCurve(this.settings.pressureCurve);
		if (!raw) await this.saveData(this.settings);
	}

	updateSettings(patch: Partial<InkSettings>): void {
		const prevCurve = this.settings.pressureCurve;
		this.settings = { ...this.settings, ...patch };
		if ('pressureCurve' in patch && patch.pressureCurve !== prevCurve) {
			setPressureCurve(this.settings.pressureCurve);
			invalidateAllGeometry();
		}
		this.notifySettings();
		// Sliders fire on every step; the file is written once they rest.
		window.clearTimeout(this.saveTimer);
		this.saveTimer = window.setTimeout(() => void this.saveData(this.settings), SETTINGS_SAVE_DELAY_MS);
	}

	onSettingsChange(listener: () => void): () => void {
		this.settingsListeners.add(listener);
		return () => this.settingsListeners.delete(listener);
	}

	private notifySettings(): void {
		for (const l of this.settingsListeners) l();
	}

	// Surfaces
	//////////

	setActiveSurface(surface: ActiveSurface | null): void {
		this.active = surface;
	}

	activeSurface(): ActiveSurface | null {
		if (this.active && !this.active.isAttached()) this.active = null;
		return this.active;
	}

	copyStrokes(strokes: InkStroke[]): void {
		this.strokeClipboard = strokes;
	}

	async openFullView(file: TFile, mode: InkMode): Promise<void> {
		const leaf = this.app.workspace.getLeaf('tab');
		await leaf.setViewState({ type: mode === 'writing' ? WRITING_VIEW : DRAWING_VIEW, state: { file: file.path }, active: true });
	}

	pickInkFile(mode: InkMode): Promise<TFile | null> {
		return pickInkFile(this.app, mode);
	}

	duplicateInkFile(file: TFile, mode: InkMode, sourcePath: string): Promise<TFile> {
		return duplicateInkFile(this.app, this.settings, file, mode, sourcePath);
	}

	// Commands
	//////////

	private async insertNew(editor: Editor, ctx: MarkdownView | MarkdownFileInfo, mode: InkMode): Promise<void> {
		const notePath = ctx.file?.path ?? null;
		const file = await createInkFile(this.app, this.settings, mode, notePath);
		const md = buildEmbedMarkdown(mode, file.path, mode === 'drawing' ? newDrawingParams() : {});
		if (notePath) openOnMount(notePath, file.path);
		editor.replaceSelection(`\n ${md}\n`);
	}

	private async insertExisting(editor: Editor, mode: InkMode): Promise<void> {
		const file = await this.pickInkFile(mode);
		if (!file) return;
		const md = buildEmbedMarkdown(mode, file.path, mode === 'drawing' ? newDrawingParams() : {});
		editor.replaceSelection(`\n ${md}\n`);
	}

	private registerCommands(): void {
		const s = this.settings;
		if (s.writingEnabled) {
			this.addCommand({
				id: 'create-handwritten-section',
				name: 'Nova seção de escrita à mão',
				icon: 'pencil',
				editorCallback: (editor, ctx) => void this.insertNew(editor, ctx, 'writing'),
			});
			this.addCommand({
				id: 'embed-writing-file',
				name: 'Inserir escrita à mão existente',
				editorCallback: editor => void this.insertExisting(editor, 'writing'),
			});
		}
		if (s.drawingEnabled) {
			this.addCommand({
				id: 'create-drawing-section',
				name: 'Novo desenho',
				icon: 'brush',
				editorCallback: (editor, ctx) => void this.insertNew(editor, ctx, 'drawing'),
			});
			this.addCommand({
				id: 'embed-drawing-file',
				name: 'Inserir desenho existente',
				editorCallback: editor => void this.insertExisting(editor, 'drawing'),
			});
		}
		this.addCommand({
			id: 'undo',
			name: 'Desfazer (tinta ativa ou nota)',
			callback: () => {
				if (this.activeSurface()?.undo()) return;
				this.app.workspace.getActiveViewOfType(MarkdownView)?.editor.undo();
			},
		});
		this.addCommand({
			id: 'redo',
			name: 'Refazer (tinta ativa ou nota)',
			callback: () => {
				if (this.activeSurface()?.redo()) return;
				this.app.workspace.getActiveViewOfType(MarkdownView)?.editor.redo();
			},
		});
	}

	private registerEditorMenu(): void {
		this.registerEvent(this.app.workspace.on('editor-menu', (menu, editor, ctx) => {
			if (this.settings.writingEnabled) {
				menu.addItem(item => item.setTitle('Nova seção de escrita à mão').setIcon('pencil')
					.onClick(() => void this.insertNew(editor, ctx, 'writing')));
			}
			if (this.settings.drawingEnabled) {
				menu.addItem(item => item.setTitle('Novo desenho').setIcon('brush')
					.onClick(() => void this.insertNew(editor, ctx, 'drawing')));
			}
		}));
	}

	/** A pasted embed asks whether to reuse its file or copy it, as Ink did. */
	private registerPasteHandler(): void {
		this.registerEvent(this.app.workspace.on('editor-paste', (evt, editor) => {
			if (evt.defaultPrevented) return;
			const text = evt.clipboardData?.getData('text/plain');
			if (!text || !text.includes('![Ink')) return;
			const matches = findEmbeds(text);
			if (!matches.length) return;
			let out = '';
			let last = 0;
			for (const m of matches) {
				out += text.slice(last, m.from) + buildEmbedMarkdown(m.mode, m.path, { ...m.params, pendingPaste: true });
				last = m.to;
			}
			out += text.slice(last);
			evt.preventDefault();
			editor.replaceSelection(out);
		}));
	}

	// Keys
	//////////

	private registerKeys(doc: Document): void {
		this.registerDomEvent(doc, 'keydown', e => this.onKeyDown(e), { capture: true });
		this.registerDomEvent(doc, 'keyup', e => {
			if (e.key === 'Control' || e.key === 'Meta') this.activeSurface()?.modifierCancel();
		}, { capture: true });
		this.registerDomEvent(doc, 'paste', e => this.onPaste(e), { capture: true });
		// Clicking anywhere outside ink makes the note the target of keys again.
		this.registerDomEvent(doc, 'pointerdown', e => {
			const a = this.activeSurface();
			if (!a) return;
			const path = e.composedPath();
			if (!path.some(n => n instanceof HTMLElement && (n.classList.contains('inkf-host') || n.classList.contains('inkf-full-host')))) {
				this.active = null;
			}
		}, { capture: true });
	}

	private onKeyDown(e: KeyboardEvent): void {
		const a = this.activeSurface();
		if (!a) return;
		const t = e.target as HTMLElement | null;
		if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') && !t.closest('.inkf-host')) return;
		const mod = e.ctrlKey || e.metaKey;
		if (e.key === 'Control' || e.key === 'Meta') {
			if (!e.repeat) a.modifierDown();
			return;
		}
		if (mod) a.modifierCancel();
		const key = e.key.toLowerCase();
		const consume = () => {
			e.preventDefault();
			e.stopPropagation();
		};
		if (mod && key === 'z' && !e.shiftKey) {
			if (a.canUndo()) {
				consume();
				a.undo();
			}
			return;
		}
		if (mod && ((key === 'z' && e.shiftKey) || key === 'y')) {
			if (a.redo()) consume();
			return;
		}
		if (!a.isHovered()) return;
		if ((e.key === 'Delete' || e.key === 'Backspace') && a.deleteSelection()) consume();
		else if (mod && key === 'c' && a.copySelection()) consume();
		else if (mod && key === 'a') {
			consume();
			a.selectAll();
		} else if (e.key === 'Escape' && a.escape()) consume();
	}

	private onPaste(e: ClipboardEvent): void {
		const a = this.activeSurface();
		if (!a || !a.isHovered()) return;
		const data = e.clipboardData;
		const hasImage = !!data && Array.from(data.items).some(i => i.kind === 'file' && i.type.startsWith('image/'));
		const hasStrokes = data?.getData('text/plain') === 'tinteiro:strokes' && this.strokeClipboard.length > 0;
		if (!hasImage && !hasStrokes) return;
		e.preventDefault();
		e.stopPropagation();
		void a.pasteFromClipboard(e);
	}

	// SVG files opened directly
	//////////

	private registerSvgEditButton(): void {
		const decorate = async (leaf: WorkspaceLeaf | null) => {
			const view = leaf?.view as unknown as { getViewType?: () => string; file?: TFile; contentEl?: HTMLElement } | undefined;
			if (!view || view.getViewType?.() !== 'image' || !view.file || view.file.extension !== 'svg' || !view.contentEl) return;
			if (view.contentEl.querySelector('.inkf-svg-edit')) return;
			const file = view.file;
			const text = await this.app.vault.cachedRead(file);
			if (!isInkFileText(text)) return;
			const mode: InkMode = text.includes('"writingLineHeight"') ? 'writing' : 'drawing';
			const btn = view.contentEl.createEl('button', { cls: 'inkf-svg-edit mod-cta', text: mode === 'writing' ? 'Editar escrita' : 'Editar desenho' });
			btn.addEventListener('click', () => void leaf!.setViewState({ type: mode === 'writing' ? WRITING_VIEW : DRAWING_VIEW, state: { file: file.path } }));
		};
		this.registerEvent(this.app.workspace.on('active-leaf-change', leaf => void decorate(leaf)));
		this.app.workspace.onLayoutReady(() => void decorate(this.app.workspace.getMostRecentLeaf()));
	}
}

