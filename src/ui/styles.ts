/**
 * Styles for everything inside an embed's shadow root. One constructable sheet, parsed once
 * and adopted by every embed; the note's own (large) stylesheet never matches inside, so a
 * class flip here restyles a handful of elements, not the note.
 *
 * Obsidian's custom properties inherit through the shadow boundary, so the theme still
 * drives the colours.
 */
export const EMBED_CSS = /* css */ `
:host {
	display: block;
	position: relative;
	contain: layout style;
	--inkf-accent: var(--interactive-accent, #7b6cd9);
	--inkf-text: var(--text-normal, #222);
	--inkf-muted: var(--text-muted, #777);
	--inkf-page: var(--background-primary, #fff);
	--inkf-glass: color-mix(in srgb, var(--background-primary, #fff) 58%, transparent);
	--inkf-glass-strong: color-mix(in srgb, var(--background-primary, #fff) 78%, transparent);
	--inkf-edge: color-mix(in srgb, var(--text-normal, #000) 12%, transparent);
	--inkf-hover: color-mix(in srgb, var(--text-normal, #000) 9%, transparent);
	--inkf-scale: 1;
	--inkf-radius: calc(14px * var(--inkf-scale));
	--inkf-btn: calc(36px * var(--inkf-scale));
	font-family: var(--font-interface, system-ui, sans-serif);
	font-size: 13px;
	color: var(--inkf-text);
	-webkit-user-select: none;
	user-select: none;
}

.embed { position: relative; }
/* A drawing narrower than the column sits in its middle, like an image. */
.embed.mode-drawing { margin: 0 auto; }

.stage {
	position: relative;
	overflow: hidden;
	border-radius: 12px;
	touch-action: pan-y;
	outline: none;
	transition: box-shadow .18s ease;
}
.stage.finger-draws,
.stage.pen-near,
.stage.is-drawing-mode { touch-action: none; }
.embed.is-locked .stage { touch-action: auto; cursor: pointer; }
.embed.is-locked.page-plain .stage { background: transparent; }
.embed.page-filled .stage { background: var(--inkf-page); }
.embed.is-editing .stage {
	box-shadow: 0 0 0 1px var(--inkf-edge), 0 6px 24px rgba(0, 0, 0, .08);
}
.embed.is-locked.framed .stage { box-shadow: 0 0 0 1px var(--inkf-edge); }
.embed.theme-light { --inkf-page: #fbfbf8; }
.embed.theme-dark { --inkf-page: #191a1f; }

.layer { position: absolute; left: 0; top: 0; pointer-events: none; }
.layer--live { will-change: contents; }

/* Cursors: a small dot for pens, a crosshair for figures; the eraser draws its own ring. */
.embed.is-editing .stage.is-draw {
	cursor: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10'%3E%3Ccircle cx='5' cy='5' r='3' fill='%23000' stroke='%23fff' stroke-width='1'/%3E%3C/svg%3E") 5 5, crosshair;
}
.embed.is-editing .stage.is-shape { cursor: crosshair; }
.embed.is-editing .stage.is-erase { cursor: none; }
.embed.is-editing .stage.is-pan { cursor: grab; }
.embed.is-editing .stage.is-select { cursor: default; }

/* Glass */
.glass {
	background: var(--inkf-glass);
	-webkit-backdrop-filter: blur(18px) saturate(1.7);
	backdrop-filter: blur(18px) saturate(1.7);
	border: 1px solid var(--inkf-edge);
	box-shadow: 0 10px 30px rgba(0, 0, 0, .16), inset 0 1px 0 rgba(255, 255, 255, .22);
	border-radius: var(--inkf-radius);
}

/*
 * Toolbar dock, inside the embed: at rest the bar sits right above the page; once the page's
 * top scrolls away it sticks 4 px below the pane's top, and it comes back down with the page.
 * Pure CSS sticky: the compositor does it while scrolling, no script runs.
 */
.dock {
	position: absolute; inset: 0; pointer-events: none; z-index: 3;
	/* Re-derived here: a custom property computed on :host would keep the host's scale. */
	--inkf-radius: calc(14px * var(--inkf-scale));
	--inkf-btn: calc(36px * var(--inkf-scale));
	--inkf-bar-h: 50px;
}
.dock .pin { pointer-events: none; height: 0; }
.dock--top .pin { position: sticky; top: calc(8px + var(--inkf-bar-h) - var(--inkf-pin-pad, 0px)); }
/* The pin is a zero-height flex line: the panel sits on it (overflowing upwards), centred, as wide
   as its tools allow and never wider than the page, where the tool row wraps instead of hiding tools. */
.dock--top .pin { display: flex; justify-content: center; align-items: flex-end; }
.dock--top .panel { position: relative; flex: 0 1 auto; min-width: 0; margin-bottom: 4px; max-width: calc(100% - 8px); }
.dock--left .pin { position: sticky; top: calc(4px - var(--inkf-pin-pad, 0px)); }
.dock--left .panel { position: absolute; top: 0; left: 4px; max-height: calc(100vh - 140px); }
.embed.full .dock--top .pin { position: absolute; top: calc(8px + var(--inkf-bar-h)); left: 0; right: 0; }
.embed.full .dock { --inkf-pin-pad: 0px; }
.embed.full .dock--left .pin { position: absolute; top: 4px; left: 0; right: 0; }
.panel { display: flex; pointer-events: auto; overflow: hidden; }
.dock--top .panel { flex-direction: column; align-items: center; }
.dock--left .panel { flex-direction: row; align-items: center; }
.dock--top .toolbar { flex-direction: row; max-width: 100%; flex-wrap: wrap; justify-content: center; }
.sel-row { padding: 0 calc(6px * var(--inkf-scale)) calc(2px * var(--inkf-scale)); }
.dock--left .sel-row { padding: calc(6px * var(--inkf-scale)) calc(2px * var(--inkf-scale)) calc(6px * var(--inkf-scale)) 0; }
.dock--left .toolbar { flex-direction: column; max-height: 100%; flex-wrap: wrap; }
/* The palette row lives in the same panel, under the tools (beside them on the left). */
.swatch-row { padding: 0 calc(8px * var(--inkf-scale)) calc(6px * var(--inkf-scale)); gap: 0; }
.dock--left .swatch-row { padding: calc(8px * var(--inkf-scale)) calc(6px * var(--inkf-scale)) calc(8px * var(--inkf-scale)) 0; }


.toolbar {
	display: flex;
	align-items: center;
	gap: calc(2px * var(--inkf-scale));
	padding: calc(4px * var(--inkf-scale));
	pointer-events: auto;
	overflow: auto;
	scrollbar-width: none;
	touch-action: pan-x pan-y;
}
.toolbar::-webkit-scrollbar { display: none; }
.sep { flex: none; background: var(--inkf-edge); }
.dock--top .sep { width: 1px; height: calc(22px * var(--inkf-scale)); margin: 0 calc(4px * var(--inkf-scale)); }
.dock--left .sep { height: 1px; width: calc(22px * var(--inkf-scale)); margin: calc(4px * var(--inkf-scale)) 0; }


.btn {
	flex: none;
	position: relative;
	display: inline-flex;
	align-items: center;
	justify-content: center;
	width: var(--inkf-btn);
	height: var(--inkf-btn);
	padding: 0;
	margin: 0;
	border: 0;
	border-radius: calc(11px * var(--inkf-scale));
	background: transparent;
	color: var(--inkf-text);
	font: inherit;
	cursor: pointer;
	-webkit-tap-highlight-color: transparent;
	transition: background-color .12s ease, color .12s ease, transform .08s ease;
}
.btn svg { display: block; pointer-events: none; width: calc(20px * var(--inkf-scale)); height: calc(20px * var(--inkf-scale)); }
.btn:hover { background: var(--inkf-hover); }
.btn:active { transform: scale(.92); }
.btn.is-active {
	background: color-mix(in srgb, var(--inkf-accent) 20%, transparent);
	color: var(--inkf-accent);
}
.btn:disabled { opacity: .35; pointer-events: none; }
.btn.accent { background: var(--inkf-accent); color: var(--text-on-accent, #fff); }
.btn.accent:hover { background: color-mix(in srgb, var(--inkf-accent) 85%, #000); }
.btn .dot {
	position: absolute;
	right: 5px;
	bottom: 5px;
	width: 8px;
	height: 8px;
	border-radius: 50%;
	box-shadow: 0 0 0 1.5px var(--inkf-glass-strong);
}
.btn .badge {
	position: absolute;
	left: 50%;
	bottom: 2px;
	transform: translateX(-50%);
	font-size: 9px;
	line-height: 1;
	color: var(--inkf-muted);
	font-variant-numeric: tabular-nums;
}
.swatch-btn .chip {
	width: calc(20px * var(--inkf-scale));
	height: calc(20px * var(--inkf-scale));
	border-radius: 50%;
	box-shadow: inset 0 0 0 1px rgba(0, 0, 0, .2), 0 0 0 2px var(--inkf-glass-strong);
}

/* Popovers */
.popover {
	position: absolute;
	z-index: 5;
	padding: 10px;
	pointer-events: auto;
	background: var(--inkf-glass-strong);
	animation: inkf-pop .14s ease-out;
}
@keyframes inkf-pop { from { opacity: 0; transform: translateY(-4px) scale(.98); } }
.popover h4 {
	margin: 2px 2px 8px;
	font-size: 11px;
	font-weight: 600;
	letter-spacing: .04em;
	text-transform: uppercase;
	color: var(--inkf-muted);
}
.popover .row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.popover .row + .row, .popover .row + h4, .popover .grid + h4 { margin-top: 10px; }
.popover .grid { display: grid; grid-template-columns: repeat(4, var(--inkf-btn)); gap: 2px; }
.popover.compact { padding: 6px; }
.popover.compact h4 { margin: 2px 4px 6px; }
.popover .grid.wide { grid-template-columns: 1fr 1fr; }
.popover .choice {
	display: flex;
	align-items: center;
	gap: 8px;
	padding: 7px 10px;
	border-radius: 10px;
	border: 0;
	background: transparent;
	color: var(--inkf-text);
	font: inherit;
	text-align: left;
	cursor: pointer;
	white-space: nowrap;
}
.popover .choice:hover { background: var(--inkf-hover); }
.popover .choice.is-active { background: color-mix(in srgb, var(--inkf-accent) 18%, transparent); color: var(--inkf-accent); }
.popover .choice svg { flex: none; }
.popover .choice.danger { color: var(--text-error, #e5484d); }
.segmented { display: inline-flex; padding: 2px; border-radius: 10px; background: var(--inkf-hover); }
.segmented button {
	border: 0; background: transparent; color: var(--inkf-text); font: inherit;
	padding: 5px 10px; border-radius: 8px; cursor: pointer;
}
.segmented button.is-active { background: color-mix(in srgb, var(--inkf-accent) 24%, transparent); color: var(--inkf-accent); }

.swatches { display: grid; grid-template-columns: repeat(6, 26px); gap: 6px; }
.swatch {
	width: 26px; height: 26px; border-radius: 50%; border: 0; padding: 0; cursor: pointer;
	box-shadow: inset 0 0 0 1px rgba(0, 0, 0, .18);
	transition: transform .1s ease;
}
.swatch:hover { transform: scale(1.1); }
.swatch.is-active { box-shadow: inset 0 0 0 1px rgba(0, 0, 0, .18), 0 0 0 2px var(--inkf-page), 0 0 0 4px var(--inkf-accent); }
/* Swatches right on the bar. */
.bar-swatch {
	flex: none; width: max(12px, calc(13px * var(--inkf-scale))); height: max(12px, calc(13px * var(--inkf-scale)));
	margin: 0 max(2px, calc(2.5px * var(--inkf-scale))); padding: 0; border: 0; border-radius: 50%; cursor: pointer;
	box-shadow: inset 0 0 0 1px rgba(0, 0, 0, .2);
	transition: transform .1s ease;
}
.bar-swatch:hover { transform: scale(1.12); }
.dock--left .bar-swatch { margin: max(2px, calc(2.5px * var(--inkf-scale))) 0; }
.bar-swatch.is-active { box-shadow: inset 0 0 0 1px rgba(0, 0, 0, .2), 0 0 0 1.5px var(--inkf-glass-strong), 0 0 0 3px var(--inkf-accent); }

.slider-row { display: grid; grid-template-columns: 52px 1fr 44px; align-items: center; gap: 8px; margin-top: 6px; }
.slider-row label { color: var(--inkf-muted); font-size: 12px; }
.slider-row output { text-align: right; font-variant-numeric: tabular-nums; }
input[type=range] {
	-webkit-appearance: none; appearance: none; width: 100%; height: 22px; background: transparent; margin: 0;
}
input[type=range]::-webkit-slider-runnable-track { height: 6px; border-radius: 3px; background: var(--track, var(--inkf-hover)); }
input[type=range]::-webkit-slider-thumb {
	-webkit-appearance: none; width: 18px; height: 18px; margin-top: -6px; border-radius: 50%;
	background: #fff; box-shadow: 0 1px 4px rgba(0, 0, 0, .35); border: 0;
}
.preview-line { height: 36px; border-radius: 10px; background: var(--inkf-page); margin-top: 8px; display: block; width: 100%; }
.stepper { display: inline-flex; align-items: center; gap: 2px; }
.stepper .btn { width: 28px; height: 28px; }
.stepper output { min-width: 40px; text-align: center; font-variant-numeric: tabular-nums; }

/* Locked */
.edit-chip {
	position: absolute;
	top: 8px;
	right: 8px;
	z-index: 2;
	opacity: 0;
	transition: opacity .15s ease;
	pointer-events: none;
}
.embed.is-locked:hover .edit-chip { opacity: 1; }
.embed.is-locked .edit-chip .btn { pointer-events: auto; }

/* Drawing resize handle */
.resize {
	position: absolute;
	right: -6px;
	bottom: -6px;
	width: 28px;
	height: 28px;
	border-radius: 50%;
	z-index: 3;
	cursor: nwse-resize;
	touch-action: none;
	display: flex;
	align-items: center;
	justify-content: center;
}
.resize::after { content: ''; width: 10px; height: 10px; border-radius: 50%; background: var(--inkf-accent); }
.embed.left-handed .resize { right: auto; left: -6px; cursor: nesw-resize; }

.banner {
	display: flex;
	align-items: center;
	gap: 8px;
	padding: 10px 12px;
	margin-bottom: 6px;
	color: var(--inkf-text);
}
.banner .spacer { flex: 1; }
.banner button.text {
	border: 0; border-radius: 9px; padding: 6px 10px; cursor: pointer; font: inherit;
	background: var(--inkf-hover); color: var(--inkf-text);
}
.banner button.text.primary { background: var(--inkf-accent); color: var(--text-on-accent, #fff); }
/* Full view */
.embed.full { position: absolute; inset: 0; }
.embed.full .full-scroller { position: absolute; inset: 0; overflow: auto; overscroll-behavior: contain; }
.embed.full.mode-writing .full-scroller { display: flex; justify-content: center; align-items: flex-start; padding: 16px 0; }
.embed.full.mode-writing .stage { flex: none; }
.embed.full.mode-drawing .full-scroller { overflow: hidden; }
.embed.full.mode-drawing .stage { border-radius: 0; box-shadow: none; }

.banner.legacy { position: absolute; left: 50%; bottom: 16px; transform: translateX(-50%); z-index: 4; }

.empty-note { padding: 18px; color: var(--inkf-muted); text-align: center; }
`;

/** One parsed sheet per window (a popout window cannot adopt the main window's sheet). */
const sheets = new WeakMap<Document, CSSStyleSheet>();

export function adoptEmbedStyles(root: ShadowRoot): void {
	const doc = root.ownerDocument;
	let sheet = sheets.get(doc);
	if (!sheet) {
		const Ctor = (doc.defaultView as (Window & typeof globalThis) | null)?.CSSStyleSheet ?? CSSStyleSheet;
		sheet = new Ctor();
		sheet.replaceSync(EMBED_CSS);
		sheets.set(doc, sheet);
	}
	root.adoptedStyleSheets = [sheet];
}
