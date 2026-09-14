import { getShapeBounds, isLinear, resolveLinePoints, unionBoxes, type Box, type Measurer } from '../shared/geometry.js';
import { sortByZ } from '../shared/ops.js';
import type { Shape } from '../shared/protocol.js';

const round = (v: number) => Math.round(v * 10) / 10;
const roundBox = (b: Box) => ({ x: round(b.x), y: round(b.y), width: round(b.width), height: round(b.height) });

export interface ShapeSummary {
    id: string;
    type: Shape['type'];
    bounds: ReturnType<typeof roundBox>;
    [key: string]: unknown;
}

/** Compact, model-friendly description of one shape. */
export function summarizeShape(shape: Shape, shapes: ReadonlyMap<string, Shape>, measurer: Measurer, full = false): ShapeSummary {
    const lookup = (id: string) => shapes.get(id);
    const summary: ShapeSummary = { id: shape.id, type: shape.type, bounds: roundBox(getShapeBounds(shape, lookup, measurer)) };
    if (shape.rotation) summary.rotation = shape.rotation;
    if (shape.opacity !== 1) summary.opacity = shape.opacity;
    if (shape.type !== 'image') summary.strokeColor = shape.strokeColor;
    if (shape.fillColor !== 'transparent' && (shape.type === 'rect' || shape.type === 'ellipse' || shape.type === 'diamond')) summary.fillColor = shape.fillColor;
    summary.author = shape.createdBy.startsWith('ai:') ? 'ai' : 'user';

    switch (shape.type) {
        case 'rect':
        case 'ellipse':
        case 'diamond':
            if (shape.label?.text) summary.label = shape.label.text;
            break;
        case 'line':
        case 'arrow': {
            const abs = resolveLinePoints(shape, lookup);
            summary.start = { x: round(abs[0]), y: round(abs[1]), ...(shape.startBinding ? { shapeId: shape.startBinding.shapeId } : {}) };
            summary.end = { x: round(abs[abs.length - 2]), y: round(abs[abs.length - 1]), ...(shape.endBinding ? { shapeId: shape.endBinding.shapeId } : {}) };
            if (abs.length > 4) {
                summary.via = [];
                for (let i = 2; i < abs.length - 2; i += 2) (summary.via as unknown[]).push({ x: round(abs[i]), y: round(abs[i + 1]) });
            }
            if (shape.label?.text) summary.label = shape.label.text;
            break;
        }
        case 'freehand':
            summary.pointCount = shape.points.length / 2;
            if (full) {
                const pts: number[][] = [];
                for (let i = 0; i + 1 < shape.points.length; i += 2) pts.push([round(shape.x + shape.points[i]), round(shape.y + shape.points[i + 1])]);
                summary.points = pts;
            }
            break;
        case 'text':
            summary.text = shape.text;
            summary.fontSize = shape.fontSize;
            if (shape.fontWeight === 'bold') summary.fontWeight = 'bold';
            break;
        case 'math':
            summary.latex = shape.latex;
            summary.fontSize = shape.fontSize;
            break;
        case 'image':
            summary.note = 'embedded image (use get_board_image to see it)';
            break;
    }
    return summary;
}

export function describeBoard(shapes: ReadonlyMap<string, Shape>, measurer: Measurer, options: { full?: boolean; limit?: number; ids?: string[] } = {}) {
    let list = sortByZ(shapes.values());
    if (options.ids?.length) {
        const wanted = new Set(options.ids);
        list = list.filter((s) => wanted.has(s.id));
    }
    const limit = options.limit ?? 300;
    const bounds = unionBoxes(list.map((s) => getShapeBounds(s, (id) => shapes.get(id), measurer)));
    const described = list.slice(0, limit).map((s) => summarizeShape(s, shapes, measurer, options.full));
    const counts: Record<string, number> = {};
    for (const s of list) counts[s.type] = (counts[s.type] ?? 0) + 1;
    return {
        shapeCount: list.length,
        countsByType: counts,
        contentBounds: bounds ? roundBox(bounds) : null,
        hasHandDrawing: list.some((s) => s.type === 'freehand' || s.type === 'image'),
        shapes: described,
        ...(list.length > limit ? { truncated: `Showing ${limit} of ${list.length} shapes (lowest first by stacking order).` } : {}),
    };
}

export function isBoxLike(shape: Shape) {
    return !isLinear(shape);
}
