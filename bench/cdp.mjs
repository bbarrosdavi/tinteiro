// Tiny CDP client for the test Obsidian (port 9333). Usage: node cdp.mjs <script.mjs>
// The script default-exports async (c) => {...} with c.eval, c.send, c.shot, c.pen, c.sleep.
import fs from 'fs';
const targets = await (await fetch('http://127.0.0.1:9333/json')).json();
const page = targets.find(t => t.type === 'page' && t.url.startsWith('app://obsidian.md'));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
let id = 0;
const pending = new Map();
ws.addEventListener('message', ev => {
	const msg = JSON.parse(ev.data);
	if (msg.id && pending.has(msg.id)) {
		const { resolve, reject } = pending.get(msg.id);
		pending.delete(msg.id);
		msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
	}
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
	const i = ++id;
	pending.set(i, { resolve, reject });
	ws.send(JSON.stringify({ id: i, method, params }));
});
const c = {
	send,
	sleep: ms => new Promise(r => setTimeout(r, ms)),
	async eval(expr) {
		const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
		if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
		return r.result.value;
	},
	async shot(path, clip) {
		const r = await send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: 1 } } : {}) });
		fs.writeFileSync(path, Buffer.from(r.data, 'base64'));
	},
	pen(type, x, y, force = 0.5, buttons = 1) {
		return send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons, clickCount: type === 'mouseMoved' ? 0 : 1, pointerType: 'pen', force });
	},
	mouse(type, x, y, button = 'left', buttons = 1, modifiers = 0) {
		return send('Input.dispatchMouseEvent', { type, x, y, button, buttons, clickCount: type === 'mouseMoved' ? 0 : 1, modifiers });
	},
	async stroke(x0, y0, n, dx, dy, wobble = 0, hz = 120) {
		await c.pen('mousePressed', x0, y0, 0.4, 1);
		for (let i = 1; i <= n; i++) {
			await c.pen('mouseMoved', x0 + dx * i + Math.sin(i / 3) * wobble, y0 + dy * i + Math.cos(i / 4) * wobble, 0.3 + 0.4 * Math.abs(Math.sin(i / 10)), 1);
			await c.sleep(1000 / hz);
		}
		await c.pen('mouseReleased', x0 + dx * n, y0 + dy * n, 0, 0);
	},
};
const mod = await import(new URL(process.argv[2], `file://${process.cwd()}/`).href);
try {
	const out = await mod.default(c);
	if (out !== undefined) console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 1));
} finally {
	ws.close();
}
