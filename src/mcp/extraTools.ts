import { randomUUID } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { colorSchema } from '../protocol/schemas.js';
import { layoutFlowchart, type FlowchartLayout, type FlowNodeKind } from '../layout/flowchart.js';
import { textBlockSize } from '../render/fonts.js';
import { renderLatex } from '../render/math.js';
import { serverMeasurer } from '../render/toSvg.js';
import { getShapeBounds, unionBoxes, type Box } from '../shared/geometry.js';
import { maxZ } from '../shared/ops.js';
import { DEFAULTS, LIMITS, type LineShape, type MathShape, type Shape, type TextShape } from '../shared/protocol.js';
import { summarizeShape } from './describe.js';
import { ToolInputError } from './inputs.js';
import { boardArg, type ToolHelpers } from './server.js';

const idSchema = z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9_\-:.]+$/, 'ids may only contain letters, digits, _ - : .');
const coord = z.number().finite().min(-LIMITS.maxCoordinate).max(LIMITS.maxCoordinate);
const latexSchema = z.string().min(1).max(LIMITS.maxLatexLength);

const KIND_STYLE: Record<FlowNodeKind, { type: 'rect' | 'diamond'; fillColor: string; cornerRadius?: (h: number) => number }> = {
    process: { type: 'rect', fillColor: '#a5d8ff', cornerRadius: () => 8 },
    decision: { type: 'diamond', fillColor: '#ffec99' },
    terminal: { type: 'rect', fillColor: '#b2f2bb', cornerRadius: (h) => h / 2 },
    io: { type: 'rect', fillColor: '#eebefa', cornerRadius: () => 2 },
    note: { type: 'rect', fillColor: '#fff3bf', cornerRadius: () => 2 },
};

/** Where to put a new block of content: given coordinates, or to the right of existing content. */
function placementOrigin(existing: ReadonlyMap<string, Shape>, x: number | undefined, y: number | undefined, measurer: ReturnType<typeof serverMeasurer>) {
    if (x !== undefined && y !== undefined) return { x, y };
    const bounds = unionBoxes(Array.from(existing.values()).map((s) => getShapeBounds(s, (id) => existing.get(id), measurer)));
    if (!bounds) return { x: x ?? 100, y: y ?? 100 };
    return { x: x ?? bounds.x + bounds.width + 120, y: y ?? bounds.y };
}

/** Throws a helpful error for invalid LaTeX. */
export function checkLatex(latex: string, fontSize: number, displayMode: boolean) {
    const rendered = renderLatex(latex, fontSize, displayMode);
    if (rendered.error) throw new ToolInputError(`LaTeX error in "${latex.slice(0, 80)}": ${rendered.error}`);
    return rendered;
}

export function registerExtraTools(server: McpServer, helpers: ToolHelpers) {
    const { resolveRoom, applyOps, origin, ok, run } = helpers;
    const measurer = serverMeasurer(helpers.ctx.math);

    server.registerTool(
        'create_flowchart',
        {
            title: 'Create a flowchart',
            description:
                'Draws a complete flowchart/diagram with automatic layout: give nodes and edges, and the server positions boxes and connects them with arrows that follow the boxes. Use for processes, decision trees, architectures, org charts, mind maps (direction "LR"), state machines. Node kinds: process (rounded box), decision (diamond), terminal (start/end pill), io (input/output), note.',
            inputSchema: {
                board: boardArg,
                nodes: z
                    .array(
                        z.object({
                            id: idSchema.describe('Your id for this node; used by edges and returned as the shape id'),
                            label: z.string().min(1).max(500),
                            kind: z.enum(['process', 'decision', 'terminal', 'io', 'note']).optional().describe('Default "process"'),
                            fillColor: colorSchema.optional(),
                        }),
                    )
                    .min(1)
                    .max(150),
                edges: z
                    .array(z.object({ from: idSchema, to: idSchema, label: z.string().max(100).optional().describe('e.g. "yes" / "no"') }))
                    .max(300)
                    .default([]),
                direction: z.enum(['TB', 'LR', 'BT', 'RL']).optional().describe('TB = top to bottom (default), LR = left to right'),
                x: coord.optional().describe('Left edge of the chart; omit to place next to existing content'),
                y: coord.optional().describe('Top edge of the chart'),
                title: z.string().max(200).optional().describe('Optional bold title above the chart'),
            },
            annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
        },
        ({ board, nodes, edges, direction, x, y, title }) =>
            run(() => {
                const room = resolveRoom(board);
                const ids = new Set<string>();
                for (const n of nodes) {
                    if (ids.has(n.id)) throw new ToolInputError(`Duplicate node id "${n.id}".`);
                    if (room.shapes.has(n.id)) throw new ToolInputError(`A shape with id "${n.id}" already exists on the board; use different node ids.`);
                    ids.add(n.id);
                }
                for (const e of edges) {
                    if (!ids.has(e.from) || !ids.has(e.to)) throw new ToolInputError(`Edge ${e.from} → ${e.to} references a node that isn't in "nodes".`);
                    if (e.from === e.to) throw new ToolInputError(`Edge ${e.from} → ${e.to} connects a node to itself, which isn't supported.`);
                }

                let layout: FlowchartLayout;
                try {
                    layout = layoutFlowchart(nodes, edges, { direction });
                } catch (err) {
                    console.error('Flowchart layout failed', err);
                    throw new ToolInputError('Could not lay out this flowchart. Try removing duplicate or crossing back-edges, or split it into smaller charts.');
                }
                const titleHeight = title ? textBlockSize(title, 28, 'bold').height + 24 : 0;
                const at = placementOrigin(room.shapes, x, y, measurer);
                const ox = at.x;
                const oy = at.y + titleHeight;
                const now = Date.now();
                let z = maxZ(room.shapes.values());
                const base = () => ({ rotation: 0, opacity: 1, z: ++z, updatedAt: now, createdBy: origin, strokeColor: DEFAULTS.strokeColor, strokeWidth: 2 });
                const shapes: Shape[] = [];

                if (title) {
                    shapes.push({ ...base(), id: randomUUID(), type: 'text', x: ox, y: at.y, text: title, fontSize: 28, fontWeight: 'bold', align: 'left', strokeWidth: 0, fillColor: 'transparent' } satisfies TextShape);
                }
                const nodeInput = new Map(nodes.map((n) => [n.id, n]));
                for (const n of layout.nodes) {
                    const style = KIND_STYLE[n.kind];
                    shapes.push({
                        ...base(),
                        id: n.id,
                        type: style.type,
                        x: ox + n.x,
                        y: oy + n.y,
                        width: n.width,
                        height: n.height,
                        fillColor: nodeInput.get(n.id)?.fillColor ?? style.fillColor,
                        label: { text: n.label },
                        ...(style.cornerRadius ? { cornerRadius: style.cornerRadius(n.height) } : {}),
                    } as Shape);
                }
                const nodeShapes = new Map(shapes.map((s) => [s.id, s]));
                for (const e of layout.edges) {
                    const from = nodeShapes.get(e.from) as Extract<Shape, { width: number }>;
                    const start = { x: from.x + from.width / 2, y: from.y + from.height / 2 };
                    const via = e.via.map((p) => ({ x: ox + p.x, y: oy + p.y }));
                    const to = nodeShapes.get(e.to) as Extract<Shape, { width: number }>;
                    const end = { x: to.x + to.width / 2, y: to.y + to.height / 2 };
                    const abs = [start, ...via, end];
                    shapes.push({
                        ...base(),
                        id: randomUUID(),
                        type: 'arrow',
                        x: start.x,
                        y: start.y,
                        points: abs.flatMap((p) => [p.x - start.x, p.y - start.y]),
                        startBinding: { shapeId: e.from },
                        endBinding: { shapeId: e.to },
                        fillColor: 'transparent',
                        ...(e.label ? { label: { text: e.label } } : {}),
                    } satisfies LineShape);
                }
                // Arrows below boxes so labels stay readable.
                const arrows = shapes.filter((s) => s.type === 'arrow');
                const others = shapes.filter((s) => s.type !== 'arrow');
                let zi = maxZ(room.shapes.values());
                for (const s of [...arrows, ...others]) s.z = ++zi;

                applyOps(room, [{ kind: 'add', shapes }]);
                const bounds = unionBoxes(shapes.map((s) => getShapeBounds(s, (id) => room.shapes.get(id), measurer)));
                return ok(`Created a flowchart with ${layout.nodes.length} node(s) and ${layout.edges.length} connector(s). Node shape ids are the node ids you gave.`, {
                    nodeIds: layout.nodes.map((n) => n.id),
                    connectorIds: arrows.map((a) => a.id),
                    bounds,
                });
            }),
    );

    server.registerTool(
        'add_math',
        {
            title: 'Add a math formula',
            description:
                'Adds a LaTeX formula rendered as real math (fractions, roots, integrals, matrices, aligned equations via \\begin{aligned}, chemistry via \\ce{...}). Invalid LaTeX returns an error explaining what is wrong.',
            inputSchema: {
                board: boardArg,
                latex: latexSchema.describe('LaTeX without surrounding $…$, e.g. "x = \\\\frac{-b \\\\pm \\\\sqrt{b^2-4ac}}{2a}"'),
                x: coord.optional(),
                y: coord.optional(),
                fontSize: z.number().min(8).max(200).optional().describe('Default 24'),
                displayMode: z.boolean().optional().describe('Display (large operators, default true) or inline style'),
                color: colorSchema.optional(),
            },
            annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
        },
        ({ board, latex, x, y, fontSize, displayMode, color }) =>
            run(() => {
                const room = resolveRoom(board);
                const size = fontSize ?? DEFAULTS.mathFontSize;
                const display = displayMode ?? true;
                const rendered = checkLatex(latex, size, display);
                const at = placementOrigin(room.shapes, x, y, measurer);
                const shape: MathShape = {
                    id: randomUUID(),
                    type: 'math',
                    x: at.x,
                    y: at.y,
                    latex,
                    fontSize: size,
                    displayMode: display,
                    rotation: 0,
                    opacity: 1,
                    strokeColor: color ?? DEFAULTS.strokeColor,
                    strokeWidth: 0,
                    fillColor: 'transparent',
                    z: maxZ(room.shapes.values()) + 1,
                    updatedAt: Date.now(),
                    createdBy: origin,
                };
                applyOps(room, [{ kind: 'add', shapes: [shape] }]);
                return ok('Added the formula.', { id: shape.id, bounds: { x: shape.x, y: shape.y, width: rendered.width, height: rendered.height } });
            }),
    );

    server.registerTool(
        'write_solution',
        {
            title: 'Write a worked solution',
            description:
                'Writes a step-by-step worked solution (math, physics, chemistry, …) as a neatly stacked block: optional title and problem statement, numbered steps each with an explanation and/or LaTeX, and a highlighted final answer. You solve the problem; this tool lays it out on the board.',
            inputSchema: {
                board: boardArg,
                title: z.string().max(200).optional(),
                problem: z.string().max(2000).optional().describe('Problem statement (plain text)'),
                problemLatex: latexSchema.optional().describe('Problem as LaTeX, shown under the statement'),
                steps: z
                    .array(
                        z.object({
                            text: z.string().max(2000).optional().describe('Explanation for this step'),
                            latex: latexSchema.optional().describe('Math for this step'),
                        }),
                    )
                    .min(1)
                    .max(40),
                answer: latexSchema.optional().describe('Final answer as LaTeX, drawn in a highlighted box'),
                x: coord.optional(),
                y: coord.optional(),
                width: z.number().min(200).max(2000).optional().describe('Text wrap width (default 560)'),
                color: colorSchema.optional().describe('Text/math color (default #1e1e1e)'),
            },
            annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
        },
        ({ board, title, problem, problemLatex, steps, answer, x, y, width, color }) =>
            run(() => {
                const room = resolveRoom(board);
                if (steps.some((s) => !s.text && !s.latex)) throw new ToolInputError('Each step needs text, latex, or both.');
                const latexChars = [problemLatex, answer, ...steps.map((s) => s.latex)].reduce((n, l) => n + (l?.length ?? 0), 0);
                if (latexChars > 8000) throw new ToolInputError('This solution has too much LaTeX for one call (8000 characters max). Split it into several write_solution calls.');
                const wrap = width ?? 560;
                const ink = color ?? DEFAULTS.strokeColor;
                const at = placementOrigin(room.shapes, x, y, measurer);
                let z = maxZ(room.shapes.values());
                let cursor = at.y;
                const now = Date.now();
                const shapes: Shape[] = [];
                const common = () => ({ id: randomUUID(), rotation: 0, opacity: 1, z: ++z, updatedAt: now, createdBy: origin, strokeWidth: 0, fillColor: 'transparent' });

                const addText = (text: string, left: number, fontSize: number, weight: 'normal' | 'bold', textColor = ink, maxWidth = wrap) => {
                    const block = textBlockSize(text, fontSize, weight, maxWidth);
                    shapes.push({ ...common(), type: 'text', x: left, y: cursor, text, fontSize, fontWeight: weight, align: 'left', width: maxWidth, strokeColor: textColor } satisfies TextShape);
                    cursor += block.height;
                };
                const addMath = (latex: string, left: number, fontSize = DEFAULTS.mathFontSize) => {
                    const rendered = checkLatex(latex, fontSize, true);
                    shapes.push({ ...common(), type: 'math', x: left, y: cursor, latex, fontSize, displayMode: true, strokeColor: ink } satisfies MathShape);
                    cursor += rendered.height;
                    return rendered;
                };

                if (title) {
                    addText(title, at.x, 30, 'bold');
                    cursor += 14;
                }
                if (problem) {
                    addText(problem, at.x, 20, 'normal', '#495057');
                    cursor += 8;
                }
                if (problemLatex) {
                    addMath(problemLatex, at.x);
                    cursor += 8;
                }
                if (title || problem || problemLatex) cursor += 12;

                // Indent step content past the widest step number ("9." vs "40.").
                const indent = Math.ceil(textBlockSize(`${steps.length}.`, 20, 'bold').width) + 12;
                steps.forEach((step, i) => {
                    const number = `${i + 1}.`;
                    const top = cursor;
                    shapes.push({ ...common(), type: 'text', x: at.x, y: top, text: number, fontSize: 20, fontWeight: 'bold', align: 'left', strokeColor: '#1971c2' } satisfies TextShape);
                    if (step.text) addText(step.text, at.x + indent, 20, 'normal', ink, wrap - indent);
                    if (step.text && step.latex) cursor += 6;
                    if (step.latex) addMath(step.latex, at.x + indent);
                    cursor = Math.max(cursor, top + 26) + 18;
                });

                if (answer) {
                    cursor += 6;
                    const label = 'Answer';
                    const boxTop = cursor;
                    const pad = 14;
                    cursor += pad;
                    const labelBlock = textBlockSize(label, 16, 'bold');
                    const labelShape: TextShape = { ...common(), type: 'text', x: at.x + pad, y: cursor, text: label, fontSize: 16, fontWeight: 'bold', align: 'left', strokeColor: '#2b8a3e' };
                    cursor += labelBlock.height + 4;
                    const rendered = checkLatex(answer, 28, true);
                    const mathShape: MathShape = { ...common(), type: 'math', x: at.x + pad, y: cursor, latex: answer, fontSize: 28, displayMode: true, strokeColor: ink };
                    cursor += rendered.height + pad;
                    const boxWidth = Math.max(rendered.width, labelBlock.width) + pad * 2;
                    shapes.push({
                        ...common(),
                        z: ++z,
                        type: 'rect',
                        x: at.x,
                        y: boxTop,
                        width: boxWidth,
                        height: cursor - boxTop,
                        cornerRadius: 8,
                        strokeColor: '#2f9e44',
                        strokeWidth: 2,
                        fillColor: '#ebfbee',
                    });
                    labelShape.z = ++z;
                    mathShape.z = ++z;
                    shapes.push(labelShape, mathShape);
                }

                applyOps(room, [{ kind: 'add', shapes }]);
                const bounds: Box | null = unionBoxes(shapes.map((s) => getShapeBounds(s, (id) => room.shapes.get(id), measurer)));
                return ok(`Wrote a solution with ${steps.length} step(s).`, {
                    ids: shapes.map((s) => s.id),
                    bounds,
                    shapes: shapes.slice(0, 5).map((s) => summarizeShape(room.shapes.get(s.id) ?? s, room.shapes, measurer)),
                });
            }),
    );
}
