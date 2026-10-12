// Offscreen bench: never shows a window. Usage: electron main.cjs <ink.svg>
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.whenReady().then(async () => {
	const file = process.argv[process.argv.length - 1];
	const text = fs.readFileSync(file, 'utf8');
	const W = 900, H = 700;
	const win = new BrowserWindow({ show: false, width: W, height: H, webPreferences: { offscreen: true, backgroundThrottling: false } });
	await win.loadFile(path.join(__dirname, 'index.html'));
	const wc = win.webContents;
	wc.setFrameRate(60);
	wc.on('paint', () => undefined);
	wc.startPainting();
	wc.debugger.attach('1.3');
	const cdp = (m, p) => wc.debugger.sendCommand(m, p);
	await cdp('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1.25, mobile: false });
	await cdp('Emulation.setFocusEmulationEnabled', { enabled: true });
	const ev = js => wc.executeJavaScript(js);
	const setup = JSON.parse(await ev(`benchSetup(${JSON.stringify(text)}, 'drawing', ${W}, ${H})`));
	console.log('setup', setup);
	const sleep = ms => new Promise(r => setTimeout(r, ms));
	const pen = (type, x, y, force, buttons) => cdp('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons, clickCount: type === 'mouseMoved' ? 0 : 1, pointerType: 'pen', force });

	async function stroke(x0, y0, n, dx, dy, wobble) {
		await pen('mousePressed', x0, y0, 0.4, 1);
		for (let i = 1; i <= n; i++) {
			const x = x0 + dx * i + Math.sin(i / 3) * wobble;
			const y = y0 + dy * i + Math.cos(i / 4) * wobble;
			await pen('mouseMoved', x, y, 0.3 + 0.4 * Math.abs(Math.sin(i / 10)), 1);
			await sleep(8); // ~120 Hz digitizer
		}
		await pen('mouseReleased', x0 + dx * n, y0 + dy * n, 0, 0);
	}

	await sleep(300);
	await ev('bench.reset()');
	// 40 handwriting-like strokes across the page.
	for (let s = 0; s < 40; s++) await stroke(80 + (s % 8) * 95, 120 + Math.floor(s / 8) * 100, 45, 1.6, 0.2, 9);
	await sleep(200);
	console.log('draw', JSON.parse(await ev('bench.stats()')));

	console.log('save first (ms)', (await ev(`bench.time('save')`)).toFixed(2));
	await ev(`bench.time('save')`);
	console.log('save again (ms)', (await ev(`bench.time('save2')`)).toFixed(2));
	console.log('full repaint (ms)', (await ev(`bench.time('fullPaint')`)).toFixed(2));
	console.log('undo (ms)', (await ev(`bench.time('undo')`)).toFixed(2));

	await ev(`bench.setTool('erase')`);
	await ev('bench.reset()');
	for (let s = 0; s < 6; s++) await stroke(100, 150 + s * 80, 60, 11, 0.5, 2);
	await sleep(200);
	console.log('erase', JSON.parse(await ev('bench.stats()')));

	await ev(`bench.setTool('pan')`);
	await ev('bench.reset()');
	for (let s = 0; s < 3; s++) await stroke(400, 300, 60, 3, 2, 0);
	await sleep(300);
	console.log('pan', JSON.parse(await ev('bench.stats()')));
	console.log('heap MB', ((await ev('bench.heap()')) / 1e6).toFixed(1));
	app.quit();
});
