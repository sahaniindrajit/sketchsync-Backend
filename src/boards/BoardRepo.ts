import type { Db } from '../db/db.js';
import type { User } from '../auth/AuthService.js';
import { BOARD_TITLE_MAX, type Shape } from '../shared/protocol.js';

export type Role = 'owner' | 'editor' | 'viewer';
export type MemberRole = 'editor' | 'viewer';
export type LinkAccess = 'edit' | 'view' | 'off';

export const LINK_ACCESS: readonly LinkAccess[] = ['edit', 'view', 'off'];
export const MEMBER_ROLES: readonly MemberRole[] = ['editor', 'viewer'];

export interface BoardMeta {
    id: string;
    ownerId: string | null;
    title: string;
    titleAt: number;
    linkAccess: LinkAccess;
    shapeCount: number;
    createdAt: string;
    updatedAt: string;
}

export interface BoardSummary {
    id: string;
    title: string;
    role: Role;
    linkAccess: LinkAccess;
    owner: { id: string; name: string; avatarUrl: string | null } | null;
    shapeCount: number;
    createdAt: string;
    updatedAt: string;
    /** owned, member (added by the owner) or visited (opened through a shared link). */
    relation: 'owned' | 'member' | 'visited';
}

export interface Member {
    userId: string | null;
    email: string | null;
    name: string;
    avatarUrl: string | null;
    role: Role;
    /** Invited by email; joins when they first sign in with that address. */
    pending: boolean;
}

type BoardRow = {
    id: string;
    owner_id: string | null;
    title: string;
    title_at: string;
    link_access: LinkAccess;
    shape_count: number;
    created_at: Date;
    updated_at: Date;
};

const META_COLUMNS = 'b.id, b.owner_id, b.title, b.title_at, b.link_access, b.shape_count, b.created_at, b.updated_at';

const toMeta = (r: BoardRow): BoardMeta => ({
    id: r.id,
    ownerId: r.owner_id,
    title: r.title,
    titleAt: Number(r.title_at),
    linkAccess: r.link_access,
    shapeCount: r.shape_count,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
});

export const cleanTitle = (title: unknown) => (typeof title === 'string' ? title.replace(/\s+/g, ' ').trim().slice(0, BOARD_TITLE_MAX) : '');

/** Role from the link alone (people who aren't the owner or a member). */
export function linkRole(access: LinkAccess): Role | null {
    return access === 'edit' ? 'editor' : access === 'view' ? 'viewer' : null;
}

export const canEdit = (role: Role | null | undefined) => role === 'owner' || role === 'editor';

export class BoardRepo {
    constructor(private readonly db: Db) {}

    async get(id: string): Promise<BoardMeta | null> {
        const { rows } = await this.db.query<BoardRow>(`SELECT ${META_COLUMNS} FROM boards b WHERE b.id = $1`, [id]);
        return rows[0] ? toMeta(rows[0]) : null;
    }

    /**
     * The board and what this person may do on it. `role` is null when they have no access.
     * Email invites for this person are turned into memberships here.
     */
    async access(id: string, user: User | null): Promise<{ board: BoardMeta | null; role: Role | null; member: boolean }> {
        if (!user) {
            const board = await this.get(id);
            return { board, role: board ? linkRole(board.linkAccess) : null, member: false };
        }
        const { rows } = await this.db.query<BoardRow & { member_role: MemberRole | null }>(
            `SELECT ${META_COLUMNS}, m.role AS member_role FROM boards b LEFT JOIN board_members m ON m.board_id = b.id AND m.user_id = $2 WHERE b.id = $1`,
            [id, user.id],
        );
        const row = rows[0];
        if (!row) return { board: null, role: null, member: false };
        const board = toMeta(row);
        if (board.ownerId === user.id) return { board, role: 'owner', member: true };
        let memberRole = row.member_role;
        if (!memberRole && user.email) memberRole = await this.acceptInvite(id, user);
        if (memberRole) return { board, role: memberRole, member: true };
        return { board, role: linkRole(board.linkAccess), member: false };
    }

    /** Creates a board. Without an owner it's an anonymous board anyone with the link can edit (the original behaviour). */
    async create(id: string, ownerId: string | null, title = ''): Promise<BoardMeta> {
        const { rows } = await this.db.query<BoardRow>(
            `INSERT INTO boards (id, owner_id, title, title_at) VALUES ($1, $2, $3, $4) RETURNING ${META_COLUMNS.replace(/b\./g, '')}`,
            [id, ownerId, cleanTitle(title), title ? Date.now() : 0],
        );
        return toMeta(rows[0]);
    }

    /** Makes sure a row exists for a board opened by link (anonymous boards from before accounts, or brand new ones). */
    async ensure(id: string): Promise<BoardMeta> {
        await this.db.query('INSERT INTO boards (id) VALUES ($1) ON CONFLICT DO NOTHING', [id]);
        return (await this.get(id))!;
    }

    /**
     * Adds boards from this browser to the person's account: ownerless boards become theirs,
     * unknown ids are created for them (the browser uploads its copy when it next opens them).
     */
    async claim(ids: string[], userId: string): Promise<string[]> {
        if (!ids.length) return [];
        await this.db.query('INSERT INTO boards (id, owner_id) SELECT unnest($1::text[]), $2 ON CONFLICT DO NOTHING', [ids, userId]);
        await this.db.query('UPDATE boards SET owner_id = $2 WHERE id = ANY($1) AND owner_id IS NULL', [ids, userId]);
        const { rows } = await this.db.query<{ id: string }>('SELECT id FROM boards WHERE id = ANY($1) AND owner_id = $2', [ids, userId]);
        return rows.map((r) => r.id);
    }

    /** Every board this person can open from their boards home. */
    async listForUser(user: User, query?: string): Promise<BoardSummary[]> {
        if (user.email) await this.acceptAllInvites(user);
        const { rows } = await this.db.query<BoardRow & { relation: BoardSummary['relation']; member_role: MemberRole | null; o_name: string | null; o_avatar: string | null }>(
            `WITH mine AS (
                SELECT id AS board_id, 'owned' AS relation, NULL AS member_role, 0 AS rank FROM boards WHERE owner_id = $1
                UNION ALL SELECT board_id, 'member', role, 1 FROM board_members WHERE user_id = $1
                UNION ALL SELECT board_id, 'visited', NULL, 2 FROM board_visits WHERE user_id = $1
            ), best AS (
                SELECT DISTINCT ON (board_id) board_id, relation, member_role FROM mine ORDER BY board_id, rank
            )
            SELECT ${META_COLUMNS}, best.relation, best.member_role, o.name AS o_name, o.avatar_url AS o_avatar
            FROM best JOIN boards b ON b.id = best.board_id LEFT JOIN users o ON o.id = b.owner_id
            WHERE ($2::text IS NULL OR b.title ILIKE '%' || $2 || '%')
            ORDER BY b.updated_at DESC
            LIMIT 500`,
            [user.id, query?.trim() ? query.trim().replace(/[\\%_]/g, (c) => `\\${c}`) : null],
        );
        const out: BoardSummary[] = [];
        for (const r of rows) {
            const meta = toMeta(r);
            const role: Role | null = r.relation === 'owned' ? 'owner' : r.relation === 'member' ? r.member_role : linkRole(meta.linkAccess);
            // A visited board whose link was turned off is no longer reachable.
            if (!role) continue;
            out.push({
                id: meta.id,
                title: meta.title,
                role,
                linkAccess: meta.linkAccess,
                owner: meta.ownerId ? { id: meta.ownerId, name: r.o_name ?? 'Someone', avatarUrl: r.o_avatar } : null,
                shapeCount: meta.shapeCount,
                createdAt: meta.createdAt,
                updatedAt: meta.updatedAt,
                relation: r.relation,
            });
        }
        return out;
    }

    /** Sets the title if `titleAt` is newer than the stored one. Returns true when it changed. */
    async setTitle(id: string, title: string, titleAt = Date.now()): Promise<boolean> {
        const { rowCount } = await this.db.query('UPDATE boards SET title = $2, title_at = $3 WHERE id = $1 AND title_at < $3', [id, cleanTitle(title), titleAt]);
        return (rowCount ?? 0) > 0;
    }

    async setLinkAccess(id: string, access: LinkAccess) {
        await this.db.query('UPDATE boards SET link_access = $2 WHERE id = $1', [id, access]);
    }

    async delete(id: string) {
        await this.db.query('DELETE FROM boards WHERE id = $1', [id]);
    }

    async recordVisit(id: string, userId: string) {
        await this.db.query('INSERT INTO board_visits (board_id, user_id) VALUES ($1, $2) ON CONFLICT (board_id, user_id) DO UPDATE SET visited_at = now()', [id, userId]);
    }

    async forgetVisit(id: string, userId: string) {
        await this.db.query('DELETE FROM board_visits WHERE board_id = $1 AND user_id = $2', [id, userId]);
    }

    /* ---------- Collaborators ---------- */

    async members(id: string): Promise<Member[]> {
        const { rows } = await this.db.query<{ user_id: string | null; email: string | null; name: string; avatar_url: string | null; role: Role; pending: boolean }>(
            `SELECT u.id AS user_id, u.email, u.name, u.avatar_url, 'owner' AS role, false AS pending, 0 AS rank, b.created_at AS at
                FROM boards b JOIN users u ON u.id = b.owner_id WHERE b.id = $1
             UNION ALL
             SELECT u.id, u.email, u.name, u.avatar_url, m.role, false, 1, m.created_at
                FROM board_members m JOIN users u ON u.id = m.user_id WHERE m.board_id = $1
             UNION ALL
             SELECT NULL, i.email, i.email, NULL, i.role, true, 2, i.created_at
                FROM board_invites i WHERE i.board_id = $1
             ORDER BY rank, at`,
            [id],
        );
        return rows.map((r) => ({ userId: r.user_id, email: r.email, name: r.name, avatarUrl: r.avatar_url, role: r.role, pending: r.pending }));
    }

    /** Adds a collaborator by email: right away if they have an account, otherwise when they first sign in. */
    async invite(id: string, email: string, role: MemberRole, invitedBy: string, existing: User | null): Promise<'added' | 'invited' | 'owner'> {
        const board = await this.get(id);
        if (existing && board?.ownerId === existing.id) return 'owner';
        if (existing) {
            await this.db.query('INSERT INTO board_members (board_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT (board_id, user_id) DO UPDATE SET role = $3', [
                id,
                existing.id,
                role,
            ]);
            return 'added';
        }
        await this.db.query('INSERT INTO board_invites (board_id, email, role, invited_by) VALUES ($1, lower($2), $3, $4) ON CONFLICT (board_id, email) DO UPDATE SET role = $3', [
            id,
            email,
            role,
            invitedBy,
        ]);
        return 'invited';
    }

    async setMemberRole(id: string, target: { userId?: string; email?: string }, role: MemberRole): Promise<boolean> {
        const result = target.userId
            ? await this.db.query('UPDATE board_members SET role = $3 WHERE board_id = $1 AND user_id = $2', [id, target.userId, role])
            : await this.db.query('UPDATE board_invites SET role = $3 WHERE board_id = $1 AND email = lower($2)', [id, target.email, role]);
        return (result.rowCount ?? 0) > 0;
    }

    async removeMember(id: string, target: { userId?: string; email?: string }): Promise<boolean> {
        const result = target.userId
            ? await this.db.query('DELETE FROM board_members WHERE board_id = $1 AND user_id = $2', [id, target.userId])
            : await this.db.query('DELETE FROM board_invites WHERE board_id = $1 AND email = lower($2)', [id, target.email]);
        if (target.userId) await this.forgetVisit(id, target.userId);
        return (result.rowCount ?? 0) > 0;
    }

    private async acceptInvite(id: string, user: User): Promise<MemberRole | null> {
        const { rows } = await this.db.query<{ role: MemberRole }>('DELETE FROM board_invites WHERE board_id = $1 AND email = lower($2) RETURNING role', [id, user.email]);
        const role = rows[0]?.role;
        if (!role) return null;
        await this.db.query('INSERT INTO board_members (board_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [id, user.id, role]);
        return role;
    }

    private async acceptAllInvites(user: User) {
        const { rows } = await this.db.query<{ board_id: string; role: MemberRole }>('DELETE FROM board_invites WHERE email = lower($1) RETURNING board_id, role', [user.email]);
        for (const r of rows) {
            await this.db.query('INSERT INTO board_members (board_id, user_id, role) SELECT $1, $2, $3 WHERE NOT EXISTS (SELECT 1 FROM boards WHERE id = $1 AND owner_id = $2) ON CONFLICT DO NOTHING', [
                r.board_id,
                user.id,
                r.role,
            ]);
        }
    }

    /* ---------- Board contents ---------- */

    async loadSnapshot(id: string): Promise<{ shapes: Shape[]; seq: number } | null> {
        const { rows } = await this.db.query<{ shapes: Shape[] | null; seq: string }>('SELECT shapes, seq FROM boards WHERE id = $1', [id]);
        const row = rows[0];
        if (!row || !row.shapes) return null;
        return { shapes: row.shapes, seq: Number(row.seq) };
    }

    async saveSnapshot(id: string, shapes: Shape[], seq: number) {
        await this.db.query('UPDATE boards SET shapes = $2::jsonb, seq = $3, shape_count = $4, updated_at = now() WHERE id = $1', [id, JSON.stringify(shapes), seq, shapes.length]);
    }
}
