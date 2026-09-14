/**
 * AI-friendly input schemas for MCP tools, and converters to protocol shapes.
 * Inputs use absolute board coordinates and sensible defaults; the protocol's
 * stricter shape schema still validates the result in RoomService.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { colorSchema } from '../protocol/schemas.js';
import { boxCenter, getShapeBounds, isBindable, isLinear, resolveLinePoints, unionBoxes, type Box, type Measurer } from '../shared/geometry.js';
import { maxZ } from '../shared/ops.js';
import { DEFAULTS, LIMITS, type LineShape, type Origin, type Shape, type ShapeChanges, type TextLabel } from '../shared/protocol.js';
import { measureTextWidth } from '../render/fonts.js';

export class ToolInputError extends Error {}

const num = (desc: string) => z.number().finite().min(-LIMITS.maxCoordinate).max(LIMITS.maxCoordinate).describe(desc);
const size = (desc: string) => z.number().finite().min(1).max(20000).describe(desc);
const color = colorSchema.describe('Hex color such as "#1e1e1e" or "#e03131", or "transparent"');
const shapeId = z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9_\-:.]+$/, 'ids may only contain letters, digits, _ - : .');

export const labelInput = z
    .union([
        z.string().max(LIMITS.maxTextLength),
        z.object({ text: z.string().max(LIMITS.maxTextLength), fontSize: z.number().min(6).max(200).optional(), color: color.optional() }),
    ])
    .describe('Text shown centered inside the shape (or on the line). A string, or {text, fontSize, color}.');

const styleFields = {
    strokeColor: color.optional().describe('Outline / line / text color. Default #1e1e1e.'),
    fillColor: color.optional().describe('Fill for rect/ellipse/diamond. Default "transparent". Light pastel fills look good: #a5d8ff, #b2f2bb, #ffec99, #ffc9c9, #eebefa.'),
    strokeWidth: z.number().min(0).max(50).optional().describe('Stroke width in px. Default 2.'),
    opacity: z.number().min(0).max(1).optional(),
    rotation: z.number().min(-360).max(360).optional().describe('Degrees clockwise around the top-left corner.'),
};

const pointInput = z.object({ x: num('Board x'), y: num('Board y') });
const endpointInput = z
    .union([pointInput, z.object({ shapeId: shapeId.describe('Attach to this shape; the end follows it when it moves') })])
    .describe('Either a point {x, y} or {shapeId} to connect to a rect/ellipse/diamond/image (existing or created in this same call).');

export const shapeInputSchema = z.discriminatedUnion('type', [
    z.object({
        type: z.enum(['rect', 'ellipse', 'diamond']),
        id: shapeId.optional().describe('Optional id so later shapes in the same call (e.g. arrows) can reference this one'),
        x: num('Left edge. Omit x and y to auto-place in free space.').optional(),
        y: num('Top edge').optional(),
        width: size('Default 160 (grows to fit the label)').optional(),
        height: size('Default 80 (120 for diamonds)').optional(),
        label: labelInput.optional(),
        cornerRadius: z.number().min(0).max(1000).optional().describe('Rounded corners for rect'),
        ...styleFields,
    }),
    z.object({
        type: z.enum(['arrow', 'line']),
        id: shapeId.optional(),
        start: endpointInput,
        end: endpointInput,
        via: z.array(pointInput).max(50).optional().describe('Optional bend points between start and end'),
        label: labelInput.optional(),
        ...styleFields,
    }),
    z.object({
        type: z.literal('freehand'),
        id: shapeId.optional(),
        points: z
            .array(z.array(num('coordinate')).length(2))
            .min(1)
            .max(LIMITS.maxPointsPerShape / 2)
            .describe('Absolute [x, y] points of a smooth hand-drawn stroke'),
        ...styleFields,
    }),
    z.object({
        type: z.literal('text'),
        id: shapeId.optional(),
        x: num('Left edge. Omit x and y to auto-place.').optional(),
        y: num('Top edge').optional(),
        text: z.string().min(1).max(LIMITS.maxTextLength).describe('Use \\n for line breaks'),
        fontSize: z.number().min(6).max(200).optional().describe('Default 20'),
        fontWeight: z.enum(['normal', 'bold']).optional(),
        align: z.enum(['left', 'center', 'right']).optional(),
        width: size('Wrap text at this width').optional(),
        color: color.optional().describe('Text color. Default #1e1e1e.'),
        opacity: styleFields.opacity,
        rotation: styleFields.rotation,
    }),
]);

export type ShapeInput = z.infer<typeof shapeInputSchema>;

export const updateInputSchema = z.object({
    id: shapeId,
    x: num('New left edge / origin x').optional(),
    y: num('New top edge / origin y').optional(),
    dx: num('Move right by this many px').optional(),
    dy: num('Move down by this many px').optional(),
    width: size('rect/ellipse/diamond/image width, or text wrap width').optional(),
    height: size('rect/ellipse/diamond/image height').optional(),
    label: z.union([labelInput, z.null()]).optional().describe('New label, or null to remove it'),
    text: z.string().min(1).max(LIMITS.maxTextLength).optional().describe('Text content (text shapes)'),
    fontSize: z.number().min(6).max(400).optional(),
    fontWeight: z.enum(['normal', 'bold']).optional(),
    align: z.enum(['left', 'center', 'right']).optional(),
    cornerRadius: z.number().min(0).max(1000).optional(),
    start: endpointInput.optional().describe('Lines/arrows: new start point or shape'),
    end: endpointInput.optional().describe('Lines/arrows: new end point or shape'),
    via: z.array(pointInput).max(50).optional(),
    color: color.optional().describe('Alias for strokeColor (handy for text and math)'),
    latex: z.string().min(1).max(LIMITS.maxLatexLength).optional().describe('New LaTeX (math shapes)'),
    displayMode: z.boolean().optional().describe('Math shapes: display (true) or inline style'),
    ...styleFields,
});

export type UpdateInput = z.infer<typeof updateInputSchema>;

const BOX_DEFAULTS = { rect: { width: 160, height: 80 }, ellipse: { width: 160, height: 80 }, diamond: { width: 160, height: 120 } } as const;

function toLabel(label: z.infer<typeof labelInput> | undefined): TextLabel | undefined {
    if (label === undefined) return undefined;
    return typeof label === 'string' ? { text: label } : label;
}

export interface BuildContext {
    existing: ReadonlyMap<string, Shape>;
    origin: Origin;
    measurer: Measurer;
}

export interface BuiltShapes {
    shapes: Shape[];
    bounds: Box | null;
}

/** Converts AI inputs into protocol shapes (ids, z-order, bindings, auto-placement). */
export function buildShapes(inputs: ShapeInput[], placement: 'exact' | 'auto' | undefined, ctx: BuildContext): BuiltShapes {
    const now = Date.now();
    let z = maxZ(ctx.existing.values());
    const batch = new Map<string, Shape>();
    const lookup = (id: string) => batch.get(id) ?? ctx.existing.get(id);
    const needsPlacement: Shape[] = [];

    for (const input of inputs) {
        const id = input.id ?? randomUUID();
        if (ctx.existing.has(id)) throw new ToolInputError(`A shape with id "${id}" already exists. Use update_shapes to change it, or pick another id.`);
        if (batch.has(id)) throw new ToolInputError(`Duplicate id "${id}" in this call.`);
        const base = {
            id,
            z: ++z,
            updatedAt: now,
            createdBy: ctx.origin,
            rotation: 'rotation' in input && input.rotation !== undefined ? input.rotation : 0,
            opacity: input.opacity ?? 1,
        };
        let shape: Shape;
        switch (input.type) {
            case 'rect':
            case 'ellipse':
            case 'diamond': {
                const label = toLabel(input.label);
                const defaults = BOX_DEFAULTS[input.type];
                const labelWidth = label ? measureTextWidth(longestLine(label.text), label.fontSize ?? DEFAULTS.labelFontSize) : 0;
                const fitWidth = input.type === 'diamond' ? labelWidth * 1.7 + 40 : labelWidth + 40;
                const width = input.width ?? Math.min(480, Math.max(defaults.width, Math.ceil(fitWidth)));
                shape = {
                    ...base,
                    type: input.type,
                    x: input.x ?? 0,
                    y: input.y ?? 0,
                    width,
                    height: input.height ?? defaults.height,
                    strokeColor: input.strokeColor ?? DEFAULTS.strokeColor,
                    strokeWidth: input.strokeWidth ?? DEFAULTS.strokeWidth,
                    fillColor: input.fillColor ?? DEFAULTS.fillColor,
                    ...(label ? { label } : {}),
                    ...(input.type === 'rect' ? { cornerRadius: input.cornerRadius ?? 8 } : {}),
                } as Shape;
                if (input.x === undefined || input.y === undefined) needsPlacement.push(shape);
                break;
            }
            case 'arrow':
            case 'line': {
                shape = buildLine({ ...base, type: input.type }, input.start, input.end, input.via, lookup);
                Object.assign(shape, {
                    strokeColor: input.strokeColor ?? DEFAULTS.strokeColor,
                    strokeWidth: input.strokeWidth ?? DEFAULTS.strokeWidth,
                    fillColor: 'transparent',
                });
                const label = toLabel(input.label);
                if (label) (shape as LineShape).label = label;
                break;
            }
            case 'freehand': {
                const [x0, y0] = input.points[0];
                shape = {
                    ...base,
                    type: 'freehand',
                    x: x0,
                    y: y0,
                    points: input.points.flatMap(([x, y]) => [x - x0, y - y0]),
                    strokeColor: input.strokeColor ?? DEFAULTS.strokeColor,
                    strokeWidth: input.strokeWidth ?? 3,
                    fillColor: 'transparent',
                };
                break;
            }
            case 'text': {
                shape = {
                    ...base,
                    type: 'text',
                    x: input.x ?? 0,
                    y: input.y ?? 0,
                    text: input.text,
                    fontSize: input.fontSize ?? DEFAULTS.fontSize,
                    fontWeight: input.fontWeight ?? 'normal',
                    align: input.align ?? 'left',
                    ...(input.width ? { width: input.width } : {}),
                    strokeColor: input.color ?? DEFAULTS.strokeColor,
                    strokeWidth: 0,
                    fillColor: 'transparent',
                };
                if (input.x === undefined || input.y === undefined) needsPlacement.push(shape);
                break;
            }
        }
        batch.set(id, shape);
    }

    const shapes = Array.from(batch.values());
    if (placement === 'exact' && needsPlacement.length) {
        throw new ToolInputError('placement "exact" needs x and y on every rect/ellipse/diamond/text shape. Omit placement to auto-place the ones without coordinates.');
    }
    if (needsPlacement.length) stackUnplaced(needsPlacement, ctx.measurer, lookup);
    if (placement === 'auto') {
        // Move the whole batch next to existing content.
        placeInFreeSpace(shapes, shapes, ctx, lookup);
    } else if (needsPlacement.length) {
        // Only shapes without coordinates move; explicitly placed ones stay where they were put.
        placeInFreeSpace(needsPlacement, shapes, ctx, lookup);
    }
    checkExtents(shapes, inputs);
    const bounds = unionBoxes(shapes.map((s) => getShapeBounds(s, lookup, ctx.measurer)));
    return { shapes, bounds };
}

/** Rejects shapes whose coordinates or point offsets fall outside the board's limits. */
function checkExtents(shapes: Shape[], inputs: ShapeInput[]) {
    const max = LIMITS.maxCoordinate;
    shapes.forEach((shape, i) => {
        const values = [shape.x, shape.y, ...('points' in shape ? shape.points : [])];
        if (values.some((v) => !Number.isFinite(v) || Math.abs(v) > max)) {
            const input = inputs[i];
            throw new ToolInputError(
                `Shape #${i + 1}${input?.id ? ` ("${input.id}")` : ''} (${shape.type}) would lie outside the board area: coordinates and line lengths must stay within ±${max}. Use coordinates closer to existing content.`,
            );
        }
    });
}

function longestLine(text: string) {
    return text.split('\n').reduce((a, b) => (b.length > a.length ? b : a), '');
}

type Endpoint = z.infer<typeof endpointInput>;

function endpointPoint(end: Endpoint, lookup: (id: string) => Shape | undefined): { x: number; y: number; bindTo?: string } {
    if ('shapeId' in end) {
        const target = lookup(end.shapeId);
        if (!target) throw new ToolInputError(`Shape "${end.shapeId}" does not exist (connect to shapes that exist or are created earlier in the same call).`);
        if (!isBindable(target)) throw new ToolInputError(`Shape "${end.shapeId}" is a ${target.type}; lines can only attach to rect, ellipse, diamond or image shapes.`);
        const c = boxCenter(target);
        return { x: c.x, y: c.y, bindTo: target.id };
    }
    return end;
}

function buildLine(
    base: Omit<LineShape, 'x' | 'y' | 'points' | 'strokeColor' | 'strokeWidth' | 'fillColor'>,
    start: Endpoint,
    end: Endpoint,
    via: { x: number; y: number }[] | undefined,
    lookup: (id: string) => Shape | undefined,
): LineShape {
    const s = endpointPoint(start, lookup);
    const e = endpointPoint(end, lookup);
    if (s.bindTo && s.bindTo === e.bindTo) throw new ToolInputError('A line cannot start and end on the same shape.');
    const abs = [s, ...(via ?? []), e];
    const line = {
        ...base,
        x: s.x,
        y: s.y,
        points: abs.flatMap((p) => [p.x - s.x, p.y - s.y]),
        strokeColor: DEFAULTS.strokeColor,
        strokeWidth: DEFAULTS.strokeWidth,
        fillColor: 'transparent',
    } as LineShape;
    if (s.bindTo) line.startBinding = { shapeId: s.bindTo };
    if (e.bindTo) line.endBinding = { shapeId: e.bindTo };
    return line;
}

/** Shapes given without coordinates are stacked vertically with a gap. */
function stackUnplaced(shapes: Shape[], measurer: Measurer, lookup: (id: string) => Shape | undefined) {
    let cursor = 0;
    for (const shape of shapes) {
        shape.x = 0;
        shape.y = cursor;
        cursor += getShapeBounds(shape, lookup, measurer).height + 40;
    }
}

/** Moves `movable` (as a group) to the right of existing content and of the other shapes in `batch`. */
function placeInFreeSpace(movable: Shape[], batch: Shape[], ctx: BuildContext, lookup: (id: string) => Shape | undefined) {
    const ids = new Set(batch.map((s) => s.id));
    const moving = new Set(movable.map((s) => s.id));
    // Connectors attached to shapes outside this batch stay put (they follow their shapes anyway).
    const group = movable.filter((s) => !(isLinear(s) && (s.startBinding || s.endBinding) && !bindingsInBatch(s, ids)));
    const groupBounds = unionBoxes(group.map((s) => getShapeBounds(s, lookup, ctx.measurer)));
    if (!groupBounds) return;
    const obstacles = [
        ...Array.from(ctx.existing.values()).map((s) => getShapeBounds(s, (id) => ctx.existing.get(id), ctx.measurer)),
        ...batch.filter((s) => !moving.has(s.id)).map((s) => getShapeBounds(s, lookup, ctx.measurer)),
    ];
    const occupied = unionBoxes(obstacles);
    const target = occupied ? { x: occupied.x + occupied.width + 120, y: occupied.y } : { x: 100, y: 100 };
    const dx = target.x - groupBounds.x;
    const dy = target.y - groupBounds.y;
    for (const s of group) {
        s.x += dx;
        s.y += dy;
    }
}

function bindingsInBatch(line: LineShape, ids: Set<string>) {
    return (!line.startBinding || ids.has(line.startBinding.shapeId)) && (!line.endBinding || ids.has(line.endBinding.shapeId));
}

/** Converts an AI update request into protocol changes for `shape`. */
export function buildChanges(shape: Shape, input: UpdateInput, lookup: (id: string) => Shape | undefined): ShapeChanges {
    const changes: ShapeChanges = {};
    const unsupported: string[] = [];
    const is = (...types: Shape['type'][]) => types.includes(shape.type);
    const set = <K extends keyof ShapeChanges>(key: K, value: ShapeChanges[K] | undefined, allowed: boolean, name: string = key) => {
        if (value === undefined) return;
        if (!allowed) unsupported.push(name);
        else changes[key] = value;
    };

    if (input.x !== undefined && input.dx !== undefined) throw new ToolInputError(`Update for "${shape.id}": use either x or dx, not both.`);
    if (input.y !== undefined && input.dy !== undefined) throw new ToolInputError(`Update for "${shape.id}": use either y or dy, not both.`);
    const moveX = input.x ?? (input.dx !== undefined ? shape.x + input.dx : undefined);
    const moveY = input.y ?? (input.dy !== undefined ? shape.y + input.dy : undefined);
    const linear = isLinear(shape);
    const moving = moveX !== undefined || moveY !== undefined;

    if (linear && (input.start || input.end || input.via) && moving) {
        throw new ToolInputError(`Update for "${shape.id}": give new start/end/via points directly instead of combining them with x/y/dx/dy.`);
    }
    if (linear && moving && shape.startBinding && shape.endBinding) {
        throw new ToolInputError(
            `"${shape.id}" is attached to shapes at both ends, so it moves with them. Move the connected shapes, or pass start/end to reattach it.`,
        );
    }

    if (linear && (input.start || input.end || input.via)) {
        const abs = resolveLinePoints(shape, lookup);
        const current = { x: abs[0], y: abs[1] };
        const last = { x: abs[abs.length - 2], y: abs[abs.length - 1] };
        const start: Endpoint = input.start ?? (shape.startBinding ? { shapeId: shape.startBinding.shapeId } : current);
        const end: Endpoint = input.end ?? (shape.endBinding ? { shapeId: shape.endBinding.shapeId } : last);
        const via =
            input.via ??
            Array.from({ length: Math.max(0, abs.length / 2 - 2) }, (_, i) => ({ x: abs[(i + 1) * 2], y: abs[(i + 1) * 2 + 1] }));
        const { startBinding: _s, endBinding: _e, ...unbound } = shape;
        void _s;
        void _e;
        const rebuilt = buildLine(unbound, start, end, via, lookup);
        changes.x = rebuilt.x;
        changes.y = rebuilt.y;
        changes.points = rebuilt.points;
        changes.startBinding = rebuilt.startBinding ?? null;
        changes.endBinding = rebuilt.endBinding ?? null;
    } else {
        set('x', moveX, true);
        set('y', moveY, true);
    }

    set('strokeColor', input.strokeColor ?? input.color, !is('image'), input.color ? 'color' : 'strokeColor');
    set('fillColor', input.fillColor, is('rect', 'ellipse', 'diamond'));
    set('strokeWidth', input.strokeWidth, !is('text', 'math', 'image'));
    set('opacity', input.opacity, true);
    set('rotation', input.rotation, true);
    set('width', input.width, is('rect', 'ellipse', 'diamond', 'image', 'text'));
    set('height', input.height, is('rect', 'ellipse', 'diamond', 'image'));
    set('cornerRadius', input.cornerRadius, is('rect'));
    if (input.label !== undefined) set('label', input.label === null ? null : toLabel(input.label), is('rect', 'ellipse', 'diamond', 'line', 'arrow'), 'label');
    set('text', input.text, is('text'));
    set('fontSize', input.fontSize, is('text', 'math'));
    set('fontWeight', input.fontWeight, is('text'));
    set('align', input.align, is('text'));
    set('latex', input.latex, is('math'));
    set('displayMode', input.displayMode, is('math'));
    if (!linear && (input.start || input.end || input.via)) unsupported.push('start/end/via');

    if (unsupported.length) throw new ToolInputError(`Shape "${shape.id}" is a ${shape.type}; it doesn't support: ${unsupported.join(', ')}.`);
    return changes;
}
