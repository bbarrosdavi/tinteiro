import { InkEditor } from '../src/engine/editor';
import { InkDocument } from '../src/engine/document';
import { parseInkFile, serializeInkFile } from '../src/model/format';
import { DEFAULT_SETTINGS } from '../src/settings';
import { WRITING_PAGE_WIDTH } from '../src/model/constants';

declare global {
	interface Window { bench: Record<string, unknown>; benchSetup(text: string, mode: 'drawing' | 'writing', w: number, h: number): string; }
}

const frames: number[] = [];
const handler: number[] = [];
let editor: InkEditor | null = null;
let doc: InkDocument | null = null;

window.benchSetup = (text, mode, w, h) => {
	const t0 = performance.now();
	const snap = parseInkFile(text, mode);
	const t1 = performance.now();
	const { strokes, ...rest } = snap;
	doc = new InkDocument(rest, strokes);
	const stage = document.getElementById('stage')!;
	stage.style.width = `${w}px`;
	stage.style.height = `${h}px`;
	editor = new InkEditor(stage, doc, mode, {
		settings: () => DEFAULT_SETTINGS,
		onEdit: () => undefined,
		onState: () => undefined,
	});
	editor.interactive = true;
	editor.resize(w, h);
	if (mode === 'drawing') {
		const b = strokes.reduce((a, s) => {
			for (const p of s.points) { a.minX = Math.min(a.minX, p[0] + s.offset.x); a.minY = Math.min(a.minY, p[1] + s.offset.y); a.maxX = Math.max(a.maxX, p[0] + s.offset.x); a.maxY = Math.max(a.maxY, p[1] + s.offset.y); }
			return a;
		}, { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
		const zoom = Math.min(w / (b.maxX - b.minX), h / (b.maxY - b.minY));
		editor.setCamera({ x: -b.minX, y: -b.minY, zoom }, false);
	}
	editor.renderer.flush();
	const t2 = performance.now();
	const r = editor.renderer as unknown as { paint: () => void };
	const orig = r.paint.bind(r);
	r.paint = () => { const t = performance.now(); orig(); paints.push(performance.now() - t); };
	return JSON.stringify({ parseMs: t1 - t0, firstPaintMs: t2 - t1, strokes: strokes.length, points: strokes.reduce((n, s) => n + s.points.length, 0) });
};

// Main-thread cost of each input event: capture at window starts, bubble at window ends.
let evStart = 0;
for (const type of ['pointerdown', 'pointermove', 'pointerup']) {
	window.addEventListener(type, () => { evStart = performance.now(); }, { capture: true });
	window.addEventListener(type, () => handler.push(performance.now() - evStart));
}
const paints: number[] = [];
let last = 0;
function tick(now: number) {
	if (last) frames.push(now - last);
	last = now;
	requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

const longTasks: number[] = [];
new PerformanceObserver(list => {
	for (const e of list.getEntries()) longTasks.push(e.duration);
}).observe({ entryTypes: ['longtask'] });

window.bench = {
	reset() { frames.length = 0; handler.length = 0; longTasks.length = 0; paints.length = 0; },
	stats() {
		const pct = (arr: number[], p: number) => { const s = [...arr].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0; };
		return JSON.stringify({
			events: handler.length,
			handlerP50: pct(handler, 0.5), handlerP95: pct(handler, 0.95), handlerMax: Math.max(0, ...handler),
			frames: frames.length, frameP95: pct(frames, 0.95), frameMax: Math.max(0, ...frames),
			paints: paints.length, paintP50: pct(paints, 0.5), paintP95: pct(paints, 0.95), paintMax: Math.max(0, ...paints),
			longTasks: longTasks.length, longTaskMax: Math.max(0, ...longTasks),
			strokes: doc?.strokes.length,
		});
	},
	time(name: string) {
		const t = performance.now();
		if (name === 'save') serializeInkFile(doc!.toSnapshot(), 'drawing', WRITING_PAGE_WIDTH);
		if (name === 'save2') serializeInkFile(doc!.toSnapshot(), 'drawing', WRITING_PAGE_WIDTH);
		if (name === 'fullPaint') { editor!.renderer.invalidate(); editor!.renderer.flush(); }
		if (name === 'undo') { editor!.undo(); editor!.renderer.flush(); }
		return performance.now() - t;
	},
	setTool(t: string) { editor!.setTool(t as never); },
	heap() { return (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0; },
};
