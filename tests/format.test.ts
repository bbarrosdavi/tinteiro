import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { parseInkFile, serializeInkFile } from '../src/model/format';
import { WRITING_PAGE_WIDTH } from '../src/model/constants';

const VAULT = join(homedir(), 'Documentos/Obsidian_Vaults/megabrain');

function inkFiles(dir: string, out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		if (name.startsWith('.')) continue;
		const p = join(dir, name);
		const st = statSync(p);
		if (st.isDirectory()) inkFiles(p, out);
		else if (name.endsWith('.svg') && p.includes('/Ink/')) out.push(p);
	}
	return out;
}

// Runs against a real vault when there is one on this machine (TINTEIRO_VAULT overrides the path).
const ROOT = process.env.TINTEIRO_VAULT ?? VAULT;
describe.skipIf(!existsSync(ROOT))('format round trip on the vault files', () => {
	const files = existsSync(ROOT) ? inkFiles(ROOT) : [];
	it('finds the files', () => expect(files.length).toBeGreaterThan(0));
	let before = 0, after = 0;
	for (const f of files) {
		it(f.split('/Ink/')[1], () => {
			const text = readFileSync(f, 'utf8');
			const snap = parseInkFile(text);
			const mode = f.includes('/Writing/') ? 'writing' : 'drawing';
			const out = serializeInkFile(snap, mode, WRITING_PAGE_WIDTH);
			const again = parseInkFile(out);
			expect(again.strokes.length).toBe(snap.strokes.length);
			for (let i = 0; i < snap.strokes.length; i++) {
				const a = snap.strokes[i], b = again.strokes[i];
				expect(b.id).toBe(a.id);
				expect(b.points.length).toBe(a.points.length);
				for (let j = 0; j < a.points.length; j++) {
					expect(Math.abs(b.points[j][0] - a.points[j][0])).toBeLessThanOrEqual(0.005 + 1e-9);
					expect(Math.abs(b.points[j][2] - a.points[j][2])).toBeLessThanOrEqual(0.0005 + 1e-9);
				}
				expect(b.image?.src).toBe(a.image?.src);
			}
			expect(again.gridEnabled).toBe(snap.gridEnabled);
			expect(again.canvasTheme).toBe(snap.canvasTheme);
			before += text.length;
			after += out.length;
		});
	}
	it('is smaller', () => {
		console.log(`total ${(before / 1e6).toFixed(2)} MB -> ${(after / 1e6).toFixed(2)} MB (${(100 - (after / before) * 100).toFixed(1)}% less)`);
		expect(after).toBeLessThan(before);
	});
});
