import { RangeSetBuilder, StateEffect, StateField, type EditorState, type Extension, type Text, type Transaction } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';
import { editorInfoField, editorLivePreviewField } from 'obsidian';
import type { InkHost } from '../plugin-api';
import { InkEmbed, type EmbedContext } from '../embed/ink-embed';
import { buildEmbedMarkdown, findEmbeds, quickTest, type EmbedMatch } from './embed-syntax';

/**
 * Live Preview: each embed line becomes a block widget. Decorations are mapped through edits
 * and only the lines an edit touched are scanned again, so typing in a long note costs a
 * regex over one line, not a walk of the whole syntax tree on every keystroke.
 */

const refreshEffect = StateEffect.define<null>();

interface Found extends EmbedMatch {
	lineFrom: number;
	lineTo: number;
}

function scanLines(doc: Text, fromLine: number, toLine: number, out: Found[]): void {
	for (let n = fromLine; n <= toLine; n++) {
		const line = doc.line(n);
		if (!quickTest(line.text)) continue;
		const matches = findEmbeds(line.text);
		// One widget per line; a line that holds anything else keeps its text.
		if (matches.length !== 1) continue;
		const m = matches[0];
		const rest = (line.text.slice(0, m.from) + line.text.slice(m.to)).trim();
		if (rest) continue;
		out.push({ ...m, from: line.from + m.from, to: line.from + m.to, lineFrom: line.from, lineTo: line.to });
	}
}

class InkWidget extends WidgetType {
	constructor(readonly host: InkHost, readonly match: Found, readonly sourcePath: string) {
		super();
	}

	eq(other: InkWidget): boolean {
		return other.match.path === this.match.path
			&& other.match.mode === this.match.mode
			&& JSON.stringify(other.match.params) === JSON.stringify(this.match.params)
			&& other.sourcePath === this.sourcePath;
	}

	private context(view: EditorView, dom: HTMLElement): EmbedContext {
		const m = this.match;
		return {
			host: this.host,
			mode: m.mode,
			linkPath: m.path,
			sourcePath: this.sourcePath,
			params: m.params,
			rewrite: update => {
				const pos = posOfWidget(view, dom);
				if (pos === null) return;
				const line = view.state.doc.lineAt(pos);
				const matches = findEmbeds(line.text);
				if (matches.length !== 1) return;
				const cur = matches[0];
				const text = buildEmbedMarkdown(update.mode ?? cur.mode, update.path ?? cur.path, update.params ?? cur.params);
				view.dispatch({ changes: { from: line.from + cur.from, to: line.from + cur.to, insert: text } });
			},
			remove: () => {
				const pos = posOfWidget(view, dom);
				if (pos === null) return;
				const line = view.state.doc.lineAt(pos);
				view.dispatch({ changes: { from: line.from, to: Math.min(view.state.doc.length, line.to + 1), insert: '' } });
			},
		};
	}

	toDOM(view: EditorView): HTMLElement {
		const wrap = document.createElement('div');
		wrap.className = 'inkf-widget';
		const embed = new InkEmbed(this.context(view, wrap));
		embeds.set(wrap, embed);
		wrap.append(embed.el);
		// Mount after CodeMirror inserted the node, so visibility is measured in place.
		requestAnimationFrame(() => embed.mount());
		return wrap;
	}

	updateDOM(dom: HTMLElement, view: EditorView): boolean {
		const embed = embeds.get(dom);
		if (!embed) return false;
		embed.update(this.context(view, dom));
		return true;
	}

	destroy(dom: HTMLElement): void {
		embeds.get(dom)?.dispose();
		embeds.delete(dom);
	}

	get estimatedHeight(): number {
		const p = this.match.params;
		if (this.match.mode === 'drawing') return Math.round((p.width ?? 500) / (p.aspectRatio ?? 16 / 9));
		return p.aspectRatio ? Math.round(700 / p.aspectRatio) : 200;
	}

	ignoreEvent(): boolean {
		return true;
	}
}

const embeds = new WeakMap<HTMLElement, InkEmbed>();

function posOfWidget(view: EditorView, dom: HTMLElement): number | null {
	try {
		return view.posAtDOM(dom);
	} catch {
		return null;
	}
}

function isLivePreview(state: EditorState): boolean {
	return state.field(editorLivePreviewField, false) === true;
}

function sourcePathOf(state: EditorState): string {
	return state.field(editorInfoField, false)?.file?.path ?? '';
}

export function inkLivePreview(host: InkHost): Extension {
	const build = (state: EditorState, found: Found[]): DecorationSet => {
		const b = new RangeSetBuilder<Decoration>();
		const sourcePath = sourcePathOf(state);
		found.sort((a, c) => a.lineFrom - c.lineFrom);
		for (const f of found) {
			b.add(f.lineFrom, f.lineTo, Decoration.replace({ widget: new InkWidget(host, f, sourcePath), block: true }));
		}
		return b.finish();
	};

	const full = (state: EditorState): DecorationSet => {
		if (!isLivePreview(state)) return Decoration.none;
		const found: Found[] = [];
		scanLines(state.doc, 1, state.doc.lines, found);
		return build(state, found);
	};

	const field = StateField.define<DecorationSet>({
		create: full,
		update(value: DecorationSet, tr: Transaction): DecorationSet {
			const wasLive = isLivePreview(tr.startState);
			const live = isLivePreview(tr.state);
			if (wasLive !== live || tr.effects.some(e => e.is(refreshEffect))) return full(tr.state);
			if (!live || !tr.docChanged) return value;

			// Lines the edit touched, in the new document.
			const doc = tr.state.doc;
			const touched: Array<[number, number]> = [];
			tr.changes.iterChangedRanges((_fa, _ta, fromB, toB) => {
				touched.push([doc.lineAt(fromB).number, doc.lineAt(Math.min(toB, doc.length)).number]);
			});
			const mapped = value.map(tr.changes);
			const found: Found[] = [];
			const keep: Array<{ from: number; to: number; deco: Decoration }> = [];
			const inTouched = (pos: number) => {
				const n = doc.lineAt(pos).number;
				return touched.some(([a, c]) => n >= a && n <= c);
			};
			mapped.between(0, doc.length, (from, to, deco) => {
				if (!inTouched(from)) keep.push({ from, to, deco });
			});
			for (const [a, c] of touched) scanLines(doc, a, c, found);
			const b = new RangeSetBuilder<Decoration>();
			const sourcePath = sourcePathOf(tr.state);
			const all = [
				...keep,
				...found.map(f => ({ from: f.lineFrom, to: f.lineTo, deco: Decoration.replace({ widget: new InkWidget(host, f, sourcePath), block: true }) })),
			].sort((x, y) => x.from - y.from);
			let last = -1;
			for (const d of all) {
				if (d.from <= last) continue;
				b.add(d.from, d.to, d.deco);
				last = d.to;
			}
			return b.finish();
		},
		provide: f => [
			EditorView.decorations.from(f),
			EditorView.atomicRanges.of(view => view.state.field(f, false) ?? Decoration.none),
		],
	});

	return [field];
}

export function refreshLivePreview(view: EditorView): void {
	view.dispatch({ effects: refreshEffect.of(null) });
}
