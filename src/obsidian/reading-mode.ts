import { MarkdownRenderChild, TFile, type MarkdownPostProcessorContext } from 'obsidian';
import type { InkHost } from '../plugin-api';
import { InkEmbed } from '../embed/ink-embed';
import { buildEmbedMarkdown, findEmbeds, parseParams, type EmbedMatch } from './embed-syntax';
import type { InkMode } from '../model/types';

/**
 * Reading view: the embeds are full editors here too, so a note can be written on without
 * its text ever being in edit mode. The source line of each section gives the exact path and
 * settings; the rendered image and link are only used to find where to put the embed.
 */

const ALT: Record<InkMode, string> = { drawing: 'InkDrawing', writing: 'InkWriting' };

class EmbedChild extends MarkdownRenderChild {
	constructor(el: HTMLElement, private embed: InkEmbed) {
		super(el);
	}

	onload(): void {
		requestAnimationFrame(() => this.embed.mount());
	}

	onunload(): void {
		this.embed.dispose();
	}
}

export function readingModeProcessor(host: InkHost) {
	return (el: HTMLElement, ctx: MarkdownPostProcessorContext): void => {
		const markers = el.querySelectorAll<HTMLElement>('img[alt="InkDrawing"], img[alt="InkWriting"], .internal-embed[alt="InkDrawing"], .internal-embed[alt="InkWriting"]');
		if (!markers.length) return;

		const info = ctx.getSectionInfo(el);
		const sourceMatches: EmbedMatch[] = info ? findEmbeds(info.text.split('\n').slice(info.lineStart, info.lineEnd + 1).join('\n')) : [];
		const seen = new Set<HTMLElement>();
		let index = 0;
		for (const marker of Array.from(markers)) {
			const embedEl = marker.closest<HTMLElement>('.internal-embed') ?? marker;
			if (seen.has(embedEl) || embedEl.closest('.inkf-host')) continue;
			seen.add(embedEl);
			const mode: InkMode = marker.getAttribute('alt') === ALT.writing ? 'writing' : 'drawing';
			const block = embedEl.closest('p, .el-p, li, blockquote, .callout-content') as HTMLElement | null ?? embedEl.parentElement;
			const link = block?.querySelector<HTMLAnchorElement>(`a[href*="type=ink${mode === 'drawing' ? 'Drawing' : 'Writing'}"]`) ?? null;

			const fromSource = sourceMatches[index++];
			const linkPath = fromSource?.path ?? pathFromSrc(host, embedEl, ctx.sourcePath);
			if (!linkPath) continue;
			const params = fromSource?.params ?? parseParams(link?.getAttribute('href') ?? '');

			const embed = new InkEmbed({
				host,
				mode,
				linkPath,
				sourcePath: ctx.sourcePath,
				params,
				rewrite: update => void rewriteInFile(host, ctx.sourcePath, linkPath, mode, update),
				remove: () => void removeFromFile(host, ctx.sourcePath, linkPath, mode),
			});
			embedEl.replaceWith(embed.el);
			link?.remove();
			// Drop the space and line break the link left behind.
			if (block && !block.textContent?.trim() && block.childElementCount === 1) block.classList.add('inkf-block');
			ctx.addChild(new EmbedChild(embed.el, embed));
		}
	};
}

function pathFromSrc(host: InkHost, el: HTMLElement, sourcePath: string): string | null {
	const src = el.getAttribute('src');
	if (!src) return null;
	if (!/^(app|capacitor|https?):/.test(src)) {
		const f = host.app.metadataCache.getFirstLinkpathDest(decodeURIComponent(src), sourcePath);
		return f?.path ?? decodeURIComponent(src);
	}
	// app://<id>/<absolute path>?<mtime>
	const basePath = (host.app.vault.adapter as unknown as { basePath?: string }).basePath ?? '';
	try {
		const url = new URL(src);
		const abs = decodeURIComponent(url.pathname);
		const i = abs.indexOf(basePath);
		if (basePath && i >= 0) return abs.slice(i + basePath.length).replace(/^\/+/, '');
	} catch {
		// Not a URL.
	}
	return null;
}

/** Takes the embed (and its line, when nothing else is on it) out of the note. */
async function removeFromFile(host: InkHost, notePath: string, linkPath: string, mode: InkMode): Promise<void> {
	const note = host.app.vault.getAbstractFileByPath(notePath);
	if (!(note instanceof TFile)) return;
	await host.app.vault.process(note, text => {
		const m = findEmbeds(text).find(x => x.path === linkPath && x.mode === mode);
		if (!m) return text;
		const lineStart = text.lastIndexOf('\n', m.from - 1) + 1;
		const nl = text.indexOf('\n', m.to);
		const lineEnd = nl < 0 ? text.length : nl;
		const rest = (text.slice(lineStart, m.from) + text.slice(m.to, lineEnd)).trim();
		if (rest) return text.slice(0, m.from) + text.slice(m.to);
		return text.slice(0, lineStart) + text.slice(nl < 0 ? lineEnd : lineEnd + 1);
	});
}

/** Reading view has no editor: the note file is edited directly, one embed line at a time. */
async function rewriteInFile(
	host: InkHost,
	notePath: string,
	linkPath: string,
	mode: InkMode,
	update: { params?: import('./embed-syntax').EmbedParams; path?: string; mode?: InkMode },
): Promise<void> {
	const note = host.app.vault.getAbstractFileByPath(notePath);
	if (!(note instanceof TFile)) return;
	await host.app.vault.process(note, text => {
		const matches = findEmbeds(text);
		const m = matches.find(x => x.path === linkPath && x.mode === mode);
		if (!m) return text;
		const md = buildEmbedMarkdown(update.mode ?? m.mode, update.path ?? m.path, update.params ?? m.params);
		return text.slice(0, m.from) + md + text.slice(m.to);
	});
}
