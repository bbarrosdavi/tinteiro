import type { CameraState, InkStroke, PageRect } from '../model/types';
import { strokeNodes, computeNodes } from '../geom/capsules';
import { approxStrokeBounds } from '../geom/bounds';
import { isThemeAdaptiveColor } from '../geom/ink-colors';
import { imageStrokeRect, isImageStroke } from '../geom/ink-images';
import { resolveSpacing, type InkLayout } from '../geom/background-layouts';

/**
 * Ink on the GPU. One WebGL2 context for the whole plugin draws into an OffscreenCanvas and
 * hands each surface an ImageBitmap (no copy), so a note full of drawings never runs into the
 * browser's limit on live WebGL contexts.
 *
 * A stroke is a chain of capsules (see geom/capsules). Every capsule is one instance of a quad
 * whose fragment shader evaluates the capsule's distance field, so edges are anti-aliased
 * analytically and stay sharp at any zoom. Consecutive strokes of one opaque colour form a run:
 * the run's capsules are drawn into a coverage buffer with MAX blending (their exact union) and
 * the buffer is laid on the page in one pass. A translucent stroke is a run of its own, so it
 * never darkens itself where its capsules overlap but does darken the strokes under it, as
 * pencil should. A whole page is a few dozen draw calls: repainting it every frame costs less
 * than a millisecond, which is what lets pan and zoom repaint instead of caching bitmaps.
 */

export interface GlPalette {
	ink: string;
	rule: string;
}

export interface GlBackground {
	layout: InkLayout;
	lineHeight: number;
	pageWidth?: number;
	pageHeight?: number;
	mode: 'writing' | 'drawing';
	/** Dot spacing multiplier (dotted paper only). */
	dotScale?: number;
}

export interface GlScene {
	camera: CameraState;
	dpr: number;
	palette: GlPalette;
	background: GlBackground | null;
	/** Identity of the stroke list's owner (the document), for the GPU buffer cache. */
	docKey: object;
	strokes: readonly InkStroke[];
	hidden: ReadonlySet<InkStroke>;
	/** Strokes drawn shifted (a selection being dragged). */
	floating: { strokes: InkStroke[]; dx: number; dy: number } | null;
	/** Transient strokes on top (the stroke under the pen, a figure preview, a resized image). */
	live: InkStroke[];
}

const STRIDE = 6; // ax, ay, ar, bx, by, br

const CAPSULE_VS = `#version 300 es
layout(location=0) in vec2 a_corner;
layout(location=1) in vec3 a_n0;
layout(location=2) in vec3 a_n1;
uniform vec3 u_cam;
uniform vec2 u_size;
uniform vec2 u_shift;
uniform float u_aa;
out vec2 v_p;
flat out vec3 v_a;
flat out vec3 v_b;
void main() {
	vec2 a = a_n0.xy + u_shift;
	vec2 b = a_n1.xy + u_shift;
	float ra = a_n0.z, rb = a_n1.z;
	vec2 d = b - a;
	float l = length(d);
	vec2 dir = l > 1e-6 ? d / l : vec2(1.0, 0.0);
	vec2 nrm = vec2(-dir.y, dir.x);
	float pad = u_aa * 1.5;
	float rm = max(ra, rb) + pad;
	float s = mix(-(ra + pad), l + rb + pad, a_corner.x);
	float t = mix(-rm, rm, a_corner.y);
	vec2 p = a + dir * s + nrm * t;
	v_p = p;
	v_a = vec3(a, ra);
	v_b = vec3(b, rb);
	vec2 dev = (p + u_cam.xy) * u_cam.z;
	gl_Position = vec4(dev.x / u_size.x * 2.0 - 1.0, 1.0 - dev.y / u_size.y * 2.0, 0.0, 1.0);
}`;

const CAPSULE_FS = `#version 300 es
precision highp float;
in vec2 v_p;
flat in vec3 v_a;
flat in vec3 v_b;
uniform float u_aa;
out vec4 o;
float cro(vec2 a, vec2 b) { return a.x * b.y - a.y * b.x; }
float sdCapsule(vec2 p, vec2 pa, vec2 pb, float ra, float rb) {
	p -= pa; pb -= pa;
	float h = dot(pb, pb);
	float b = ra - rb;
	if (h <= b * b + 1e-6) return min(length(p) - ra, length(p - pb) - rb);
	vec2 q = vec2(dot(p, vec2(pb.y, -pb.x)), dot(p, pb)) / h;
	q.x = abs(q.x);
	vec2 c = vec2(sqrt(h - b * b), b);
	float k = cro(c, q);
	float m = dot(c, q);
	float n = dot(q, q);
	if (k < 0.0) return sqrt(h * n) - ra;
	if (k > c.x) return sqrt(h * (n + 1.0 - 2.0 * q.y)) - rb;
	return m - ra;
}
void main() {
	float d = sdCapsule(v_p, v_a.xy, v_b.xy, v_a.z, v_b.z);
	float c = clamp(0.5 - d / u_aa, 0.0, 1.0);
	if (c <= 0.0) discard;
	o = vec4(c);
}`;

const QUAD_VS = `#version 300 es
layout(location=0) in vec2 a_corner;
uniform vec4 u_rect;
uniform vec2 u_size;
out vec2 v_uv;
void main() {
	vec2 dev = u_rect.xy + a_corner * u_rect.zw;
	v_uv = a_corner;
	gl_Position = vec4(dev.x / u_size.x * 2.0 - 1.0, 1.0 - dev.y / u_size.y * 2.0, 0.0, 1.0);
}`;

const COMPOSITE_FS = `#version 300 es
precision highp float;
uniform sampler2D u_cov;
uniform vec4 u_color;
out vec4 o;
void main() {
	float c = texelFetch(u_cov, ivec2(gl_FragCoord.xy), 0).r;
	o = u_color * c;
}`;

const IMAGE_FS = `#version 300 es
precision highp float;
uniform sampler2D u_tex;
in vec2 v_uv;
out vec4 o;
void main() { o = texture(u_tex, v_uv); }`;

const PAPER_FS = `#version 300 es
precision highp float;
uniform vec3 u_cam;
uniform vec2 u_size;
uniform vec4 u_color;
uniform int u_kind;        // 1 dots, 2 horizontal rules, 3 grid, 4 isometric
uniform float u_spacing;
uniform float u_dot;       // dot radius, device px
uniform float u_line;      // line width, device px
uniform vec4 u_clip;       // page rect the paper is limited to (minX, minY, maxX, maxY)
uniform float u_skipTop;   // 1: no rule at y = 0
out vec4 o;
float lineCov(float v, float s, float k) {
	float d = abs(v - floor(v / s + 0.5) * s) * k;
	return clamp(u_line * 0.5 + 0.5 - d, 0.0, 1.0);
}
void main() {
	vec2 dev = vec2(gl_FragCoord.x, u_size.y - gl_FragCoord.y);
	float k = u_cam.z;
	vec2 p = dev / k - u_cam.xy;
	if (p.x < u_clip.x || p.y < u_clip.y || p.x > u_clip.z || p.y > u_clip.w) discard;
	float s = u_spacing;
	float c = 0.0;
	if (u_kind == 1) {
		vec2 g = floor(p / s + 0.5) * s;
		c = clamp(u_dot + 0.5 - length(p - g) * k, 0.0, 1.0);
	} else if (u_kind == 2 || u_kind == 3) {
		c = lineCov(p.y, s, k);
		if (u_skipTop > 0.5 && abs(p.y) * k < u_line + 1.0) c = 0.0;
		if (u_kind == 3) c = max(c, lineCov(p.x, s, k));
	} else if (u_kind == 4) {
		const float C30 = 0.8660254;
		const float T30 = 0.5773503;
		float step = s / C30;
		c = lineCov(p.x, s, k);
		c = max(c, lineCov(p.y - T30 * p.x, step, k * C30));
		c = max(c, lineCov(p.y + T30 * p.x, step, k * C30));
	}
	if (c <= 0.0) discard;
	o = u_color * c;
}`;

interface DocBuffer {
	strokes: readonly InkStroke[];
	buffer: WebGLBuffer;
	capacity: number;
	/** Instance start and count per stroke, aligned with `strokes`. */
	starts: Int32Array;
	counts: Int32Array;
}

interface Program {
	prog: WebGLProgram;
	u: Record<string, WebGLUniformLocation | null>;
}

function parseColor(css: string, cache: Map<string, [number, number, number]>): [number, number, number] {
	let c = cache.get(css);
	if (c) return c;
	let r = 0, g = 0, b = 0;
	const hex = css.trim();
	if (/^#[0-9a-f]{6}$/i.test(hex)) {
		r = parseInt(hex.slice(1, 3), 16); g = parseInt(hex.slice(3, 5), 16); b = parseInt(hex.slice(5, 7), 16);
	} else if (/^#[0-9a-f]{3}$/i.test(hex)) {
		r = parseInt(hex[1] + hex[1], 16); g = parseInt(hex[2] + hex[2], 16); b = parseInt(hex[3] + hex[3], 16);
	} else {
		const m = /rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)/.exec(hex);
		if (m) { r = +m[1]; g = +m[2]; b = +m[3]; }
	}
	c = [r / 255, g / 255, b / 255];
	cache.set(css, c);
	return c;
}

export class GlRaster {
	private canvas: OffscreenCanvas;
	private gl: WebGL2RenderingContext;
	private capsule!: Program;
	private composite!: Program;
	private image!: Program;
	private paper!: Program;
	private quad!: WebGLBuffer;
	private vao!: WebGLVertexArrayObject;
	private scratch!: WebGLBuffer;
	private scratchCapacity = 0;
	private cov: { tex: WebGLTexture; fbo: WebGLFramebuffer; w: number; h: number } | null = null;
	private docs = new WeakMap<object, DocBuffer>();
	private textures = new Map<string, { tex: WebGLTexture | null; loading: boolean }>();
	private colors = new Map<string, [number, number, number]>();
	private lost = false;
	/** Called when an image finished uploading or the context came back. */
	onNeedsRepaint?: () => void;
	private finalizer = new FinalizationRegistry<WebGLBuffer>(buf => {
		if (!this.lost) this.gl.deleteBuffer(buf);
	});

	static create(): GlRaster | null {
		try {
			if (typeof OffscreenCanvas === 'undefined') return null;
			const canvas = new OffscreenCanvas(1, 1);
			const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false });
			if (!gl) return null;
			return new GlRaster(canvas, gl);
		} catch {
			return null;
		}
	}

	private constructor(canvas: OffscreenCanvas, gl: WebGL2RenderingContext) {
		this.canvas = canvas;
		this.gl = gl;
		canvas.addEventListener('webglcontextlost', e => {
			e.preventDefault();
			this.lost = true;
		});
		canvas.addEventListener('webglcontextrestored', () => {
			this.lost = false;
			this.docs = new WeakMap();
			this.textures.clear();
			this.cov = null;
			this.init();
			this.onNeedsRepaint?.();
		});
		this.init();
	}

	private compile(vs: string, fs: string, uniforms: string[]): Program {
		const gl = this.gl;
		const make = (type: number, src: string) => {
			const s = gl.createShader(type)!;
			gl.shaderSource(s, src);
			gl.compileShader(s);
			if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader');
			return s;
		};
		const prog = gl.createProgram()!;
		gl.attachShader(prog, make(gl.VERTEX_SHADER, vs));
		gl.attachShader(prog, make(gl.FRAGMENT_SHADER, fs));
		gl.linkProgram(prog);
		if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? 'link');
		const u: Record<string, WebGLUniformLocation | null> = {};
		for (const name of uniforms) u[name] = gl.getUniformLocation(prog, name);
		return { prog, u };
	}

	private init(): void {
		const gl = this.gl;
		this.capsule = this.compile(CAPSULE_VS, CAPSULE_FS, ['u_cam', 'u_size', 'u_shift', 'u_aa']);
		this.composite = this.compile(QUAD_VS, COMPOSITE_FS, ['u_rect', 'u_size', 'u_cov', 'u_color']);
		this.image = this.compile(QUAD_VS, IMAGE_FS, ['u_rect', 'u_size', 'u_tex']);
		this.paper = this.compile(QUAD_VS, PAPER_FS, ['u_rect', 'u_size', 'u_cam', 'u_color', 'u_kind', 'u_spacing', 'u_dot', 'u_line', 'u_clip', 'u_skipTop']);
		this.quad = gl.createBuffer()!;
		gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
		gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]), gl.STATIC_DRAW);
		this.vao = gl.createVertexArray()!;
		gl.bindVertexArray(this.vao);
		gl.enableVertexAttribArray(0);
		gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
		this.scratch = gl.createBuffer()!;
		this.scratchCapacity = 0;
		gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
	}

	// Geometry buffers
	//////////

	private docBuffer(key: object, strokes: readonly InkStroke[]): DocBuffer {
		const gl = this.gl;
		let db = this.docs.get(key);
		if (db && db.strokes === strokes) return db;
		const prev = db;
		const counts = new Int32Array(strokes.length);
		const starts = new Int32Array(strokes.length);
		let total = 0;
		const nodes: Float32Array[] = new Array(strokes.length);
		for (let i = 0; i < strokes.length; i++) {
			const n = strokeNodes(strokes[i]);
			nodes[i] = n;
			const segs = n.length >= 6 ? n.length / 3 - 1 : n.length === 3 ? 1 : 0;
			starts[i] = total;
			counts[i] = segs;
			total += segs;
		}
		// Appending to the same list only uploads the tail.
		const appendOnly = !!prev && strokes.length >= prev.strokes.length && prev.strokes.every((s, i) => strokes[i] === s);
		let buffer = prev?.buffer ?? null;
		let capacity = prev?.capacity ?? 0;
		const firstNew = appendOnly ? prev!.strokes.length : 0;
		const fromInstance = appendOnly ? (firstNew < strokes.length ? starts[firstNew] : total) : 0;
		const need = total * STRIDE * 4;
		if (!buffer || need > capacity) {
			capacity = Math.max(need * 1.5, 64 * 1024);
			const fresh = gl.createBuffer()!;
			gl.bindBuffer(gl.ARRAY_BUFFER, fresh);
			gl.bufferData(gl.ARRAY_BUFFER, capacity, gl.DYNAMIC_DRAW);
			if (buffer) gl.deleteBuffer(buffer);
			buffer = fresh;
			this.finalizer.register(key, fresh);
			this.writeInstances(strokes, nodes, starts, 0, total, 0);
		} else {
			gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
			this.writeInstances(strokes, nodes, starts, appendOnly ? firstNew : 0, total, fromInstance);
		}
		db = { strokes, buffer, capacity, starts, counts };
		this.docs.set(key, db);
		return db;
	}

	/** Writes instances of strokes [from…] into the bound buffer, offsets baked in. */
	private writeInstances(strokes: readonly InkStroke[], nodes: Float32Array[], starts: Int32Array, from: number, total: number, fromInstance: number): void {
		const count = total - fromInstance;
		if (count <= 0) return;
		const data = new Float32Array(count * STRIDE);
		for (let i = from; i < strokes.length; i++) {
			const n = nodes[i];
			const o = strokes[i].offset;
			let w = (starts[i] - fromInstance) * STRIDE;
			if (n.length === 3) {
				data.set([n[0] + o.x, n[1] + o.y, n[2], n[0] + o.x, n[1] + o.y, n[2]], w);
				continue;
			}
			for (let j = 0; j + 5 < n.length; j += 3) {
				data[w++] = n[j] + o.x; data[w++] = n[j + 1] + o.y; data[w++] = n[j + 2];
				data[w++] = n[j + 3] + o.x; data[w++] = n[j + 4] + o.y; data[w++] = n[j + 5];
			}
		}
		this.gl.bufferSubData(this.gl.ARRAY_BUFFER, fromInstance * STRIDE * 4, data);
	}

	private instancesOf(strokes: InkStroke[]): Float32Array {
		let total = 0;
		const all = strokes.map(s => {
			const n = isImageStroke(s) ? new Float32Array(0) : computeNodesFor(s);
			total += n.length >= 6 ? n.length / 3 - 1 : n.length === 3 ? 1 : 0;
			return n;
		});
		const data = new Float32Array(total * STRIDE);
		let w = 0;
		strokes.forEach((s, i) => {
			const n = all[i];
			const o = s.offset;
			if (n.length === 3) {
				data.set([n[0] + o.x, n[1] + o.y, n[2], n[0] + o.x, n[1] + o.y, n[2]], w);
				w += STRIDE;
				return;
			}
			for (let j = 0; j + 5 < n.length; j += 3) {
				data[w++] = n[j] + o.x; data[w++] = n[j + 1] + o.y; data[w++] = n[j + 2];
				data[w++] = n[j + 3] + o.x; data[w++] = n[j + 4] + o.y; data[w++] = n[j + 5];
			}
		});
		return data;
	}

	// Rendering
	//////////

	private ensureCoverage(w: number, h: number): void {
		const gl = this.gl;
		if (this.cov && this.cov.w === w && this.cov.h === h) return;
		if (this.cov) {
			gl.deleteTexture(this.cov.tex);
			gl.deleteFramebuffer(this.cov.fbo);
		}
		const tex = gl.createTexture()!;
		gl.bindTexture(gl.TEXTURE_2D, tex);
		gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R8, w, h);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
		const fbo = gl.createFramebuffer()!;
		gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
		gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
		gl.bindFramebuffer(gl.FRAMEBUFFER, null);
		this.cov = { tex, fbo, w, h };
	}

	/** Paints the scene at w × h device pixels and returns it as a bitmap. */
	render(w: number, h: number, scene: GlScene): ImageBitmap | null {
		if (this.lost) return null;
		const gl = this.gl;
		w = Math.max(1, Math.round(w));
		h = Math.max(1, Math.round(h));
		if (this.canvas.width !== w || this.canvas.height !== h) {
			this.canvas.width = w;
			this.canvas.height = h;
		}
		this.ensureCoverage(w, h);
		const { camera, dpr } = scene;
		const k = camera.zoom * dpr;
		const aa = 1 / k;
		const view: PageRect = { minX: -camera.x, minY: -camera.y, maxX: w / k - camera.x, maxY: h / k - camera.y };

		gl.bindVertexArray(this.vao);
		gl.bindFramebuffer(gl.FRAMEBUFFER, null);
		gl.viewport(0, 0, w, h);
		gl.disable(gl.SCISSOR_TEST);
		gl.clearColor(0, 0, 0, 0);
		gl.clear(gl.COLOR_BUFFER_BIT);
		gl.enable(gl.BLEND);
		gl.blendEquation(gl.FUNC_ADD);
		gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

		if (scene.background) this.drawPaper(scene, w, h, k);

		const db = this.docBuffer(scene.docKey, scene.strokes);
		const ink = parseColor(scene.palette.ink, this.colors);
		const colorOf = (s: InkStroke): [number, number, number] => isThemeAdaptiveColor(s.style.color) ? ink : parseColor(s.style.color, this.colors);

		// Runs over the document, in stacking order.
		const strokes = scene.strokes;
		let i = 0;
		while (i < strokes.length) {
			const s = strokes[i];
			if (scene.hidden.has(s) || !overlaps(s, view)) {
				i++;
				continue;
			}
			if (isImageStroke(s)) {
				this.drawImage(s, w, h, camera, dpr, 0, 0);
				i++;
				continue;
			}
			const opacity = s.style.opacity ?? 1;
			let j = i + 1;
			let box = approxStrokeBounds(s);
			if (opacity >= 1) {
				// Extend the run while colour and opacity match; hidden or off-screen strokes break it.
				while (j < strokes.length) {
					const t = strokes[j];
					if (scene.hidden.has(t) || isImageStroke(t) || (t.style.opacity ?? 1) < 1 || t.style.color !== s.style.color) break;
					box = unionBox(box, approxStrokeBounds(t));
					j++;
				}
			}
			this.layer(db.buffer, db.starts[i], (j < strokes.length ? db.starts[j] : db.starts[strokes.length - 1] + db.counts[strokes.length - 1]) - db.starts[i],
				colorOf(s), opacity, box, w, h, camera, k, aa, 0, 0);
			i = j;
		}

		// Floating selection, then live strokes, from a scratch buffer.
		const extra: Array<{ strokes: InkStroke[]; dx: number; dy: number }> = [];
		if (scene.floating && scene.floating.strokes.length) extra.push(scene.floating);
		if (scene.live.length) extra.push({ strokes: scene.live, dx: 0, dy: 0 });
		for (const group of extra) {
			for (const s of group.strokes) {
				if (isImageStroke(s)) this.drawImage(s, w, h, camera, dpr, group.dx, group.dy);
			}
			const inkOnly = group.strokes.filter(s => !isImageStroke(s));
			if (!inkOnly.length) continue;
			const data = this.instancesOf(inkOnly);
			gl.bindBuffer(gl.ARRAY_BUFFER, this.scratch);
			if (data.byteLength > this.scratchCapacity) {
				this.scratchCapacity = Math.max(data.byteLength * 2, 64 * 1024);
				gl.bufferData(gl.ARRAY_BUFFER, this.scratchCapacity, gl.DYNAMIC_DRAW);
			}
			gl.bufferSubData(gl.ARRAY_BUFFER, 0, data);
			let start = 0;
			for (const s of inkOnly) {
				const n = isImageStroke(s) ? 0 : computeNodesFor(s).length;
				const count = n >= 6 ? n / 3 - 1 : n === 3 ? 1 : 0;
				const b = approxStrokeBounds(s);
				const box = { minX: b.minX + group.dx, minY: b.minY + group.dy, maxX: b.maxX + group.dx, maxY: b.maxY + group.dy };
				this.layer(this.scratch, start, count, colorOf(s), s.style.opacity ?? 1, box, w, h, camera, k, aa, group.dx, group.dy);
				start += count;
			}
		}

		gl.disable(gl.SCISSOR_TEST);
		return this.canvas.transferToImageBitmap();
	}

	/** One run: capsules into the coverage buffer (union), then laid on the page in colour. */
	private layer(
		buffer: WebGLBuffer, start: number, count: number, rgb: [number, number, number], opacity: number,
		box: PageRect, w: number, h: number, camera: CameraState, k: number, aa: number, dx: number, dy: number,
	): void {
		if (count <= 0) return;
		const gl = this.gl;
		const cov = this.cov!;
		// Device box of the run, clamped to the target; GL scissor counts rows from the bottom.
		const x0 = Math.max(0, Math.floor((box.minX + camera.x) * k) - 2);
		const y0 = Math.max(0, Math.floor((box.minY + camera.y) * k) - 2);
		const x1 = Math.min(w, Math.ceil((box.maxX + camera.x) * k) + 2);
		const y1 = Math.min(h, Math.ceil((box.maxY + camera.y) * k) + 2);
		if (x1 <= x0 || y1 <= y0) return;
		gl.enable(gl.SCISSOR_TEST);
		gl.scissor(x0, h - y1, x1 - x0, y1 - y0);

		gl.bindFramebuffer(gl.FRAMEBUFFER, cov.fbo);
		gl.clearColor(0, 0, 0, 0);
		gl.clear(gl.COLOR_BUFFER_BIT);
		gl.blendEquation(gl.MAX);
		gl.blendFunc(gl.ONE, gl.ONE);
		const p = this.capsule;
		gl.useProgram(p.prog);
		gl.uniform3f(p.u.u_cam, camera.x, camera.y, k);
		gl.uniform2f(p.u.u_size, w, h);
		gl.uniform2f(p.u.u_shift, dx, dy);
		gl.uniform1f(p.u.u_aa, aa);
		gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
		const off = start * STRIDE * 4;
		gl.enableVertexAttribArray(1);
		gl.vertexAttribPointer(1, 3, gl.FLOAT, false, STRIDE * 4, off);
		gl.vertexAttribDivisor(1, 1);
		gl.enableVertexAttribArray(2);
		gl.vertexAttribPointer(2, 3, gl.FLOAT, false, STRIDE * 4, off + 12);
		gl.vertexAttribDivisor(2, 1);
		gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, count);
		gl.disableVertexAttribArray(1);
		gl.disableVertexAttribArray(2);

		gl.bindFramebuffer(gl.FRAMEBUFFER, null);
		gl.blendEquation(gl.FUNC_ADD);
		gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
		const c = this.composite;
		gl.useProgram(c.prog);
		gl.uniform4f(c.u.u_rect, x0, y0, x1 - x0, y1 - y0);
		gl.uniform2f(c.u.u_size, w, h);
		gl.activeTexture(gl.TEXTURE0);
		gl.bindTexture(gl.TEXTURE_2D, cov.tex);
		gl.uniform1i(c.u.u_cov, 0);
		gl.uniform4f(c.u.u_color, rgb[0] * opacity, rgb[1] * opacity, rgb[2] * opacity, opacity);
		gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
		gl.drawArrays(gl.TRIANGLES, 0, 6);
	}

	private drawImage(s: InkStroke & { image?: { src: string } }, w: number, h: number, camera: CameraState, dpr: number, dx: number, dy: number): void {
		const src = s.image!.src;
		let entry = this.textures.get(src);
		if (!entry) {
			entry = { tex: null, loading: true };
			this.textures.set(src, entry);
			const img = new Image();
			img.decoding = 'async';
			img.src = src;
			const e = entry;
			img.decode().then(() => {
				if (this.lost) return;
				const gl = this.gl;
				const tex = gl.createTexture()!;
				gl.bindTexture(gl.TEXTURE_2D, tex);
				gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
				gl.generateMipmap(gl.TEXTURE_2D);
				gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
				gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
				gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
				gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
				e.tex = tex;
				e.loading = false;
				this.onNeedsRepaint?.();
			}, () => { e.loading = false; });
		}
		if (!entry.tex) return;
		const gl = this.gl;
		const r = imageStrokeRect(s as InkStroke & { image: { src: string } });
		const k = camera.zoom * dpr;
		gl.disable(gl.SCISSOR_TEST);
		const p = this.image;
		gl.useProgram(p.prog);
		gl.uniform4f(p.u.u_rect, (r.x + dx + camera.x) * k, (r.y + dy + camera.y) * k, r.width * k, r.height * k);
		gl.uniform2f(p.u.u_size, w, h);
		gl.activeTexture(gl.TEXTURE0);
		gl.bindTexture(gl.TEXTURE_2D, entry.tex);
		gl.uniform1i(p.u.u_tex, 0);
		gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
		gl.drawArrays(gl.TRIANGLES, 0, 6);
	}

	private drawPaper(scene: GlScene, w: number, h: number, k: number): void {
		const bg = scene.background!;
		if (bg.layout === 'blank') return;
		const gl = this.gl;
		const { camera, dpr } = scene;
		let kind = 0;
		let spacing = 0;
		let alpha = 0.5;
		let clip = [-1e9, -1e9, 1e9, 1e9];
		let skipTop = 0;
		if (bg.mode === 'drawing') {
			spacing = resolveSpacing(bg.layout, { lineHeight: bg.lineHeight });
			if (bg.layout === 'dot') {
				spacing *= bg.dotScale ?? 1;
				// Too dense to read at this zoom: every other dot, until it reads again.
				while (spacing * camera.zoom < 6) spacing *= 2;
				kind = 1;
				alpha = 0.4;
			} else {
				if (spacing * camera.zoom <= 1) return;
				kind = bg.layout === 'isometric' ? 4 : bg.layout.startsWith('grid') ? 3 : 2;
			}
		} else {
			const width = bg.pageWidth ?? 2000;
			const height = bg.pageHeight ?? 1e9;
			spacing = resolveSpacing(bg.layout, { lineHeight: bg.lineHeight });
			if (bg.layout === 'dot') {
				spacing *= bg.dotScale ?? 1;
				kind = 1;
				clip = [0, 0, width, height];
			} else {
				kind = bg.layout === 'isometric' ? 4 : bg.layout.startsWith('grid') ? 3 : 2;
				clip = [width * 0.05, 0, width * 0.95, height];
				skipTop = 1;
			}
		}
		if (!(spacing > 0) || !kind) return;
		const rgb = parseColor(scene.palette.rule, this.colors);
		gl.disable(gl.SCISSOR_TEST);
		const p = this.paper;
		gl.useProgram(p.prog);
		gl.uniform4f(p.u.u_rect, 0, 0, w, h);
		gl.uniform2f(p.u.u_size, w, h);
		gl.uniform3f(p.u.u_cam, camera.x, camera.y, k);
		gl.uniform4f(p.u.u_color, rgb[0] * alpha, rgb[1] * alpha, rgb[2] * alpha, alpha);
		gl.uniform1i(p.u.u_kind, kind);
		gl.uniform1f(p.u.u_spacing, spacing);
		gl.uniform1f(p.u.u_dot, 1.25 * dpr);
		gl.uniform1f(p.u.u_line, dpr);
		gl.uniform4f(p.u.u_clip, clip[0], clip[1], clip[2], clip[3]);
		gl.uniform1f(p.u.u_skipTop, skipTop);
		gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
		gl.drawArrays(gl.TRIANGLES, 0, 6);
	}
}

/** Live strokes change every frame; their nodes are computed fresh, not cached. */
function computeNodesFor(s: InkStroke): Float32Array {
	return liveNodes.get(s) ?? (() => {
		const n = computeNodes(s.points, s.style);
		liveNodes.set(s, n);
		return n;
	})();
}
const liveNodes = new WeakMap<InkStroke, Float32Array>();

function overlaps(s: InkStroke, view: PageRect): boolean {
	const b = approxStrokeBounds(s);
	return b.minX <= view.maxX && b.maxX >= view.minX && b.minY <= view.maxY && b.maxY >= view.minY;
}

function unionBox(a: PageRect, b: PageRect): PageRect {
	return { minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY), maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY) };
}

let shared: GlRaster | null | undefined;

/** The plugin's one WebGL rasterizer (null where WebGL2 is unavailable). */
export function sharedRaster(): GlRaster | null {
	if (shared === undefined) shared = GlRaster.create();
	return shared;
}
