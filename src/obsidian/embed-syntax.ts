import type { InkMode } from '../model/types';
import { WRITING_PAGE_WIDTH } from '../model/constants';

/**
 * The markdown an embed is written as, unchanged from Ink so notes stay compatible:
 *
 *   ![InkDrawing](<path.svg>) [Edit Drawing](https://youtu.be/2arL1jh8ihA?type=inkDrawing&width=…)
 *
 * The second link carries the embed's display settings (drawing size and framing).
 */

export const INK_EMBED_BASE_URL = 'https://youtu.be/2arL1jh8ihA';

export interface ViewBox { x: number; y: number; width: number; height: number }

export interface EmbedParams {
	/** Drawing display width in px. */
	width?: number;
	aspectRatio?: number;
	viewBox?: ViewBox;
	pendingPaste?: boolean;
}

export interface EmbedMatch {
	mode: InkMode;
	path: string;
	params: EmbedParams;
	/** Offsets inside the scanned text. */
	from: number;
	to: number;
}

const EMBED_RE = /!\[Ink(Writing|Drawing)\]\((?:<([^>\n]+)>|([^)\s]+))\)(?:[ \t]*\[Edit (?:Writing|Drawing)\]\(([^)\s]*)\))?/g;

export function quickTest(text: string): boolean {
	return text.includes('![Ink');
}

export function findEmbeds(text: string): EmbedMatch[] {
	const out: EmbedMatch[] = [];
	if (!quickTest(text)) return out;
	EMBED_RE.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = EMBED_RE.exec(text))) {
		const mode: InkMode = m[1] === 'Writing' ? 'writing' : 'drawing';
		out.push({ mode, path: (m[2] ?? m[3]).trim(), params: parseParams(m[4] ?? ''), from: m.index, to: m.index + m[0].length });
	}
	return out;
}

export function parseParams(url: string): EmbedParams {
	const q = url.indexOf('?');
	if (q < 0) return {};
	const sp = new URLSearchParams(url.slice(q + 1));
	const num = (k: string) => {
		const v = sp.get(k);
		const n = v === null ? NaN : Number(v);
		return Number.isFinite(n) ? n : undefined;
	};
	const params: EmbedParams = {};
	const width = num('width');
	if (width !== undefined && width > 0) params.width = width;
	const aspect = num('aspectRatio');
	if (aspect !== undefined && aspect > 0) params.aspectRatio = aspect;
	const vx = num('viewBoxX'), vy = num('viewBoxY'), vw = num('viewBoxW'), vh = num('viewBoxH');
	if (vx !== undefined && vy !== undefined && vw !== undefined && vh !== undefined && vw > 0 && vh > 0) {
		params.viewBox = { x: vx, y: vy, width: vw, height: vh };
	}
	if (sp.get('pendingPaste') === 'true') params.pendingPaste = true;
	return params;
}

function r3(n: number): string {
	return String(Math.round(n * 1000) / 1000);
}

export function buildEmbedUrl(mode: InkMode, params: EmbedParams): string {
	const sp = new URLSearchParams();
	if (mode === 'drawing') {
		const p = withDrawingDefaults(params);
		sp.set('width', r3(p.width!));
		sp.set('aspectRatio', p.aspectRatio!.toFixed(3));
		sp.set('viewBoxX', r3(p.viewBox!.x));
		sp.set('viewBoxY', r3(p.viewBox!.y));
		sp.set('viewBoxW', r3(p.viewBox!.width));
		sp.set('viewBoxH', r3(p.viewBox!.height));
	} else if (params.aspectRatio) {
		sp.set('aspectRatio', params.aspectRatio.toFixed(3));
	}
	if (params.pendingPaste) sp.set('pendingPaste', 'true');
	const type = mode === 'drawing' ? 'inkDrawing' : 'inkWriting';
	const rest = sp.toString();
	return `${INK_EMBED_BASE_URL}?type=${type}${rest ? '&' + rest : ''}`;
}

export function buildEmbedMarkdown(mode: InkMode, path: string, params: EmbedParams): string {
	const alt = mode === 'drawing' ? 'InkDrawing' : 'InkWriting';
	const label = mode === 'drawing' ? 'Edit Drawing' : 'Edit Writing';
	return `![${alt}](<${path}>) [${label}](${buildEmbedUrl(mode, params)})`;
}

/** New drawings frame a page as wide as a writing page, so the pen feels the same in both. */
export function newDrawingParams(): EmbedParams {
	const aspectRatio = 16 / 9;
	return { width: 500, aspectRatio, viewBox: { x: 0, y: 0, width: WRITING_PAGE_WIDTH, height: WRITING_PAGE_WIDTH / aspectRatio } };
}

export function withDrawingDefaults(params: EmbedParams): Required<Pick<EmbedParams, 'width' | 'aspectRatio' | 'viewBox'>> & EmbedParams {
	const width = params.width ?? 500;
	const aspectRatio = params.aspectRatio ?? 16 / 9;
	const viewBox = params.viewBox ?? { x: 0, y: 0, width: 500, height: 500 / aspectRatio };
	return { ...params, width, aspectRatio, viewBox };
}
