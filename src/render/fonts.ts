import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import opentype from 'opentype.js';
import { DEFAULTS, type FontWeight } from '../shared/protocol.js';

const fontDir = fileURLToPath(new URL('../../assets/fonts/', import.meta.url));

export const FONT_FILES = {
    normal: `${fontDir}Inter-Regular.ttf`,
    bold: `${fontDir}Inter-Bold.ttf`,
} as const;

type Font = ReturnType<typeof opentype.parse>;
const fonts: Partial<Record<FontWeight, Font>> = {};
const advanceCache: Record<FontWeight, Map<string, number>> = { normal: new Map(), bold: new Map() };

function font(weight: FontWeight): Font {
    let f = fonts[weight];
    if (!f) {
        const buf = readFileSync(FONT_FILES[weight]);
        f = opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
        fonts[weight] = f;
    }
    return f;
}

/** Width of a single line of text in px (per-glyph advances; kerning is ignored). */
export function measureTextWidth(text: string, fontSize: number, weight: FontWeight = 'normal'): number {
    const f = font(weight);
    const cache = advanceCache[weight];
    let units = 0;
    for (const ch of text) {
        let adv = cache.get(ch);
        if (adv === undefined) {
            adv = f.charToGlyph(ch).advanceWidth ?? f.unitsPerEm * 0.5;
            cache.set(ch, adv);
        }
        units += adv;
    }
    return (units * fontSize) / f.unitsPerEm;
}

/** Word-wraps like Konva.Text with wrap="word" (mirrors the frontend's wrapLines). Linear in text length. */
export function wrapLines(text: string, fontSize: number, weight: FontWeight, width?: number): string[] {
    const lines: string[] = [];
    for (const paragraph of text.split('\n')) {
        if (!width) {
            lines.push(paragraph);
            continue;
        }
        let line = '';
        let lineWidth = 0;
        for (const token of paragraph.split(/(\s+)/)) {
            if (!token) continue;
            const tokenWidth = measureTextWidth(token, fontSize, weight);
            const isSpace = /^\s+$/.test(token);
            if (line && !isSpace && lineWidth + tokenWidth > width) {
                lines.push(line.trimEnd());
                line = token;
                lineWidth = tokenWidth;
            } else if (!(isSpace && !line)) {
                line += token;
                lineWidth += tokenWidth;
            }
        }
        lines.push(line.trimEnd());
    }
    return lines;
}

const blockCache = new Map<string, { lines: string[]; width: number; height: number }>();

export function textBlockSize(text: string, fontSize: number, weight: FontWeight, width?: number) {
    const key = `${fontSize}|${weight}|${width ?? ''}|${text}`;
    const cached = blockCache.get(key);
    if (cached) return cached;
    const lines = wrapLines(text || ' ', fontSize, weight, width);
    const block = {
        lines,
        width: width ?? lines.reduce((max, l) => Math.max(max, measureTextWidth(l, fontSize, weight)), 1),
        height: lines.length * fontSize * DEFAULTS.lineHeight,
    };
    blockCache.set(key, block);
    if (blockCache.size > 2000) blockCache.delete(blockCache.keys().next().value!);
    return block;
}
