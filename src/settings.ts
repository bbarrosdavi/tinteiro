import { THEME_ADAPTIVE_INK_COLOR, normaliseInkColor } from './geom/ink-colors';
import { normaliseCurve, type PressureCurve } from './geom/pressure-curve';
import { INK_LAYOUTS, type InkLayout } from './geom/background-layouts';
import { HANDNOTES_PEN_TOOLS, clampSizeForTool, type HandnotesPenTool, type ToolSizeOverrides } from './geom/tool-presets';
import { ERASER_RADIUS } from './geom/pen-model';
import { WRITING_LINE_HEIGHT } from './model/constants';

export type EraserMode = 'stroke' | 'ink';
export type CanvasTheme = 'auto' | 'light' | 'dark';
export type ToolbarPlacement = 'top' | 'left';
export type InputTreatAs = 'auto' | 'pen' | 'mouse';
export type AttachmentLocation = 'obsidian' | 'root' | 'note';
export type DotDensity = 'dense' | 'medium' | 'sparse' | 'very-sparse';

/** Dot spacing as a multiple of the default (half a writing line). */
export const DOT_DENSITY_SCALE: Record<DotDensity, number> = {
	dense: 0.5,
	medium: 1,
	sparse: 2,
	'very-sparse': 4,
};

export interface InkSettings {
	// Pen and paper
	activePen: HandnotesPenTool;
	color: string;
	penSizes: ToolSizeOverrides;
	/** Up to eight custom colours the user saved next to the palette. */
	recentColors: string[];
	pressureCurve: PressureCurve | null;
	drawingLayout: InkLayout;
	writingLayout: InkLayout;
	/** How far apart the dots of the dotted paper are. */
	dotDensity: DotDensity;
	canvasTheme: CanvasTheme;
	eraserMode: EraserMode;
	eraserSize: number;
	zoomLocked: boolean;

	// Interface
	dominantHand: 'right' | 'left';
	toolbarPlacement: ToolbarPlacement;
	/** The palette shown right on the toolbar, not only in the colour drawer. */
	toolbarSwatches: boolean;
	/** Size of the toolbar and its icons (1 = 36 px buttons). */
	toolbarScale: number;
	/** Draws a short predicted tail ahead of the pen, hiding one frame of latency. */
	strokePrediction: boolean;
	fingerDrawing: boolean;
	strokeInputTreatAs: InputTreatAs;

	// Formats
	writingEnabled: boolean;
	drawingEnabled: boolean;
	writingLineHeight: number;
	writingBufferLines: number;
	writingLinesWhenLocked: boolean;
	writingBackgroundWhenLocked: boolean;
	drawingGridEnabledByDefault: boolean;
	drawingFrameWhenLocked: boolean;
	drawingBackgroundWhenLocked: boolean;

	// Files
	customAttachmentFolders: boolean;
	noteAttachmentFolderLocation: AttachmentLocation;
	notelessAttachmentFolderLocation: AttachmentLocation;
	writingSubfolder: string;
	drawingSubfolder: string;
}

export const DEFAULT_SETTINGS: InkSettings = {
	activePen: 'fountain',
	color: THEME_ADAPTIVE_INK_COLOR,
	penSizes: {},
	recentColors: [],
	pressureCurve: null,
	drawingLayout: 'dot',
	writingLayout: 'ruled-narrow',
	dotDensity: 'medium',
	canvasTheme: 'auto',
	eraserMode: 'ink',
	eraserSize: ERASER_RADIUS,
	zoomLocked: false,

	dominantHand: 'right',
	toolbarPlacement: 'top',
	toolbarSwatches: false,
	toolbarScale: 1,
	strokePrediction: true,
	fingerDrawing: false,
	strokeInputTreatAs: 'auto',

	writingEnabled: true,
	drawingEnabled: true,
	writingLineHeight: WRITING_LINE_HEIGHT,
	writingBufferLines: 3,
	writingLinesWhenLocked: true,
	writingBackgroundWhenLocked: true,
	drawingGridEnabledByDefault: true,
	drawingFrameWhenLocked: false,
	drawingBackgroundWhenLocked: false,

	customAttachmentFolders: false,
	noteAttachmentFolderLocation: 'obsidian',
	notelessAttachmentFolderLocation: 'obsidian',
	writingSubfolder: 'Ink/Writing',
	drawingSubfolder: 'Ink/Drawing',
};

export const MIN_ERASER_SIZE = 4;
export const MAX_ERASER_SIZE = 90;

export function clampEraserSize(size: unknown): number {
	if (typeof size !== 'number' || !Number.isFinite(size)) return DEFAULT_SETTINGS.eraserSize;
	return Math.min(MAX_ERASER_SIZE, Math.max(MIN_ERASER_SIZE, size));
}

function pick<T>(value: unknown, allowed: readonly T[], fallback: T): T {
	return allowed.includes(value as T) ? (value as T) : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
	return typeof value === 'boolean' ? value : fallback;
}

function numberIn(value: unknown, min: number, max: number, fallback: number): number {
	return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

/**
 * Reads this plugin's settings; on first run, imports the old Ink (handnotes) settings so
 * pens, colours, curve, paper and folders carry over.
 */
export function normaliseSettings(raw: unknown, legacy?: unknown): InkSettings {
	const d = DEFAULT_SETTINGS;
	const old = (legacy ?? {}) as Record<string, unknown>;
	const oldHandnotes = (old.handnotes ?? {}) as Record<string, unknown>;
	const input = { ...old, ...oldHandnotes, ...((raw ?? {}) as Record<string, unknown>) } as Record<string, unknown>;

	const penSizes: ToolSizeOverrides = {};
	const sizes = (input.penSizes ?? {}) as Record<string, unknown>;
	for (const pen of HANDNOTES_PEN_TOOLS) {
		const size = sizes[pen];
		if (typeof size === 'number' && Number.isFinite(size)) penSizes[pen] = clampSizeForTool(pen, size);
	}
	const recent = Array.isArray(input.recentColors)
		? (input.recentColors as unknown[]).map(c => normaliseInkColor(c as string)).filter((c): c is string => !!c).slice(0, 8)
		: [];

	const locations: AttachmentLocation[] = ['obsidian', 'root', 'note'];
	return {
		activePen: pick(input.activePen, HANDNOTES_PEN_TOOLS, d.activePen),
		color: normaliseInkColor(input.color as string) ?? d.color,
		penSizes,
		recentColors: recent,
		pressureCurve: input.pressureCurve ? normaliseCurve(input.pressureCurve as PressureCurve) : null,
		drawingLayout: pick(input.drawingLayout, INK_LAYOUTS, d.drawingLayout),
		writingLayout: pick(input.writingLayout, INK_LAYOUTS, d.writingLayout),
		dotDensity: pick<DotDensity>(input.dotDensity, ['dense', 'medium', 'sparse', 'very-sparse'], d.dotDensity),
		canvasTheme: pick<CanvasTheme>(input.canvasTheme, ['auto', 'light', 'dark'], d.canvasTheme),
		eraserMode: pick<EraserMode>(input.eraserMode, ['ink', 'stroke'], d.eraserMode),
		eraserSize: clampEraserSize(input.eraserSize),
		zoomLocked: input.zoomLocked === true,

		dominantHand: pick<'right' | 'left'>(input.dominantHand, ['right', 'left'], d.dominantHand),
		toolbarPlacement: pick<ToolbarPlacement>(input.toolbarPlacement, ['top', 'left'], d.toolbarPlacement),
		toolbarSwatches: bool(input.toolbarSwatches, d.toolbarSwatches),
		toolbarScale: numberIn(input.toolbarScale, 0.6, 1.4, d.toolbarScale),
		strokePrediction: bool(input.strokePrediction, d.strokePrediction),
		fingerDrawing: bool(input.fingerDrawing, d.fingerDrawing),
		strokeInputTreatAs: pick<InputTreatAs>(input.strokeInputTreatAs, ['auto', 'pen', 'mouse'], d.strokeInputTreatAs),

		writingEnabled: bool(input.writingEnabled, d.writingEnabled),
		drawingEnabled: bool(input.drawingEnabled, d.drawingEnabled),
		writingLineHeight: numberIn(input.writingLineHeight, 50, 400, d.writingLineHeight),
		writingBufferLines: numberIn(input.writingBufferLines, 0, 10, d.writingBufferLines),
		writingLinesWhenLocked: bool(input.writingLinesWhenLocked, d.writingLinesWhenLocked),
		writingBackgroundWhenLocked: bool(input.writingBackgroundWhenLocked, d.writingBackgroundWhenLocked),
		drawingGridEnabledByDefault: bool(input.drawingGridEnabledByDefault, d.drawingGridEnabledByDefault),
		drawingFrameWhenLocked: bool(input.drawingFrameWhenLocked, d.drawingFrameWhenLocked),
		drawingBackgroundWhenLocked: bool(input.drawingBackgroundWhenLocked, d.drawingBackgroundWhenLocked),

		customAttachmentFolders: bool(input.customAttachmentFolders, d.customAttachmentFolders),
		noteAttachmentFolderLocation: pick(input.noteAttachmentFolderLocation, locations, d.noteAttachmentFolderLocation),
		notelessAttachmentFolderLocation: pick(input.notelessAttachmentFolderLocation, locations, d.notelessAttachmentFolderLocation),
		writingSubfolder: typeof input.writingSubfolder === 'string' ? input.writingSubfolder : d.writingSubfolder,
		drawingSubfolder: typeof input.drawingSubfolder === 'string' ? input.drawingSubfolder : d.drawingSubfolder,
	};
}
