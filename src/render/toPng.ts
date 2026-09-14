import { Resvg } from '@resvg/resvg-js';
import type { Box } from '../shared/geometry.js';
import type { Shape } from '../shared/protocol.js';
import { FONT_FILES } from './fonts.js';
import { boardToSvg, contentBounds, type MathRenderer } from './toSvg.js';

export interface PngOptions {
    region?: Box;
    /** Longest edge of the output image in px. */
    maxSize?: number;
    math?: MathRenderer;
}

export interface PngResult {
    png: Buffer;
    width: number;
    height: number;
    region: Box;
    /** Output pixels per board unit. */
    scale: number;
}

export const DEFAULT_IMAGE_SIZE = 1568;
export const MAX_IMAGE_SIZE = 2048;

const MIN_EDGE_PX = 16;

export function boardToPng(shapes: ReadonlyMap<string, Shape>, options: PngOptions = {}): PngResult {
    const maxSize = Math.min(MAX_IMAGE_SIZE, Math.max(64, options.maxSize ?? DEFAULT_IMAGE_SIZE));
    const content = options.region ? null : contentBounds(shapes, options.math);
    let region: Box | undefined = options.region
        ? { ...options.region }
        : content
          ? { x: content.x - 40, y: content.y - 40, width: content.width + 80, height: content.height + 80 }
          : undefined;
    if (region) {
        // Very thin regions would round to 0 px; widen the short side around its center.
        const scale = Math.min(2, maxSize / Math.max(region.width, region.height, 1));
        const minBoard = MIN_EDGE_PX / scale;
        if (region.width < minBoard) region = { ...region, x: region.x - (minBoard - region.width) / 2, width: minBoard };
        if (region.height < minBoard) region = { ...region, y: region.y - (minBoard - region.height) / 2, height: minBoard };
    }
    // Never upscale small boards by more than 2x; the longest edge never exceeds maxSize.
    const planned = region ?? { x: 0, y: 0, width: 800, height: 600 };
    const scale = Math.min(2, maxSize / Math.max(planned.width, planned.height, 1));
    const svgResult = boardToSvg(shapes, { region, math: options.math, pixelScale: scale });
    const { svg } = svgResult;
    region = svgResult.region;
    const resvg = new Resvg(svg, {
        fitTo: { mode: 'zoom', value: scale },
        font: { fontFiles: [FONT_FILES.normal, FONT_FILES.bold], loadSystemFonts: false, defaultFontFamily: 'Inter' },
        imageRendering: 0,
        shapeRendering: 2,
        textRendering: 1,
    });
    const rendered = resvg.render();
    return { png: rendered.asPng(), width: rendered.width, height: rendered.height, region, scale: Math.round(scale * 10000) / 10000 };
}
