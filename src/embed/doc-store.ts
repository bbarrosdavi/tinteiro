import { TFile, type App } from 'obsidian';
import { InkDocument } from '../engine/document';
import { emptySnapshot, parseInkFile, serializeInkFile, warmStroke } from '../model/format';
import type { InkCanvasSnapshot, InkMode } from '../model/types';
import { WRITING_PAGE_WIDTH } from '../model/constants';

/**
 * One InkDocument per file, shared by every embed and view showing it, so two embeds of the
 * same drawing stay in sync and a file is parsed once. Saving is per file: 500 ms after the
 * last change, at most 2 s into a burst of changes, and never while a pen is on any surface
 * showing the file (it retries every 250 ms).
 */

const SAVE_DELAY_MS = 500;
const SAVE_MAX_WAIT_MS = 2000;
const BUSY_RETRY_MS = 250;
/** Parsed documents nobody shows are kept this long, so scrolling back is instant. */
const IDLE_KEEP_MS = 60_000;

export interface DocEntry {
	path: string;
	mode: InkMode;
	doc: InkDocument;
	refs: number;
}

interface Internal extends DocEntry {
	savedRevision: number;
	/** Our own write echoes back as a `modify` event; it is ignored until then. */
	selfWriteUntil: number;
	warm: number;
	lastWritten: string | null;
	timer: number;
	firstDirtyAt: number;
	idleTimer: number;
	saving: Promise<void> | null;
	busyCheckers: Set<() => boolean>;
	listeners: Set<() => void>;
}

export class DocStore {
	private entries = new Map<string, Internal>();
	private loading = new Map<string, Promise<Internal>>();

	constructor(private app: App) {}

	async acquire(file: TFile, mode: InkMode, gridDefault: boolean): Promise<DocEntry> {
		const existing = this.entries.get(file.path);
		if (existing) {
			window.clearTimeout(existing.idleTimer);
			existing.refs++;
			return existing;
		}
		let pending = this.loading.get(file.path);
		if (!pending) {
			pending = this.load(file, mode, gridDefault);
			this.loading.set(file.path, pending);
		}
		try {
			const entry = await pending;
			window.clearTimeout(entry.idleTimer);
			entry.refs++;
			return entry;
		} finally {
			this.loading.delete(file.path);
		}
	}

	private async load(file: TFile, mode: InkMode, gridDefault: boolean): Promise<Internal> {
		const text = await this.app.vault.cachedRead(file);
		const snapshot = text.trim() ? parseInkFile(text, mode) : emptySnapshot(mode, gridDefault);
		const { strokes, ...rest } = snapshot;
		const entry: Internal = {
			path: file.path,
			mode,
			doc: new InkDocument(rest, strokes),
			refs: 0,
			savedRevision: 0,
			selfWriteUntil: 0,
			warm: 0,
			lastWritten: text,
			timer: 0,
			firstDirtyAt: 0,
			idleTimer: 0,
			saving: null,
			busyCheckers: new Set(),
			listeners: new Set(),
		};
		entry.doc.onChange(() => this.schedule(entry));
		this.entries.set(file.path, entry);
		return entry;
	}

	release(entry: DocEntry): void {
		const e = this.entries.get(entry.path);
		if (!e) return;
		e.refs = Math.max(0, e.refs - 1);
		if (e.refs > 0) return;
		void this.flush(e.path);
		window.clearTimeout(e.idleTimer);
		e.idleTimer = window.setTimeout(() => {
			if (e.refs === 0 && !e.timer && !e.saving) this.entries.delete(e.path);
		}, IDLE_KEEP_MS);
	}

	/** A surface reports whether its pen is down; saves wait while any is busy. */
	addBusyCheck(entry: DocEntry, check: () => boolean): () => void {
		const e = this.entries.get(entry.path);
		if (!e) return () => undefined;
		e.busyCheckers.add(check);
		return () => e.busyCheckers.delete(check);
	}

	/** The file became a writing section or a drawing: it is serialised as such from now on. */
	setMode(entry: DocEntry, mode: InkMode): void {
		const e = this.entries.get(entry.path);
		if (e) e.mode = mode;
	}

	/** Files this plugin may write to (anything else opens read-only). */
	isWritable(path: string): boolean {
		return path.toLowerCase().endsWith('.svg');
	}

	isDirty(path: string): boolean {
		const e = this.entries.get(path);
		return !!e && e.doc.revision !== e.savedRevision;
	}

	private schedule(e: Internal): void {
		if (e.doc.revision === e.savedRevision) return;
		const now = Date.now();
		if (!e.timer) e.firstDirtyAt = now;
		window.clearTimeout(e.timer);
		const wait = Math.min(SAVE_DELAY_MS, Math.max(0, e.firstDirtyAt + SAVE_MAX_WAIT_MS - now));
		e.timer = window.setTimeout(() => this.timedSave(e), wait);
	}

	private timedSave(e: Internal): void {
		if ([...e.busyCheckers].some(c => c())) {
			e.timer = window.setTimeout(() => this.timedSave(e), BUSY_RETRY_MS);
			return;
		}
		e.timer = 0;
		void this.write(e);
	}

	/** Saves now if there is anything unsaved (lock, close, unload). */
	async flush(path: string): Promise<void> {
		const e = this.entries.get(path);
		if (!e) return;
		window.clearTimeout(e.timer);
		e.timer = 0;
		await this.write(e);
	}

	async flushAll(): Promise<void> {
		await Promise.all([...this.entries.keys()].map(p => this.flush(p)));
	}

	private async write(e: Internal): Promise<void> {
		if (e.saving) await e.saving;
		if (e.doc.revision === e.savedRevision) return;
		const revision = e.doc.revision;
		const text = serializeInkFile(e.doc.toSnapshot(), e.mode, WRITING_PAGE_WIDTH);
		e.saving = (async () => {
			const file = this.app.vault.getAbstractFileByPath(e.path);
			// Pre-0.5 files (.writing/.drawing) are shown, never overwritten with SVG.
			if (!(file instanceof TFile) || file.extension !== 'svg') {
				e.savedRevision = revision;
				return;
			}
			e.lastWritten = text;
			e.selfWriteUntil = Date.now() + 3000;
			await this.app.vault.modify(file, text);
			e.savedRevision = revision;
		})();
		try {
			await e.saving;
		} finally {
			e.saving = null;
		}
		if (e.doc.revision !== e.savedRevision) this.schedule(e);
	}

	/** The file changed on disk (sync, another device, git): reload unless it is our own write. */
	async onFileModified(file: TFile): Promise<void> {
		const e = this.entries.get(file.path);
		if (!e || e.saving) return;
		if (Date.now() < e.selfWriteUntil && e.lastWritten !== null && file.stat.size === utf8Length(e.lastWritten)) return;
		const text = await this.app.vault.read(file);
		if (text === e.lastWritten) return;
		if (e.doc.revision !== e.savedRevision) return; // unsaved local work wins; it is saved next
		let snapshot: InkCanvasSnapshot;
		try {
			snapshot = parseInkFile(text);
		} catch {
			return;
		}
		e.lastWritten = text;
		const { strokes, ...rest } = snapshot;
		e.doc.snapshot = rest;
		e.doc.reset(strokes);
		e.savedRevision = e.doc.revision;
	}

	onFileRenamed(file: TFile, oldPath: string): void {
		const e = this.entries.get(oldPath);
		if (!e) return;
		this.entries.delete(oldPath);
		e.path = file.path;
		this.entries.set(file.path, e);
	}

	/**
	 * Builds the per-stroke save caches (SVG path, JSON) in idle slices once a file is being
	 * edited, so the first save never lands on the pen as one long task.
	 */
	warmSaveCaches(entry: DocEntry): void {
		const e = this.entries.get(entry.path);
		if (!e || e.warm) return;
		const strokes = [...e.doc.strokes];
		let i = 0;
		const idle = (cb: (d: IdleDeadline) => void) => (window.requestIdleCallback ?? ((f: (d: IdleDeadline) => void) => window.setTimeout(() => f({ timeRemaining: () => 8, didTimeout: false } as IdleDeadline), 16)))(cb);
		const step = (d: IdleDeadline) => {
			while (i < strokes.length && d.timeRemaining() > 2) warmStroke(strokes[i++]);
			if (i < strokes.length) e.warm = idle(step);
		};
		e.warm = idle(step);
	}

	/** Marks the snapshot-level fields (grid, theme) changed so they get saved. */
	touch(entry: DocEntry): void {
		const e = this.entries.get(entry.path);
		if (!e) return;
		e.doc.revision++;
		this.schedule(e);
	}
}

function utf8Length(s: string): number {
	let n = 0;
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		if (c < 0x80) n += 1;
		else if (c < 0x800) n += 2;
		else if (c >= 0xd800 && c <= 0xdbff) { n += 4; i++; }
		else n += 3;
	}
	return n;
}
