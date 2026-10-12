import type { InkCanvasSnapshot, InkStroke } from '../model/types';

/**
 * The strokes of one file and their history. The stroke list is immutable: every edit
 * swaps in a new array, so an undo step is just the pair of arrays and costs nothing
 * to record or replay. Listeners learn what was added and removed, which lets the
 * renderer paint a new stroke on top instead of repainting the page.
 */

export interface DocChange {
	added: InkStroke[];
	removed: InkStroke[];
	/** True when only strokes were appended on top (no reorder, no removal). */
	appendOnly: boolean;
}

interface Step {
	before: readonly InkStroke[];
	after: readonly InkStroke[];
}

const MAX_HISTORY = 300;

export class InkDocument {
	private list: readonly InkStroke[];
	private undoStack: Step[] = [];
	private redoStack: Step[] = [];
	private listeners = new Set<(change: DocChange) => void>();
	/** Bumped on every change; the autosave compares it with the saved one. */
	revision = 0;

	constructor(public snapshot: Omit<InkCanvasSnapshot, 'strokes'>, strokes: InkStroke[]) {
		this.list = strokes;
	}

	get strokes(): readonly InkStroke[] {
		return this.list;
	}

	onChange(listener: (change: DocChange) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	add(strokes: InkStroke[]): void {
		if (strokes.length === 0) return;
		this.commit([...this.list, ...strokes]);
	}

	/** Replaces strokes in place (keeps their stacking order); `extra` are appended. */
	replace(replacements: Map<InkStroke, InkStroke[]>, extra: InkStroke[] = []): void {
		if (replacements.size === 0 && extra.length === 0) return;
		const next: InkStroke[] = [];
		for (const s of this.list) {
			const r = replacements.get(s);
			if (r) next.push(...r);
			else next.push(s);
		}
		next.push(...extra);
		this.commit(next);
	}

	remove(strokes: Iterable<InkStroke>): void {
		const gone = new Set(strokes);
		if (gone.size === 0) return;
		this.commit(this.list.filter(s => !gone.has(s)));
	}

	/** Swaps in a whole new list as one undo step (the eraser's gesture). */
	replaceAll(next: InkStroke[]): void {
		this.commit(next);
	}

	clear(): void {
		if (this.list.length) this.commit([]);
	}

	/** Puts pasted images under the ink, where the old plugin draws them. */
	addUnder(strokes: InkStroke[]): void {
		if (strokes.length) this.commit([...strokes, ...this.list]);
	}

	canUndo(): boolean {
		return this.undoStack.length > 0;
	}

	canRedo(): boolean {
		return this.redoStack.length > 0;
	}

	undo(): boolean {
		const step = this.undoStack.pop();
		if (!step) return false;
		this.redoStack.push(step);
		this.swap(step.before);
		return true;
	}

	redo(): boolean {
		const step = this.redoStack.pop();
		if (!step) return false;
		this.undoStack.push(step);
		this.swap(step.after);
		return true;
	}

	toSnapshot(): InkCanvasSnapshot {
		return { ...this.snapshot, strokes: [...this.list] } as InkCanvasSnapshot;
	}

	/** Replaces everything without history (file changed on disk). */
	reset(strokes: InkStroke[]): void {
		this.undoStack = [];
		this.redoStack = [];
		this.swap(strokes);
	}

	private commit(next: readonly InkStroke[]): void {
		this.undoStack.push({ before: this.list, after: next });
		if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
		this.redoStack = [];
		this.swap(next);
	}

	private swap(next: readonly InkStroke[]): void {
		const prev = this.list;
		this.list = next;
		this.revision++;
		const appendOnly = next.length >= prev.length && prev.every((s, i) => next[i] === s);
		let added: InkStroke[];
		let removed: InkStroke[];
		if (appendOnly) {
			added = next.slice(prev.length);
			removed = [];
		} else {
			const before = new Set(prev);
			const after = new Set(next);
			added = next.filter(s => !before.has(s));
			removed = prev.filter(s => !after.has(s));
		}
		const change: DocChange = { added, removed, appendOnly };
		for (const l of this.listeners) l(change);
	}
}
