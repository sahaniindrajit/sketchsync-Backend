/**
 * LaTeX → SVG with MathJax. The frontend has a matching renderer
 * (sketchsync/src/board/math/renderLatex.ts) so sizes agree on both sides.
 */
import { liteAdaptor } from 'mathjax-full/js/adaptors/liteAdaptor.js';
import { RegisterHTMLHandler } from 'mathjax-full/js/handlers/html.js';
import { TeX } from 'mathjax-full/js/input/tex.js';
import 'mathjax-full/js/input/tex/ams/AmsConfiguration.js';
import 'mathjax-full/js/input/tex/boldsymbol/BoldsymbolConfiguration.js';
import 'mathjax-full/js/input/tex/cancel/CancelConfiguration.js';
import 'mathjax-full/js/input/tex/color/ColorConfiguration.js';
import 'mathjax-full/js/input/tex/mhchem/MhchemConfiguration.js';
import 'mathjax-full/js/input/tex/newcommand/NewcommandConfiguration.js';
import { mathjax } from 'mathjax-full/js/mathjax.js';
import { SVG } from 'mathjax-full/js/output/svg.js';
import type { MathShape } from '../shared/protocol.js';

export interface RenderedMath {
    /** Standalone <svg> markup with px width/height. */
    svg: string;
    width: number;
    height: number;
    /** TeX error message, if the input is invalid (the svg then shows the error). */
    error?: string;
}

const PACKAGES = ['base', 'ams', 'newcommand', 'boldsymbol', 'color', 'cancel', 'mhchem'];

const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);
const doc = mathjax.document('', {
    InputJax: new TeX({ packages: PACKAGES }),
    OutputJax: new SVG({ fontCache: 'none' }),
});

const cache = new Map<string, RenderedMath>();
let cacheBytes = 0;
const MAX_CACHE_BYTES = 64 * 1024 * 1024;
/** Formulas larger than this (px) are refused: they break layout and hit-testing. */
export const MAX_MATH_SIZE_PX = 20_000;
/** Refuse pathological formulas that expand to huge SVGs. */
export const MAX_MATH_SVG_BYTES = 400_000;
/** Equation numbering needs a page width MathJax can't know here. */
const UNSUPPORTED = /\\(tag|label|eqref|ref|notag|nonumber)\b/;

const escapeAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

export function renderLatex(latex: string, fontSize: number, displayMode: boolean, color = '#1e1e1e'): RenderedMath {
    const key = `${displayMode ? 'D' : 'I'}|${fontSize}|${color}|${latex}`;
    const cached = cache.get(key);
    if (cached) return cached;

    const ex = fontSize / 2;
    let rendered: RenderedMath;
    const unsupported = latex.match(UNSUPPORTED);
    if (unsupported) {
        return { svg: '', width: 1, height: 1, error: `\\${unsupported[1]} is not supported (equation numbers need a page layout)` };
    }
    try {
        const node = doc.convert(latex, { display: displayMode, em: fontSize, ex, containerWidth: 80 * fontSize });
        const svgNode = adaptor.firstChild(node) as Parameters<typeof adaptor.outerHTML>[0];
        let svg = adaptor.outerHTML(svgNode);
        const errorMatch = svg.match(/data-mjx-error="([^"]*)"/);
        const widthEx = Number.parseFloat(svg.match(/width="([\d.]+)ex"/)?.[1] ?? '0');
        const heightEx = Number.parseFloat(svg.match(/height="([\d.]+)ex"/)?.[1] ?? '0');
        const width = Math.max(1, Math.round(widthEx * ex * 100) / 100);
        const height = Math.max(1, Math.round(heightEx * ex * 100) / 100);
        svg = svg
            .replace(/ style="vertical-align:[^"]*"/, '')
            .replace(/width="[\d.]+ex"/, `width="${width}"`)
            .replace(/height="[\d.]+ex"/, `height="${height}"`)
            .replace(/currentColor/g, escapeAttr(color))
            // eslint-disable-next-line no-control-regex
            .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '');
        let error = errorMatch?.[1];
        if (!error && (widthEx <= 0 || heightEx <= 0 || width <= 1 || height <= 1)) error = 'The formula has no visible size';
        if (!error && (width > MAX_MATH_SIZE_PX || height > MAX_MATH_SIZE_PX)) error = `The formula is too large (over ${MAX_MATH_SIZE_PX}px)`;
        if (!error && svg.length > MAX_MATH_SVG_BYTES) error = 'The formula is too complex to render';
        rendered = error ? { svg: '', width: 1, height: 1, error } : { svg, width, height };
    } catch (err) {
        rendered = { svg: '', width: 1, height: 1, error: err instanceof Error ? err.message : 'Could not render LaTeX' };
    }
    cache.set(key, rendered);
    cacheBytes += rendered.svg.length + key.length;
    while (cache.size > 1000 || cacheBytes > MAX_CACHE_BYTES) {
        const [oldKey, old] = cache.entries().next().value!;
        cache.delete(oldKey);
        cacheBytes -= old.svg.length + oldKey.length;
    }
    return rendered;
}

/** MathRenderer for the board SVG renderer: inner markup without the outer <svg> wrapper sizing. */
export function mathForShape(shape: MathShape) {
    const r = renderLatex(shape.latex, shape.fontSize, shape.displayMode, shape.strokeColor);
    // Invalid LaTeX falls back to showing the source text.
    if (!r.svg || r.error) return null;
    // Strip the outer <svg ...> element; the board renderer wraps the content in its own sized <svg>.
    const outer = r.svg.match(/^<svg[^>]*>/)?.[0] ?? '';
    const inner = r.svg.slice(outer.length).replace(/<\/svg>$/, '');
    const viewBox = outer.match(/viewBox="([^"]*)"/)?.[1];
    return { svg: viewBox ? `<svg viewBox="${viewBox}" width="${r.width}" height="${r.height}">${inner}</svg>` : r.svg, width: r.width, height: r.height };
}
