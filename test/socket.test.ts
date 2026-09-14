import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { io as ioClient } from 'socket.io-client';
import { EVENTS } from '../src/shared/protocol.js';
import { join, nextOp, noOpWithin, rect, sendOp, startServer } from './helpers.js';

describe('realtime sockets', () => {
    let server: Awaited<ReturnType<typeof startServer>> | undefined;

    afterEach(async () => {
        await server?.stop();
        server = undefined;
    });

    it('reports fresh rooms and serves current state to later joiners', async () => {
        server = await startServer();
        const roomId = randomUUID();
        const a = await server.connect();
        expect(await join(a, roomId)).toMatchObject({ ok: true, fresh: true, shapes: [] });
        await sendOp(a, roomId, { kind: 'add', shapes: [rect({ id: 'from-a' })] });
        const b = await server.connect();
        const ackB = await join(b, roomId);
        expect(ackB).toMatchObject({ ok: true, fresh: false });
        expect(ackB.ok && ackB.shapes.map((s) => s.id)).toEqual(['from-a']);
    });

    it('broadcasts ops to every member including the sender, not to other rooms', async () => {
        server = await startServer();
        const roomId = randomUUID();
        const a = await server.connect();
        const b = await server.connect();
        const outsider = await server.connect();
        await join(a, roomId);
        await join(b, roomId);
        await join(outsider, randomUUID());

        const toB = nextOp(b);
        const echo = nextOp(a);
        const outsiderSilent = noOpWithin(outsider);
        const ack = await sendOp(a, roomId, { kind: 'add', shapes: [rect({ id: 'x' })] });
        const opId = `${(a as unknown as { clientId: string }).clientId}:1`;
        expect(ack).toEqual({ ok: true, seq: 1 });
        expect(await toB).toMatchObject({ roomId, seq: 1, opId, op: { kind: 'add' } });
        expect(await echo).toMatchObject({ seq: 1, opId });
        expect(await outsiderSilent).toBe(true);
    });

    it('acks replayed op ids as duplicates without broadcasting and reports them on join', async () => {
        server = await startServer();
        const roomId = randomUUID();
        const a = await server.connect();
        const b = await server.connect();
        await join(a, roomId, { clientId: 'client-a' });
        await join(b, roomId);
        await sendOp(a, roomId, { kind: 'add', shapes: [rect({ id: 'x' })] }, 'client-a:1');
        await new Promise((r) => setTimeout(r, 50));
        const silent = noOpWithin(b);
        expect(await sendOp(a, roomId, { kind: 'add', shapes: [rect({ id: 'x' })] }, 'client-a:1')).toEqual({ ok: true, seq: 1, duplicate: true });
        expect(await silent).toBe(true);

        // A reconnecting client learns which of its pending ops already landed, and retires its old id.
        a.disconnect();
        const again = await server.connect();
        const ack = await join(again, roomId, { pendingOpIds: ['client-a:1', 'client-a:2'], retireClientIds: ['client-a'] });
        expect(ack.ok && ack.appliedOpIds).toEqual(['client-a:1']);
        expect(server.rooms.getRoom(roomId)!.retired.has('client-a')).toBe(true);
    });

    it('rejects op ids that belong to another client and ops out of order', async () => {
        server = await startServer();
        const roomId = randomUUID();
        const a = await server.connect();
        await join(a, roomId, { clientId: 'mine' });
        expect(await sendOp(a, roomId, { kind: 'clear' }, 'someone-else:1')).toMatchObject({ ok: false, code: 'forbidden' });
        expect(await sendOp(a, roomId, { kind: 'clear' }, 'mine:2')).toMatchObject({ ok: false, code: 'out_of_order' });
        expect(await sendOp(a, roomId, { kind: 'clear' }, 'mine:1')).toMatchObject({ ok: true });
        // Two live connections can't share a client id.
        const b = await server.connect();
        expect(await join(b, roomId, { clientId: 'mine' })).toMatchObject({ ok: false, code: 'forbidden' });
    });

    it('streams freehand points in order', async () => {
        server = await startServer();
        const roomId = randomUUID();
        const a = await server.connect();
        await join(a, roomId);
        const stroke = { ...rect({ id: 'stroke' }), type: 'freehand', points: [0, 0] };
        expect((await sendOp(a, roomId, { kind: 'add', shapes: [stroke] })).ok).toBe(true);
        for (let i = 1; i <= 5; i++) {
            expect((await sendOp(a, roomId, { kind: 'append-points', id: 'stroke', points: [i, i] })).ok).toBe(true);
        }
        const late = await server.connect();
        const ack = await join(late, roomId);
        expect(ack.ok && (ack.shapes[0] as { points: number[] }).points).toEqual([0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5]);
    });

    it('rejects ops before joining, invalid rooms and protocol mismatches', async () => {
        server = await startServer();
        const s = await server.connect();
        expect(await sendOp(s, randomUUID(), { kind: 'clear' })).toMatchObject({ ok: false, code: 'not_joined' });
        expect(await join(s, 'not-a-uuid')).toMatchObject({ ok: false, error: 'Invalid room id' });
        const mismatch = await s.timeout(2000).emitWithAck(EVENTS.join, { roomId: randomUUID(), clientId: 'abc', protocolVersion: 999 });
        expect(mismatch.error).toMatch(/Protocol mismatch/);
        const noOpId = await s.timeout(2000).emitWithAck(EVENTS.op, { roomId: randomUUID(), op: { kind: 'clear' } });
        expect(noOpId.ok).toBe(false);
    });

    it('keeps each connection in a single room', async () => {
        server = await startServer();
        const first = randomUUID();
        const second = randomUUID();
        const s = await server.connect();
        await join(s, first);
        await join(s, second);
        expect(server.rooms.getRoom(first)!.connections).toBe(0);
        expect(server.rooms.getRoom(second)!.connections).toBe(1);
        expect(await sendOp(s, first, { kind: 'clear' })).toMatchObject({ ok: false, code: 'not_joined' });
        // Re-joining the current room (new client id) does not double count.
        await join(s, second);
        expect(server.rooms.getRoom(second)!.connections).toBe(1);
    });

    it('rate limits joins and ops', async () => {
        server = await startServer(undefined, { socketJoinsPerMinute: 6, socketOpsPerSecond: 5 });
        const s = await server.connect();
        const results = [];
        for (let i = 0; i < 6; i++) results.push((await join(s, randomUUID())).ok);
        expect(results.filter((ok) => !ok).length).toBeGreaterThan(0);

        const t = await server.connect();
        const roomId = randomUUID();
        await join(t, roomId);
        const acks = await Promise.all(Array.from({ length: 20 }, () => sendOp(t, roomId, { kind: 'add', shapes: [rect()] })));
        expect(acks.some((a) => !a.ok && a.code === 'rate_limited')).toBe(true);
    });

    it('limits connections per IP', async () => {
        server = await startServer(undefined, { maxConnectionsPerIp: 2 });
        await server.connect();
        await server.connect();
        const third = ioClient(server.url, { transports: ['websocket'], forceNew: true, reconnection: false });
        const error = await new Promise<Error>((resolve) => third.once('connect_error', resolve));
        expect(error.message).toBe('Too many connections');
        third.disconnect();
    });

    it('releases connections on disconnect so idle rooms can be swept', async () => {
        server = await startServer();
        const roomId = randomUUID();
        const a = await server.connect();
        await join(a, roomId);
        a.disconnect();
        await new Promise((r) => setTimeout(r, 100));
        expect(server.rooms.getRoom(roomId)!.connections).toBe(0);
    });

    it('returns validation errors in the ack and does not broadcast', async () => {
        server = await startServer();
        const roomId = randomUUID();
        const a = await server.connect();
        const b = await server.connect();
        await join(a, roomId);
        await join(b, roomId);
        const silent = noOpWithin(b);
        expect((await sendOp(a, roomId, { kind: 'add', shapes: [{ id: 'x', type: 'rect' }] })).ok).toBe(false);
        expect(await silent).toBe(true);
    });

    it('keeps /ping working', async () => {
        server = await startServer();
        expect(await (await fetch(`${server.url}/ping`)).json()).toEqual({ message: 'Server is alive!' });
    });
});
