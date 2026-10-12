/**
 * Line icons on a 24 px grid, 1.75 px stroke, drawn for this plugin (Lucide's visual
 * language). Inlined so the toolbar never depends on which icon set Obsidian ships.
 */

const P: Record<string, string> = {
	undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
	redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>',
	fountain: '<path d="M12 21v-6"/><path d="M8.5 9.5 12 3l3.5 6.5L12 15z"/><circle cx="12" cy="10.5" r="1.2"/>',
	ballpoint: '<path d="m15.5 4.5 4 4L9 19l-5 1 1-5z"/><path d="m13.5 6.5 4 4"/>',
	pencil: '<path d="M17.5 3.5a2.1 2.1 0 0 1 3 3L8 19l-4.5 1.5L5 16z"/><path d="m15 6 3 3"/><path d="M5 16l3 3"/>',
	marker: '<path d="m9 11-5 5v3h3l5-5"/><path d="m22 6-8.5 8.5-5-5L17 1z" transform="translate(-1 2)"/>',
	eraser: '<path d="m7 21-4.3-4.3a1 1 0 0 1 0-1.4l9.6-9.6a1 1 0 0 1 1.4 0l5.6 5.6a1 1 0 0 1 0 1.4L13 21"/><path d="M22 21H7"/><path d="m5 11 9 9"/>',
	select: '<path d="M7 22a5 5 0 0 1-2-4"/><path d="M3.3 14A6.8 6.8 0 0 1 2 10c0-4.4 4.5-8 10-8s10 3.6 10 8-4.5 8-10 8a12 12 0 0 1-5-1"/><path d="M5 18a2 2 0 1 0 0-4 2 2 0 0 0 0 4z"/>',
	pan: '<path d="M18 11V6a2 2 0 0 0-4 0v1"/><path d="M14 10V4a2 2 0 0 0-4 0v2"/><path d="M10 10.5V6a2 2 0 0 0-4 0v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/>',
	shapes: '<path d="M8.3 10a.7.7 0 0 1-.63-1.06l3.7-6a.7.7 0 0 1 1.26 0l3.7 6A.7.7 0 0 1 15.7 10z"/><rect x="3" y="14" width="7" height="7" rx="1"/><circle cx="17.5" cy="17.5" r="3.5"/>',
	line: '<path d="M5 19 19 5"/>',
	arrow: '<path d="M5 19 19 5"/><path d="M9 5h10v10"/>',
	spline: '<path d="M4 18c3-9 6-12 8-6s5 3 8-6"/>',
	ellipse: '<ellipse cx="12" cy="12" rx="9" ry="6.5"/>',
	rect: '<rect x="4" y="6" width="16" height="12" rx="1.5"/>',
	plot2d: '<path d="M4 20V4"/><path d="M4 20h16"/><path d="m2 6 2-2 2 2"/><path d="m18 18 2 2-2 2"/><path d="M8 19v2M12 19v2M16 19v2M3 16h2M3 12h2M3 8h2"/>',
	axes3d: '<path d="M12 12V3"/><path d="m12 12 8 5"/><path d="m12 12-8 5"/><path d="m10 5 2-2 2 2"/><path d="M12 12v6M12 12l-5-3M12 12l5-3" stroke-dasharray="1.5 2"/>',
	cube: '<path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="m3 8 9 5 9-5"/><path d="M12 13v8"/>',
	palette: '<circle cx="13.5" cy="6.5" r="1"/><circle cx="17.5" cy="10.5" r="1"/><circle cx="8.5" cy="7.5" r="1"/><circle cx="6.5" cy="12.5" r="1"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.93 0 1.65-.75 1.65-1.69 0-.44-.18-.84-.44-1.13-.29-.29-.44-.65-.44-1.13a1.64 1.64 0 0 1 1.67-1.67h2c3.05 0 5.56-2.5 5.56-5.55C21.97 6 17.46 2 12 2z"/>',
	image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>',
	imagePlus: '<path d="M16 5h6M19 2v6"/><path d="M21 11.5V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7.5"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/><circle cx="9" cy="9" r="2"/>',
	paper: '<path d="M6 3h12a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M8 8h8M8 12h8M8 16h5"/>',
	more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
	check: '<path d="M20 6 9 17l-5-5"/>',
	trash: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M10 11v6M14 11v6"/>',
	copy: '<rect x="8" y="8" width="14" height="14" rx="2"/><path d="M4 16a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2"/>',
	duplicate: '<rect x="8" y="8" width="14" height="14" rx="2"/><path d="M15 12v6M12 15h6"/><path d="M4 16a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2"/>',
	paste: '<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>',
	selectAll: '<path d="M5 3a2 2 0 0 0-2 2M19 3a2 2 0 0 1 2 2M21 19a2 2 0 0 1-2 2M5 21a2 2 0 0 1-2-2M9 3h1M9 21h1M14 3h1M14 21h1M3 9v1M21 9v1M3 14v1M21 14v1"/><rect x="8" y="8" width="8" height="8" rx="1"/>',
	expand: '<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>',
	frame: '<path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2"/><circle cx="12" cy="12" r="3"/>',
	zoomLock: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/><rect x="8" y="10" width="6" height="4.5" rx="1"/><path d="M9.5 10V8.8a1.5 1.5 0 0 1 3 0V10"/>',
	finger: '<path d="M22 14a8 8 0 0 1-8 8"/><path d="M18 11v-1a2 2 0 0 0-2-2a2 2 0 0 0-2 2"/><path d="M14 10V9a2 2 0 0 0-2-2a2 2 0 0 0-2 2v1"/><path d="M10 9.5V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v10"/><path d="M18 11a2 2 0 1 1 4 0v3a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/>',
	panelLeft: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/>',
	panelTop: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/>',
	imageDown: '<path d="M10.3 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10l-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/><path d="m14 19 3 3v-5.5M17 22l3-3"/><circle cx="9" cy="9" r="2"/>',
	sunMoon: '<path d="M12 8a2.8 2.8 0 0 0 4 4 4 4 0 1 1-4-4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M6.3 17.7l-1.4 1.4M19.1 4.9l-1.4 1.4"/>',
	grid: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/>',
	plusLines: '<path d="M11 12H3M16 6H3M16 18H3M18 9v6M21 12h-6"/>',
	x: '<path d="M18 6 6 18M6 6l12 12"/>',
	minus: '<path d="M5 12h14"/>',
	plus: '<path d="M5 12h14M12 5v14"/>',
	lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
	pencilLine: '<path d="M12 20h9"/><path d="M16.4 3.6a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
	convert: '<path d="m16 3 4 4-4 4"/><path d="M20 7H4"/><path d="m8 21-4-4 4-4"/><path d="M4 17h16"/>',
	fileOpen: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M12 18v-6M9 15l3 3 3-3"/>',
};

export type IconName = keyof typeof P;

const cache = new Map<string, string>();

export function iconSvg(name: string, size = 20): string {
	const key = `${name}:${size}`;
	let svg = cache.get(key);
	if (!svg) {
		svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] ?? ''}</svg>`;
		cache.set(key, svg);
	}
	return svg;
}

export function hasIcon(name: string): boolean {
	return name in P;
}
