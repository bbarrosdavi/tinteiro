import { FileView, Notice, TFile, type WorkspaceLeaf } from 'obsidian';
import type { InkHost } from '../plugin-api';
import type { DocEntry } from '../embed/doc-store';
import { InkSurface } from '../embed/surface';
import { adoptEmbedStyles } from '../ui/styles';
import type { InkMode } from '../model/types';
import { WRITING_PAGE_WIDTH } from '../model/constants';
import { contentBounds, serializeInkFile } from '../model/format';
import { frameRect } from '../geom/view';

export const WRITING_VIEW = 'inkf-writing-view';
export const DRAWING_VIEW = 'inkf-drawing-view';

/**
 * A file on its own tab. Drawing: the page fills the tab, camera kept in the file. Writing:
 * the page fits the tab width (at most 1100 px) inside a native scroller, so scrolling is the
 * compositor's job and never repaints the ink.
 */
export class InkFullView extends FileView {
	private shadowHost: HTMLDivElement | null = null;
	private surface: InkSurface | null = null;
	private entry: DocEntry | null = null;
	private resizeObs: ResizeObserver | null = null;
	private scrollerEl: HTMLDivElement | null = null;
	private stage: HTMLDivElement | null = null;
	private root: HTMLDivElement | null = null;
	allowNoFile = false;

	constructor(leaf: WorkspaceLeaf, private host: InkHost, private mode: InkMode) {
		super(leaf);
		this.navigation = true;
	}

	getViewType(): string {
		return this.mode === 'writing' ? WRITING_VIEW : DRAWING_VIEW;
	}

	getDisplayText(): string {
		return this.file?.basename ?? (this.mode === 'writing' ? 'Escrita' : 'Desenho');
	}

	getIcon(): string {
		return this.mode === 'writing' ? 'pencil' : 'brush';
	}

	canAcceptExtension(extension: string): boolean {
		return extension === 'svg';
	}

	async onLoadFile(file: TFile): Promise<void> {
		this.contentEl.empty();
		this.contentEl.addClass('inkf-full-view');
		const shadowHost = this.contentEl.createDiv({ cls: 'inkf-full-host' });
		const shadow = shadowHost.attachShadow({ mode: 'open' });
		adoptEmbedStyles(shadow);
		const root = document.createElement('div');
		root.className = `embed is-editing page-filled full mode-${this.mode}`;
		const scroller = document.createElement('div');
		scroller.className = 'full-scroller';
		const stage = document.createElement('div');
		stage.className = 'stage';
		scroller.append(stage);
		root.append(scroller);
		shadow.append(root);
		this.shadowHost = shadowHost;
		this.scrollerEl = scroller;
		this.stage = stage;
		this.root = root;

		try {
			this.entry = await this.host.docs.acquire(file, this.mode, this.host.settings.drawingGridEnabledByDefault);
		} catch {
			new Notice('Não foi possível ler este arquivo de tinta.');
			return;
		}
		const surface = new InkSurface(this.host, root, stage, this.entry, this.mode, false, () => scroller);
		surface.onPageHeight = () => this.layout();
		surface.actions = { done: () => this.leaf.detach() };
		this.surface = surface;
		if (!this.host.docs.isWritable(file.path)) {
			// Old tldraw-era file: shown converted, read-only, with a way to make a new copy.
			surface.editor.interactive = false;
			this.legacyBanner(root, file);
		} else {
			surface.showToolbar();
			this.host.setActiveSurface(surface);
			this.host.docs.warmSaveCaches(this.entry);
		}
		this.resizeObs = new ResizeObserver(() => this.layout(true));
		this.resizeObs.observe(shadowHost);
		this.layout(true);
	}

	private legacyBanner(root: HTMLElement, file: TFile): void {
		const b = document.createElement('div');
		b.className = 'banner glass legacy';
		b.innerHTML = '<span>Formato antigo do Ink: somente leitura.</span><span class="spacer"></span>';
		const btn = document.createElement('button');
		btn.className = 'text primary';
		btn.textContent = 'Criar cópia editável (.svg)';
		btn.addEventListener('click', async () => {
			if (!this.entry) return;
			const target = file.path.replace(/\.(writing|drawing)$/i, '') + '.svg';
			if (this.app.vault.getAbstractFileByPath(target)) {
				new Notice('Já existe ' + target);
				return;
			}
			const text = serializeInkFile(this.entry.doc.toSnapshot(), this.mode, WRITING_PAGE_WIDTH);
			const created = await this.app.vault.create(target, text);
			new Notice('Cópia criada: ' + created.path);
			await this.leaf.setViewState({ type: this.getViewType(), state: { file: created.path } });
		});
		b.append(btn);
		root.append(b);
	}

	private framed = false;

	private layout(resized = false): void {
		const surface = this.surface;
		const host = this.shadowHost;
		if (!surface || !host || !this.stage || !this.scrollerEl) return;
		const W = host.clientWidth;
		const H = host.clientHeight;
		if (!W || !H) return;
		if (this.mode === 'writing') {
			const w = Math.min(W - 32, 1100);
			const pageH = surface.editor.writingHeightFor(true) + 6 * (this.entry?.doc.snapshot.writingLineHeight ?? 150);
			const h = Math.max(H - 32, pageH * (w / WRITING_PAGE_WIDTH));
			this.stage.style.width = `${w}px`;
			this.stage.style.height = `${Math.round(h)}px`;
			surface.editor.resize(w, Math.round(h));
			surface.editor.pageHeight = h / (w / WRITING_PAGE_WIDTH);
			surface.applyLook();
			return;
		}
		this.stage.style.width = `${W}px`;
		this.stage.style.height = `${H}px`;
		surface.editor.resize(W, H);
		if (this.framed || !resized) return;
		this.framed = true;
		const saved = this.entry?.doc.snapshot.camera;
		if (saved) {
			surface.editor.setCamera(saved, false);
			return;
		}
		const b = contentBounds([...surface.editor.doc.strokes]);
		surface.editor.setCamera(b
			? frameRect(W, H, { x: b.minX, y: b.minY, width: b.maxX - b.minX, height: b.maxY - b.minY })
			: { x: 0, y: 0, zoom: W / WRITING_PAGE_WIDTH }, false);
	}

	async onUnloadFile(): Promise<void> {
		this.teardown();
	}

	async onClose(): Promise<void> {
		this.teardown();
	}

	private teardown(): void {
		this.resizeObs?.disconnect();
		this.resizeObs = null;
		if (this.surface && this.entry && this.mode === 'drawing') {
			// The full view remembers where the camera was, like Ink did.
			this.entry.doc.snapshot.camera = { ...this.surface.editor.camera };
			this.host.docs.touch(this.entry);
		}
		this.surface?.dispose();
		this.surface = null;
		if (this.entry) this.host.docs.release(this.entry);
		this.entry = null;
		this.shadowHost?.remove();
		this.shadowHost = null;
		this.framed = false;
		void this.root;
	}
}
