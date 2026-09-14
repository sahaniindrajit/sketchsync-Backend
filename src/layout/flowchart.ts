import dagre from '@dagrejs/dagre';
import { DEFAULTS } from '../shared/protocol.js';
import { measureTextWidth, wrapLines } from '../render/fonts.js';

export type FlowNodeKind = 'process' | 'decision' | 'terminal' | 'io' | 'note';

export interface FlowNodeInput {
    id: string;
    label: string;
    kind?: FlowNodeKind;
}

export interface FlowEdgeInput {
    from: string;
    to: string;
    label?: string;
}

export interface LaidOutNode {
    id: string;
    kind: FlowNodeKind;
    label: string;
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface LaidOutEdge {
    from: string;
    to: string;
    label?: string;
    /** Bend points between the two nodes (empty for straight connectors). */
    via: { x: number; y: number }[];
}

export interface FlowchartLayout {
    nodes: LaidOutNode[];
    edges: LaidOutEdge[];
    width: number;
    height: number;
}

export interface FlowchartOptions {
    direction?: 'TB' | 'LR' | 'BT' | 'RL';
    nodeSpacing?: number;
    rankSpacing?: number;
}

const LABEL_SIZE = DEFAULTS.labelFontSize;
const LINE_HEIGHT = LABEL_SIZE * DEFAULTS.lineHeight;

function nodeSize(label: string, kind: FlowNodeKind) {
    const maxText = kind === 'decision' ? 150 : 200;
    const lines = wrapLines(label, LABEL_SIZE, 'normal', maxText);
    const textW = Math.max(...lines.map((l) => measureTextWidth(l, LABEL_SIZE)), 20);
    const textH = lines.length * LINE_HEIGHT;
    let width = Math.min(260, Math.max(140, Math.ceil(textW + 48)));
    let height = Math.max(64, Math.ceil(textH + 28));
    if (kind === 'decision') {
        // Text must fit inside the inner rhombus.
        width = Math.max(160, Math.ceil((textW + 40) * 1.6));
        height = Math.max(100, Math.ceil((textH + 20) * 1.8));
    } else if (kind === 'terminal') {
        height = Math.max(56, Math.ceil(textH + 20));
    }
    return { width, height };
}

/** Merges edges with the same endpoints (their labels are joined with " / "). */
export function mergeDuplicateEdges(edges: FlowEdgeInput[]): FlowEdgeInput[] {
    const byPair = new Map<string, FlowEdgeInput>();
    for (const e of edges) {
        const key = `${e.from}\u0000${e.to}`;
        const existing = byPair.get(key);
        const label = e.label?.trim();
        if (!existing) byPair.set(key, { ...e, label });
        else if (label) existing.label = existing.label ? `${existing.label} / ${label}` : label;
    }
    return Array.from(byPair.values());
}

/** Lays out a flowchart with dagre. Coordinates start at (0, 0). Duplicate edges are merged. */
export function layoutFlowchart(nodes: FlowNodeInput[], rawEdges: FlowEdgeInput[], options: FlowchartOptions = {}): FlowchartLayout {
    const edges = mergeDuplicateEdges(rawEdges);
    const g = new dagre.graphlib.Graph({ multigraph: true });
    g.setGraph({
        rankdir: options.direction ?? 'TB',
        nodesep: options.nodeSpacing ?? 60,
        ranksep: options.rankSpacing ?? 70,
        edgesep: 20,
        marginx: 0,
        marginy: 0,
    });
    g.setDefaultEdgeLabel(() => ({}));

    for (const node of nodes) {
        const kind = node.kind ?? 'process';
        g.setNode(node.id, { ...nodeSize(node.label, kind), kind, label: node.label });
    }
    edges.forEach((edge, i) => {
        const label = edge.label?.trim();
        const size = label ? { width: measureTextWidth(label, LABEL_SIZE - 2) + 12, height: LINE_HEIGHT + 4, labelpos: 'c' } : {};
        g.setEdge(edge.from, edge.to, size, `e${i}`);
    });

    dagre.layout(g);

    const laidNodes: LaidOutNode[] = nodes.map((n) => {
        const d = g.node(n.id) as { x: number; y: number; width: number; height: number };
        return { id: n.id, kind: n.kind ?? 'process', label: n.label, x: d.x - d.width / 2, y: d.y - d.height / 2, width: d.width, height: d.height };
    });

    const rank = (id: string) => (g.node(id) as { rank?: number }).rank ?? 0;
    const byId = new Map(laidNodes.map((n) => [n.id, n]));
    const laidEdges: LaidOutEdge[] = edges.map((e, i) => {
        const d = g.edge({ v: e.from, w: e.to, name: `e${i}` }) as { points?: { x: number; y: number }[] } | undefined;
        // Forward edges with a clear line of sight are drawn straight (and stay clean when boxes move);
        // backward edges and edges that would cross other boxes keep dagre's routing.
        const from = byId.get(e.from)!;
        const to = byId.get(e.to)!;
        const straight =
            rank(e.to) > rank(e.from) &&
            !laidNodes.some((n) => n !== from && n !== to && segmentHitsBox(center(from), center(to), n, 12));
        return { from: e.from, to: e.to, label: e.label?.trim() || undefined, via: straight ? [] : bendPoints(d?.points ?? []) };
    });

    const graph = g.graph() as { width?: number; height?: number };
    return { nodes: laidNodes, edges: laidEdges, width: graph.width ?? 0, height: graph.height ?? 0 };
}

const center = (b: { x: number; y: number; width: number; height: number }) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });

/** Whether the segment a→b passes through box (expanded by `pad`). Liang–Barsky clipping. */
function segmentHitsBox(a: { x: number; y: number }, b: { x: number; y: number }, box: { x: number; y: number; width: number; height: number }, pad: number) {
    const minX = box.x - pad;
    const maxX = box.x + box.width + pad;
    const minY = box.y - pad;
    const maxY = box.y + box.height + pad;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    let t0 = 0;
    let t1 = 1;
    for (const [p, q] of [
        [-dx, a.x - minX],
        [dx, maxX - a.x],
        [-dy, a.y - minY],
        [dy, maxY - a.y],
    ]) {
        if (p === 0) {
            if (q < 0) return false;
        } else {
            const t = q / p;
            if (p < 0) t0 = Math.max(t0, t);
            else t1 = Math.min(t1, t);
            if (t0 > t1) return false;
        }
    }
    return true;
}

/** Interior points of a dagre edge, or none when the edge is (nearly) straight. */
function bendPoints(points: { x: number; y: number }[]): { x: number; y: number }[] {
    if (points.length <= 2) return [];
    const first = points[0];
    const last = points[points.length - 1];
    const interior = points.slice(1, -1);
    const len = Math.hypot(last.x - first.x, last.y - first.y) || 1;
    const straight = interior.every((p) => Math.abs((last.x - first.x) * (first.y - p.y) - (first.x - p.x) * (last.y - first.y)) / len < 4);
    return straight ? [] : interior.map((p) => ({ x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10 }));
}
