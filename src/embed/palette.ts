import type { Palette } from '../engine/renderer';
import type { CanvasTheme } from '../settings';

/**
 * Canvas colours. Forced pages use the fixed colours Ink used for them; `auto` follows the
 * Obsidian theme, read once per theme change (not per frame, not per embed).
 */

const FORCED: Record<'light' | 'dark', Palette & { page: string }> = {
	light: { page: '#fbfbf8', ink: '#1c1c1e', rule: '#b9b9b0', accent: '#5b6cff' },
	dark: { page: '#191a1f', ink: '#e6e6e8', rule: '#6a6b74', accent: '#8f9bff' },
};

let themed: (Palette & { page: string }) | null = null;

export function invalidateThemePalette(): void {
	themed = null;
}

function resolveCssColor(value: string, fallback: string): string {
	const v = value.trim();
	if (!v) return fallback;
	if (/^#|^rgb|^hsl/.test(v)) return v;
	// Anything else (color-mix, named colours): let the browser resolve it once.
	const probe = document.createElement('span');
	probe.style.color = v;
	probe.style.display = 'none';
	document.body.append(probe);
	const resolved = getComputedStyle(probe).color || fallback;
	probe.remove();
	return resolved;
}

export function paletteFor(theme: CanvasTheme): Palette & { page: string } {
	if (theme === 'light' || theme === 'dark') return FORCED[theme];
	if (!themed) {
		const cs = getComputedStyle(document.body);
		const dark = document.body.classList.contains('theme-dark');
		themed = {
			page: resolveCssColor(cs.getPropertyValue('--background-primary'), dark ? '#1e1e1e' : '#ffffff'),
			ink: resolveCssColor(cs.getPropertyValue('--text-normal'), dark ? '#dcddde' : '#222222'),
			rule: resolveCssColor(cs.getPropertyValue('--text-muted'), dark ? '#888888' : '#999999'),
			accent: resolveCssColor(cs.getPropertyValue('--interactive-accent'), '#7b6cd9'),
		};
	}
	return themed;
}

export function effectiveTheme(theme: CanvasTheme): 'light' | 'dark' {
	if (theme !== 'auto') return theme;
	return document.body.classList.contains('theme-dark') ? 'dark' : 'light';
}
