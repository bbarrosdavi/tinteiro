import type { CameraState } from '../model/types';
import { clampZoom } from './pen-model';

/**
 * The camera that shows a rectangle of page whole and centred in a viewport, never zoomed in
 * past 1×. An empty rectangle gets a default overview zoom.
 */
export function frameRect(
	viewportWidth: number,
	viewportHeight: number,
	rect: { x: number; y: number; width: number; height: number },
	margin = 16,
): CameraState {
	if (rect.width <= 0 || rect.height <= 0) return { x: 0, y: 0, zoom: 0.3 };
	const fitX = (viewportWidth - margin * 2) / rect.width;
	const fitY = (viewportHeight - margin * 2) / rect.height;
	const zoom = clampZoom(Math.min(fitX, fitY, 1));
	return {
		x: viewportWidth / (2 * zoom) - (rect.x + rect.width / 2),
		y: viewportHeight / (2 * zoom) - (rect.y + rect.height / 2),
		zoom,
	};
}
