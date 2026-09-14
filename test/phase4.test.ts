import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { layoutFlowchart } from '../src/layout/flowchart.js';
import { fullMcpFeatures } from '../src/mcp/features.js';
import { attachMcp } from '../src/mcp/http.js';
import { mathForShape, renderLatex } from '../src/render/math.js';
import { serverMeasurer } from '../src/render/toSvg.js';
import { boxesIntersect, getShapeBounds, resolveLinePoints } from '../src/shared/geometry.js';
import type { LineShape, Shape } from '../src/shared/protocol.js';
import { join, startServer } from './helpers.js';

const measurer = serverMeasurer(mathForShape);

type ToolResult = { content: { type: string; text?: string; data?: string }[]; isError?: boolean; structuredContent?: Record<string, unknown> };

describe('flowchart layout', () => {
    it('merges duplicate edges and survives reverse/duplicate edge combinations', () => {
        const nodes = ['n1', 'n2', 'n4', 'n6', 'n7', 'n8', 'n9'].map((id) => ({ id, label: id }));
        const edges = [['n2', 'n7', 'yes'], ['n2', 'n7', 'no'], ['n4', 'n1'], ['n7', 'n2'], ['n8', 'n9'], ['n9', 'n6']].map(([from, to, label]) => ({ from, to, label }));
        const layout = layoutFlowchart(nodes, edges);
        expect(layout.edges).toHaveLength(5);
        expect(layout.edges.find((e) => e.from === 'n2' && e.to === 'n7')!.label).toBe('yes / no');
        // The reverse edge is routed, not drawn on top of the forward one.
        const forward = layout.edges.find((e) => e.from === 'n2')!;
        const backward = layout.edges.find((e) => e.from === 'n7')!;
        expect(forward.via.length === 0 && backward.via.length === 0).toBe(false);
    });

    it('lays out nodes without overlaps in the requested direction', () => {
        const nodes = [
            { id: 'start', label: 'Start', kind: 'terminal' as const },
            { id: 'input', label: 'Read the user input from the form', kind: 'io' as const },
            { id: 'valid', label: 'Is the input valid?', kind: 'decision' as const },
            { id: 'save', label: 'Save' },
            { id: 'error', label: 'Show an error' },
            { id: 'end', label: 'End', kind: 'terminal' as const },
        ];
        const edges = [
            { from: 'start', to: 'input' },
            { from: 'input', to: 'valid' },
            { from: 'valid', to: 'save', label: 'yes' },
            { from: 'valid', to: 'error', label: 'no' },
            { from: 'error', to: 'input' },
            { from: 'save', to: 'end' },
        ];
        const tb = layoutFlowchart(nodes, edges);
        for (const a of tb.nodes) for (const b of tb.nodes) if (a !== b) expect(boxesIntersect(a, b)).toBe(false);
        const y = (id: string) => tb.nodes.find((n) => n.id === id)!.y;
        expect(y('start')).toBeLessThan(y('input'));
        expect(y('input')).toBeLessThan(y('valid'));
        expect(y('valid')).toBeLessThan(y('end'));
        const decision = tb.nodes.find((n) => n.id === 'valid')!;
        expect(decision.width).toBeGreaterThan(160);

        const lr = layoutFlowchart(nodes, edges, { direction: 'LR' });
        const x = (id: string) => lr.nodes.find((n) => n.id === id)!.x;
        expect(x('start')).toBeLessThan(x('input'));
        expect(x('input')).toBeLessThan(x('end'));
        // The back edge (error → input) gets bend points.
        expect(tb.edges.find((e) => e.from === 'error')!.via.length).toBeGreaterThan(0);
    });
});

describe('math rendering', () => {
    it('renders LaTeX with px sizes and reports errors', () => {
        const ok = renderLatex('x^2 + \\frac{1}{2}', 24, true);
        expect(ok.error).toBeUndefined();
        expect(ok.svg).toMatch(/^<svg/);
        expect(ok.width).toBeGreaterThan(40);
        expect(ok.height).toBeGreaterThan(20);
        expect(ok.svg).not.toContain('currentColor');
        expect(renderLatex('\\frac{1}{', 24, true).error).toMatch(/Missing close brace/);
        expect(renderLatex('\\notacommand', 24, true).error).toMatch(/Undefined control sequence/);
        expect(renderLatex('\\ce{H2O}', 24, false).error).toBeUndefined();
        // Unsupported or degenerate formulas are errors instead of zero-size or gigantic output.
        expect(renderLatex('E=mc^2 \\tag{1}', 24, true).error).toMatch(/not supported/);
        expect(renderLatex('\\rule{100000em}{1em}', 24, true).error).toMatch(/too large/);
        expect(renderLatex('\\hspace{-20em}x', 24, true).error).toMatch(/no visible size/);
        // Bigger font → proportionally bigger.
        expect(renderLatex('x^2 + \\frac{1}{2}', 48, true).width).toBeCloseTo(ok.width * 2, 0);
    });
});

describe('Phase 4 MCP tools', () => {
    let server: Awaited<ReturnType<typeof startServer>>;
    const clients: Client[] = [];

    beforeAll(async () => {
        server = await startServer({ routes: (app, rooms) => attachMcp(app, rooms, { ...config, mcpRequestsPerSecond: 1000 }, fullMcpFeatures) });
    });
    afterAll(async () => {
        await Promise.all(clients.map((c) => c.close().catch(() => undefined)));
        await server.stop();
    });

    async function setup() {
        const roomId = randomUUID();
        const socket = await server.connect();
        await join(socket, roomId);
        const client = new Client({ name: 'claude-ai', version: '1' });
        await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp/${roomId}`)));
        clients.push(client);
        const call = async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as ToolResult;
        const shapes = () => server.rooms.getRoom(roomId)!.shapes;
        return { roomId, call, shapes };
    }
    const text = (r: ToolResult) => r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    const saveImage = async (call: (n: string, a?: Record<string, unknown>) => Promise<ToolResult>, file: string) => {
        const img = await call('get_board_image');
        writeFileSync(file, Buffer.from(img.content.find((c) => c.type === 'image')!.data!, 'base64'));
    };

    it('create_flowchart builds connected, non-overlapping shapes next to existing content', async () => {
        const { call, shapes } = await setup();
        await call('add_shapes', { shapes: [{ type: 'rect', id: 'existing', x: 0, y: 0, width: 300, height: 300 }] });
        const result = await call('create_flowchart', {
            title: 'Login flow',
            nodes: [
                { id: 'open', label: 'Open app', kind: 'terminal' },
                { id: 'creds', label: 'Enter email & password', kind: 'io' },
                { id: 'ok', label: 'Credentials correct?', kind: 'decision' },
                { id: 'home', label: 'Show home screen' },
                { id: 'retry', label: 'Show error and retry', kind: 'note' },
            ],
            edges: [
                { from: 'open', to: 'creds' },
                { from: 'creds', to: 'ok' },
                { from: 'ok', to: 'home', label: 'yes' },
                { from: 'ok', to: 'retry', label: 'no' },
                { from: 'retry', to: 'creds' },
            ],
        });
        expect(result.isError).toBeFalsy();
        const map = shapes();
        const lookup = (id: string) => map.get(id);
        const nodes = ['open', 'creds', 'ok', 'home', 'retry'].map((id) => map.get(id)!);
        expect(nodes.map((n) => n.type)).toEqual(['rect', 'rect', 'diamond', 'rect', 'rect']);
        expect(nodes.every((n) => n.x > 300)).toBe(true);
        for (const a of nodes) for (const b of nodes) if (a !== b) expect(boxesIntersect(getShapeBounds(a, lookup), getShapeBounds(b, lookup))).toBe(false);
        const arrows = Array.from(map.values()).filter((s): s is LineShape => s.type === 'arrow');
        expect(arrows).toHaveLength(5);
        expect(arrows.every((a) => a.startBinding && a.endBinding)).toBe(true);
        expect(arrows.find((a) => a.label?.text === 'yes')).toMatchObject({ startBinding: { shapeId: 'ok' }, endBinding: { shapeId: 'home' } });
        // Arrows are drawn beneath nodes.
        expect(Math.max(...arrows.map((a) => a.z))).toBeLessThan(Math.min(...nodes.map((n) => n.z)));
        expect(Array.from(map.values()).some((s) => s.type === 'text' && s.text === 'Login flow')).toBe(true);
        // Moving a node keeps its connectors attached.
        await call('update_shapes', { updates: [{ id: 'home', dx: 200 }] });
        const moved = shapes();
        const yes = Array.from(moved.values()).find((s) => s.type === 'arrow' && (s as LineShape).label?.text === 'yes') as LineShape;
        const end = resolveLinePoints(yes, (id) => moved.get(id)).slice(-2);
        const home = getShapeBounds(moved.get('home')!, (id) => moved.get(id));
        expect(end[0]).toBeGreaterThan(home.x - 10);
        await saveImage(call, '/tmp/claude-0/-root-code-personal-whiteboard/f684010f-7d99-4d10-9d79-7db34bafbaed/scratchpad/phase4-flowchart.png');
    });

    it('write_solution indents step content past wide step numbers', async () => {
        const { call, shapes } = await setup();
        const steps = Array.from({ length: 40 }, (_, i) => ({ text: `Step ${i + 1}` }));
        expect((await call('write_solution', { steps, x: 0, y: 0 })).isError).toBeFalsy();
        const list = Array.from(shapes().values()) as Extract<Shape, { type: 'text' }>[];
        const label40 = list.find((s) => s.text === '40.')!;
        const text40 = list.find((s) => s.text === 'Step 40')!;
        expect(text40.x).toBeGreaterThan(label40.x + getShapeBounds(label40, () => undefined, measurer).width);
    });

    it('create_flowchart validates its input', async () => {
        const { call, shapes } = await setup();
        expect(text(await call('create_flowchart', { nodes: [{ id: 'a', label: 'A' }], edges: [{ from: 'a', to: 'zzz' }] }))).toMatch(/isn't in "nodes"/);
        expect(text(await call('create_flowchart', { nodes: [{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }] }))).toMatch(/Duplicate node id/);
        expect(text(await call('create_flowchart', { nodes: [{ id: 'a', label: 'A' }], edges: [{ from: 'a', to: 'a' }] }))).toMatch(/itself/);
        await call('add_shapes', { shapes: [{ type: 'rect', id: 'taken', x: 0, y: 0 }] });
        expect(text(await call('create_flowchart', { nodes: [{ id: 'taken', label: 'A' }] }))).toMatch(/already exists/);
        expect(shapes().size).toBe(1);
    });

    it('add_math adds formulas and rejects invalid LaTeX with the TeX error', async () => {
        const { call, shapes } = await setup();
        const ok = await call('add_math', { latex: 'E = mc^2', x: 100, y: 100, fontSize: 32 });
        expect(ok.isError).toBeFalsy();
        const math = Array.from(shapes().values()).find((s) => s.type === 'math')!;
        expect(math).toMatchObject({ latex: 'E = mc^2', fontSize: 32, displayMode: true, x: 100, y: 100 });
        const bad = await call('add_math', { latex: '\\frac{1}{' });
        expect(bad.isError).toBe(true);
        expect(text(bad)).toMatch(/LaTeX error.*Missing close brace/);
        expect(shapes().size).toBe(1);

        // update_shapes validates LaTeX too.
        expect(text(await call('update_shapes', { updates: [{ id: math.id, latex: '\\nope' }] }))).toMatch(/Undefined control sequence/);
        expect((await call('update_shapes', { updates: [{ id: math.id, latex: 'E = mc^3', color: '#1971c2' }] })).isError).toBeFalsy();
        expect(shapes().get(math.id)).toMatchObject({ latex: 'E = mc^3', strokeColor: '#1971c2' });

        // get_board reports math with real rendered bounds.
        const board = (await call('get_board')).structuredContent as { shapes: { latex?: string; bounds: { width: number } }[] };
        expect(board.shapes[0].latex).toBe('E = mc^3');
        expect(board.shapes[0].bounds.width).toBeCloseTo(renderLatex('E = mc^3', 32, true).width, 0);
    });

    it('write_solution lays out a readable step-by-step solution', async () => {
        const { call, shapes } = await setup();
        const result = await call('write_solution', {
            title: 'Solve 2x² − 8x + 6 = 0',
            problemLatex: '2x^2 - 8x + 6 = 0',
            steps: [
                { text: 'Divide both sides by 2.', latex: 'x^2 - 4x + 3 = 0' },
                { text: 'Factor the quadratic.', latex: '(x - 1)(x - 3) = 0' },
                { text: 'Set each factor to zero and solve.' },
                { latex: 'x - 1 = 0 \\quad\\text{or}\\quad x - 3 = 0' },
            ],
            answer: 'x = 1 \\text{ or } x = 3',
            x: 50,
            y: 50,
        });
        expect(result.isError).toBeFalsy();
        const list = Array.from(shapes().values()).sort((a, b) => a.y - b.y || a.x - b.x);
        const lookup = (id: string) => shapes().get(id);
        // Vertically stacked: no two consecutive content blocks (other than the answer box) overlap.
        const content = list.filter((s) => s.type !== 'rect');
        const numberLabels = content.filter((s) => s.type === 'text' && /^\d+\.$/.test(s.text));
        expect(numberLabels.map((s) => (s as { text: string }).text)).toEqual(['1.', '2.', '3.', '4.']);
        const blocks = content.filter((s) => !numberLabels.includes(s));
        for (let i = 1; i < blocks.length; i++) {
            const prev = getShapeBounds(blocks[i - 1], lookup, measurer);
            const cur = getShapeBounds(blocks[i], lookup, measurer);
            expect(cur.y).toBeGreaterThanOrEqual(prev.y + prev.height - 1);
        }
        const box = list.find((s) => s.type === 'rect') as Extract<Shape, { type: 'rect' }>;
        const answer = list.find((s) => s.type === 'math' && s.latex.includes('x = 1'))!;
        const answerBounds = getShapeBounds(answer, lookup, measurer);
        expect(answerBounds.x).toBeGreaterThanOrEqual(box.x);
        expect(answerBounds.y + answerBounds.height).toBeLessThanOrEqual(box.y + box.height);
        expect(box.z).toBeLessThan(answer.z);

        expect(text(await call('write_solution', { steps: [{ latex: '\\frac{' }] }))).toMatch(/LaTeX error/);
        const heavy = Array.from({ length: 5 }, () => ({ latex: 'x+'.repeat(1990) + 'x' }));
        expect(text(await call('write_solution', { steps: heavy }))).toMatch(/too much LaTeX/);
        expect(text(await call('write_solution', { steps: [{}] }))).toMatch(/needs text, latex, or both/);
        await saveImage(call, '/tmp/claude-0/-root-code-personal-whiteboard/f684010f-7d99-4d10-9d79-7db34bafbaed/scratchpad/phase4-solution.png');
    });
});
