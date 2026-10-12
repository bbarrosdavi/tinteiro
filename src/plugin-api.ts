import type { App, TFile } from 'obsidian';
import type { InkSettings } from './settings';
import type { DocStore } from './embed/doc-store';
import type { InkStroke, InkMode } from './model/types';

/** What embeds and views need from the plugin; keeps them free of a hard import cycle. */
export interface InkHost {
	app: App;
	settings: InkSettings;
	docs: DocStore;
	updateSettings(patch: Partial<InkSettings>): void;
	onSettingsChange(listener: () => void): () => void;
	/** The surface keys and paste go to. */
	setActiveSurface(surface: ActiveSurface | null): void;
	activeSurface(): ActiveSurface | null;
	strokeClipboard: InkStroke[];
	copyStrokes(strokes: InkStroke[]): void;
	openFullView(file: TFile, mode: InkMode): Promise<void>;
	pickInkFile(mode: InkMode): Promise<TFile | null>;
	duplicateInkFile(file: TFile, mode: InkMode, sourcePath: string): Promise<TFile>;
}

export interface ActiveSurface {
	undo(): boolean;
	redo(): boolean;
	canUndo(): boolean;
	deleteSelection(): boolean;
	copySelection(): boolean;
	pasteFromClipboard(e: ClipboardEvent | KeyboardEvent): Promise<boolean>;
	modifierDown(): void;
	modifierCancel(): void;
	selectAll(): void;
	escape(): boolean;
	/** True when the pointer is over this surface (Delete and paste only act then). */
	isHovered(): boolean;
	isAttached(): boolean;
}
