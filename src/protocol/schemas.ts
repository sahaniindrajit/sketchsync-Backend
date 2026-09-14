import { z } from 'zod';
import { LIMITS, type Op, type Shape, type ShapeChanges } from '../shared/protocol.js';

const coord = z.number().finite().min(-LIMITS.maxCoordinate).max(LIMITS.maxCoordinate);
const size = z.number().finite().min(-LIMITS.maxCoordinate).max(LIMITS.maxCoordinate);
const positiveSize = z.number().finite().min(0).max(LIMITS.maxCoordinate);
export const colorSchema = z
    .string()
    .regex(/^(#[0-9a-fA-F]{3}|#[0-9a-fA-F]{4}|#[0-9a-fA-F]{6}|#[0-9a-fA-F]{8}|transparent)$/, 'Use a hex color like #1e1e1e or "transparent"');
const idSchema = z.string().min(1).max(64).regex(/^[A-Za-z0-9_\-:.]+$/, 'ids may only contain letters, digits, _ - : .');
const fontSize = z.number().finite().min(4).max(400);
const pointsSchema = z
    .array(coord)
    .max(LIMITS.maxPointsPerShape)
    .refine((p) => p.length % 2 === 0, 'points must be a flat [x0, y0, x1, y1, ...] array');

export const textLabelSchema = z.object({
    text: z.string().max(LIMITS.maxTextLength),
    fontSize: fontSize.optional(),
    color: colorSchema.optional(),
});

export const bindingSchema = z.object({ shapeId: idSchema });

const base = {
    id: idSchema,
    x: coord,
    y: coord,
    rotation: z.number().finite().min(-3600).max(3600),
    opacity: z.number().min(0).max(1),
    strokeColor: colorSchema,
    strokeWidth: z.number().finite().min(0).max(200),
    fillColor: colorSchema,
    z: z.number().finite(),
    updatedAt: z.number().finite(),
    createdBy: z.string().max(200),
};

const imageSrc = z
    .string()
    .max(Math.ceil((LIMITS.maxImageBytes * 4) / 3) + 100, 'image is larger than 1 MB')
    .regex(/^data:image\/(png|jpeg|gif|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/, 'src must be a base64 data: URL (png, jpeg, gif, webp or svg)');

export const shapeSchema = z.discriminatedUnion('type', [
    z.object({ ...base, type: z.literal('rect'), width: size, height: size, cornerRadius: positiveSize.optional(), label: textLabelSchema.optional() }),
    z.object({ ...base, type: z.literal('ellipse'), width: size, height: size, label: textLabelSchema.optional() }),
    z.object({ ...base, type: z.literal('diamond'), width: size, height: size, label: textLabelSchema.optional() }),
    z.object({
        ...base,
        type: z.enum(['line', 'arrow']),
        points: pointsSchema,
        startBinding: bindingSchema.optional(),
        endBinding: bindingSchema.optional(),
        label: textLabelSchema.optional(),
    }),
    z.object({ ...base, type: z.literal('freehand'), points: pointsSchema }),
    z.object({
        ...base,
        type: z.literal('text'),
        text: z.string().max(LIMITS.maxTextLength),
        fontSize,
        fontWeight: z.enum(['normal', 'bold']),
        align: z.enum(['left', 'center', 'right']),
        width: positiveSize.optional(),
    }),
    z.object({ ...base, type: z.literal('math'), latex: z.string().min(1).max(LIMITS.maxLatexLength), fontSize, displayMode: z.boolean() }),
    z.object({ ...base, type: z.literal('image'), src: imageSrc, width: size, height: size }),
]);

export const shapeChangesSchema = z
    .object({
        x: coord,
        y: coord,
        rotation: base.rotation,
        opacity: base.opacity,
        strokeColor: colorSchema,
        strokeWidth: base.strokeWidth,
        fillColor: colorSchema,
        z: base.z,
        updatedAt: base.updatedAt,
        createdBy: base.createdBy,
        width: size.nullable(),
        height: size,
        cornerRadius: positiveSize.nullable(),
        label: textLabelSchema.nullable(),
        points: pointsSchema,
        startBinding: bindingSchema.nullable(),
        endBinding: bindingSchema.nullable(),
        text: z.string().max(LIMITS.maxTextLength),
        fontSize,
        fontWeight: z.enum(['normal', 'bold']),
        align: z.enum(['left', 'center', 'right']),
        latex: z.string().min(1).max(LIMITS.maxLatexLength),
        displayMode: z.boolean(),
        src: imageSrc,
    })
    .partial()
    .strict();

export const opSchema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('add'), shapes: z.array(shapeSchema).min(1).max(LIMITS.maxShapesPerOp) }),
    z.object({
        kind: z.literal('update'),
        patches: z.array(z.object({ id: idSchema, changes: shapeChangesSchema })).min(1).max(LIMITS.maxShapesPerOp),
    }),
    z.object({ kind: z.literal('append-points'), id: idSchema, points: pointsSchema.refine((p) => p.length > 0, 'points required') }),
    z.object({ kind: z.literal('delete'), ids: z.array(idSchema).min(1).max(LIMITS.maxShapesPerOp) }),
    z.object({ kind: z.literal('clear') }),
]);

// Compile-time checks that the zod schemas and the shared TS types agree.
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;
export type _ShapeMatches = Assert<Equals<z.infer<typeof shapeSchema>, Shape>>;
export type _ChangesMatch = Assert<Equals<z.infer<typeof shapeChangesSchema>, ShapeChanges>>;
export type _OpMatches = Assert<Equals<z.infer<typeof opSchema>, Op>>;

/** Fields each shape type accepts in an update patch. */
const COMMON_FIELDS = ['x', 'y', 'rotation', 'opacity', 'strokeColor', 'strokeWidth', 'fillColor', 'z', 'updatedAt', 'createdBy'];
export const PATCHABLE_FIELDS: Record<Shape['type'], ReadonlySet<string>> = {
    rect: new Set([...COMMON_FIELDS, 'width', 'height', 'cornerRadius', 'label']),
    ellipse: new Set([...COMMON_FIELDS, 'width', 'height', 'label']),
    diamond: new Set([...COMMON_FIELDS, 'width', 'height', 'label']),
    line: new Set([...COMMON_FIELDS, 'points', 'startBinding', 'endBinding', 'label']),
    arrow: new Set([...COMMON_FIELDS, 'points', 'startBinding', 'endBinding', 'label']),
    freehand: new Set([...COMMON_FIELDS, 'points']),
    text: new Set([...COMMON_FIELDS, 'text', 'fontSize', 'fontWeight', 'align', 'width']),
    math: new Set([...COMMON_FIELDS, 'latex', 'fontSize', 'displayMode']),
    image: new Set([...COMMON_FIELDS, 'src', 'width', 'height']),
};

/**
 * Human-friendly zod error text for tool results and socket acks. When the
 * failing value is an op, array indices are replaced by shape ids so the
 * message still makes sense after ops were split into chunks.
 */
export function formatZodError(error: z.ZodError, input?: unknown): string {
    const op = input as { shapes?: { id?: unknown }[]; patches?: { id?: unknown }[] } | undefined;
    const describe = (path: PropertyKey[]) => {
        if (!path.length) return '(root)';
        const [head, index, ...rest] = path;
        const list = head === 'shapes' ? op?.shapes : head === 'patches' ? op?.patches : undefined;
        const id = typeof index === 'number' ? list?.[index]?.id : undefined;
        if (typeof id === 'string') {
            const field = (head === 'patches' && rest[0] === 'changes' ? rest.slice(1) : rest).map(String).join('.');
            return `${head === 'shapes' ? 'shape' : 'update for'} "${id}"${field ? ` (${field})` : ''}`;
        }
        return path.map(String).join('.');
    };
    return error.issues
        .slice(0, 8)
        .map((i) => `${describe(i.path)}: ${i.message}`)
        .join('; ');
}
