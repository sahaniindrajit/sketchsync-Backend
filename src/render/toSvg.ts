import {
    arrowHeadSize,
    boxesIntersect,
    diamondPoints,
    estimateMeasurer,
    getShapeBounds,
    isDotStroke,
    polylineMidpoint,
    resolveLinePoints,
    smoothPathData,
    unionBoxes,
    type Box,
    type Measurer,
} from '../shared/geometry.js';
import { sortByZ } from '../shared/ops.js';
import { DEFAULTS, type LineShape, type MathShape, type Shape, type TextLabel } from '../shared/protocol.js';
import { measureTextWidth, textBlockSize, wrapLines } from './fonts.js';

/** Renders LaTeX to an SVG fragment sized in px, or null if it can't. */
export type MathRenderer = (shape: MathShape) => { svg: string; width: number; height: number } | null;

export interface SvgOptions {
    /** Board-space area to render; defaults to all content plus padding. */
    region?: Box;
    padding?: number;
    math?: MathRenderer;
    /** Output pixels per board unit; text smaller than ~3 px is drawn as placeholder bars. */
    pixelScale?: number;
}

export interface SvgResult {
    svg: string;
    region: Box;
}

const FONT = `${DEFAULTS.fontFamily}`;
const GREEK_BELOW_PX = 3;
/** Set per render; module-level to avoid threading it through every helper. */
let currentPixelScale = 1;
const r = (v: number) => Math.round(v * 100) / 100;

/** Escapes for XML text/attributes and drops characters XML can't contain (control chars, lone surrogates). */
const esc = (s: string) =>
    s
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');

const fill = (c: string) => (c === 'transparent' ? 'none' : c);

export function serverMeasurer(math?: MathRenderer): Measurer {
    return {
        text: (s) => {
            const size = textBlockSize(s.text, s.fontSize, s.fontWeight, s.width);
            return { width: size.width, height: size.height };
        },
        math: (s) => {
            const rendered = math?.(s);
            return rendered ? { width: rendered.width, height: rendered.height } : estimateMeasurer.math(s);
        },
    };
}

/** Content bounds of the whole board (null when empty). */
export function contentBounds(shapes: ReadonlyMap<string, Shape>, math?: MathRenderer): Box | null {
    const measurer = serverMeasurer(math);
    return unionBoxes(Array.from(shapes.values()).map((s) => getShapeBounds(s, (id) => shapes.get(id), measurer)));
}

export function boardToSvg(shapes: ReadonlyMap<string, Shape>, options: SvgOptions = {}): SvgResult {
    const padding = options.padding ?? 40;
    const content = contentBounds(shapes, options.math);
    const region =
        options.region ??
        (content
            ? { x: content.x - padding, y: content.y - padding, width: content.width + padding * 2, height: content.height + padding * 2 }
            : { x: 0, y: 0, width: 800, height: 600 });

    // Only draw what's visible in the region.
    currentPixelScale = options.pixelScale ?? 1;
    const measurer = serverMeasurer(options.math);
    const body = sortByZ(shapes.values())
        .filter((shape) => boxesIntersect(getShapeBounds(shape, (id) => shapes.get(id), measurer), region))
        .map((shape) => shapeToSvg(shape, (id) => shapes.get(id), options.math))
        .join('\n');

    const svg =
        `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ` +
        `width="${r(region.width)}" height="${r(region.height)}" viewBox="${r(region.x)} ${r(region.y)} ${r(region.width)} ${r(region.height)}">` +
        `<rect x="${r(region.x)}" y="${r(region.y)}" width="${r(region.width)}" height="${r(region.height)}" fill="#ffffff"/>` +
        body +
        `</svg>`;
    return { svg, region };
}

function group(shape: Shape, inner: string, originX = shape.x, originY = shape.y, rotation = shape.rotation): string {
    const transform = `translate(${r(originX)} ${r(originY)})${rotation ? ` rotate(${r(rotation)})` : ''}`;
    const opacity = shape.opacity < 1 ? ` opacity="${r(shape.opacity)}"` : '';
    return `<g transform="${transform}"${opacity}>${inner}</g>`;
}

function stroke(shape: Shape): string {
    return shape.strokeWidth > 0 ? ` stroke="${shape.strokeColor}" stroke-width="${r(shape.strokeWidth)}"` : '';
}

/** Text lines drawn like Konva: each line centred vertically in its line box. */
function textLines(lines: string[], x: number, y: number, width: number, fontSize: number, color: string, align: 'left' | 'center' | 'right', weight: 'normal' | 'bold'): string {
    const lineHeight = fontSize * DEFAULTS.lineHeight;
    if (fontSize * currentPixelScale < GREEK_BELOW_PX) {
        // Unreadably small at this zoom: draw each line as a faint bar (much faster to rasterize).
        return lines
            .map((line, i) => {
                const w = Math.min(width, measureTextWidth(line, fontSize, weight));
                const lx = align === 'center' ? x + (width - w) / 2 : align === 'right' ? x + width - w : x;
                return w > 0 ? `<rect x="${r(lx)}" y="${r(y + i * lineHeight + lineHeight * 0.3)}" width="${r(w)}" height="${r(lineHeight * 0.4)}" fill="${color}" opacity="0.35"/>` : '';
            })
            .join('');
    }
    const anchor = align === 'center' ? 'middle' : align === 'right' ? 'end' : 'start';
    const ax = align === 'center' ? x + width / 2 : align === 'right' ? x + width : x;
    return lines
        .map(
            (line, i) =>
                `<text x="${r(ax)}" y="${r(y + i * lineHeight + lineHeight / 2)}" font-family="${FONT}" font-size="${r(fontSize)}"` +
                `${weight === 'bold' ? ' font-weight="bold"' : ''} fill="${color}" text-anchor="${anchor}" dominant-baseline="central" xml:space="preserve">${esc(line)}</text>`,
        )
        .join('');
}

function boxLabel(label: TextLabel | undefined, width: number, height: number, fallbackColor: string, inset = 0): string {
    if (!label?.text) return '';
    const padX = Math.abs(width) * inset + 8;
    const padY = Math.abs(height) * inset + 4;
    const innerW = Math.max(1, Math.abs(width) - padX * 2);
    const innerH = Math.max(1, Math.abs(height) - padY * 2);
    const fontSize = label.fontSize ?? DEFAULTS.labelFontSize;
    const lineHeight = fontSize * DEFAULTS.lineHeight;
    // Like Konva.Text with a fixed height: lines that don't fit are not drawn (at least one line is).
    const lines = wrapLines(label.text, fontSize, 'normal', innerW).slice(0, Math.max(1, Math.floor(innerH / lineHeight)));
    const blockH = lines.length * lineHeight;
    return textLines(lines, padX, padY + (innerH - blockH) / 2, innerW, fontSize, label.color ?? fallbackColor, 'center', 'normal');
}

export function shapeToSvg(shape: Shape, getShape: (id: string) => Shape | undefined, math?: MathRenderer): string {
    switch (shape.type) {
        case 'rect': {
            const rx = shape.cornerRadius ? ` rx="${r(shape.cornerRadius)}"` : '';
            return group(
                shape,
                `<rect width="${r(shape.width)}" height="${r(shape.height)}"${rx} fill="${fill(shape.fillColor)}"${stroke(shape)}/>` +
                    boxLabel(shape.label, shape.width, shape.height, shape.strokeColor),
            );
        }
        case 'ellipse':
            return group(
                shape,
                `<ellipse cx="${r(shape.width / 2)}" cy="${r(shape.height / 2)}" rx="${r(Math.abs(shape.width / 2))}" ry="${r(Math.abs(shape.height / 2))}" fill="${fill(shape.fillColor)}"${stroke(shape)}/>` +
                    boxLabel(shape.label, shape.width, shape.height, shape.strokeColor),
            );
        case 'diamond':
            return group(
                shape,
                `<polygon points="${diamondPoints(shape.width, shape.height).map(r).join(' ')}" fill="${fill(shape.fillColor)}"${stroke(shape)} stroke-linejoin="round"/>` +
                    boxLabel(shape.label, shape.width, shape.height, shape.strokeColor, 0.2),
            );
        case 'line':
        case 'arrow':
            return linearToSvg(shape, getShape);
        case 'freehand': {
            if (isDotStroke(shape.points)) {
                return group(shape, `<circle cx="${r(shape.points[0] ?? 0)}" cy="${r(shape.points[1] ?? 0)}" r="${r(Math.max(1, shape.strokeWidth / 2))}" fill="${shape.strokeColor}"/>`);
            }
            return group(
                shape,
                `<path d="${smoothPathData(shape.points, DEFAULTS.freehandTension)}" fill="none" stroke="${shape.strokeColor}" stroke-width="${r(shape.strokeWidth)}" stroke-linecap="round" stroke-linejoin="round"/>`,
            );
        }
        case 'text': {
            const block = textBlockSize(shape.text, shape.fontSize, shape.fontWeight, shape.width);
            return group(shape, textLines(block.lines, 0, 0, block.width, shape.fontSize, shape.strokeColor, shape.align, shape.fontWeight));
        }
        case 'math': {
            const rendered = math?.(shape);
            if (rendered) {
                return group(shape, `<svg x="0" y="0" width="${r(rendered.width)}" height="${r(rendered.height)}" overflow="visible" style="color:${shape.strokeColor}">${rendered.svg}</svg>`);
            }
            return group(shape, textLines([shape.latex], 0, 0, measureTextWidth(shape.latex, shape.fontSize), shape.fontSize, shape.strokeColor, 'left', 'normal'));
        }
        case 'image':
            return group(shape, `<image width="${r(shape.width)}" height="${r(shape.height)}" preserveAspectRatio="none" href="${esc(shape.src)}" xlink:href="${esc(shape.src)}"/>`);
    }
}

function linearToSvg(shape: LineShape, getShape: (id: string) => Shape | undefined): string {
    const bound = !!(shape.startBinding || shape.endBinding);
    // Bound lines are resolved in absolute coordinates; unbound ones draw relative to (x, y) and may be rotated.
    const pts = bound ? resolveLinePoints(shape, getShape) : shape.points;
    const ox = bound ? 0 : shape.x;
    const oy = bound ? 0 : shape.y;
    const rotation = bound ? 0 : shape.rotation;
    if (pts.length < 4) return '';
    let d = `M${r(pts[0])} ${r(pts[1])}`;
    for (let i = 2; i + 1 < pts.length; i += 2) d += ` L${r(pts[i])} ${r(pts[i + 1])}`;
    let inner = `<path d="${d}" fill="none" stroke="${shape.strokeColor}" stroke-width="${r(shape.strokeWidth)}" stroke-linecap="round" stroke-linejoin="round"/>`;
    if (shape.type === 'arrow') {
        const size = arrowHeadSize(shape.strokeWidth);
        const head = arrowHeadPolygon(pts, size);
        if (head) inner += `<polygon points="${head.map(r).join(' ')}" fill="${shape.strokeColor}" stroke="${shape.strokeColor}" stroke-width="${r(shape.strokeWidth)}" stroke-linejoin="round"/>`;
    }
    if (shape.label?.text) {
        const mid = polylineMidpoint(pts);
        const fontSize = shape.label.fontSize ?? DEFAULTS.labelFontSize - 2;
        const lines = shape.label.text.split('\n');
        const w = Math.max(...lines.map((l) => measureTextWidth(l, fontSize))) + 8;
        const h = lines.length * fontSize * DEFAULTS.lineHeight + 4;
        inner +=
            `<rect x="${r(mid.x - w / 2)}" y="${r(mid.y - h / 2)}" width="${r(w)}" height="${r(h)}" rx="3" fill="#ffffff"/>` +
            textLines(lines, mid.x - w / 2 + 4, mid.y - h / 2 + 2, w - 8, fontSize, shape.label.color ?? shape.strokeColor, 'center', 'normal');
    }
    return group(shape, inner, ox, oy, rotation);
}

/** Konva.Arrow-style head: tip at the last point, base `size` back along the last segment. */
function arrowHeadPolygon(pts: number[], size: number): number[] | null {
    const n = pts.length;
    const tipX = pts[n - 2];
    const tipY = pts[n - 1];
    let i = n - 4;
    while (i >= 0 && pts[i] === tipX && pts[i + 1] === tipY) i -= 2;
    if (i < 0) return null;
    const angle = Math.atan2(tipY - pts[i + 1], tipX - pts[i]);
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const bx = tipX - size * cos;
    const by = tipY - size * sin;
    return [tipX, tipY, bx + (size / 2) * sin, by - (size / 2) * cos, bx - (size / 2) * sin, by + (size / 2) * cos];
}
