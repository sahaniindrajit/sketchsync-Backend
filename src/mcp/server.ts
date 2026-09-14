import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Room } from '../rooms/RoomStore.js';
import type { RoomService } from '../rooms/RoomService.js';
import { boardToPng, DEFAULT_IMAGE_SIZE, MAX_IMAGE_SIZE } from '../render/toPng.js';
import { contentBounds, serverMeasurer, type MathRenderer } from '../render/toSvg.js';
import { getShapeBounds, unionBoxes } from '../shared/geometry.js';
import { splitOp } from '../shared/ops.js';
import { extractRoomId, type Op, type Origin, type ShapePatch } from '../shared/protocol.js';
import { describeBoard, summarizeShape } from './describe.js';
import { buildChanges, buildShapes, shapeInputSchema, ToolInputError, updateInputSchema } from './inputs.js';

export interface McpContext {
    rooms: RoomService;
    /** Room from the connector URL (/mcp/:roomId). */
    defaultRoomId?: string;
    clientName: string;
    frontendUrl: string;
    math?: MathRenderer;
    /** Throws ToolInputError for invalid LaTeX. */
    validateLatex?: (latex: string, fontSize: number, displayMode: boolean) => void;
    /** Extra tools (e.g. flowcharts, math) registered by later modules. */
    extend?: (server: McpServer, helpers: ToolHelpers) => void;
}

export interface ToolHelpers {
    resolveRoom: (board?: string) => Room;
    applyOps: (room: Room, ops: Op[]) => void;
    origin: Origin;
    ok: (text: string, structured?: Record<string, unknown>) => CallToolResult;
    run: <T>(fn: () => T | Promise<T>) => Promise<T | CallToolResult>;
    boardUrl: (roomId: string) => string;
    ctx: McpContext;
}

export const boardArg = z
    .string()
    .max(500)
    .optional()
    .describe('Board link or id. Optional when the connector URL already points at a board (…/mcp/<boardId>).');

const INSTRUCTIONS = `SketchSync is a collaborative whiteboard. These tools read and edit a board live: people viewing it see your changes immediately.

Coordinates: board pixels, origin at the top-left, x grows right, y grows down. A typical screen shows about 1400x800 px around the existing content.
Colors are hex strings ("#1e1e1e", "#e03131", "#1971c2", "#2f9e44", "#f08c00") or "transparent".

Workflow tips:
- Call get_board first to see what exists (ids, positions, labels). Use get_board_image when the board has hand drawings or images, or to check your layout visually.
- Put new diagrams in free space: omit x/y (or pass placement "auto") and they are placed to the right of existing content.
- Connect shapes with arrows using {shapeId}; connectors follow shapes when they move.
- Prefer labels inside shapes over separate text shapes. Keep text short.
- Use update_shapes to change existing shapes instead of deleting and re-adding them.
- For diagrams with several connected boxes use create_flowchart (automatic layout). For formulas use add_math; for step-by-step solutions use write_solution.`;

/** One MCP server per HTTP request (stateless transport). */
export function createMcpServer(ctx: McpContext): McpServer {
    const server = new McpServer({ name: 'sketchsync', title: 'SketchSync whiteboard', version: '1.0.0' }, { instructions: INSTRUCTIONS });
    const origin: Origin = `ai:${ctx.clientName}`;
    const measurer = serverMeasurer(ctx.math);
    const boardUrl = (roomId: string) => `${ctx.frontendUrl.replace(/\/+$/, '')}/board/${roomId}`;

    const resolveRoom = (board?: string): Room => {
        const roomId = board ? extractRoomId(board) : ctx.defaultRoomId;
        if (!roomId) {
            throw new ToolInputError(
                board
                    ? `"${board}" is not a SketchSync board link or id.`
                    : 'No board specified. Pass `board` with the board link (e.g. https://sketchsync.onrender.com/board/<id>), or connect using the board-specific MCP URL.',
            );
        }
        const room = ctx.rooms.getRoom(roomId);
        if (!room) {
            throw new ToolInputError(
                `Board ${roomId} is not open on the server right now. Ask the user to open ${boardUrl(roomId)} in a browser (this loads it), then try again.`,
            );
        }
        return room;
    };

    /** Applies the tool's changes all-or-nothing. */
    const applyOps = (room: Room, ops: Op[]) => {
        const batchId = randomUUID();
        const result = ctx.rooms.applyBatch(
            room.id,
            ops.flatMap((o) => splitOp(o)),
            { origin, batchId, opIdPrefix: `ai-${batchId}` },
        );
        if (!result.ok) throw new ToolInputError(`Nothing was changed: ${result.error}`);
    };

    const ok = (text: string, structured?: Record<string, unknown>): CallToolResult => ({
        content: [{ type: 'text', text: structured ? `${text}\n\n${JSON.stringify(structured, null, 2)}` : text }],
        ...(structured ? { structuredContent: structured } : {}),
    });

    const run = async <T,>(fn: () => T | Promise<T>): Promise<T | CallToolResult> => {
        try {
            return await fn();
        } catch (err) {
            if (err instanceof ToolInputError) return { isError: true, content: [{ type: 'text', text: err.message }] };
            console.error('MCP tool failed', err);
            return { isError: true, content: [{ type: 'text', text: 'Internal error while running this tool.' }] };
        }
    };

    server.registerTool(
        'get_board',
        {
            title: 'Read the board',
            description:
                'Lists the shapes on the board: ids, types, bounding boxes, labels/text, colors, and line endpoints (with the shapes they connect). Call this before editing. Freehand strokes are summarized; use get_board_image to actually see drawings.',
            inputSchema: {
                board: boardArg,
                detail: z.enum(['summary', 'full']).optional().describe('"full" also includes freehand point lists. Default "summary".'),
                ids: z.array(z.string()).max(1000).optional().describe('Only describe these shapes'),
                limit: z.number().int().min(1).max(2000).optional().describe('Max shapes to list (default 300)'),
            },
            annotations: { readOnlyHint: true, openWorldHint: false },
        },
        ({ board, detail, ids, limit }) =>
            run(() => {
                const room = resolveRoom(board);
                const description = describeBoard(room.shapes, measurer, { full: detail === 'full', ids, limit });
                return ok(`Board ${room.id} (${boardUrl(room.id)}) has ${description.shapeCount} shape(s).`, { boardId: room.id, boardUrl: boardUrl(room.id), ...description });
            }),
    );

    server.registerTool(
        'add_shapes',
        {
            title: 'Add shapes',
            description:
                'Adds rectangles, ellipses, diamonds, arrows/lines (optionally connected to shapes by id), freehand strokes and text. Shapes can reference ids created earlier in the same call. Omit x/y to auto-place in free space. Returns the created ids and bounds.',
            inputSchema: {
                board: boardArg,
                shapes: z.array(shapeInputSchema).min(1).max(200),
                placement: z
                    .enum(['exact', 'auto'])
                    .optional()
                    .describe(
                        'Default: shapes with x/y stay where given and shapes without x/y are placed in free space. "auto" moves the whole group next to existing content. "exact" requires x/y on every box and text.',
                    ),
            },
            annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
        },
        ({ board, shapes, placement }) =>
            run(() => {
                const room = resolveRoom(board);
                const built = buildShapes(shapes, placement, { existing: room.shapes, origin, measurer });
                applyOps(room, [{ kind: 'add', shapes: built.shapes }]);
                const created = built.shapes.map((s) => summarizeShape(room.shapes.get(s.id) ?? s, room.shapes, measurer));
                return ok(`Added ${created.length} shape(s) to the board.`, { created, groupBounds: built.bounds });
            }),
    );

    server.registerTool(
        'update_shapes',
        {
            title: 'Update shapes',
            description:
                'Changes existing shapes: move (x/y or dx/dy), resize, relabel, recolor, edit text, or reconnect arrows (start/end with {x,y} or {shapeId}). Only fields that apply to each shape type are allowed. Arrows attached at both ends move with their shapes; for arrows attached at one end, dx/dy moves the free end. All updates in a call apply together or not at all.',
            inputSchema: {
                board: boardArg,
                updates: z.array(updateInputSchema).min(1).max(500),
            },
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
        },
        ({ board, updates }) =>
            run(() => {
                const room = resolveRoom(board);
                const seen = new Set<string>();
                for (const u of updates) {
                    if (seen.has(u.id)) throw new ToolInputError(`"${u.id}" appears more than once; combine its changes into one update.`);
                    seen.add(u.id);
                }
                const missing = updates.filter((u) => !room.shapes.has(u.id)).map((u) => u.id);
                if (missing.length) throw new ToolInputError(`Unknown shape id(s): ${missing.join(', ')}. Call get_board to see current ids.`);
                const lookup = (id: string) => room.shapes.get(id);
                const patches: ShapePatch[] = updates.map((u) => ({ id: u.id, changes: buildChanges(room.shapes.get(u.id)!, u, lookup) }));
                for (const patch of patches) {
                    const shape = room.shapes.get(patch.id)!;
                    if (shape.type === 'math' && (patch.changes.latex || patch.changes.fontSize || patch.changes.displayMode !== undefined)) {
                        ctx.validateLatex?.(patch.changes.latex ?? shape.latex, patch.changes.fontSize ?? shape.fontSize, patch.changes.displayMode ?? shape.displayMode);
                    }
                }
                applyOps(room, [{ kind: 'update', patches }]);
                const updated = updates.map((u) => summarizeShape(room.shapes.get(u.id)!, room.shapes, measurer));
                return ok(`Updated ${updated.length} shape(s).`, { updated });
            }),
    );

    server.registerTool(
        'delete_shapes',
        {
            title: 'Delete shapes',
            description: 'Deletes shapes by id. Arrows attached to deleted shapes stay where they are but become unattached.',
            inputSchema: { board: boardArg, ids: z.array(z.string()).min(1).max(2000) },
            annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
        },
        ({ board, ids }) =>
            run(() => {
                const room = resolveRoom(board);
                const existing = ids.filter((id) => room.shapes.has(id));
                const unknown = ids.filter((id) => !room.shapes.has(id));
                if (existing.length) applyOps(room, [{ kind: 'delete', ids: existing }]);
                return ok(`Deleted ${existing.length} shape(s).${unknown.length ? ` Not found: ${unknown.join(', ')}.` : ''}`);
            }),
    );

    server.registerTool(
        'clear_board',
        {
            title: 'Clear the board',
            description: 'Removes EVERY shape from the board for everyone. Only use when the user explicitly asks to clear or start over.',
            inputSchema: { board: boardArg, confirm: z.literal(true).describe('Must be true') },
            annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
        },
        ({ board }) =>
            run(() => {
                const room = resolveRoom(board);
                const count = room.shapes.size;
                applyOps(room, [{ kind: 'clear' }]);
                return ok(`Cleared the board (${count} shape(s) removed).`);
            }),
    );

    server.registerTool(
        'get_board_image',
        {
            title: 'Look at the board',
            description:
                'Renders the board (or part of it) to a PNG so you can see hand-drawn sketches, handwriting, images and overall layout. The response says which board area the image covers and the scale, so you can convert image pixels to board coordinates.',
            inputSchema: {
                board: boardArg,
                region: z
                    .object({
                        x: z.number().finite().min(-1_000_000).max(1_000_000),
                        y: z.number().finite().min(-1_000_000).max(1_000_000),
                        width: z.number().finite().min(1).max(100000),
                        height: z.number().finite().min(1).max(100000),
                    })
                    .optional()
                    .describe('Board area to render. Default: all content plus padding.'),
                shapeIds: z.array(z.string()).max(2000).optional().describe('Render the area around these shapes'),
                maxSize: z.number().int().min(64).max(MAX_IMAGE_SIZE).optional().describe(`Longest image edge in px (default ${DEFAULT_IMAGE_SIZE})`),
            },
            annotations: { readOnlyHint: true, openWorldHint: false },
        },
        ({ board, region, shapeIds, maxSize }) =>
            run(() => {
                const room = resolveRoom(board);
                if (room.shapes.size === 0 && !region) return ok('The board is empty.');
                let area = region;
                if (!area && shapeIds?.length) {
                    const lookup = (id: string) => room.shapes.get(id);
                    const found = shapeIds.map(lookup).filter((s) => !!s);
                    if (!found.length) throw new ToolInputError('None of those shape ids exist.');
                    const b = unionBoxes(found.map((s) => getShapeBounds(s!, lookup, measurer)))!;
                    area = { x: b.x - 40, y: b.y - 40, width: b.width + 80, height: b.height + 80 };
                }
                const result = boardToPng(room.shapes, { region: area, maxSize, math: ctx.math });
                const r = (v: number) => Math.round(v * 10) / 10;
                const content = contentBounds(room.shapes, ctx.math);
                const text =
                    `Image ${result.width}x${result.height}px of board area x=${r(result.region.x)}, y=${r(result.region.y)}, ` +
                    `width=${r(result.region.width)}, height=${r(result.region.height)} (scale ${result.scale} px per board unit). ` +
                    `Board point = (${r(result.region.x)} + imageX / ${result.scale}, ${r(result.region.y)} + imageY / ${result.scale}).` +
                    (content ? ` All content spans x=${r(content.x)}..${r(content.x + content.width)}, y=${r(content.y)}..${r(content.y + content.height)}.` : '');
                return {
                    content: [
                        { type: 'image', data: result.png.toString('base64'), mimeType: 'image/png' },
                        { type: 'text', text },
                    ],
                } satisfies CallToolResult;
            }),
    );

    ctx.extend?.(server, { resolveRoom, applyOps, origin, ok, run, boardUrl, ctx });
    return server;
}
