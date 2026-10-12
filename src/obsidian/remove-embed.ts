import { Modal, Notice, TFile, type App } from 'obsidian';
import type { InkMode } from '../model/types';

/**
 * Deleting an embed, as Ink did: when the file shows up elsewhere in the vault only this embed
 * goes; when this is its only embed, the user chooses between keeping the file and sending it
 * to the trash (Obsidian's own trash setting decides where it goes).
 */

/** How many embeds of this file the vault has, from Obsidian's link index (no file reads). */
export function embedCount(app: App, file: TFile): number {
	let n = 0;
	const links = app.metadataCache.resolvedLinks;
	for (const source in links) n += links[source][file.path] ?? 0;
	return n;
}

class RemoveEmbedModal extends Modal {
	constructor(app: App, private mode: InkMode, private onlyEmbed: () => void, private embedAndFile: () => void) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText('Apagar embed');
		const what = this.mode === 'drawing' ? 'Este desenho' : 'Esta escrita';
		this.contentEl.createEl('p', { text: `${what} só aparece nesta nota. Apagar só o embed, ou também o arquivo?` });
		const row = this.contentEl.createDiv({ cls: 'modal-button-container' });
		row.createEl('button', { text: 'Cancelar' }).addEventListener('click', () => this.close());
		const both = row.createEl('button', { cls: 'mod-warning', text: 'Apagar embed e arquivo' });
		both.addEventListener('click', () => {
			this.close();
			this.embedAndFile();
		});
		const only = row.createEl('button', { cls: 'mod-cta', text: 'Apagar só o embed' });
		only.addEventListener('click', () => {
			this.close();
			this.onlyEmbed();
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

export function removeEmbedFlow(app: App, file: TFile | null, mode: InkMode, removeEmbed: () => void): void {
	if (!file) {
		removeEmbed();
		return;
	}
	const count = embedCount(app, file);
	if (count > 1) {
		removeEmbed();
		new Notice(`Embed apagado. O arquivo continua em ${count - 1} ${count - 1 === 1 ? 'outro embed' : 'outros embeds'}.`);
		return;
	}
	new RemoveEmbedModal(app, mode, removeEmbed, () => {
		removeEmbed();
		void app.fileManager.trashFile(file).catch(err => new Notice('Não foi possível apagar o arquivo: ' + String(err)));
	}).open();
}
