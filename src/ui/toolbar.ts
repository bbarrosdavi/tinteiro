import { setTooltip } from 'obsidian';
import { iconSvg } from './icons';
import type { InkTool, InkShapeTool, InkMode } from '../model/types';
import { INK_SHAPE_TOOLS } from '../model/types';
import { PEN_PRESETS, HANDNOTES_PEN_TOOLS, sizeForTool, clampSizeForTool, type HandnotesPenTool } from '../geom/tool-presets';
import { INK_COLOR_SWATCHES, THEME_ADAPTIVE_INK_COLOR, hexToHsl, hslToHex, isThemeAdaptiveColor, normaliseInkColor } from '../geom/ink-colors';
import { INK_LAYOUTS, type InkLayout } from '../geom/background-layouts';
import { MAX_ERASER_SIZE, MIN_ERASER_SIZE, type InkSettings, type CanvasTheme } from '../settings';

/**
 * The glass toolbar. Built once per editing session; state changes only flip classes and
 * text, so a tool change costs a few attribute writes inside the shadow root.
 */

export interface ToolbarHost {
	mode: InkMode;
	embedded: boolean;
	settings(): InkSettings;
	updateSettings(patch: Partial<InkSettings>): void;
	tool(): InkTool;
	setTool(tool: InkTool): void;
	canUndo(): boolean;
	canRedo(): boolean;
	undo(): void;
	redo(): void;
	selectionCount(): number;
	deleteSelection(): void;
	duplicateSelection(): void;
	copySelection(): void;
	pasteStrokes(): boolean;
	hasCopiedStrokes(): boolean;
	recolorSelection(color: string): void;
	selectAll(): void;
	pasteImage(): void;
	eraseAll(): void;
	done(): void;
	framingDirty(): boolean;
	saveFraming(): void;
	openFullView?(): void;
	copyAsImage(): void;
	convert?(): void;
	/** Colour theme-following ink is drawn with on this page. */
	inkColor(): string;
	gridEnabled(): boolean;
	setGridEnabled(on: boolean): void;
	addLines?(): void;
}

const PEN_ICON: Record<HandnotesPenTool, string> = {
	fountain: 'fountain',
	ballpoint: 'ballpoint',
	pencil: 'pencil',
	marker: 'marker',
};

const PEN_LABEL: Record<HandnotesPenTool, string> = {
	fountain: 'Caneta tinteiro',
	ballpoint: 'Esferográfica',
	pencil: 'Lápis',
	marker: 'Marca-texto',
};

const SHAPE_LABEL: Record<InkShapeTool, string> = {
	line: 'Reta',
	arrow: 'Seta',
	spline: 'Curva',
	ellipse: 'Elipse',
	rect: 'Retângulo',
	plot2d: 'Eixos 2D',
	axes3d: 'Eixos 3D',
	cube: 'Cubo',
};

const LAYOUT_LABEL: Record<InkLayout, string> = {
	blank: 'Em branco',
	'ruled-fine': 'Pautado fino',
	'ruled-narrow': 'Pautado',
	'ruled-wide': 'Pautado largo',
	'grid-small': 'Quadriculado',
	'grid-large': 'Quadriculado largo',
	dot: 'Pontilhado',
	isometric: 'Isométrico',
};

const SWATCH_LABEL: Record<string, string> = {
	theme: 'Tema', black: 'Preto', grey: 'Cinza', red: 'Vermelho', orange: 'Laranja', yellow: 'Amarelo',
	green: 'Verde', teal: 'Petróleo', blue: 'Azul', violet: 'Violeta', pink: 'Rosa', brown: 'Marrom',
};

type PopoverKind = 'pen' | 'eraser' | 'shapes' | 'color' | 'paper' | 'more' | 'selColor';

function el<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
	const e = doc.createElement(tag);
	if (cls) e.className = cls;
	if (text) e.textContent = text;
	return e;
}

export class Toolbar {
	readonly dock: HTMLDivElement;
	/** The one glass panel: the tool row, and the palette row under it when that option is on. */
	private panel: HTMLDivElement;
	private bar: HTMLDivElement;
	private sub: HTMLDivElement | null = null;
	private doc: Document;
	private buttons = new Map<string, HTMLButtonElement>();
	private popover: HTMLDivElement | null = null;
	private popoverKind: PopoverKind | null = null;
	private selectionGroup: HTMLElement[] = [];
	private outsideHandler = (e: PointerEvent) => {
		if (!this.popover) return;
		const path = e.composedPath();
		if (path.includes(this.popover) || path.includes(this.panel)) return;
		this.closePopover();
	};

	private resizeObs: ResizeObserver;

	constructor(private host: ToolbarHost, private parent: HTMLElement) {
		this.doc = parent.ownerDocument;
		this.dock = el(this.doc, 'div', 'dock');
		const pin = el(this.doc, 'div', 'pin');
		this.panel = el(this.doc, 'div', 'panel glass');
		this.bar = el(this.doc, 'div', 'toolbar');
		this.panel.append(this.bar);
		pin.append(this.panel);
		this.dock.append(pin);
		parent.append(this.dock);
		// The sticky pin needs the bar's height to hold it 4 px below the pane's top.
		this.resizeObs = new ResizeObserver(entries => {
			const h = Math.round(entries[0].borderBoxSize?.[0]?.blockSize ?? this.panel.offsetHeight);
			this.dock.style.setProperty('--inkf-bar-h', `${h}px`);
		});
		this.resizeObs.observe(this.panel);
		this.measureScrollerPadding();
		this.build();
		this.doc.addEventListener('pointerdown', this.outsideHandler, true);
		this.update();
	}

	/**
	 * Sticky offsets count from inside the scroller's padding, and Obsidian pads the note
	 * (file margins); without this the bar would stop that far below the pane's top.
	 */
	private measureScrollerPadding(): void {
		const host = (this.parent.getRootNode() as ShadowRoot).host as HTMLElement | undefined;
		const scroller = host?.closest('.cm-scroller, .markdown-preview-view') as HTMLElement | null;
		const pad = scroller ? parseFloat(getComputedStyle(scroller).paddingTop) || 0 : 0;
		this.dock.style.setProperty('--inkf-pin-pad', `${pad}px`);
	}

	dispose(): void {
		this.doc.removeEventListener('pointerdown', this.outsideHandler, true);
		this.resizeObs.disconnect();
		this.dock.remove();
	}

	private btn(id: string, icon: string, label: string, onClick: (b: HTMLButtonElement) => void): HTMLButtonElement {
		const b = el(this.doc, 'button', 'btn');
		b.type = 'button';
		b.innerHTML = iconSvg(icon);
		b.setAttribute('aria-label', label);
		setTooltip(b, label, { placement: this.host.settings().toolbarPlacement === 'left' ? 'right' : 'bottom' });
		// pointerdown keeps the pen from leaving a dot and fires before any drag.
		b.addEventListener('click', ev => {
			ev.stopPropagation();
			onClick(b);
		});
		b.addEventListener('pointerdown', ev => ev.stopPropagation());
		this.buttons.set(id, b);
		return b;
	}

	private sep(): HTMLElement {
		return el(this.doc, 'span', 'sep');
	}

	private build(): void {
		const h = this.host;
		const bar = this.bar;
		bar.append(
			this.btn('undo', 'undo', 'Desfazer', () => h.undo()),
			this.btn('redo', 'redo', 'Refazer', () => h.redo()),
			this.sep(),
		);
		for (const pen of HANDNOTES_PEN_TOOLS) {
			bar.append(this.btn(`pen-${pen}`, PEN_ICON[pen], PEN_LABEL[pen], b => {
				const s = h.settings();
				if (h.tool() === 'draw' && s.activePen === pen) {
					this.togglePopover('pen', b);
					return;
				}
				h.updateSettings({ activePen: pen });
				h.setTool('draw');
				this.closePopover();
			}));
		}
		const color = this.btn('color', 'palette', 'Cor', b => this.togglePopover('color', b));
		color.classList.add('swatch-btn');
		color.innerHTML = '<span class="chip"></span>';
		bar.append(color);
		if (h.settings().toolbarSwatches) {
			this.sub = el(this.doc, 'div', 'toolbar swatch-row');
			this.panel.append(this.sub);
			this.buildBarSwatches(this.sub);
		}
		bar.append(this.sep());
		bar.append(this.btn('erase', 'eraser', 'Borracha', b => {
			if (h.tool() === 'erase') this.togglePopover('eraser', b);
			else {
				h.setTool('erase');
				this.closePopover();
			}
		}));
		bar.append(this.btn('select', 'select', 'Seleção (laço)', () => {
			h.setTool('select');
			this.closePopover();
		}));
		if (h.mode === 'drawing' || !h.embedded) {
			bar.append(this.btn('pan', 'pan', 'Mão', () => {
				h.setTool('pan');
				this.closePopover();
			}));
		}
		bar.append(this.btn('shapes', 'shapes', 'Figuras (Shift: 15° e proporção regular)', b => this.togglePopover('shapes', b)));

		// Contextual: only while something is selected.
		const selSep = this.sep();
		const del = this.btn('sel-delete', 'trash', 'Apagar seleção', () => h.deleteSelection());
		const dup = this.btn('sel-dup', 'duplicate', 'Duplicar', () => h.duplicateSelection());
		const copy = this.btn('sel-copy', 'copy', 'Copiar', () => h.copySelection());
		const recolor = this.btn('sel-color', 'palette', 'Mudar cor da seleção', b => this.togglePopover('selColor', b));
		this.selectionGroup = [selSep, del, dup, copy, recolor];
		bar.append(...this.selectionGroup);

		bar.append(
			this.sep(),
			this.btn('image', 'imagePlus', 'Colar imagem', () => h.pasteImage()),
			this.btn('paper', 'paper', 'Papel', b => this.togglePopover('paper', b)),
			this.btn('more', 'more', 'Mais', b => this.togglePopover('more', b)),
		);
		const frame = this.btn('frame', 'frame', 'Salvar enquadramento', () => h.saveFraming());
		frame.classList.add('accent');
		bar.append(frame);
		bar.append(this.btn('done', 'check', 'Concluir', () => h.done()));
	}

	private barSwatches: Array<{ el: HTMLButtonElement; value: string }> = [];

	/** The palette right on the bar (option): one tap picks a colour, no drawer. */
	private buildBarSwatches(bar: HTMLElement): void {
		const h = this.host;
		const values = [...INK_COLOR_SWATCHES.map(sw => ({ value: sw.value, label: SWATCH_LABEL[sw.id] ?? sw.label }))];
		for (const c of h.settings().recentColors) if (!values.some(v => v.value === c)) values.push({ value: c, label: c });
		for (const { value, label } of values) {
			const b = el(this.doc, 'button', 'bar-swatch');
			b.type = 'button';
			b.setAttribute('aria-label', label);
			setTooltip(b, label, { placement: h.settings().toolbarPlacement === 'left' ? 'right' : 'bottom' });
			b.addEventListener('pointerdown', e => e.stopPropagation());
			b.addEventListener('click', e => {
				e.stopPropagation();
				h.updateSettings(this.colorPatch(value));
				const t = h.tool();
				if (t === 'erase' || t === 'select' || t === 'pan') h.setTool('draw');
			});
			bar.append(b);
			this.barSwatches.push({ el: b, value });
		}
	}

	update(): void {
		const h = this.host;
		const s = h.settings();
		const tool = h.tool();
		const set = (id: string, cls: string, on: boolean) => {
			const b = this.buttons.get(id);
			if (b && b.classList.contains(cls) !== on) b.classList.toggle(cls, on);
		};
		const enable = (id: string, on: boolean) => {
			const b = this.buttons.get(id);
			if (b && b.disabled === on) b.disabled = !on;
		};
		const show = (node: HTMLElement | undefined, on: boolean) => {
			if (node && (node.style.display === 'none') === on) node.style.display = on ? '' : 'none';
		};

		const dockClass = `dock dock--${s.toolbarPlacement}`;
		if (this.dock.className !== dockClass) this.dock.className = dockClass;
		const scale = String(s.toolbarScale);
		if (this.dock.style.getPropertyValue('--inkf-scale') !== scale) this.dock.style.setProperty('--inkf-scale', scale);
		enable('undo', h.canUndo());
		enable('redo', h.canRedo());
		for (const pen of HANDNOTES_PEN_TOOLS) set(`pen-${pen}`, 'is-active', tool === 'draw' && s.activePen === pen);
		set('erase', 'is-active', tool === 'erase');
		set('select', 'is-active', tool === 'select');
		set('pan', 'is-active', tool === 'pan');
		const isShape = (INK_SHAPE_TOOLS as readonly string[]).includes(tool);
		set('shapes', 'is-active', isShape);
		const shapesBtn = this.buttons.get('shapes');
		const shapeIcon = isShape ? tool : 'shapes';
		if (shapesBtn && shapesBtn.dataset.icon !== shapeIcon) {
			shapesBtn.dataset.icon = shapeIcon;
			shapesBtn.innerHTML = iconSvg(shapeIcon);
		}
		const chip = this.buttons.get('color')?.querySelector<HTMLElement>('.chip');
		const chipColor = isThemeAdaptiveColor(s.color) ? h.inkColor() : s.color;
		if (chip && chip.style.background !== chipColor) chip.style.background = chipColor;

		for (const sw of this.barSwatches) {
			const bg = isThemeAdaptiveColor(sw.value) ? `conic-gradient(${h.inkColor()} 0 50%, var(--inkf-page) 0 100%)` : sw.value;
			if (sw.el.dataset.bg !== bg) {
				sw.el.dataset.bg = bg;
				sw.el.style.background = bg;
			}
			const on = sw.value === s.color;
			if (sw.el.classList.contains('is-active') !== on) sw.el.classList.toggle('is-active', on);
		}

		const selCount = h.selectionCount();
		for (const node of this.selectionGroup) show(node, selCount > 0);
		show(this.buttons.get('frame'), h.mode === 'drawing' && h.embedded && h.framingDirty());

		if (this.popover && this.popoverKind) this.refreshPopover();
	}

	// Popovers
	//////////

	private togglePopover(kind: PopoverKind, anchor: HTMLElement): void {
		if (this.popoverKind === kind) {
			this.closePopover();
			return;
		}
		this.closePopover();
		this.popoverKind = kind;
		const pop = el(this.doc, 'div', 'popover glass');
		pop.addEventListener('pointerdown', e => e.stopPropagation());
		this.popover = pop;
		this.fillPopover(pop, kind);
		this.panel.parentElement!.append(pop);
		this.place(pop, anchor);
	}

	private place(pop: HTMLElement, anchor: HTMLElement): void {
		const left = this.host.settings().toolbarPlacement === 'left';
		const barRect = this.panel.getBoundingClientRect();
		const pinRect = this.panel.parentElement!.getBoundingClientRect();
		const a = anchor.getBoundingClientRect();
		if (left) {
			pop.style.left = `${barRect.right - pinRect.left + 8}px`;
			pop.style.top = `${a.top - pinRect.top}px`;
		} else {
			pop.style.left = `${a.left - pinRect.left}px`;
			pop.style.top = `${barRect.bottom - pinRect.top + 8}px`;
		}
		// Keep the whole popover inside the window.
		const view = this.doc.defaultView ?? window;
		const r = pop.getBoundingClientRect();
		const dx = Math.min(0, view.innerWidth - 8 - r.right) + Math.max(0, 8 - r.left);
		const dy = Math.min(0, view.innerHeight - 8 - r.bottom) + Math.max(0, 8 - r.top);
		if (dx) pop.style.left = `${parseFloat(pop.style.left) + dx}px`;
		if (dy) pop.style.top = `${parseFloat(pop.style.top) + dy}px`;
	}

	closePopover(): void {
		this.popover?.remove();
		this.popover = null;
		this.popoverKind = null;
	}

	private refreshPopover(): void {
		const pop = this.popover;
		const kind = this.popoverKind;
		if (!pop || !kind) return;
		// Sliders being dragged keep their element; everything else is cheap to rebuild.
		const active = (pop.getRootNode() as ShadowRoot | Document).activeElement;
		if (active && pop.contains(active) && active.tagName === 'INPUT') return;
		pop.replaceChildren();
		this.fillPopover(pop, kind);
	}

	private fillPopover(pop: HTMLElement, kind: PopoverKind): void {
		switch (kind) {
			case 'pen': return this.penPopover(pop);
			case 'eraser': return this.eraserPopover(pop);
			case 'shapes': return this.shapesPopover(pop);
			case 'color': return this.colorPopover(pop, c => this.host.updateSettings(this.colorPatch(c)));
			case 'selColor': return this.colorPopover(pop, c => this.host.recolorSelection(c), true);
			case 'paper': return this.paperPopover(pop);
			case 'more': return this.morePopover(pop);
		}
	}

	private colorPatch(color: string): Partial<InkSettings> {
		const s = this.host.settings();
		if (isThemeAdaptiveColor(color) || INK_COLOR_SWATCHES.some(sw => sw.value === color)) return { color };
		const recent = [color, ...s.recentColors.filter(c => c !== color)].slice(0, 8);
		return { color, recentColors: recent };
	}

	private heading(pop: HTMLElement, text: string): void {
		pop.append(el(this.doc, 'h4', undefined, text));
	}

	private penPopover(pop: HTMLElement): void {
		const s = this.host.settings();
		const pen = s.activePen;
		const preset = PEN_PRESETS[pen];
		this.heading(pop, PEN_LABEL[pen]);
		const size = sizeForTool(pen, s.penSizes);
		const canvas = el(this.doc, 'canvas', 'preview-line');
		const draw = (w: number) => this.paintPreview(canvas, w, preset.thinning, preset.opacity);
		pop.append(this.sliderRow('Largura', preset.minSize, preset.maxSize, 0.5, size, v => {
			const clamped = clampSizeForTool(pen, v);
			this.host.updateSettings({ penSizes: { ...s.penSizes, [pen]: clamped } });
			draw(clamped);
		}));
		pop.append(canvas);
		requestAnimationFrame(() => draw(size));
	}

	private paintPreview(canvas: HTMLCanvasElement, width: number, thinning: number, opacity: number): void {
		const dpr = window.devicePixelRatio || 1;
		const w = canvas.clientWidth || 200;
		const h = canvas.clientHeight || 36;
		canvas.width = w * dpr;
		canvas.height = h * dpr;
		const ctx = canvas.getContext('2d');
		if (!ctx) return;
		ctx.scale(dpr, dpr);
		const s = this.host.settings();
		ctx.fillStyle = isThemeAdaptiveColor(s.color) ? this.host.inkColor() : s.color;
		ctx.globalAlpha = opacity;
		// A gentle wave whose width follows a simulated press, scaled like the page.
		const scale = 0.5;
		ctx.strokeStyle = ctx.fillStyle;
		ctx.lineCap = 'round';
		let px = 0, py = 0;
		for (let i = 0; i <= 120; i++) {
			const t = i / 120;
			const x = 12 + t * (w - 24);
			const y = h / 2 + Math.sin(t * Math.PI * 2) * (h / 5);
			const press = 1 - thinning * (1 - Math.sin(t * Math.PI));
			if (i > 0) {
				ctx.lineWidth = Math.max(0.8, width * scale * press);
				ctx.beginPath();
				ctx.moveTo(px, py);
				ctx.lineTo(x, y);
				ctx.stroke();
			}
			px = x;
			py = y;
		}
	}

	private eraserPopover(pop: HTMLElement): void {
		const s = this.host.settings();
		this.heading(pop, 'Borracha');
		const seg = el(this.doc, 'div', 'segmented');
		for (const [mode, label] of [['ink', 'Apaga o que passa'], ['stroke', 'Traço inteiro']] as const) {
			const b = el(this.doc, 'button', s.eraserMode === mode ? 'is-active' : '', label);
			b.addEventListener('click', () => this.host.updateSettings({ eraserMode: mode }));
			seg.append(b);
		}
		const row = el(this.doc, 'div', 'row');
		row.append(seg);
		pop.append(row);
		pop.append(this.sliderRow('Tamanho', MIN_ERASER_SIZE, MAX_ERASER_SIZE, 0.5, s.eraserSize, v => this.host.updateSettings({ eraserSize: v })));
		const clear = el(this.doc, 'button', 'choice', 'Apagar tudo');
		clear.insertAdjacentHTML('afterbegin', iconSvg('trash', 18));
		clear.addEventListener('click', () => {
			this.closePopover();
			this.host.eraseAll();
		});
		const r2 = el(this.doc, 'div', 'row');
		r2.append(clear);
		pop.append(r2);
	}

	private shapesPopover(pop: HTMLElement): void {
		this.heading(pop, 'Figuras');
		const grid = el(this.doc, 'div', 'grid');
		const current = this.host.tool();
		for (const shape of INK_SHAPE_TOOLS) {
			const b = el(this.doc, 'button', `btn${current === shape ? ' is-active' : ''}`);
			b.type = 'button';
			b.innerHTML = iconSvg(shape);
			b.setAttribute('aria-label', SHAPE_LABEL[shape]);
			setTooltip(b, SHAPE_LABEL[shape]);
			b.addEventListener('click', () => {
				this.host.setTool(shape);
				this.closePopover();
			});
			grid.append(b);
		}
		pop.append(grid);
		pop.classList.add('compact');
	}

	private colorPopover(pop: HTMLElement, apply: (c: string) => void, forSelection = false): void {
		const s = this.host.settings();
		const current = forSelection ? '' : s.color;
		this.heading(pop, forSelection ? 'Cor da seleção' : 'Cor');
		const grid = el(this.doc, 'div', 'swatches');
		const add = (value: string, label: string, theme = false) => {
			const b = el(this.doc, 'button', `swatch${value === current ? ' is-active' : ''}`);
			b.type = 'button';
			b.style.background = theme ? `conic-gradient(${this.host.inkColor()} 0 50%, var(--inkf-page) 0 100%)` : value;
			b.setAttribute('aria-label', label);
			setTooltip(b, label);
			b.addEventListener('click', () => apply(value));
			grid.append(b);
		};
		for (const sw of INK_COLOR_SWATCHES) add(sw.value, SWATCH_LABEL[sw.id] ?? sw.label, sw.value === THEME_ADAPTIVE_INK_COLOR);
		pop.append(grid);
		if (s.recentColors.length) {
			this.heading(pop, 'Recentes');
			const recent = el(this.doc, 'div', 'swatches');
			pop.append(recent);
			for (const c of s.recentColors) {
				const b = el(this.doc, 'button', `swatch${c === current ? ' is-active' : ''}`);
				b.type = 'button';
				b.style.background = c;
				b.addEventListener('click', () => apply(c));
				recent.append(b);
			}
		}
		this.heading(pop, 'Personalizada');
		const base = isThemeAdaptiveColor(current) || !current ? '#1971c2' : (normaliseInkColor(current) ?? '#1971c2');
		const hsl = hexToHsl(base);
		const value = { ...hsl };
		const commit = () => apply(hslToHex(value));
		const hue = this.sliderRow('Matiz', 0, 360, 1, hsl.h, v => { value.h = v; repaint(); }, commit);
		const sat = this.sliderRow('Saturação', 0, 100, 1, hsl.s, v => { value.s = v; repaint(); }, commit);
		const lig = this.sliderRow('Luz', 0, 100, 1, hsl.l, v => { value.l = v; repaint(); }, commit);
		const repaint = () => {
			hue.querySelector('input')!.style.setProperty('--track', 'linear-gradient(90deg,#f00,#ff0,#0f0,#0ff,#00f,#f0f,#f00)');
			sat.querySelector('input')!.style.setProperty('--track', `linear-gradient(90deg,hsl(${value.h} 0% ${value.l}%),hsl(${value.h} 100% ${value.l}%))`);
			lig.querySelector('input')!.style.setProperty('--track', `linear-gradient(90deg,#000,hsl(${value.h} ${value.s}% 50%),#fff)`);
		};
		repaint();
		pop.append(hue, sat, lig);
	}

	private sliderRow(
		label: string, min: number, max: number, step: number, value: number,
		onInput: (v: number) => void, onCommit?: () => void,
	): HTMLElement {
		const row = el(this.doc, 'div', 'slider-row');
		const l = el(this.doc, 'label', undefined, label);
		const input = el(this.doc, 'input');
		input.type = 'range';
		input.min = String(min);
		input.max = String(max);
		input.step = String(step);
		input.value = String(value);
		const out = el(this.doc, 'output', undefined, fmt(value));
		input.addEventListener('input', () => {
			const v = Number(input.value);
			out.textContent = fmt(v);
			if (!onCommit) onInput(v);
			else onInput(v);
		});
		if (onCommit) input.addEventListener('change', onCommit);
		input.addEventListener('pointerdown', e => e.stopPropagation());
		row.append(l, input, out);
		return row;
	}

	private paperPopover(pop: HTMLElement): void {
		const h = this.host;
		const s = h.settings();
		const key = h.mode === 'writing' ? 'writingLayout' : 'drawingLayout';
		this.heading(pop, 'Papel');
		const grid = el(this.doc, 'div', 'grid wide');
		for (const layout of INK_LAYOUTS) {
			const b = el(this.doc, 'button', `choice${s[key] === layout ? ' is-active' : ''}`, LAYOUT_LABEL[layout]);
			b.addEventListener('click', () => h.updateSettings({ [key]: layout } as Partial<InkSettings>));
			grid.append(b);
		}
		pop.append(grid);
		this.heading(pop, 'Folha');
		const seg = el(this.doc, 'div', 'segmented');
		for (const [theme, label] of [['auto', 'Tema'], ['light', 'Clara'], ['dark', 'Escura']] as Array<[CanvasTheme, string]>) {
			const b = el(this.doc, 'button', s.canvasTheme === theme ? 'is-active' : '', label);
			b.addEventListener('click', () => h.updateSettings({ canvasTheme: theme }));
			seg.append(b);
		}
		const row = el(this.doc, 'div', 'row');
		row.append(seg);
		pop.append(row);
		if (h.mode === 'drawing') {
			const grid2 = el(this.doc, 'button', `choice${h.gridEnabled() ? ' is-active' : ''}`, 'Mostrar fundo neste desenho');
			grid2.insertAdjacentHTML('afterbegin', iconSvg('grid', 18));
			grid2.addEventListener('click', () => h.setGridEnabled(!h.gridEnabled()));
			const r2 = el(this.doc, 'div', 'row');
			r2.append(grid2);
			pop.append(r2);
		}
	}

	private morePopover(pop: HTMLElement): void {
		const h = this.host;
		const s = h.settings();
		const items: Array<[string, string, () => void, boolean?]> = [];
		if (h.openFullView) items.push(['expand', 'Abrir em tela cheia', () => h.openFullView!()]);
		items.push(['selectAll', 'Selecionar tudo', () => h.selectAll()]);
		if (h.hasCopiedStrokes()) items.push(['paste', 'Colar traços', () => { h.pasteStrokes(); }]);
		items.push(['imageDown', 'Copiar como imagem', () => h.copyAsImage()]);
		if (h.mode === 'drawing') items.push(['zoomLock', 'Travar zoom', () => h.updateSettings({ zoomLocked: !s.zoomLocked }), s.zoomLocked]);
		items.push(['finger', 'Desenhar com o dedo', () => h.updateSettings({ fingerDrawing: !s.fingerDrawing }), s.fingerDrawing]);
		if (h.addLines) items.push(['plusLines', 'Mais linhas', () => h.addLines!()]);
		items.push(['palette', 'Cores na barra', () => h.updateSettings({ toolbarSwatches: !s.toolbarSwatches }), s.toolbarSwatches]);
		items.push([
			s.toolbarPlacement === 'top' ? 'panelLeft' : 'panelTop',
			s.toolbarPlacement === 'top' ? 'Barra na lateral' : 'Barra no topo',
			() => h.updateSettings({ toolbarPlacement: s.toolbarPlacement === 'top' ? 'left' : 'top' }),
		]);
		if (h.convert) items.push(['convert', h.mode === 'drawing' ? 'Converter em escrita' : 'Converter em desenho', () => h.convert!()]);
		const list = el(this.doc, 'div');
		list.style.display = 'flex';
		list.style.flexDirection = 'column';
		for (const [icon, label, fn, active] of items) {
			const b = el(this.doc, 'button', `choice${active ? ' is-active' : ''}`, label);
			b.insertAdjacentHTML('afterbegin', iconSvg(icon, 18));
			b.addEventListener('click', () => {
				this.closePopover();
				fn();
			});
			list.append(b);
		}
		pop.append(list);
	}
}

function fmt(v: number): string {
	return Number.isInteger(v) ? String(v) : v.toFixed(1);
}
