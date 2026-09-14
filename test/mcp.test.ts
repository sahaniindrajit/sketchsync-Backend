import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { fullMcpFeatures } from '../src/mcp/features.js';
import { attachMcp } from '../src/mcp/http.js';
import type { LineShape, OpBroadcast, Shape } from '../src/shared/protocol.js';
import { join, nextOp, sendOp, startServer } from './helpers.js';

type Server = Awaited<ReturnType<typeof startServer>>;
type ToolResult = { content: { type: string; text?: string; data?: string; mimeType?: string }[]; isError?: boolean; structuredContent?: Record<string, unknown> };

describe('MCP server', () => {
    let server: Server;
    const clients: Client[] = [];

    beforeAll(async () => {
        server = await startServer({ routes: (app, rooms) => attachMcp(app, rooms, { ...config, frontendUrl: 'https://board.example', mcpRequestsPerSecond: 1000 }, fullMcpFeatures) });
    });

    afterAll(async () => {
        await Promise.all(clients.map((c) => c.close().catch(() => undefined)));
        await server.stop();
    });

    async function connect(path: string, name = 'test-client') {
        const client = new Client({ name, version: '1.0.0' });
        await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}${path}`)));
        clients.push(client);
        return client;
    }

    /** A browser-like participant that keeps the room loaded and records broadcasts. */
    async function openBoard() {
        const roomId = randomUUID();
        const socket = await server.connect();
        const ack = await join(socket, roomId);
        expect(ack.ok).toBe(true);
        const received: OpBroadcast[] = [];
        socket.on('op', (op: OpBroadcast) => received.push(op));
        return { roomId, socket, received };
    }

    const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as ToolResult;
    const text = (r: ToolResult) => r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    const shapesOf = (roomId: string) => Array.from(server.rooms.getRoom(roomId)!.shapes.values());

    it('lists the tools with schemas and annotations', async () => {
        const { roomId } = await openBoard();
        const client = await connect(`/mcp/${roomId}`);
        const { tools } = await client.listTools();
        const names = tools.map((t) => t.name).sort();
        expect(names).toEqual(['add_math', 'add_shapes', 'clear_board', 'create_flowchart', 'delete_shapes', 'get_board', 'get_board_image', 'update_shapes', 'write_solution']);
        const clear = tools.find((t) => t.name === 'clear_board')!;
        expect(clear.annotations).toMatchObject({ destructiveHint: true });
        const add = tools.find((t) => t.name === 'add_shapes')!;
        expect(JSON.stringify(add.inputSchema)).toContain('shapeId');
        expect(client.getInstructions()).toMatch(/Coordinates/);
    });

    it('adds connected shapes that broadcast live to the board, attributed to the AI client', async () => {
        const board = await openBoard();
        const client = await connect(`/mcp/${board.roomId}`, 'claude-ai');
        const broadcast = nextOp(board.socket);
        const result = await call(client, 'add_shapes', {
            shapes: [
                { type: 'rect', id: 'start', x: 100, y: 100, label: 'Start' },
                { type: 'diamond', id: 'check', x: 100, y: 300, label: 'Valid?', fillColor: '#ffec99' },
                { type: 'arrow', start: { shapeId: 'start' }, end: { shapeId: 'check' }, label: 'next' },
                { type: 'text', x: 400, y: 100, text: 'Notes', fontSize: 28, fontWeight: 'bold', color: '#1971c2' },
                { type: 'freehand', points: [[400, 300], [420, 320], [450, 310]], strokeColor: '#e03131' },
            ],
        });
        expect(result.isError).toBeFalsy();
        const op = await broadcast;
        expect(op.origin).toBe('ai:Claude');
        expect(op.batchId).toBeTruthy();
        expect(op.op.kind).toBe('add');

        const shapes = shapesOf(board.roomId);
        expect(shapes).toHaveLength(5);
        const arrow = shapes.find((s) => s.type === 'arrow') as LineShape;
        expect(arrow.startBinding).toEqual({ shapeId: 'start' });
        expect(arrow.endBinding).toEqual({ shapeId: 'check' });
        expect(arrow.label).toEqual({ text: 'next' });
        expect(shapes.find((s) => s.id === 'check')).toMatchObject({ type: 'diamond', fillColor: '#ffec99', label: { text: 'Valid?' } });
        expect(shapes.find((s) => s.type === 'text')).toMatchObject({ text: 'Notes', strokeColor: '#1971c2', fontWeight: 'bold' });
        expect(shapes.find((s) => s.type === 'freehand')).toMatchObject({ x: 400, y: 300, points: [0, 0, 20, 20, 50, 10] });
        expect((result.structuredContent!.created as unknown[]).length).toBe(5);
    });

    it('auto-places shapes without coordinates next to existing content', async () => {
        const board = await openBoard();
        const client = await connect(`/mcp/${board.roomId}`);
        await call(client, 'add_shapes', { shapes: [{ type: 'rect', x: 0, y: 0, width: 300, height: 200 }] });
        await call(client, 'add_shapes', { shapes: [{ type: 'rect', label: 'A' }, { type: 'ellipse', label: 'B' }] });
        const [, a, b] = shapesOf(board.roomId) as Extract<Shape, { type: 'rect' }>[];
        expect(a.x).toBeGreaterThanOrEqual(300);
        expect(b.x).toBe(a.x);
        expect(b.y).toBeGreaterThan(a.y + a.height);
        // Growing width to fit a long label.
        await call(client, 'add_shapes', { shapes: [{ type: 'rect', x: 0, y: 500, label: 'A considerably longer label than usual' }] });
        const long = shapesOf(board.roomId).at(-1) as Extract<Shape, { type: 'rect' }>;
        expect(long.width).toBeGreaterThan(160);
    });

    it('reads the board with ids, bounds, labels and connections', async () => {
        const board = await openBoard();
        const client = await connect(`/mcp/${board.roomId}`);
        await call(client, 'add_shapes', {
            shapes: [
                { type: 'rect', id: 'a', x: 0, y: 0, width: 100, height: 50, label: 'Alpha' },
                { type: 'rect', id: 'b', x: 300, y: 0, width: 100, height: 50 },
                { type: 'arrow', id: 'ab', start: { shapeId: 'a' }, end: { shapeId: 'b' } },
                { type: 'freehand', id: 'scribble', points: [[0, 200], [10, 210]] },
            ],
        });
        const result = await call(client, 'get_board');
        const data = result.structuredContent as { shapeCount: number; boardUrl: string; hasHandDrawing: boolean; shapes: Record<string, unknown>[] };
        expect(data.shapeCount).toBe(4);
        expect(data.boardUrl).toBe(`https://board.example/board/${board.roomId}`);
        expect(data.hasHandDrawing).toBe(true);
        expect(data.shapes.find((s) => s.id === 'a')).toMatchObject({ label: 'Alpha', bounds: { x: 0, y: 0, width: 100, height: 50 } });
        expect(data.shapes.find((s) => s.id === 'ab')).toMatchObject({ start: { shapeId: 'a', x: 106, y: 25 }, end: { shapeId: 'b', x: 294, y: 25 } });
        expect(data.shapes.find((s) => s.id === 'scribble')).toMatchObject({ pointCount: 2 });
        expect(data.shapes.find((s) => s.id === 'scribble')).not.toHaveProperty('points');
        const full = (await call(client, 'get_board', { detail: 'full', ids: ['scribble'] })).structuredContent as { shapes: Record<string, unknown>[] };
        expect(full.shapes).toHaveLength(1);
        expect(full.shapes[0].points).toEqual([[0, 200], [10, 210]]);
        expect(text(result)).toContain('4 shape(s)');
    });

    it('updates shapes: move, resize, relabel, recolor, reconnect', async () => {
        const board = await openBoard();
        const client = await connect(`/mcp/${board.roomId}`);
        await call(client, 'add_shapes', {
            shapes: [
                { type: 'rect', id: 'a', x: 0, y: 0 },
                { type: 'rect', id: 'b', x: 400, y: 0 },
                { type: 'ellipse', id: 'c', x: 400, y: 300 },
                { type: 'arrow', id: 'link', start: { shapeId: 'a' }, end: { shapeId: 'b' } },
                { type: 'text', id: 't', x: 0, y: 400, text: 'hello' },
            ],
        });
        const result = await call(client, 'update_shapes', {
            updates: [
                { id: 'a', dx: 50, dy: 25, width: 200, label: 'Moved', fillColor: '#b2f2bb' },
                { id: 'link', end: { shapeId: 'c' }, label: 'now to c' },
                { id: 't', text: 'hello world', color: '#e03131', fontSize: 32 },
            ],
        });
        expect(result.isError).toBeFalsy();
        const shapes = new Map(shapesOf(board.roomId).map((s) => [s.id, s]));
        expect(shapes.get('a')).toMatchObject({ x: 50, y: 25, width: 200, label: { text: 'Moved' }, fillColor: '#b2f2bb' });
        expect(shapes.get('link')).toMatchObject({ startBinding: { shapeId: 'a' }, endBinding: { shapeId: 'c' }, label: { text: 'now to c' } });
        expect(shapes.get('t')).toMatchObject({ text: 'hello world', strokeColor: '#e03131', fontSize: 32 });

        // Detach an end by giving a point; remove a label.
        await call(client, 'update_shapes', { updates: [{ id: 'link', end: { x: 900, y: 900 } }, { id: 'a', label: null }] });
        const after = new Map(shapesOf(board.roomId).map((s) => [s.id, s]));
        expect((after.get('link') as LineShape).endBinding).toBeUndefined();
        expect(after.get('a')).not.toHaveProperty('label');
    });

    it('reports helpful errors without changing the board', async () => {
        const board = await openBoard();
        const client = await connect(`/mcp/${board.roomId}`);
        await call(client, 'add_shapes', { shapes: [{ type: 'text', id: 't', x: 0, y: 0, text: 'hi' }] });
        const before = shapesOf(board.roomId);

        const unknownUpdate = await call(client, 'update_shapes', { updates: [{ id: 'nope', x: 1 }] });
        expect(unknownUpdate.isError).toBe(true);
        expect(text(unknownUpdate)).toMatch(/Unknown shape id/);

        const wrongField = await call(client, 'update_shapes', { updates: [{ id: 't', fillColor: '#ff0000' }] });
        expect(text(wrongField)).toMatch(/doesn't support: fillColor/);

        const badRef = await call(client, 'add_shapes', { shapes: [{ type: 'arrow', start: { shapeId: 't' }, end: { x: 0, y: 0 } }] });
        expect(text(badRef)).toMatch(/can only attach/);

        const dup = await call(client, 'add_shapes', { shapes: [{ type: 'rect', id: 't', x: 0, y: 0 }] });
        expect(text(dup)).toMatch(/already exists/);

        const invalidColor = await call(client, 'add_shapes', { shapes: [{ type: 'rect', x: 0, y: 0, strokeColor: 'red' }] });
        expect(invalidColor.isError).toBe(true);

        expect(shapesOf(board.roomId)).toEqual(before);
    });

    it('deletes shapes and clears the board (with confirmation)', async () => {
        const board = await openBoard();
        const client = await connect(`/mcp/${board.roomId}`);
        await call(client, 'add_shapes', { shapes: [{ type: 'rect', id: 'a', x: 0, y: 0 }, { type: 'rect', id: 'b', x: 300, y: 0 }, { type: 'rect', id: 'c', x: 600, y: 0 }] });
        const del = await call(client, 'delete_shapes', { ids: ['a', 'ghost'] });
        expect(text(del)).toMatch(/Deleted 1 shape\(s\)\. Not found: ghost/);
        const unconfirmed = await call(client, 'clear_board', {});
        expect(unconfirmed.isError).toBe(true);
        expect(shapesOf(board.roomId)).toHaveLength(2);
        await call(client, 'clear_board', { confirm: true });
        expect(shapesOf(board.roomId)).toHaveLength(0);
    });

    it('renders the board to a PNG with a coordinate mapping', async () => {
        const board = await openBoard();
        const client = await connect(`/mcp/${board.roomId}`);
        expect(text(await call(client, 'get_board_image'))).toBe('The board is empty.');
        await call(client, 'add_shapes', {
            shapes: [
                { type: 'rect', id: 'a', x: 100, y: 100, width: 200, height: 100, label: 'Box' },
                { type: 'freehand', points: [[400, 100], [500, 200], [600, 150]] },
            ],
        });
        const result = await call(client, 'get_board_image', { maxSize: 800 });
        const image = result.content.find((c) => c.type === 'image')!;
        expect(image.mimeType).toBe('image/png');
        const png = Buffer.from(image.data!, 'base64');
        expect(png.subarray(1, 4).toString()).toBe('PNG');
        expect(png.readUInt32BE(16)).toBe(800); // width
        expect(text(result)).toMatch(/board area x=60, y=58.5/);

        const cropped = await call(client, 'get_board_image', { shapeIds: ['a'] });
        expect(text(cropped)).toMatch(/board area x=60, y=60, width=280, height=180/);
    });

    it('works with the generic /mcp endpoint when a board link is passed', async () => {
        const board = await openBoard();
        const client = await connect('/mcp');
        const missing = await call(client, 'get_board');
        expect(missing.isError).toBe(true);
        expect(text(missing)).toMatch(/No board specified/);
        const ok = await call(client, 'add_shapes', { board: `https://board.example/board/${board.roomId}`, shapes: [{ type: 'rect', x: 0, y: 0 }] });
        expect(ok.isError).toBeFalsy();
        expect(shapesOf(board.roomId)).toHaveLength(1);
        const bogus = await call(client, 'get_board', { board: 'not a link' });
        expect(text(bogus)).toMatch(/not a SketchSync board/);
    });

    it('asks the user to open boards that are not loaded on the server', async () => {
        const roomId = randomUUID();
        const client = await connect(`/mcp/${roomId}`);
        const result = await call(client, 'get_board');
        expect(result.isError).toBe(true);
        expect(text(result)).toContain(`https://board.example/board/${roomId}`);
        expect(server.rooms.getRoom(roomId)).toBeUndefined();
    });

    it('interleaves correctly with browser edits', async () => {
        const board = await openBoard();
        const client = await connect(`/mcp/${board.roomId}`);
        await sendOp(board.socket, board.roomId, {
            kind: 'add',
            shapes: [{ id: 'user-box', type: 'rect', x: 0, y: 0, width: 100, height: 100, rotation: 0, opacity: 1, strokeColor: '#000000', strokeWidth: 2, fillColor: 'transparent', z: 1, updatedAt: 0, createdBy: 'user:x' }],
        });
        const read = (await call(client, 'get_board')).structuredContent as { shapes: { id: string; author: string }[] };
        expect(read.shapes).toEqual([expect.objectContaining({ id: 'user-box', author: 'user' })]);
        await call(client, 'update_shapes', { updates: [{ id: 'user-box', label: 'labelled by AI' }] });
        expect(server.rooms.getRoom(board.roomId)!.shapes.get('user-box')).toMatchObject({ label: { text: 'labelled by AI' } });
        await new Promise((r) => setTimeout(r, 50));
        expect(board.received.some((o) => o.origin.startsWith('ai:') && o.op.kind === 'update')).toBe(true);
    });

    it('rejects GET/DELETE and bad board URLs with JSON-RPC errors, and serves CORS', async () => {
        const get = await fetch(`${server.url}/mcp/${randomUUID()}`);
        expect(get.status).toBe(405);
        expect((await get.json()).error.message).toMatch(/POST/);
        const bad = await fetch(`${server.url}/mcp/not-a-board`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{}' });
        expect(bad.status).toBe(404);
        const parse = await fetch(`${server.url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops' });
        expect(parse.status).toBe(400);
        const preflight = await fetch(`${server.url}/mcp`, { method: 'OPTIONS', headers: { origin: 'https://claude.ai', 'access-control-request-method': 'POST' } });
        expect(preflight.headers.get('access-control-allow-origin')).toBe('*');
    });
});

describe('MCP robustness (review regressions)', () => {
    let server: Server;
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
        const client = new Client({ name: 'robustness', version: '1' });
        await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp/${roomId}`)));
        clients.push(client);
        const call = async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as ToolResult;
        return { roomId, call, shapes: () => Array.from(server.rooms.getRoom(roomId)!.shapes.values()) };
    }
    const text = (r: ToolResult) => r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');

    it('renders boards containing control characters and unusual unicode', async () => {
        const { call } = await setup();
        await call('add_shapes', { shapes: [{ type: 'rect', x: 0, y: 0, label: 'hi\u0001there \uD83D\uDE00 \uD800 عربى 中文' }, { type: 'text', x: 0, y: 200, text: 'bell\u0007 tab\tok' }] });
        const result = await call('get_board_image');
        expect(result.isError).toBeFalsy();
        expect(result.content.some((c) => c.type === 'image')).toBe(true);
    });

    it('handles huge wrapped text quickly', async () => {
        const { call } = await setup();
        const long = 'a '.repeat(4999);
        const started = Date.now();
        const shapes = Array.from({ length: 20 }, (_, i) => ({ type: 'text', x: 0, y: i * 100, text: long, width: 20000 }));
        expect((await call('add_shapes', { shapes })).isError).toBeFalsy();
        await call('add_shapes', { shapes: Array.from({ length: 20 }, (_, i) => ({ type: 'rect', x: 3000, y: i * 100, width: 400, label: long })) });
        await call('get_board');
        expect((await call('get_board_image')).isError).toBeFalsy();
        expect(Date.now() - started).toBeLessThan(4000);
    });

    it('never leaves partial changes when part of a call is invalid', async () => {
        const { call, shapes } = await setup();
        await call('add_shapes', { shapes: Array.from({ length: 40 }, (_, i) => ({ type: 'rect', id: `r${i}`, x: i * 200, y: 0 })) });
        const before = JSON.stringify(shapes());
        const updates = Array.from({ length: 39 }, (_, i) => ({ id: `r${i}`, label: 'x'.repeat(9000) }));
        const result = await call('update_shapes', { updates: [...updates, { id: 'r39', dx: 1e6 }] });
        expect(result.isError).toBe(true);
        expect(text(result)).toMatch(/Nothing was changed: update for "r39"/);
        expect(JSON.stringify(shapes())).toBe(before);

        const pts = Array.from({ length: 20000 }, (_, i) => [i % 500, i % 300]);
        const add = await call('add_shapes', { shapes: [{ type: 'freehand', id: 'f1', points: pts }, { type: 'freehand', id: 'f2', points: pts }, { type: 'rect', id: 'r0', x: 0, y: 0 }] });
        expect(add.isError).toBe(true);
        expect(shapes().some((s) => s.id === 'f1')).toBe(false);
    });

    it('bounds get_board_image sizes and handles degenerate regions', async () => {
        const { call } = await setup();
        await call('add_shapes', { shapes: [{ type: 'rect', x: 0, y: 0 }] });
        const dims = (r: ToolResult) => {
            const png = Buffer.from(r.content.find((c) => c.type === 'image')!.data!, 'base64');
            return [png.readUInt32BE(16), png.readUInt32BE(20)];
        };
        for (const region of [{ x: 0, y: 0, width: 100000, height: 1 }, { x: 0, y: 0, width: 1, height: 100000 }]) {
            const r = await call('get_board_image', { region, maxSize: 2048 });
            expect(r.isError).toBeFalsy();
            const [w, h] = dims(r);
            expect(Math.max(w, h)).toBeLessThanOrEqual(2048);
            expect(Math.min(w, h)).toBeGreaterThanOrEqual(1);
        }
        expect((await call('get_board_image', { region: { x: 1e308, y: 0, width: 10, height: 10 } })).isError).toBe(true);
        expect(text(await call('get_board_image', { maxSize: 500 }))).not.toMatch(/\d\.\d{6,}/);
    });

    it('auto-places only the shapes without coordinates', async () => {
        const { call, shapes } = await setup();
        await call('add_shapes', { shapes: [{ type: 'rect', id: 'existing', x: 0, y: 0 }] });
        await call('add_shapes', { shapes: [{ type: 'rect', id: 'placed', x: 0, y: 300 }, { type: 'text', id: 'caption', text: 'caption' }, { type: 'arrow', id: 'pointer', start: { x: 10, y: 10 }, end: { x: 100, y: 40 } }] });
        const byId = new Map(shapes().map((s) => [s.id, s]));
        expect(byId.get('placed')).toMatchObject({ x: 0, y: 300 });
        expect(byId.get('pointer')).toMatchObject({ x: 10, y: 10 });
        expect(byId.get('caption')!.x).toBeGreaterThan(160);
        const exact = await call('add_shapes', { placement: 'exact', shapes: [{ type: 'rect' }] });
        expect(text(exact)).toMatch(/needs x and y/);
    });

    it('explains out-of-range geometry in terms of the input', async () => {
        const { call } = await setup();
        const r = await call('add_shapes', { shapes: [{ type: 'line', id: 'wide', start: { x: -900000, y: 0 }, end: { x: 900000, y: 0 } }] });
        expect(text(r)).toMatch(/Shape #1 \("wide"\).*outside the board area/);
    });

    it('applies clear rules to moving connectors', async () => {
        const { call, shapes } = await setup();
        await call('add_shapes', {
            shapes: [
                { type: 'rect', id: 'a', x: 0, y: 0 },
                { type: 'rect', id: 'b', x: 400, y: 0 },
                { type: 'arrow', id: 'both', start: { shapeId: 'a' }, end: { shapeId: 'b' } },
                { type: 'arrow', id: 'one', start: { shapeId: 'a' }, end: { x: 100, y: 400 } },
            ],
        });
        expect(text(await call('update_shapes', { updates: [{ id: 'both', dx: 10 }] }))).toMatch(/moves with them/);
        expect(text(await call('update_shapes', { updates: [{ id: 'a', x: 5, dx: 5 }] }))).toMatch(/either x or dx/);
        expect(text(await call('update_shapes', { updates: [{ id: 'one', start: { x: 0, y: 500 }, dx: 50 }] }))).toMatch(/instead of combining/);
        expect(text(await call('update_shapes', { updates: [{ id: 'a', dx: 10 }, { id: 'a', dx: 10 }] }))).toMatch(/more than once/);
        await call('update_shapes', { updates: [{ id: 'one', dx: 30 }] });
        const one = shapes().find((s) => s.id === 'one') as LineShape;
        expect(one.startBinding).toEqual({ shapeId: 'a' });
        expect(one.x + one.points[2]).toBe(130);
    });

    it('accepts tool calls that omit the arguments object', async () => {
        const { call, roomId } = await setup();
        await call('add_shapes', { shapes: [{ type: 'rect', x: 0, y: 0 }] });
        const client = new Client({ name: 'bare', version: '1' });
        await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp/${roomId}`)));
        clients.push(client);
        const board = (await client.callTool({ name: 'get_board' })) as ToolResult;
        expect(board.isError).toBeFalsy();
        const image = (await client.callTool({ name: 'get_board_image' })) as ToolResult;
        expect(image.content.some((c) => c.type === 'image')).toBe(true);
    });

    it('produces tool schemas without tuple-form items', async () => {
        const { roomId } = await setup();
        const client = new Client({ name: 'schema', version: '1' });
        await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp/${roomId}`)));
        clients.push(client);
        const { tools } = await client.listTools();
        const json = JSON.stringify(tools.map((t) => t.inputSchema));
        expect(json).not.toMatch(/"items":\[/);
        expect(json).not.toMatch(/additionalItems|prefixItems/);
    });
});

describe('MCP rate limiting', () => {
    it('limits requests per IP and board', async () => {
        const server = await startServer({ routes: (app, rooms) => attachMcp(app, rooms, { ...config, mcpRequestsPerSecond: 3 }) });
        try {
            const roomId = randomUUID();
            const statuses = await Promise.all(
                Array.from({ length: 8 }, () =>
                    fetch(`${server.url}/mcp/${roomId}`, {
                        method: 'POST',
                        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
                        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
                    }).then((r) => r.status),
                ),
            );
            expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
        } finally {
            await server.stop();
        }
    });
});
