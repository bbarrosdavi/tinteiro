/** Written into every file; the old plugin reads the same tag. */
export const INK_CANVAS_FORMAT_VERSION = '0.5.0';

export const ATTACHMENT_SUBFOLDER_NAME = 'Ink';
export const WRITING_SUBFOLDER_NAME = 'Writing';
export const DRAWING_SUBFOLDER_NAME = 'Drawing';
export const WRITE_FILE_V1_EXT = 'writing';
export const DRAW_FILE_V1_EXT = 'drawing';

export const WRITING_PAGE_WIDTH = 2000;
export const WRITING_LINE_HEIGHT = 150;
export const WRITING_MIN_PAGE_HEIGHT = WRITING_LINE_HEIGHT * 2.5;

export const DRAWING_INITIAL_WIDTH = 500;
export const DRAWING_INITIAL_ASPECT_RATIO = 1;

/** Baked colours in the saved SVG, for viewers without the plugin. */
export const SVG_PRIMARY_STROKE = '#000000';
export const SVG_WRITING_LINE = '#888888';
export const SVG_STROKE_CLASS = 'ink-type-stroke ink-color-primary';
export const SVG_STROKE_CUSTOM_CLASS = 'ink-type-stroke ink-color-custom';
export const SVG_WRITING_LINE_CLASS = 'ink-type-writing-line ink-color-writing-line';
