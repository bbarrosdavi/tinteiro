import { PluginSettingTab, Setting, type App } from 'obsidian';
import type TinteiroPlugin from '../main';
import { type InkLayout } from '../geom/background-layouts';
import { PRESSURE_CURVE_PRESETS, normaliseCurve, samplePressureCurve, DEFAULT_PRESSURE_CURVE, type PressureCurve } from '../geom/pressure-curve';
import { MAX_ERASER_SIZE, MIN_ERASER_SIZE, type AttachmentLocation, type DotDensity } from '../settings';

const LAYOUT_LABEL: Record<InkLayout, string> = {
	blank: 'Em branco', 'ruled-fine': 'Pautado fino', 'ruled-narrow': 'Pautado', 'ruled-wide': 'Pautado largo',
	'grid-small': 'Quadriculado', 'grid-large': 'Quadriculado largo', dot: 'Pontilhado', isometric: 'Isométrico',
};

const LOCATIONS: Record<AttachmentLocation, string> = {
	obsidian: 'Pasta de anexos do Obsidian',
	note: 'Mesma pasta da nota',
	root: 'Raiz do cofre',
};

export class InkSettingsTab extends PluginSettingTab {
	constructor(app: App, private plugin: TinteiroPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		const p = this.plugin;
		const s = () => p.settings;
		const set = (patch: Partial<typeof p.settings>, redraw = false) => {
			p.updateSettings(patch);
			if (redraw) this.display();
		};
		containerEl.empty();

		new Setting(containerEl).setName('Canetas e papel').setHeading();
		new Setting(containerEl)
			.setName('Curva de pressão')
			.setDesc('Como a força na caneta vira largura do traço. Arraste os pontos; toque duplo num ponto o remove, toque duplo fora cria um.')
			.addDropdown(d => {
				d.addOption('builtin', 'Padrão do Ink');
				d.addOption('linear', 'Linear');
				d.addOption('light', 'Mão leve');
				d.addOption('heavy', 'Mão pesada');
				d.addOption('custom', 'Personalizada');
				d.setValue(presetName(s().pressureCurve));
				d.onChange(v => {
					if (v === 'builtin') set({ pressureCurve: null }, true);
					else if (v !== 'custom') set({ pressureCurve: PRESSURE_CURVE_PRESETS[v] }, true);
				});
			});
		const curveHost = containerEl.createDiv({ cls: 'inkf-curve-host' });
		new CurveEditor(curveHost, s().pressureCurve ?? DEFAULT_PRESSURE_CURVE, curve => set({ pressureCurve: curve }));

		new Setting(containerEl)
			.setName('Densidade do pontilhado')
			.setDesc('Distância entre os pontos do papel pontilhado, na escrita e no desenho.')
			.addDropdown(d => d
				.addOptions({ dense: 'Densa (¼ de linha)', medium: 'Média (½ linha)', sparse: 'Espaçada (1 linha)', 'very-sparse': 'Bem espaçada (2 linhas)' })
				.setValue(s().dotDensity)
				.onChange(v => set({ dotDensity: v as DotDensity })));
		new Setting(containerEl)
			.setName('Cor da folha')
			.setDesc('Seguir o tema, ou forçar folha clara ou escura. A folha forçada fica gravada no arquivo.')
			.addDropdown(d => d
				.addOptions({ auto: 'Seguir o tema', light: 'Clara', dark: 'Escura' })
				.setValue(s().canvasTheme)
				.onChange(v => set({ canvasTheme: v as 'auto' | 'light' | 'dark' })));
		new Setting(containerEl)
			.setName('Borracha')
			.setDesc('Apagar só o que passa por baixo (corta o traço) ou o traço inteiro.')
			.addDropdown(d => d
				.addOptions({ ink: 'Apaga o que passa', stroke: 'Traço inteiro' })
				.setValue(s().eraserMode)
				.onChange(v => set({ eraserMode: v as 'ink' | 'stroke' })));
		new Setting(containerEl)
			.setName('Tamanho da borracha')
			.addSlider(sl => sl.setLimits(MIN_ERASER_SIZE, MAX_ERASER_SIZE, 0.5).setValue(s().eraserSize).setDynamicTooltip()
				.onChange(v => set({ eraserSize: v })));

		new Setting(containerEl).setName('Interface').setHeading();
		new Setting(containerEl)
			.setName('Posição da barra de ferramentas')
			.addDropdown(d => d
				.addOptions({ top: 'Topo', left: 'Lateral esquerda' })
				.setValue(s().toolbarPlacement)
				.onChange(v => set({ toolbarPlacement: v as 'top' | 'left' })));
		new Setting(containerEl)
			.setName('Escala da barra')
			.setDesc('Tamanho dos botões e ícones da barra de ferramentas. As cores na barra nunca ficam menores que 12 px.')
			.addSlider(sl => sl.setLimits(0.6, 1.4, 0.05).setValue(s().toolbarScale).setDynamicTooltip()
				.onChange(v => set({ toolbarScale: v })));
		new Setting(containerEl)
			.setName('Cores na barra')
			.setDesc('A paleta numa fileira dentro da barra, além da gaveta de cores.')
			.addToggle(t => t.setValue(s().toolbarSwatches).onChange(v => set({ toolbarSwatches: v })));
		new Setting(containerEl)
			.setName('Mão dominante')
			.setDesc('Põe a alça de redimensionar do lado da mão que não escreve.')
			.addDropdown(d => d
				.addOptions({ right: 'Direita', left: 'Esquerda' })
				.setValue(s().dominantHand)
				.onChange(v => set({ dominantHand: v as 'right' | 'left' })));
		new Setting(containerEl)
			.setName('Predição do traço')
			.setDesc('Desenha um pedaço curto à frente da caneta, previsto pelo navegador, e o troca pelo real no quadro seguinte. Esconde um quadro de latência.')
			.addToggle(t => t.setValue(s().strokePrediction).onChange(v => set({ strokePrediction: v })));
		new Setting(containerEl)
			.setName('Desenhar com o dedo')
			.setDesc('Desligado: um dedo rola a nota, dois dedos movem e ampliam o desenho.')
			.addToggle(t => t.setValue(s().fingerDrawing).onChange(v => set({ fingerDrawing: v })));
		new Setting(containerEl)
			.setName('Tratar a entrada como')
			.setDesc('Automático detecta se o traço veio de uma caneta com pressão.')
			.addDropdown(d => d
				.addOptions({ auto: 'Automático', pen: 'Caneta', mouse: 'Mouse' })
				.setValue(s().strokeInputTreatAs)
				.onChange(v => set({ strokeInputTreatAs: v as 'auto' | 'pen' | 'mouse' })));

		new Setting(containerEl).setName('Escrita').setHeading();
		new Setting(containerEl).setName('Ativar escrita').setDesc('Vale depois de reiniciar o Obsidian.')
			.addToggle(t => t.setValue(s().writingEnabled).onChange(v => set({ writingEnabled: v })));
		new Setting(containerEl).setName('Papel da escrita')
			.addDropdown(d => d.addOptions(LAYOUT_LABEL).setValue(s().writingLayout).onChange(v => set({ writingLayout: v as InkLayout })));
		new Setting(containerEl).setName('Altura da linha').setDesc('Para seções novas.')
			.addSlider(sl => sl.setLimits(50, 400, 10).setValue(s().writingLineHeight).setDynamicTooltip()
				.onChange(v => set({ writingLineHeight: v })));
		new Setting(containerEl).setName('Linhas livres abaixo da escrita').setDesc('Enquanto edita.')
			.addSlider(sl => sl.setLimits(0, 10, 1).setValue(s().writingBufferLines).setDynamicTooltip()
				.onChange(v => set({ writingBufferLines: v })));
		new Setting(containerEl).setName('Pauta fora da edição')
			.addToggle(t => t.setValue(s().writingLinesWhenLocked).onChange(v => set({ writingLinesWhenLocked: v })));
		new Setting(containerEl).setName('Fundo fora da edição')
			.addToggle(t => t.setValue(s().writingBackgroundWhenLocked).onChange(v => set({ writingBackgroundWhenLocked: v })));

		new Setting(containerEl).setName('Desenho').setHeading();
		new Setting(containerEl).setName('Ativar desenho').setDesc('Vale depois de reiniciar o Obsidian.')
			.addToggle(t => t.setValue(s().drawingEnabled).onChange(v => set({ drawingEnabled: v })));
		new Setting(containerEl).setName('Papel do desenho')
			.addDropdown(d => d.addOptions(LAYOUT_LABEL).setValue(s().drawingLayout).onChange(v => set({ drawingLayout: v as InkLayout })));
		new Setting(containerEl).setName('Fundo em desenhos novos')
			.addToggle(t => t.setValue(s().drawingGridEnabledByDefault).onChange(v => set({ drawingGridEnabledByDefault: v })));
		new Setting(containerEl).setName('Moldura fora da edição')
			.addToggle(t => t.setValue(s().drawingFrameWhenLocked).onChange(v => set({ drawingFrameWhenLocked: v })));
		new Setting(containerEl).setName('Fundo fora da edição')
			.addToggle(t => t.setValue(s().drawingBackgroundWhenLocked).onChange(v => set({ drawingBackgroundWhenLocked: v })));

		new Setting(containerEl).setName('Arquivos').setHeading();
		new Setting(containerEl).setName('Pastas personalizadas')
			.setDesc('Desligado: os arquivos vão para a pasta de anexos do Obsidian, em Ink/Writing e Ink/Drawing.')
			.addToggle(t => t.setValue(s().customAttachmentFolders).onChange(v => set({ customAttachmentFolders: v }, true)));
		if (s().customAttachmentFolders) {
			new Setting(containerEl).setName('Criados dentro de uma nota')
				.addDropdown(d => d.addOptions(LOCATIONS).setValue(s().noteAttachmentFolderLocation)
					.onChange(v => set({ noteAttachmentFolderLocation: v as AttachmentLocation })));
			new Setting(containerEl).setName('Criados fora de uma nota')
				.addDropdown(d => d.addOptions({ obsidian: LOCATIONS.obsidian, root: LOCATIONS.root })
					.setValue(s().notelessAttachmentFolderLocation)
					.onChange(v => set({ notelessAttachmentFolderLocation: v as AttachmentLocation })));
			new Setting(containerEl).setName('Subpasta da escrita')
				.addText(t => t.setValue(s().writingSubfolder).onChange(v => set({ writingSubfolder: v })));
			new Setting(containerEl).setName('Subpasta do desenho')
				.addText(t => t.setValue(s().drawingSubfolder).onChange(v => set({ drawingSubfolder: v })));
		}
	}
}

function presetName(curve: PressureCurve | null): string {
	if (!curve) return 'builtin';
	const key = JSON.stringify(curve.points);
	for (const [name, preset] of Object.entries(PRESSURE_CURVE_PRESETS)) {
		if (name !== 'default' && JSON.stringify(preset.points) === key) return name;
	}
	return 'custom';
}

/** Draggable monotone curve on a canvas. */
class CurveEditor {
	private canvas: HTMLCanvasElement;
	private curve: PressureCurve;
	private drag = -1;
	private readonly size = 220;
	private readonly pad = 14;

	constructor(host: HTMLElement, curve: PressureCurve, private onChange: (c: PressureCurve) => void) {
		this.curve = normaliseCurve(curve);
		this.canvas = host.createEl('canvas');
		const dpr = window.devicePixelRatio || 1;
		this.canvas.width = this.size * dpr;
		this.canvas.height = this.size * dpr;
		this.canvas.style.width = `${this.size}px`;
		this.canvas.style.height = `${this.size}px`;
		this.canvas.style.touchAction = 'none';
		this.canvas.style.borderRadius = '12px';
		this.canvas.style.background = 'var(--background-secondary)';
		this.canvas.addEventListener('pointerdown', e => this.down(e));
		this.canvas.addEventListener('pointermove', e => this.move(e));
		this.canvas.addEventListener('pointerup', () => this.up());
		this.canvas.addEventListener('dblclick', e => this.dbl(e));
		this.draw();
	}

	private toCurve(e: { offsetX: number; offsetY: number }): { x: number; y: number } {
		const span = this.size - this.pad * 2;
		return {
			x: Math.min(1, Math.max(0, (e.offsetX - this.pad) / span)),
			y: Math.min(1, Math.max(0, 1 - (e.offsetY - this.pad) / span)),
		};
	}

	private hit(e: PointerEvent | MouseEvent): number {
		const span = this.size - this.pad * 2;
		return this.curve.points.findIndex(p => Math.hypot(this.pad + p.x * span - e.offsetX, this.pad + (1 - p.y) * span - e.offsetY) < 12);
	}

	private down(e: PointerEvent): void {
		this.drag = this.hit(e);
		if (this.drag >= 0) this.canvas.setPointerCapture(e.pointerId);
	}

	private move(e: PointerEvent): void {
		if (this.drag < 0) return;
		const pts = this.curve.points.map(p => ({ ...p }));
		const c = this.toCurve(e);
		const i = this.drag;
		const lo = i === 0 ? 0 : pts[i - 1].x + 0.02;
		const hi = i === pts.length - 1 ? 1 : pts[i + 1].x - 0.02;
		pts[i] = { x: i === 0 ? 0 : i === pts.length - 1 ? 1 : Math.min(hi, Math.max(lo, c.x)), y: c.y };
		this.curve = { points: pts };
		this.draw();
	}

	private up(): void {
		if (this.drag >= 0) this.onChange(this.curve);
		this.drag = -1;
	}

	private dbl(e: MouseEvent): void {
		const i = this.hit(e);
		const pts = this.curve.points.map(p => ({ ...p }));
		if (i > 0 && i < pts.length - 1) pts.splice(i, 1);
		else if (i < 0) pts.push(this.toCurve(e));
		this.curve = normaliseCurve({ points: pts });
		this.draw();
		this.onChange(this.curve);
	}

	private draw(): void {
		const ctx = this.canvas.getContext('2d');
		if (!ctx) return;
		const dpr = window.devicePixelRatio || 1;
		const span = this.size - this.pad * 2;
		const style = getComputedStyle(this.canvas);
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, this.size, this.size);
		ctx.strokeStyle = style.getPropertyValue('--background-modifier-border') || '#8884';
		ctx.lineWidth = 1;
		for (let k = 0; k <= 4; k++) {
			const v = this.pad + (span * k) / 4;
			ctx.beginPath(); ctx.moveTo(this.pad, v); ctx.lineTo(this.pad + span, v); ctx.stroke();
			ctx.beginPath(); ctx.moveTo(v, this.pad); ctx.lineTo(v, this.pad + span); ctx.stroke();
		}
		ctx.strokeStyle = style.getPropertyValue('--interactive-accent') || '#7b6cd9';
		ctx.lineWidth = 2.5;
		ctx.beginPath();
		samplePressureCurve(this.curve, 64).forEach((p, i) => {
			const x = this.pad + p.x * span;
			const y = this.pad + (1 - p.y) * span;
			if (i === 0) ctx.moveTo(x, y);
			else ctx.lineTo(x, y);
		});
		ctx.stroke();
		ctx.fillStyle = style.getPropertyValue('--text-normal') || '#222';
		for (const p of this.curve.points) {
			ctx.beginPath();
			ctx.arc(this.pad + p.x * span, this.pad + (1 - p.y) * span, 5, 0, Math.PI * 2);
			ctx.fill();
		}
	}
}

