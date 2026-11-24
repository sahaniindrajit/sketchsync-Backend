import { randomUUID } from 'node:crypto';
import express, { type Request, type Response } from 'express';
import type { User } from '../auth/AuthService.js';
import { loadUser, publicUser, requireUser } from '../auth/routes.js';
import type { Platform } from '../platform.js';
import { mathForShape } from '../render/math.js';
import { boardToSvg } from '../render/toSvg.js';
import { isValidRoomId } from '../shared/protocol.js';
import { canEdit, cleanTitle, LINK_ACCESS, MEMBER_ROLES, type BoardMeta, type LinkAccess, type MemberRole, type Role } from './BoardRepo.js';

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{1,63}$/;

const boardJson = (b: BoardMeta, role: Role | null) => ({
    id: b.id,
    title: b.title,
    titleAt: b.titleAt,
    linkAccess: b.linkAccess,
    shapeCount: b.shapeCount,
    createdAt: b.createdAt,
    updatedAt: b.updatedAt,
    role,
    owned: role === 'owner',
});

/** REST API for boards: the boards home, board settings, collaborators and thumbnails. */
export function boardsRouter(platform: Platform) {
    const router = express.Router();
    const { boards } = platform;
    router.use(loadUser(platform));
    const json = express.json({ limit: '64kb' });
    const user = (res: Response) => res.locals.user as User | null;

    /** Loads the board and the caller's role; answers 404 when it doesn't exist or they can't see it. */
    async function withBoard(req: Request, res: Response): Promise<{ board: BoardMeta; role: Role } | null> {
        const id = String(req.params.id ?? '').toLowerCase();
        if (!isValidRoomId(id)) {
            res.status(404).json({ error: 'Board not found' });
            return null;
        }
        const { board, role } = await boards.access(id, user(res));
        if (!board || !role) {
            res.status(board ? (user(res) ? 403 : 401) : 404).json({ error: board ? "You don't have access to this board" : 'Board not found' });
            return null;
        }
        return { board, role };
    }

    function ownerOnly(res: Response, role: Role): boolean {
        if (role === 'owner') return true;
        res.status(403).json({ error: 'Only the board owner can do that' });
        return false;
    }

    router.get('/boards', requireUser, async (req, res, next) => {
        try {
            const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 100) : undefined;
            res.json({ boards: await boards.listForUser(user(res)!, q) });
        } catch (err) {
            next(err);
        }
    });

    router.post('/boards', requireUser, json, async (req, res, next) => {
        try {
            const board = await boards.create(randomUUID(), user(res)!.id, cleanTitle((req.body as { title?: unknown })?.title));
            res.status(201).json({ board: boardJson(board, 'owner') });
        } catch (err) {
            next(err);
        }
    });

    // Boards made in this browser before signing in: add them to the account.
    router.post('/boards/import', requireUser, json, async (req, res, next) => {
        try {
            const raw = (req.body as { ids?: unknown })?.ids;
            const ids = Array.isArray(raw) ? Array.from(new Set(raw.filter((id): id is string => isValidRoomId(id)).map((id) => id.toLowerCase()))).slice(0, 200) : [];
            res.json({ imported: await boards.claim(ids, user(res)!.id) });
        } catch (err) {
            next(err);
        }
    });

    router.get('/boards/:id', async (req, res, next) => {
        try {
            const found = await withBoard(req, res);
            if (!found) return;
            const owner = found.board.ownerId ? await platform.auth.getUser(found.board.ownerId) : null;
            res.json({ board: { ...boardJson(found.board, found.role), owner: owner ? publicUser(owner) : null } });
        } catch (err) {
            next(err);
        }
    });

    router.patch('/boards/:id', json, async (req, res, next) => {
        try {
            const found = await withBoard(req, res);
            if (!found) return;
            const body = (req.body ?? {}) as { title?: unknown; linkAccess?: unknown };
            if (body.linkAccess !== undefined) {
                if (!ownerOnly(res, found.role)) return;
                if (!LINK_ACCESS.includes(body.linkAccess as LinkAccess)) return res.status(400).json({ error: 'linkAccess must be edit, view or off' });
                await boards.setLinkAccess(found.board.id, body.linkAccess as LinkAccess);
                await platform.live.refreshAccess(found.board.id);
            }
            if (body.title !== undefined) {
                if (!canEdit(found.role)) return res.status(403).json({ error: 'Viewers cannot rename this board' });
                const title = cleanTitle(body.title);
                const at = Date.now();
                if (await boards.setTitle(found.board.id, title, at)) platform.live.broadcastTitle(found.board.id, title, at);
            }
            const updated = await boards.get(found.board.id);
            res.json({ board: boardJson(updated!, found.role) });
        } catch (err) {
            next(err);
        }
    });

    router.delete('/boards/:id', async (req, res, next) => {
        try {
            const found = await withBoard(req, res);
            if (!found) return;
            const me = user(res);
            if (found.role !== 'owner') {
                // Not yours: just take it off your list.
                if (me) {
                    await boards.forgetVisit(found.board.id, me.id);
                    await boards.removeMember(found.board.id, { userId: me.id });
                    await platform.live.refreshAccess(found.board.id);
                }
                return res.json({ ok: true, removed: 'from-list' });
            }
            await boards.delete(found.board.id);
            await platform.live.close(found.board.id);
            platform.store.drop(found.board.id);
            res.json({ ok: true, removed: 'deleted' });
        } catch (err) {
            next(err);
        }
    });

    router.get('/boards/:id/members', async (req, res, next) => {
        try {
            const found = await withBoard(req, res);
            if (!found) return;
            if (!user(res)) return res.status(401).json({ error: 'Sign in first' });
            const members = await boards.members(found.board.id);
            // Only the owner sees email addresses.
            res.json({ members: found.role === 'owner' ? members : members.map((m) => ({ ...m, email: null, name: m.pending ? 'Invited guest' : m.name })) });
        } catch (err) {
            next(err);
        }
    });

    router.post('/boards/:id/members', json, async (req, res, next) => {
        try {
            const found = await withBoard(req, res);
            if (!found || !ownerOnly(res, found.role)) return;
            const { email, role } = (req.body ?? {}) as { email?: unknown; role?: unknown };
            if (typeof email !== 'string' || !EMAIL_RE.test(email.trim())) return res.status(400).json({ error: 'Enter a valid email address' });
            const memberRole: MemberRole = MEMBER_ROLES.includes(role as MemberRole) ? (role as MemberRole) : 'editor';
            const existing = await platform.auth.findUserByEmail(email.trim());
            const result = await boards.invite(found.board.id, email.trim(), memberRole, user(res)!.id, existing);
            if (result === 'owner') return res.status(400).json({ error: 'That’s you: you already own this board' });
            if (result === 'added') await platform.live.refreshAccess(found.board.id);
            res.status(201).json({ result, members: await boards.members(found.board.id) });
        } catch (err) {
            next(err);
        }
    });

    router.patch('/boards/:id/members', json, async (req, res, next) => {
        try {
            const found = await withBoard(req, res);
            if (!found || !ownerOnly(res, found.role)) return;
            const { userId, email, role } = (req.body ?? {}) as { userId?: unknown; email?: unknown; role?: unknown };
            if (!MEMBER_ROLES.includes(role as MemberRole)) return res.status(400).json({ error: 'role must be editor or viewer' });
            const target = typeof userId === 'string' ? { userId } : typeof email === 'string' ? { email } : null;
            if (!target || !(await boards.setMemberRole(found.board.id, target, role as MemberRole))) return res.status(404).json({ error: 'Collaborator not found' });
            await platform.live.refreshAccess(found.board.id);
            res.json({ members: await boards.members(found.board.id) });
        } catch (err) {
            next(err);
        }
    });

    router.delete('/boards/:id/members', json, async (req, res, next) => {
        try {
            const found = await withBoard(req, res);
            if (!found || !ownerOnly(res, found.role)) return;
            const { userId, email } = (req.body ?? {}) as { userId?: unknown; email?: unknown };
            const target = typeof userId === 'string' ? { userId } : typeof email === 'string' ? { email } : null;
            if (!target || !(await boards.removeMember(found.board.id, target))) return res.status(404).json({ error: 'Collaborator not found' });
            await platform.live.refreshAccess(found.board.id);
            res.json({ members: await boards.members(found.board.id) });
        } catch (err) {
            next(err);
        }
    });

    // Small preview for the boards home. Rendered from the live room when it's open.
    router.get('/boards/:id/thumbnail.svg', async (req, res, next) => {
        try {
            const found = await withBoard(req, res);
            if (!found) return;
            const room = await platform.store.load(found.board.id);
            const shapes = room?.shapes ?? new Map();
            res.setHeader('Cache-Control', 'private, max-age=5');
            res.type('image/svg+xml');
            if (!shapes.size) return res.send('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 250"/>');
            res.send(boardToSvg(shapes, { padding: 40, math: mathForShape, pixelScale: 0.4 }).svg);
        } catch (err) {
            next(err);
        }
    });

    return router;
}
