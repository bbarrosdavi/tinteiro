import type { InkStrokeStyle, StrokeInputKind } from '../model/types';
import type { PenPreset } from './tool-presets';

/**
 * How pen input becomes stroke parameters: the zoom range, how smoothing follows the zoom
 * the stroke was drawn at, the stroke style for a pen or a mouse, the default pressure
 * response, and how raw stylus pressure is conditioned. The numbers are the ones existing
 * Ink files were drawn with, so old strokes keep their exact weight and shape.
 */

// Zoom
//////////

export const ZOOM_MIN = 0.1;
export const ZOOM_MAX = 5;
/** Zoom at which the base values below apply unchanged. */
export const BASE_ZOOM = 1;

export function clampZoom(zoom: number): number {
	return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom));
}

function clamp01(value: number): number {
	return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

/**
 * A value tuned at the base zoom, seen from another zoom. Zoomed in, it shrinks in
 * proportion (1/zoom). Zoomed out, it slides towards `farValue`, reaching it at the widest
 * zoom, measured along 1/zoom so the change is even per step of zooming out.
 */
export function valueAtZoom(baseValue: number, farValue: number, zoom: number): number {
	const z = clampZoom(zoom);
	if (z >= BASE_ZOOM) return baseValue * (BASE_ZOOM / z);
	const progress = (1 / z - 1 / BASE_ZOOM) / (1 / ZOOM_MIN - 1 / BASE_ZOOM);
	const t = Math.min(1, Math.max(0, progress));
	return baseValue + (farValue - baseValue) * t;
}

/** Where streamline and smoothing end up at the widest zoom, per input kind. */
const FAR_SMOOTHING: Record<StrokeInputKind, number> = { pen: 0.2, mouse: 0.65 };

/** Clamped to 0..1; an undefined zoom stays undefined (NaN), as in the files' original code. */
export function smoothingAtZoom(baseValue: number, zoom: number, kind: StrokeInputKind): number {
	return Math.min(1, Math.max(0, valueAtZoom(baseValue, FAR_SMOOTHING[kind], zoom)));
}

// Stroke style
//////////

type Numerics = Pick<InkStrokeStyle, 'thinning' | 'smoothing' | 'streamline' | 'simulatePressure'>;

/** A real stylus: follow the pen closely, width from its pressure. */
export const PEN_NUMERICS: Numerics = { thinning: 0.6, smoothing: 0.1, streamline: 0, simulatePressure: false };

/** A mouse or finger: smoothed, width simulated from speed. */
export const MOUSE_NUMERICS: Numerics = { thinning: 0.6, smoothing: 0.4, streamline: 0.4, simulatePressure: true };

/**
 * The style a new stroke is stored with: the toolbar's size and colour, the numerics of the
 * input kind scaled for the current zoom, then the pen preset on top (its thinning replaces,
 * its boosts add to the zoom-scaled smoothing and streamline).
 */
export function strokeStyleFor(
	base: InkStrokeStyle,
	kind: StrokeInputKind,
	zoom: number = BASE_ZOOM,
	preset?: PenPreset,
): InkStrokeStyle {
	const numerics = kind === 'pen' ? PEN_NUMERICS : MOUSE_NUMERICS;
	const z = clampZoom(zoom);
	const style: InkStrokeStyle = {
		...base,
		...numerics,
		streamline: smoothingAtZoom(numerics.streamline, z, kind),
		smoothing: smoothingAtZoom(numerics.smoothing, z, kind),
		inputKind: kind,
		captureZoom: z,
	};
	if (!preset) return style;
	style.thinning = preset.thinning;
	style.streamline = clamp01(style.streamline + preset.streamlineBoost);
	style.smoothing = clamp01(style.smoothing + preset.smoothingBoost);
	if (preset.opacity < 1) style.opacity = preset.opacity;
	else delete style.opacity;
	return style;
}

// Pressure response
//////////

/** Default response for a stylus: a little fuller than linear at light pressure. */
export function defaultPenEasing(t: number): number {
	return 0.65 * t + 0.35 * Math.sin((Math.PI * t) / 2);
}

export function linearEasing(t: number): number {
	return t;
}

/** Pen strokes use the pressure curve; strokes without an input kind decide by real pressure. */
export function usesPenEasing(style: InkStrokeStyle): boolean {
	if (style.inputKind) return style.inputKind === 'pen';
	return !style.simulatePressure;
}

// Stylus pressure conditioning
//////////

/** Browsers report pen pressure a little low; it is amplified, then clipped to 0..1. */
export const PRESSURE_GAIN = 1.25;
/** Pressure is held at least this high until the stroke is one brush-size long. */
export const START_PRESSURE_FLOOR = 0.15;
/** Weight of a new sample in the running pressure (exponential smoothing). */
export const PRESSURE_SMOOTHING = 0.4;
/** Most the pressure may change per brush-size of travel (keeps fast strokes from pinching). */
export const PRESSURE_SLEW_PER_SIZE = 0.3;
/** Pen moves at or below this pressure are hover, not ink. */
export const HOVER_PRESSURE = 0.01;

export function conditionPenPressure(raw: number, travelled: number, size: number): number {
	const amplified = Number.isFinite(raw) ? Math.min(1, Math.max(0, raw * PRESSURE_GAIN)) : 0;
	const early = size <= 0 || travelled < size;
	return early ? Math.max(START_PRESSURE_FLOOR, amplified) : amplified;
}

// Eraser
//////////

/** Eraser radius at the base zoom, in page units (the default eraser size). */
export const ERASER_RADIUS = 15;

/**
 * Eraser footprint in screen pixels: constant on screen around the base zoom, growing in
 * page terms as the view zooms out so a wide view does not need a microscopic eraser.
 */
export function eraserRadiusOnScreen(zoom: number, radius: number = ERASER_RADIUS): number {
	const z = clampZoom(zoom);
	return valueAtZoom(radius, radius * (BASE_ZOOM / ZOOM_MIN), z) * z;
}
