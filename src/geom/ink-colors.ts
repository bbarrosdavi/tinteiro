///////////////////////////
///////////////////////////

/**
 * Sentinel stored in `InkStrokeStyle.color` for "follow the Obsidian theme".
 * This is the Ink default: strokes inherit `currentColor`, so they are dark
 * on a light theme and light on a dark theme. Any other value is a literal CSS
 * colour and is rendered (and exported) exactly as given.
 */
export const THEME_ADAPTIVE_INK_COLOR = 'currentColor';

export interface InkColorSwatch {
	id: string;
	label: string;
	/** CSS colour, or {@link THEME_ADAPTIVE_INK_COLOR}. */
	value: string;
}

/**
 * Default swatches. Chosen to stay legible on both a white page and a dark theme,
 * which rules out very dark blues and very light yellows.
 */
export const INK_COLOR_SWATCHES: InkColorSwatch[] = [
	{ id: 'theme', label: 'Theme', value: THEME_ADAPTIVE_INK_COLOR },
	{ id: 'black', label: 'Black', value: '#1a1a1a' },
	{ id: 'grey', label: 'Grey', value: '#8a8a8a' },
	{ id: 'red', label: 'Red', value: '#e03131' },
	{ id: 'orange', label: 'Orange', value: '#e8590c' },
	{ id: 'yellow', label: 'Yellow', value: '#f0a800' },
	{ id: 'green', label: 'Green', value: '#2f9e44' },
	{ id: 'teal', label: 'Teal', value: '#0c8599' },
	{ id: 'blue', label: 'Blue', value: '#1971c2' },
	{ id: 'violet', label: 'Violet', value: '#6741d9' },
	{ id: 'pink', label: 'Pink', value: '#c2255c' },
	{ id: 'brown', label: 'Brown', value: '#8b5a2b' },
];

export interface Hsl {
	/** 0..360 */
	h: number;
	/** 0..100 */
	s: number;
	/** 0..100 */
	l: number;
}

///////////////////////////

export function isThemeAdaptiveColor(color: string | undefined | null): boolean {
	return !color || color === THEME_ADAPTIVE_INK_COLOR;
}

/**
 * Accepts `#rgb`, `#rrggbb`, `hsl(h, s%, l%)` or the theme sentinel and returns a value
 * safe to hand to the renderer. Returns `null` for anything unrecognised.
 *
 * Every colour entering the stroke style goes through here: a colour the renderer
 * cannot parse would silently paint the stroke black, which is worse than refusing it.
 */
export function normaliseInkColor(color: string | undefined | null): string | null {
	if (color === undefined || color === null) return null;
	const trimmed = color.trim();
	if (trimmed === '') return null;
	if (trimmed === THEME_ADAPTIVE_INK_COLOR) return THEME_ADAPTIVE_INK_COLOR;

	const shortHex = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(trimmed);
	if (shortHex) {
		return `#${shortHex[1]}${shortHex[1]}${shortHex[2]}${shortHex[2]}${shortHex[3]}${shortHex[3]}`.toLowerCase();
	}

	const longHex = /^#[0-9a-f]{6}$/i.exec(trimmed);
	if (longHex) return trimmed.toLowerCase();

	const hsl = /^hsl\(\s*(-?[\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*\)$/i.exec(trimmed);
	if (hsl) {
		return hslToHex({
			h: Number(hsl[1]),
			s: Number(hsl[2]),
			l: Number(hsl[3]),
		});
	}

	return null;
}

export function hslToHex(hsl: Hsl): string {
	const h = ((hsl.h % 360) + 360) % 360;
	const s = clamp(hsl.s, 0, 100) / 100;
	const l = clamp(hsl.l, 0, 100) / 100;

	const c = (1 - Math.abs(2 * l - 1)) * s;
	const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
	const m = l - c / 2;

	let rgb: [number, number, number];
	if (h < 60) rgb = [c, x, 0];
	else if (h < 120) rgb = [x, c, 0];
	else if (h < 180) rgb = [0, c, x];
	else if (h < 240) rgb = [0, x, c];
	else if (h < 300) rgb = [x, 0, c];
	else rgb = [c, 0, x];

	const toHexPair = (channel: number) => {
		const value = Math.round((channel + m) * 255);
		return clamp(value, 0, 255).toString(16).padStart(2, '0');
	};

	return `#${toHexPair(rgb[0])}${toHexPair(rgb[1])}${toHexPair(rgb[2])}`;
}

export function hexToHsl(hex: string): Hsl {
	const normalised = normaliseInkColor(hex);
	if (!normalised || normalised === THEME_ADAPTIVE_INK_COLOR) return { h: 0, s: 0, l: 0 };

	const r = parseInt(normalised.slice(1, 3), 16) / 255;
	const g = parseInt(normalised.slice(3, 5), 16) / 255;
	const b = parseInt(normalised.slice(5, 7), 16) / 255;

	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	const delta = max - min;
	const l = (max + min) / 2;

	let h = 0;
	let s = 0;
	if (delta !== 0) {
		s = l > 0.5 ? delta / (2 - max - min) : delta / (max + min);
		if (max === r) h = ((g - b) / delta + (g < b ? 6 : 0)) * 60;
		else if (max === g) h = ((b - r) / delta + 2) * 60;
		else h = ((r - g) / delta + 4) * 60;
	}

	return {
		h: Math.round(h),
		s: Math.round(s * 100),
		l: Math.round(l * 100),
	};
}

/** CSS colour for a swatch preview, resolving the theme sentinel to the note's text colour. */
export function swatchPreviewColor(value: string): string {
	return isThemeAdaptiveColor(value) ? 'var(--text-normal)' : value;
}

function clamp(value: number, min: number, max: number): number {
	if (!Number.isFinite(value)) return min;
	return Math.min(max, Math.max(min, value));
}
