import { PEN_NUMERICS } from './pen-model';

///////////////////////////
///////////////////////////

/** Every tool selectable from the toolbar. */
export type HandnotesTool =
	| 'fountain'
	| 'ballpoint'
	| 'pencil'
	| 'marker'
	| 'eraser'
	| 'select'
	| 'pan';

/** Tools that put ink on the canvas (i.e. carry a stroke preset). */
export type HandnotesPenTool = 'fountain' | 'ballpoint' | 'pencil' | 'marker';

export const HANDNOTES_PEN_TOOLS: HandnotesPenTool[] = ['fountain', 'ballpoint', 'pencil', 'marker'];

export interface PenPreset {
	label: string;
	/** Base stroke diameter in page units. */
	size: number;
	/** Bounds for the width slider. */
	minSize: number;
	maxSize: number;
	/**
	 * How strongly pressure changes the width (perfect-freehand `thinning`, -1..1).
	 * 0 gives a constant width, higher values give more taper.
	 */
	thinning: number;
	/** Added to the input-kind smoothing after zoom scaling. Clamped to 0..1. */
	smoothingBoost: number;
	/** Added to the input-kind streamline after zoom scaling. Clamped to 0..1. */
	streamlineBoost: number;
	/** Stroke alpha, 0..1. Written to the SVG as `fill-opacity`. */
	opacity: number;
}

/**
 * Pen presets.
 *
 * `fountain` intentionally reproduces the Ink pen feel exactly
 * (`thinning` matches {@link PEN_NUMERICS}, full opacity, no boosts),
 * so leaving the toolbar on its default tool changes nothing about how Ink writes today.
 */
export const PEN_PRESETS: Record<HandnotesPenTool, PenPreset> = {
	fountain: {
		label: 'Fountain pen',
		size: 8,
		minSize: 2,
		maxSize: 40,
		thinning: PEN_NUMERICS.thinning,
		smoothingBoost: 0,
		streamlineBoost: 0,
		opacity: 1,
	},
	ballpoint: {
		label: 'Ballpoint',
		size: 5,
		minSize: 1,
		maxSize: 24,
		// Near-constant width is what separates a biro from a nib.
		thinning: 0.1,
		smoothingBoost: 0.1,
		streamlineBoost: 0.05,
		opacity: 1,
	},
	pencil: {
		label: 'Pencil',
		size: 5,
		minSize: 1,
		maxSize: 24,
		// Graphite feel: strong pressure taper, a rawer line (negative boosts undo part of
		// the input smoothing), and real translucency so overlapping strokes darken like
		// pencil shading. The previous 0.85 opacity was indistinguishable from the pen.
		thinning: 0.75,
		smoothingBoost: -0.3,
		streamlineBoost: -0.2,
		opacity: 0.55,
	},
	marker: {
		label: 'Marker',
		size: 26,
		minSize: 8,
		maxSize: 80,
		// A chisel marker does not taper with pressure.
		thinning: 0,
		smoothingBoost: 0.15,
		streamlineBoost: 0.2,
		opacity: 0.3,
	},
};

export const NON_PEN_TOOL_LABELS: Record<Exclude<HandnotesTool, HandnotesPenTool>, string> = {
	eraser: 'Erase',
	select: 'Select',
	pan: 'Pan',
};

export function isPenTool(tool: HandnotesTool): tool is HandnotesPenTool {
	return tool === 'fountain' || tool === 'ballpoint' || tool === 'pencil' || tool === 'marker';
}

export function toolLabel(tool: HandnotesTool): string {
	return isPenTool(tool) ? PEN_PRESETS[tool].label : NON_PEN_TOOL_LABELS[tool];
}

/** Clamp a user-chosen width to the preset's range. */
export function clampSizeForTool(tool: HandnotesPenTool, size: number): number {
	const preset = PEN_PRESETS[tool];
	if (!Number.isFinite(size)) return preset.size;
	return Math.min(preset.maxSize, Math.max(preset.minSize, size));
}

/** Per-tool width chosen by the user, falling back to the preset default. */
export type ToolSizeOverrides = Partial<Record<HandnotesPenTool, number>>;

export function sizeForTool(tool: HandnotesPenTool, overrides: ToolSizeOverrides | undefined): number {
	const override = overrides?.[tool];
	if (override === undefined) return PEN_PRESETS[tool].size;
	return clampSizeForTool(tool, override);
}
