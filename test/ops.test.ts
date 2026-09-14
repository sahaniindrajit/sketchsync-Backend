import { describe, expect, it } from 'vitest';
import { boundaryPoint, getShapeBounds, resolveLinePoints, smoothPathData } from '../src/shared/geometry.js';
import { applyOp, sortByZ } from '../src/shared/ops.js';
import { extractRoomId, type Shape } from '../src/shared/protocol.js';
import { arrow, rect } from './helpers.js';

const mapOf = (...shapes: Shape[]) => new Map(shapes.map((s) => [s.id, s]));

describe('applyOp', () => {
    it('adds, updates and deletes without mutating the input', () => {
        const r = rect({ id: 'box' });
        const empty = new Map<string, Shape>();
        const added = applyOp(empty, { kind: 'add', shapes: [r] });
        expect(empty.size).toBe(0);
        expect(added.get('box')).toEqual(r);

        const updated = applyOp(added, { kind: 'update', patches: [{ id: 'box', changes: { x: 50, label: { text: 'hi' } } }] });
        expect(added.get('box')!.x).toBe(0);
        expect(updated.get('box')).toMatchObject({ x: 50, label: { text: 'hi' } });

        const unlabeled = applyOp(updated, { kind: 'update', patches: [{ id: 'box', changes: { label: null } }] });
        expect('label' in unlabeled.get('box')!).toBe(false);

        expect(applyOp(unlabeled, { kind: 'delete', ids: ['box'] }).size).toBe(0);
    });

    it('ignores updates for unknown shapes and never changes id/type', () => {
        const r = rect({ id: 'box' });
        const next = applyOp(mapOf(r), {
            kind: 'update',
            patches: [
                { id: 'missing', changes: { x: 1 } },
                { id: 'box', changes: { id: 'hacked', type: 'text' } as never },
            ],
        });
        expect(next.size).toBe(1);
        expect(next.get('box')).toMatchObject({ id: 'box', type: 'rect' });
    });

    it('appends points to freehand strokes', () => {
        const stroke: Shape = { ...arrow({ id: 's' }), type: 'freehand', points: [0, 0] } as Shape;
        const next = applyOp(mapOf(stroke), { kind: 'append-points', id: 's', points: [1, 1, 2, 2] });
        expect((next.get('s') as { points: number[] }).points).toEqual([0, 0, 1, 1, 2, 2]);
    });

    it('bakes arrow endpoints when a bound shape is deleted', () => {
        const a = rect({ id: 'a', x: 0, y: 0, width: 100, height: 100 });
        const b = rect({ id: 'b', x: 300, y: 0, width: 100, height: 100 });
        const link = arrow({ id: 'link', x: 0, y: 0, points: [0, 0, 0, 0], startBinding: { shapeId: 'a' }, endBinding: { shapeId: 'b' } });
        const before = resolveLinePoints(link, (id) => mapOf(a, b).get(id));
        const next = applyOp(mapOf(a, b, link), { kind: 'delete', ids: ['b'] });
        const baked = next.get('link') as typeof link;
        expect(baked.endBinding).toBeUndefined();
        expect(baked.startBinding).toEqual({ shapeId: 'a' });
        expect(resolveLinePoints(baked, (id) => next.get(id))).toEqual(before);
    });

    it('clear empties the board', () => {
        expect(applyOp(mapOf(rect(), rect()), { kind: 'clear' }).size).toBe(0);
    });

    it('sorts by z then id', () => {
        const shapes = [rect({ id: 'b', z: 1 }), rect({ id: 'a', z: 1 }), rect({ id: 'c', z: 0 })];
        expect(sortByZ(shapes).map((s) => s.id)).toEqual(['c', 'a', 'b']);
    });
});

describe('geometry', () => {
    it('clips connectors to rectangle, ellipse and diamond outlines', () => {
        const box = rect({ x: 0, y: 0, width: 100, height: 100 }) as Extract<Shape, { type: 'rect' }>;
        expect(boundaryPoint(box, { x: 500, y: 50 })).toEqual({ x: 100, y: 50 });
        const ellipse = { ...box, type: 'ellipse' as const };
        const p = boundaryPoint(ellipse, { x: 500, y: 500 });
        expect(Math.hypot(p.x - 50, p.y - 50)).toBeCloseTo(50, 5);
        const diamond = { ...box, type: 'diamond' as const };
        const d = boundaryPoint(diamond, { x: 500, y: 500 });
        expect(d.x).toBeCloseTo(75, 5);
        expect(d.y).toBeCloseTo(75, 5);
    });

    it('returns the center when the target is inside the shape', () => {
        const box = rect({ x: 0, y: 0, width: 100, height: 100 }) as Extract<Shape, { type: 'rect' }>;
        expect(boundaryPoint(box, { x: 60, y: 50 })).toEqual({ x: 50, y: 50 });
    });

    it('resolves bound arrows between two boxes', () => {
        const a = rect({ id: 'a', x: 0, y: 0, width: 100, height: 100 });
        const b = rect({ id: 'b', x: 300, y: 0, width: 100, height: 100 });
        const link = arrow({ points: [0, 0, 1, 1], startBinding: { shapeId: 'a' }, endBinding: { shapeId: 'b' } });
        const pts = resolveLinePoints(link, (id) => mapOf(a, b).get(id));
        expect(pts).toEqual([106, 50, 294, 50]);
    });

    it('computes rotated bounds', () => {
        const r = rect({ x: 0, y: 0, width: 100, height: 100, rotation: 90 });
        const b = getShapeBounds(r, () => undefined);
        expect(b.x).toBeCloseTo(-100);
        expect(b.width).toBeCloseTo(100);
    });

    it('produces Konva-style smooth paths', () => {
        const d = smoothPathData([0, 0, 10, 10, 20, 0, 30, 10], 0.5);
        expect(d.startsWith('M0 0 Q')).toBe(true);
        expect(d).toContain(' C');
        expect(smoothPathData([0, 0, 5, 5], 0.5)).toBe('M0 0 L5 5');
    });

    it('extracts room ids from links', () => {
        const id = '3f2b8c1e-8d2a-4c5b-9e7f-1a2b3c4d5e6f';
        expect(extractRoomId(id)).toBe(id);
        expect(extractRoomId(`https://sketchsync.onrender.com/board/${id}`)).toBe(id);
        expect(extractRoomId(`https://x/live?roomId=${id.toUpperCase()}`)).toBe(id);
        expect(extractRoomId('nope')).toBeNull();
    });
});
