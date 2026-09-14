import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { InMemoryRoomStore } from '../src/rooms/RoomStore.js';
import { RoomService, type RoomOpEvent } from '../src/rooms/RoomService.js';
import { LIMITS } from '../src/shared/protocol.js';
import { rect } from './helpers.js';

function service(opts: Partial<{ maxRooms: number; idleTtlMs: number; maxTotalBytes: number }> = {}) {
    let now = 1000;
    const svc = new RoomService(new InMemoryRoomStore(), { maxRooms: 10, idleTtlMs: 1000, maxTotalBytes: 1e9, now: () => now, ...opts });
    return { svc, tick: (ms: number) => (now += ms) };
}

const user = (opId: string = randomUUID()) => ({ origin: 'user:c1' as const, opId });

describe('RoomService', () => {
    it('creates a room on first join and reports fresh only once', () => {
        const { svc } = service();
        const id = randomUUID();
        expect(svc.join(id).fresh).toBe(true);
        const second = svc.join(id);
        expect(second.fresh).toBe(false);
        expect(second.room.connections).toBe(2);
    });

    it('applies ops, bumps seq, stamps server fields and emits events', () => {
        const { svc } = service();
        const id = randomUUID();
        svc.join(id);
        const events: RoomOpEvent[] = [];
        svc.on('op', (e) => events.push(e));
        const res = svc.apply(id, { kind: 'add', shapes: [rect({ id: 'a', createdBy: 'ai:spoofed' })] }, { origin: 'user:c1', opId: 'op-1' });
        expect(res).toMatchObject({ ok: true, seq: 1, duplicate: false });
        const stored = svc.getRoom(id)!.shapes.get('a')!;
        expect(stored.createdBy).toBe('user:c1');
        expect(stored.updatedAt).toBe(1000);
        expect(events).toEqual([expect.objectContaining({ roomId: id, seq: 1, origin: 'user:c1', opId: 'op-1' })]);
    });

    it('processes each client strictly in order and ignores replays', () => {
        const { svc } = service();
        const id = randomUUID();
        svc.join(id);
        const seq = (opId: string) => ({ origin: 'user:c1' as const, opId, sequenced: true });
        svc.apply(id, { kind: 'add', shapes: [{ ...rect({ id: 's' }), type: 'freehand', points: [0, 0] }] }, seq('c1:1'));
        const events: RoomOpEvent[] = [];
        svc.on('op', (e) => events.push(e));
        expect(svc.apply(id, { kind: 'append-points', id: 's', points: [1, 1] }, seq('c1:2'))).toMatchObject({ ok: true, seq: 2, duplicate: false });
        expect(svc.apply(id, { kind: 'append-points', id: 's', points: [1, 1] }, seq('c1:2'))).toMatchObject({ ok: true, duplicate: true });
        expect(svc.apply(id, { kind: 'append-points', id: 's', points: [9, 9] }, seq('c1:4'))).toMatchObject({ ok: false, code: 'out_of_order' });
        expect((svc.getRoom(id)!.shapes.get('s') as { points: number[] }).points).toEqual([0, 0, 1, 1]);
        expect(events).toHaveLength(1);

        // A permanently rejected op still consumes its number; a temporarily refused one doesn't.
        expect(svc.apply(id, { kind: 'explode' }, seq('c1:3'))).toMatchObject({ ok: false, code: 'invalid' });
        expect(svc.apply(id, { kind: 'clear' }, seq('c1:3'))).toMatchObject({ ok: true, duplicate: true });
        expect(svc.apply(id, { kind: 'clear' }, seq('c1:4'))).toMatchObject({ ok: true, duplicate: false });

        // Replays stay safe no matter how many other ops the room sees meanwhile.
        for (let i = 1; i <= 12_000; i++) svc.apply(id, { kind: 'update', patches: [{ id: 'nope', changes: { x: i } }] }, { origin: 'user:c2', opId: `c2:${i}`, sequenced: true });
        expect(svc.apply(id, { kind: 'clear' }, seq('c1:4'))).toMatchObject({ ok: true, duplicate: true });
        expect(svc.appliedOpIds(id, ['c1:1', 'c1:4', 'c1:5', 'c2:12000', 'zz', 42])).toEqual(['c1:1', 'c1:4', 'c2:12000']);
    });

    it('rejects ops from retired client ids', () => {
        const { svc } = service();
        const id = randomUUID();
        svc.join(id);
        svc.retireClients(id, ['old']);
        expect(svc.apply(id, { kind: 'clear' }, { origin: 'user:old', opId: 'old:1', sequenced: true })).toMatchObject({ ok: false, code: 'forbidden' });
    });

    it('does not consume an op refused for lack of server storage', () => {
        const { svc } = service({ maxTotalBytes: 2_000_000 });
        const id = randomUUID();
        svc.join(id);
        const big = 'data:image/png;base64,' + 'A'.repeat(1_300_000);
        const seq = (n: number) => ({ origin: 'user:c1' as const, opId: `c1:${n}`, sequenced: true });
        expect(svc.apply(id, { kind: 'add', shapes: [{ ...rect(), id: 'i1', type: 'image', src: big }] }, seq(1)).ok).toBe(true);
        expect(svc.apply(id, { kind: 'add', shapes: [{ ...rect(), id: 'i2', type: 'image', src: big }] }, seq(2))).toMatchObject({ ok: false, code: 'unavailable' });
        svc.apply(id, { kind: 'delete', ids: ['i1'] }, { origin: 'user:c9', opId: 'c9:1', sequenced: true });
        expect(svc.apply(id, { kind: 'add', shapes: [{ ...rect(), id: 'i2', type: 'image', src: big }] }, seq(2))).toMatchObject({ ok: true, duplicate: false });
    });

    it('rejects invalid ops and op ids with readable errors', () => {
        const { svc } = service();
        const id = randomUUID();
        svc.join(id);
        const bad = svc.apply(id, { kind: 'add', shapes: [{ ...rect(), strokeColor: 'red' }] }, user());
        expect(!bad.ok && bad.error).toMatch(/shape "r\d+" \(strokeColor\)/);
        expect(svc.apply(id, { kind: 'explode' }, user()).ok).toBe(false);
        expect(svc.apply(id, { kind: 'clear' }, user('bad id!'))).toEqual({ ok: false, error: 'Invalid op id', code: 'invalid' });
        expect(svc.apply(randomUUID(), { kind: 'clear' }, user())).toEqual({ ok: false, error: 'Room not found', code: 'not_found' });
        const dup = svc.apply(id, { kind: 'add', shapes: [rect({ id: 'x' }), rect({ id: 'x' })] }, user());
        expect(!dup.ok && dup.error).toMatch(/Duplicate/);
        expect(!dup.ok && dup.code).toBe('invalid');
    });

    it('rejects patch fields that do not apply to the shape type', () => {
        const { svc } = service();
        const id = randomUUID();
        svc.join(id);
        svc.apply(id, { kind: 'add', shapes: [rect({ id: 'a' })] }, user());
        expect(svc.apply(id, { kind: 'update', patches: [{ id: 'a', changes: { latex: 'x^2' } }] }, user()).ok).toBe(false);
        expect(svc.apply(id, { kind: 'update', patches: [{ id: 'a', changes: { width: null } }] }, user()).ok).toBe(false);
        expect(svc.getRoom(id)!.shapes.get('a')).toMatchObject({ width: 100 });
    });

    it('enforces the shape count limit', () => {
        const { svc } = service();
        const id = randomUUID();
        svc.join(id);
        const shapes = Array.from({ length: LIMITS.maxShapesPerOp }, (_, i) => rect({ id: `s${i}` }));
        for (let batch = 0; batch < LIMITS.maxShapesPerRoom / LIMITS.maxShapesPerOp; batch++) {
            expect(svc.apply(id, { kind: 'add', shapes: shapes.map((s) => ({ ...s, id: `${s.id}-${batch}` })) }, user()).ok).toBe(true);
        }
        expect(svc.apply(id, { kind: 'add', shapes: [rect({ id: 'one-too-many' })] }, user()).ok).toBe(false);
        expect(svc.apply(id, { kind: 'add', shapes: [{ ...shapes[0], id: 's0-0', x: 5 }] }, user()).ok).toBe(true);
    });

    it('enforces byte limits for adds, updates and point appends', () => {
        const { svc } = service();
        const id = randomUUID();
        svc.join(id);
        const big = 'data:image/png;base64,' + 'A'.repeat(1_300_000);
        const tiny = 'data:image/png;base64,AAAA';
        const images = Array.from({ length: 12 }, (_, i) => ({ ...rect(), id: `img${i}`, type: 'image', src: tiny }));
        expect(svc.apply(id, { kind: 'add', shapes: images }, user()).ok).toBe(true);
        // Growing images through updates must respect the same cap.
        let accepted = 0;
        for (let i = 0; i < 12; i++) {
            if (svc.apply(id, { kind: 'update', patches: [{ id: `img${i}`, changes: { src: big } }] }, user()).ok) accepted++;
        }
        expect(accepted).toBeGreaterThan(5);
        expect(accepted).toBeLessThan(12);
        expect(svc.getRoom(id)!.bytes).toBeLessThanOrEqual(LIMITS.maxRoomBytes);

        svc.apply(id, { kind: 'clear' }, user());
        expect(svc.getRoom(id)!.bytes).toBe(0);
        expect(svc.usedBytes()).toBe(0);

        // Point appends count too.
        const strokes = Array.from({ length: 400 }, (_, i) => ({ ...rect(), id: `st${i}`, type: 'freehand', points: [0, 0] }));
        svc.apply(id, { kind: 'add', shapes: strokes }, user());
        const pts = Array.from({ length: 39_000 }, () => 1);
        let failures = 0;
        for (let i = 0; i < 400; i++) {
            if (!svc.apply(id, { kind: 'append-points', id: `st${i}`, points: pts }, user()).ok) failures++;
        }
        expect(failures).toBeGreaterThan(0);
        expect(svc.getRoom(id)!.bytes).toBeLessThanOrEqual(LIMITS.maxRoomBytes);
    });

    it('applies batches all-or-nothing', () => {
        const { svc } = service();
        const id = randomUUID();
        svc.join(id);
        svc.apply(id, { kind: 'add', shapes: [rect({ id: 'a' }), rect({ id: 'b' })] }, user());
        const events: RoomOpEvent[] = [];
        svc.on('op', (e) => events.push(e));
        const bad = svc.applyBatch(
            id,
            [
                { kind: 'update', patches: [{ id: 'a', changes: { label: { text: 'first chunk' } } }] },
                { kind: 'update', patches: [{ id: 'b', changes: { x: 5e6 } }] },
            ],
            { origin: 'ai:test' },
        );
        expect(bad).toMatchObject({ ok: false, index: 1 });
        expect(!bad.ok && bad.error).toMatch(/update for "b" \(x\)/);
        expect(svc.getRoom(id)!.shapes.get('a')).not.toHaveProperty('label');
        expect(events).toHaveLength(0);

        const good = svc.applyBatch(
            id,
            [
                { kind: 'update', patches: [{ id: 'a', changes: { x: 1 } }] },
                { kind: 'delete', ids: ['b'] },
            ],
            { origin: 'ai:test', batchId: 'b1', opIdPrefix: 'ai-b1' },
        );
        expect(good.ok).toBe(true);
        expect(events.map((e) => [e.opId, e.batchId])).toEqual([['ai-b1-0', 'b1'], ['ai-b1-1', 'b1']]);
        expect(svc.getRoom(id)!.shapes.has('b')).toBe(false);
    });

    it('enforces the global memory budget across rooms', () => {
        const { svc } = service({ maxTotalBytes: 3_000_000 });
        const big = 'data:image/png;base64,' + 'A'.repeat(1_300_000);
        const results = [randomUUID(), randomUUID(), randomUUID()].map((id) => {
            svc.join(id);
            return svc.apply(id, { kind: 'add', shapes: [{ ...rect(), type: 'image', src: big }] }, user());
        });
        expect(results.map((r) => r.ok)).toEqual([true, true, false]);
        expect(!results[2].ok && results[2].error).toMatch(/storage is full/);
    });

    it('evicts idle rooms without connections, and LRU when full', () => {
        const { svc, tick } = service({ maxRooms: 2, idleTtlMs: 1000 });
        const a = randomUUID();
        const b = randomUUID();
        svc.join(a);
        svc.join(b);
        svc.leave(a);
        tick(10);
        const c = randomUUID();
        svc.join(c);
        expect(svc.getRoom(a)).toBeUndefined();
        expect(() => svc.join(randomUUID())).toThrow(/capacity/);
        svc.leave(b);
        tick(5000);
        expect(svc.sweep()).toBe(1);
        expect(svc.getRoom(c)).toBeDefined();
    });
});
