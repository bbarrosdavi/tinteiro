import { FuzzySuggestModal, normalizePath, TFile, type App } from 'obsidian';
import type { InkMode } from '../model/types';
import { DEFAULT_SETTINGS, type InkSettings } from '../settings';
import { emptySnapshot, serializeInkFile } from '../model/format';
import { WRITING_PAGE_WIDTH } from '../model/constants';

/** `2026.10.11 - 22.57pm`, the name Ink always gave new files. */
export function dateFilename(date = new Date()): string {
	const minutes = String(date.getMinutes()).padStart(2, '0');
	const suffix = date.getHours() < 12 ? 'am' : 'pm';
	return `${date.getFullYear()}.${date.getMonth() + 1}.${date.getDate()} - ${date.getHours()}.${minutes}${suffix}`;
}

function dirname(path: string): string {
	const i = path.lastIndexOf('/');
	return i < 0 ? '' : path.slice(0, i);
}

async function obsidianAttachmentFolder(app: App, notePath: string): Promise<string> {
	try {
		const p = await app.fileManager.getAvailablePathForAttachment('ink.svg', notePath);
		return dirname(p);
	} catch {
		return '';
	}
}

export async function inkFolderFor(app: App, settings: InkSettings, mode: InkMode, notePath: string | null): Promise<string> {
	const custom = settings.customAttachmentFolders;
	const location = notePath
		? (custom ? settings.noteAttachmentFolderLocation : DEFAULT_SETTINGS.noteAttachmentFolderLocation)
		: (custom ? settings.notelessAttachmentFolderLocation : DEFAULT_SETTINGS.notelessAttachmentFolderLocation);
	let base = '';
	if (location === 'obsidian') base = await obsidianAttachmentFolder(app, notePath ?? '');
	else if (location === 'note' && notePath) base = dirname(notePath);
	const sub = (custom
		? (mode === 'writing' ? settings.writingSubfolder : settings.drawingSubfolder)
		: (mode === 'writing' ? DEFAULT_SETTINGS.writingSubfolder : DEFAULT_SETTINGS.drawingSubfolder)).trim();
	return normalizePath([base, sub].filter(Boolean).join('/'));
}

async function ensureFolder(app: App, folder: string): Promise<void> {
	if (!folder || folder === '/') return;
	if (app.vault.getAbstractFileByPath(folder)) return;
	await app.vault.createFolder(folder).catch(() => undefined);
}

async function availablePath(app: App, folder: string, name: string): Promise<string> {
	let path = normalizePath(`${folder ? folder + '/' : ''}${name}.svg`);
	let n = 1;
	while (app.vault.getAbstractFileByPath(path)) {
		path = normalizePath(`${folder ? folder + '/' : ''}${name} (${n++}).svg`);
	}
	return path;
}

export async function createInkFile(app: App, settings: InkSettings, mode: InkMode, notePath: string | null): Promise<TFile> {
	const folder = await inkFolderFor(app, settings, mode, notePath);
	await ensureFolder(app, folder);
	const path = await availablePath(app, folder, dateFilename());
	const snapshot = emptySnapshot(mode, settings.drawingGridEnabledByDefault);
	if (mode === 'writing') snapshot.writingLineHeight = settings.writingLineHeight;
	return app.vault.create(path, serializeInkFile(snapshot, mode, WRITING_PAGE_WIDTH));
}

export async function duplicateInkFile(app: App, settings: InkSettings, file: TFile, mode: InkMode, notePath: string): Promise<TFile> {
	const folder = await inkFolderFor(app, settings, mode, notePath);
	await ensureFolder(app, folder);
	const path = await availablePath(app, folder, dateFilename());
	return app.vault.copy(file, path);
}

/** Link path written into the note: vault-relative, as Ink did. */
export function linkPathFor(file: TFile): string {
	return file.path;
}

class InkFilePicker extends FuzzySuggestModal<TFile> {
	private done = false;
	constructor(app: App, private files: TFile[], private resolve: (f: TFile | null) => void) {
		super(app);
		this.setPlaceholder('Escolha um arquivo de tinta');
	}

	getItems(): TFile[] {
		return this.files;
	}

	getItemText(file: TFile): string {
		return file.path;
	}

	onChooseItem(file: TFile): void {
		this.done = true;
		this.resolve(file);
	}

	onClose(): void {
		// onChooseItem runs after onClose; wait a tick before reporting a cancel.
		window.setTimeout(() => {
			if (!this.done) this.resolve(null);
		}, 0);
	}
}

export function pickInkFile(app: App, mode: InkMode): Promise<TFile | null> {
	const folderHint = mode === 'writing' ? '/Writing/' : '/Drawing/';
	const recent = app.vault.getFiles()
		.filter(f => f.extension === 'svg' && f.path.includes('Ink'))
		.sort((a, b) => {
			const am = a.path.includes(folderHint) ? 1 : 0;
			const bm = b.path.includes(folderHint) ? 1 : 0;
			return bm - am || b.stat.mtime - a.stat.mtime;
		});
	return new Promise(resolve => new InkFilePicker(app, recent, resolve).open());
}
