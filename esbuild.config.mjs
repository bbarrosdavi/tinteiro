import esbuild from 'esbuild';
import fs from 'fs';

const prod = process.argv[2] === 'production';

const copyStatic = {
	name: 'copy-static',
	setup(build) {
		build.onEnd(() => {
			fs.mkdirSync('dist', { recursive: true });
			fs.copyFileSync('manifest.json', 'dist/manifest.json');
			fs.copyFileSync('src/styles.css', 'dist/styles.css');
		});
	},
};

const ctx = await esbuild.context({
	entryPoints: ['src/main.ts'],
	bundle: true,
	external: ['obsidian', 'electron', '@codemirror/*', '@lezer/*'],
	format: 'cjs',
	target: 'es2022',
	logLevel: 'info',
	sourcemap: prod ? false : 'inline',
	minify: prod,
	treeShaking: true,
	outfile: 'dist/main.js',
	plugins: [copyStatic],
});

if (prod) {
	await ctx.rebuild();
	process.exit(0);
} else {
	await ctx.watch();
}
