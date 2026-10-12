import type { InkStroke, InkStrokeImage, InkStrokeStyle } from '../model/types';

///////////////////////////
///////////////////////////

/**
 * Pasted images live in the stroke store as a special stroke: `image` carries the data
 * URL and the two points are the image's corners in page space. Everything that moves or
 * scales points (select-and-move, mode conversion, culling) therefore works unchanged.
 *
 * The style is inert on purpose. The official Ink plugin ignores the `image` field and
 * would draw these two points as a stroke: a transparent, zero-size style keeps that
 * stroke invisible there, while the exported SVG body still shows the picture.
 */
export const IMAGE_STROKE_STYLE: InkStrokeStyle = {
	size: 0,
	thinning: 0,
	smoothing: 0,
	streamline: 0,
	simulatePressure: false,
	color: 'transparent',
};

/** Longest side kept for a pasted image; larger ones are scaled down before embedding. */
export const MAX_PASTED_IMAGE_SIDE_PX = 2000;
/** Pastes at or under this size (and side) are embedded byte-for-byte. */
export const MAX_PASTED_IMAGE_BYTES_UNCHANGED = 1_500_000;
/** Re-encoding quality when an image has to be scaled down. */
export const PASTED_IMAGE_WEBP_QUALITY = 0.92;
/** A new image takes at most this share of the visible canvas width. */
export const PASTED_IMAGE_MAX_VIEW_FRACTION = 0.6;

export type ImageStroke = InkStroke & { image: InkStrokeImage };

export interface ImageRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

let imageIdCounter = 0;

///////////////////////////

export function isImageStroke(stroke: InkStroke): stroke is ImageStroke {
	return !!stroke.image && typeof stroke.image.src === 'string' && stroke.points.length >= 2;
}

/**
 * Render order: images first, ink after, each group in store order. Ink written over a
 * picture must stay on top of it. Returns the same array when there are no images.
 */
export function orderImagesFirst(strokes: InkStroke[]): InkStroke[] {
	let hasImage = false;
	for (const stroke of strokes) {
		if (isImageStroke(stroke)) { hasImage = true; break; }
	}
	if (!hasImage) return strokes;
	return [...strokes.filter(isImageStroke), ...strokes.filter(stroke => !isImageStroke(stroke))];
}

/** The image's rectangle in page space, including any select-and-move offset. */
export function imageStrokeRect(stroke: ImageStroke): ImageRect {
	const [a, b] = stroke.points;
	return {
		x: Math.min(a[0], b[0]) + stroke.offset.x,
		y: Math.min(a[1], b[1]) + stroke.offset.y,
		width: Math.abs(b[0] - a[0]),
		height: Math.abs(b[1] - a[1]),
	};
}

/** Same rectangle without the offset: the frame the renderer translates. */
export function imageStrokeLocalRect(stroke: ImageStroke): ImageRect {
	const [a, b] = stroke.points;
	return {
		x: Math.min(a[0], b[0]),
		y: Math.min(a[1], b[1]),
		width: Math.abs(b[0] - a[0]),
		height: Math.abs(b[1] - a[1]),
	};
}

export function buildImageStroke(src: string, rect: ImageRect, now: number = Date.now()): ImageStroke {
	return {
		id: `img_${now}_${imageIdCounter++}`,
		points: [
			[rect.x, rect.y, 0.5],
			[rect.x + rect.width, rect.y + rect.height, 0.5],
		],
		style: { ...IMAGE_STROKE_STYLE },
		offset: { x: 0, y: 0 },
		startedAt: now,
		finishedAt: now,
		image: { src },
	};
}

/**
 * Where a pasted image goes: centred on `center` (page units), at its natural pixel size
 * shown 1:1 on screen, shrunk to `maxWidth` page units when wider, aspect ratio kept.
 */
export function placeImageRect(
	center: { x: number; y: number },
	naturalWidth: number,
	naturalHeight: number,
	zoom: number,
	maxWidth: number,
): ImageRect {
	const safeZoom = zoom > 0 ? zoom : 1;
	let width = naturalWidth / safeZoom;
	let height = naturalHeight / safeZoom;
	if (maxWidth > 0 && width > maxWidth) {
		height = height * (maxWidth / width);
		width = maxWidth;
	}
	return { x: center.x - width / 2, y: center.y - height / 2, width, height };
}

/** First image file on the clipboard, if any. */
export function getClipboardImageFile(data: DataTransfer | null): File | null {
	if (!data) return null;
	for (const item of Array.from(data.items ?? [])) {
		if (item.kind === 'file' && item.type.startsWith('image/')) {
			const file = item.getAsFile();
			if (file) return file;
		}
	}
	for (const file of Array.from(data.files ?? [])) {
		if (file.type.startsWith('image/')) return file;
	}
	return null;
}

/** Electron's clipboard, on desktop only. Mobile has no `require('electron')`. */
function electronClipboard(): {
	availableFormats?: () => string[];
	readImage?: () => { isEmpty(): boolean; toPNG(): Uint8Array };
} | null {
	try {
		const req = (window as unknown as { require?: (id: string) => unknown }).require;
		const electron = req?.('electron') as { clipboard?: ReturnType<typeof electronClipboard> } | undefined;
		return electron?.clipboard ?? null;
	} catch {
		return null;
	}
}

/**
 * Whether the clipboard holds an image, answered synchronously so a keydown can decide
 * to take over cmd/ctrl+V. `null` when it cannot tell (no Electron clipboard): the
 * caller then leaves the key alone and relies on the paste event.
 */
export function clipboardHasImageSync(): boolean | null {
	const formats = electronClipboard()?.availableFormats?.();
	if (!formats) return null;
	return formats.some(format => format.startsWith('image/'));
}

/**
 * Reads an image from the clipboard without a paste event, for the toolbar button on
 * touch screens. Tries the async Clipboard API, then Electron's clipboard.
 */
export async function readClipboardImageBlob(): Promise<Blob | null> {
	try {
		if (navigator.clipboard?.read) {
			for (const item of await navigator.clipboard.read()) {
				const type = item.types.find(t => t.startsWith('image/'));
				if (type) return await item.getType(type);
			}
		}
	} catch {
		// Permission refused or API missing: fall through to Electron.
	}
	const image = electronClipboard()?.readImage?.();
	if (image && !image.isEmpty()) {
		return new Blob([image.toPNG() as Uint8Array<ArrayBuffer>], { type: 'image/png' });
	}
	return null;
}

/**
 * Turns a pasted image into an embeddable data URL. Small images are kept byte-for-byte;
 * anything past {@link MAX_PASTED_IMAGE_SIDE_PX} or {@link MAX_PASTED_IMAGE_BYTES_UNCHANGED}
 * is scaled down and re-encoded as WebP, so one screenshot does not bloat the ink file.
 */
export async function readPastedImage(blob: Blob): Promise<{ src: string; width: number; height: number }> {
	const bitmap = await createImageBitmap(blob);
	try {
		const longest = Math.max(bitmap.width, bitmap.height);
		const keepOriginal = blob.size <= MAX_PASTED_IMAGE_BYTES_UNCHANGED && longest <= MAX_PASTED_IMAGE_SIDE_PX;
		if (keepOriginal) {
			return { src: await blobToDataUrl(blob), width: bitmap.width, height: bitmap.height };
		}

		const scale = Math.min(1, MAX_PASTED_IMAGE_SIDE_PX / longest);
		const width = Math.max(1, Math.round(bitmap.width * scale));
		const height = Math.max(1, Math.round(bitmap.height * scale));
		const canvas = document.createElement('canvas');
		canvas.width = width;
		canvas.height = height;
		const context = canvas.getContext('2d');
		if (!context) throw new Error('No 2D context to scale the pasted image');
		context.drawImage(bitmap, 0, 0, width, height);
		return { src: canvas.toDataURL('image/webp', PASTED_IMAGE_WEBP_QUALITY), width, height };
	} finally {
		bitmap.close();
	}
}

function blobToDataUrl(blob: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(String(reader.result));
		reader.onerror = () => reject(reader.error ?? new Error('Could not read the pasted image'));
		reader.readAsDataURL(blob);
	});
}
