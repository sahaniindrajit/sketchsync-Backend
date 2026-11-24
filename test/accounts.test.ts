import { randomBytes, randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pkceS256 } from '../src/auth/tokens.js';
import { config } from '../src/config.js';
import { createDb, migrate, type Db } from '../src/db/db.js';
import { fullMcpFeatures } from '../src/mcp/features.js';
import { attachMcp } from '../src/mcp/http.js';
import { EVENTS, type AccessBroadcast, type TitleBroadcast } from '../src/shared/protocol.js';
import { join, rect, sendOp, startServer } from './helpers.js';

/**
 * Accounts, saved boards, sharing and the personal MCP connector, against a real Postgres.
 * Set TEST_DATABASE_URL to run (the database is wiped).
 */
const DB_URL = process.env.TEST_DATABASE_URL;
type Server = Awaited<ReturnType<typeof startServer>>;
type ToolResult = { content: { type: string; text?: string }[]; isError?: boolean; structuredContent?: Record<string, unknown> };

const FRONTEND = 'https://app.example';

describe.skipIf(!DB_URL)('accounts and saved boards', () => {
    let db: Db;
    let server: Server;
    const clients: Client[] = [];

    const settings = { ...config, devLogin: true, frontendUrl: FRONTEND, snapshotIntervalMs: 50, mcpRequestsPerSecond: 1000, apiRequestsPerSecond: 10_000, socketJoinsPerMinute: 6000, socketOpsPerSecond: 1000, logRequests: false };
    const start = () => startServer({ routes: (app, rooms, platform) => attachMcp(app, rooms, settings, fullMcpFeatures, platform) }, settings, { db });

    beforeAll(async () => {
        const admin = new pg.Client({ connectionString: DB_URL });
        await admin.connect();
        await admin.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
        await admin.end();
        db = createDb(DB_URL!);
        await migrate(db);
        await migrate(db); // idempotent
        server = await start();
    });

    afterAll(async () => {
        await Promise.all(clients.map((c) => c.close().catch(() => undefined)));
        await server?.stop();
        await db?.end();
    });

    const api = async (path: string, init: { method?: string; token?: string; body?: unknown } = {}) => {
        const res = await fetch(`${server.url}/api${path}`, {
            method: init.method ?? 'GET',
            headers: { ...(init.token ? { authorization: `Bearer ${init.token}` } : {}), ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}) },
            body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        });
        const text = await res.text();
        return { status: res.status, body: text ? JSON.parse(text) : null };
    };

    const signIn = async (email: string, name = email.split('@')[0]) => {
        const { status, body } = await api('/auth/dev', { method: 'POST', body: { email, name } });
        expect(status).toBe(200);
        return body as { token: string; user: { id: string; name: string } };
    };

    const waitFor = <T>(socket: { once: (e: string, cb: (p: T) => void) => void }, event: string, ms = 2000) =>
        new Promise<T>((resolve, reject) => {
            const t = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), ms);
            socket.once(event, (p: T) => {
                clearTimeout(t);
                resolve(p);
            });
        });

    it('signs in, creates, lists, renames and previews boards', async () => {
        expect((await api('/auth/providers')).body).toEqual({ google: false, github: false, dev: true });
        const alice = await signIn('alice@example.com', 'Alice');
        expect((await api('/me', { token: alice.token })).body.user).toMatchObject({ name: 'Alice', email: 'alice@example.com' });
        expect((await api('/me')).status).toBe(401);
        expect((await api('/boards')).status).toBe(401);

        const created = await api('/boards', { method: 'POST', token: alice.token, body: { title: '  Roadmap  ' } });
        expect(created.status).toBe(201);
        expect(created.body.board).toMatchObject({ title: 'Roadmap', role: 'owner', linkAccess: 'edit' });
        const id = created.body.board.id as string;

        const list = await api('/boards', { token: alice.token });
        expect(list.body.boards.map((b: { id: string }) => b.id)).toContain(id);

        const renamed = await api(`/boards/${id}`, { method: 'PATCH', token: alice.token, body: { title: 'Q3 roadmap' } });
        expect(renamed.body.board.title).toBe('Q3 roadmap');
        expect((await api('/boards?q=q3', { token: alice.token })).body.boards).toHaveLength(1);
        expect((await api('/boards?q=nothing', { token: alice.token })).body.boards).toHaveLength(0);

        const thumb = await fetch(`${server.url}/api/boards/${id}/thumbnail.svg`, { headers: { authorization: `Bearer ${alice.token}` } });
        expect(thumb.headers.get('content-type')).toMatch(/svg/);
    });

    it('saves boards to the database and loads them after a restart', async () => {
        const alice = await signIn('alice@example.com');
        const { body } = await api('/boards', { method: 'POST', token: alice.token, body: { title: 'Saved' } });
        const id = body.board.id as string;
        const socket = await server.connect(alice.token);
        const ack = await join(socket, id);
        expect(ack).toMatchObject({ ok: true, role: 'owner', title: 'Saved', fresh: true });
        expect((await sendOp(socket, id, { kind: 'add', shapes: [rect({ id: 'kept' })] })).ok).toBe(true);
        socket.disconnect();

        await server.stop();
        server = await start();
        expect(server.rooms.getRoom(id)).toBeUndefined();
        const again = await server.connect(alice.token);
        const ack2 = await join(again, id);
        expect(ack2.ok && ack2.shapes.map((s) => s.id)).toEqual(['kept']);
        expect(ack2).toMatchObject({ fresh: false });
        expect((await api('/boards', { token: alice.token })).body.boards.find((b: { id: string }) => b.id === id).shapeCount).toBe(1);
    });

    it('enforces link access and roles live', async () => {
        const owner = await signIn('owner@example.com', 'Owner');
        const bob = await signIn('bob@example.com', 'Bob');
        const { body } = await api('/boards', { method: 'POST', token: owner.token, body: { title: 'Shared' } });
        const id = body.board.id as string;

        // Anyone with the link can edit by default, signed in or not.
        const guest = await server.connect();
        expect(await join(guest, id)).toMatchObject({ ok: true, role: 'editor' });
        expect((await sendOp(guest, id, { kind: 'add', shapes: [rect({ id: 'g1' })] })).ok).toBe(true);
        const bobSocket = await server.connect(bob.token);
        expect(await join(bobSocket, id)).toMatchObject({ ok: true, role: 'editor' });
        // Bob opened it by link: it shows up under his boards.
        await new Promise((r) => setTimeout(r, 50));
        expect((await api('/boards', { token: bob.token })).body.boards.find((b: { id: string }) => b.id === id)).toMatchObject({ relation: 'visited', role: 'editor' });

        // Only the owner can change sharing.
        expect((await api(`/boards/${id}`, { method: 'PATCH', token: bob.token, body: { linkAccess: 'off' } })).status).toBe(403);

        // View-only link: open sessions are told, and edits are refused.
        const told = waitFor<AccessBroadcast>(guest, EVENTS.access);
        expect((await api(`/boards/${id}`, { method: 'PATCH', token: owner.token, body: { linkAccess: 'view' } })).status).toBe(200);
        expect(await told).toEqual({ roomId: id, role: 'viewer' });
        expect(await sendOp(guest, id, { kind: 'add', shapes: [rect()] })).toMatchObject({ ok: false, code: 'forbidden' });

        // Link off: guests must sign in, others get no access.
        const removed = waitFor<AccessBroadcast>(guest, EVENTS.access);
        await api(`/boards/${id}`, { method: 'PATCH', token: owner.token, body: { linkAccess: 'off' } });
        expect((await removed).role).toBeNull();
        expect(await join(await server.connect(), id)).toMatchObject({ ok: false, code: 'auth_required' });
        expect(await join(await server.connect(bob.token), id)).toMatchObject({ ok: false, code: 'forbidden' });
        expect((await api(`/boards/${id}`)).status).toBe(401);
        expect((await api('/boards', { token: bob.token })).body.boards.find((b: { id: string }) => b.id === id)).toBeUndefined();

        // Invite Bob as a viewer, then promote him.
        const invited = await api(`/boards/${id}/members`, { method: 'POST', token: owner.token, body: { email: 'BOB@example.com', role: 'viewer' } });
        expect(invited.body.result).toBe('added');
        const bobAgain = await server.connect(bob.token);
        expect(await join(bobAgain, id)).toMatchObject({ ok: true, role: 'viewer' });
        const promoted = waitFor<AccessBroadcast>(bobAgain, EVENTS.access);
        await api(`/boards/${id}/members`, { method: 'PATCH', token: owner.token, body: { userId: bob.user.id, role: 'editor' } });
        expect((await promoted).role).toBe('editor');
        expect((await sendOp(bobAgain, id, { kind: 'add', shapes: [rect()] })).ok).toBe(true);

        // Collaborators see names, not emails; the owner sees both.
        const asBob = await api(`/boards/${id}/members`, { token: bob.token });
        expect(asBob.body.members.every((m: { email: string | null }) => m.email === null)).toBe(true);
        const asOwner = await api(`/boards/${id}/members`, { token: owner.token });
        expect(asOwner.body.members.map((m: { role: string }) => m.role)).toEqual(['owner', 'editor']);
    });

    it('turns email invites into memberships on first sign-in', async () => {
        const owner = await signIn('owner2@example.com');
        const { body } = await api('/boards', { method: 'POST', token: owner.token, body: { title: 'Invite' } });
        const id = body.board.id as string;
        await api(`/boards/${id}`, { method: 'PATCH', token: owner.token, body: { linkAccess: 'off' } });
        const invited = await api(`/boards/${id}/members`, { method: 'POST', token: owner.token, body: { email: 'newcomer@example.com', role: 'editor' } });
        expect(invited.body.result).toBe('invited');
        expect(invited.body.members.find((m: { pending: boolean }) => m.pending)).toMatchObject({ email: 'newcomer@example.com' });

        const newcomer = await signIn('newcomer@example.com');
        expect((await api('/boards', { token: newcomer.token })).body.boards.find((b: { id: string }) => b.id === id)).toMatchObject({ role: 'editor', relation: 'member' });
        expect(await join(await server.connect(newcomer.token), id)).toMatchObject({ ok: true, role: 'editor' });
    });

    it('renames through the socket (editors only) and the API, telling open boards', async () => {
        const owner = await signIn('owner3@example.com');
        const { body } = await api('/boards', { method: 'POST', token: owner.token, body: {} });
        const id = body.board.id as string;
        const a = await server.connect(owner.token);
        await join(a, id);
        const b = await server.connect();
        await join(b, id);
        const heard = waitFor<TitleBroadcast>(b, EVENTS.title);
        await api(`/boards/${id}`, { method: 'PATCH', token: owner.token, body: { title: 'From the API' } });
        expect(await heard).toMatchObject({ roomId: id, title: 'From the API' });

        a.emit(EVENTS.presence, { roomId: id, name: 'Owner', color: '#112233', x: 1, y: 2, title: 'From presence', titleAt: Date.now() + 1000 });
        await new Promise((r) => setTimeout(r, 150));
        expect((await api(`/boards/${id}`, { token: owner.token })).body.board.title).toBe('From presence');
    });

    it('imports boards from this browser and deletes boards', async () => {
        const carol = await signIn('carol@example.com');
        const anon = randomUUID();
        const guest = await server.connect();
        await join(guest, anon);
        await sendOp(guest, anon, { kind: 'add', shapes: [rect()] });
        const unknown = randomUUID();
        const res = await api('/boards/import', { method: 'POST', token: carol.token, body: { ids: [anon, unknown, 'not-an-id'] } });
        expect(res.body.imported.sort()).toEqual([anon, unknown].sort());
        // Someone else can't take them afterwards.
        const dave = await signIn('dave@example.com');
        expect((await api('/boards/import', { method: 'POST', token: dave.token, body: { ids: [anon] } })).body.imported).toEqual([]);

        const gone = waitFor<AccessBroadcast>(guest, EVENTS.access);
        expect((await api(`/boards/${anon}`, { method: 'DELETE', token: dave.token })).body.removed).toBe('from-list');
        expect((await api(`/boards/${anon}`, { method: 'DELETE', token: carol.token })).body.removed).toBe('deleted');
        expect((await gone).role).toBeNull();
        expect((await api(`/boards/${anon}`, { token: carol.token })).status).toBe(404);
    });

    describe('personal MCP connector', () => {
        const pkce = () => {
            const verifier = randomBytes(32).toString('base64url');
            return { verifier, challenge: pkceS256(verifier) };
        };

        /** Runs the OAuth flow the way an MCP client + the web app's consent screen do. */
        async function authorize(token: string, redirectUri = 'https://client.example/callback') {
            const reg = await fetch(`${server.url}/oauth/register`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ client_name: 'Claude', redirect_uris: [redirectUri] }),
            });
            expect(reg.status).toBe(201);
            const { client_id } = (await reg.json()) as { client_id: string };
            const { verifier, challenge } = pkce();
            const params = { response_type: 'code', client_id, redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz', scope: 'boards' };
            const auth = await fetch(`${server.url}/oauth/authorize?${new URLSearchParams(params)}`, { redirect: 'manual' });
            expect(auth.status).toBe(302);
            expect(auth.headers.get('location')).toMatch(new RegExp(`^${FRONTEND}/authorize\\?`));
            const info = await api(`/oauth/request?${new URLSearchParams(params)}`);
            expect(info.body.clientName).toBe('Claude');
            const decision = await api('/oauth/decision', { method: 'POST', token, body: { params, approve: true } });
            const redirect = new URL(decision.body.redirect);
            expect(redirect.searchParams.get('state')).toBe('xyz');
            const code = redirect.searchParams.get('code')!;
            const exchange = async (v: string) =>
                fetch(`${server.url}/oauth/token`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/x-www-form-urlencoded' },
                    body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: v, client_id, redirect_uri: redirectUri }),
                });
            const tokens = (await (await exchange(verifier)).json()) as { access_token: string; refresh_token: string };
            expect(tokens.access_token).toMatch(/^ssat_/);
            // Codes work once.
            expect((await exchange(verifier)).status).toBe(400);
            return { ...tokens, client_id };
        }

        async function mcp(accessToken?: string, path = '/mcp') {
            const client = new Client({ name: 'claude-ai', version: '1.0.0' });
            await client.connect(
                new StreamableHTTPClientTransport(new URL(`${server.url}${path}`), accessToken ? { requestInit: { headers: { authorization: `Bearer ${accessToken}` } } } : undefined),
            );
            clients.push(client);
            return client;
        }
        const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as ToolResult;
        const text = (r: ToolResult) => r.content.map((c) => c.text ?? '').join('\n');

        it('advertises OAuth metadata and asks for sign-in', async () => {
            const meta = await (await fetch(`${server.url}/.well-known/oauth-authorization-server`)).json();
            expect(meta).toMatchObject({ code_challenge_methods_supported: ['S256'], registration_endpoint: expect.stringMatching(/\/oauth\/register$/) });
            const resource = await (await fetch(`${server.url}/.well-known/oauth-protected-resource/mcp`)).json();
            expect(resource.resource).toMatch(/\/mcp$/);
            const res = await fetch(`${server.url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{}' });
            expect(res.status).toBe(401);
            expect(res.headers.get('www-authenticate')).toMatch(/resource_metadata=/);
            const bad = await fetch(`${server.url}/mcp`, { method: 'POST', headers: { authorization: 'Bearer nope', 'content-type': 'application/json' }, body: '{}' });
            expect(bad.headers.get('www-authenticate')).toMatch(/invalid_token/);
        });

        it('rejects bad registrations, PKCE and redirect URIs', async () => {
            const reg = await fetch(`${server.url}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['http://evil.example/cb'] }) });
            expect(reg.status).toBe(400);
            const ok = await (
                await fetch(`${server.url}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['http://127.0.0.1:9999/cb'] }) })
            ).json();
            const wrongRedirect = await fetch(
                `${server.url}/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: ok.client_id, redirect_uri: 'https://evil.example/cb', code_challenge: 'a'.repeat(43), code_challenge_method: 'S256' })}`,
                { redirect: 'manual' },
            );
            expect(wrongRedirect.status).toBe(400);
            const noPkce = await fetch(`${server.url}/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: ok.client_id, redirect_uri: 'http://127.0.0.1:9999/cb' })}`, {
                redirect: 'manual',
            });
            expect(noPkce.headers.get('location')).toMatch(/error=invalid_request/);
        });

        it('reaches all of the account’s boards by name, and nobody else’s', async () => {
            const erin = await signIn('erin@example.com', 'Erin');
            const tokens = await authorize(erin.token);
            const client = await mcp(tokens.access_token);
            const names = (await client.listTools()).tools.map((t) => t.name);
            expect(names).toEqual(expect.arrayContaining(['list_boards', 'create_board', 'rename_board', 'add_shapes', 'create_flowchart']));

            expect(text(await call(client, 'list_boards'))).toMatch(/No boards yet/);
            const a = await call(client, 'create_board', { name: 'Board A' });
            const b = await call(client, 'create_board', { name: 'Board B' });
            const aId = a.structuredContent!.id as string;
            const bId = b.structuredContent!.id as string;

            // A browser on board A sees the AI's edit live.
            const watcher = await server.connect(erin.token);
            await join(watcher, aId);
            const seen = waitFor<{ origin: string }>(watcher, EVENTS.op);
            const added = await call(client, 'add_shapes', { board: 'board a', shapes: [{ type: 'rect', x: 0, y: 0, width: 100, height: 60, label: 'From AI' }] });
            expect(added.isError).toBeFalsy();
            expect((await seen).origin).toBe('ai:Claude');
            await call(client, 'add_shapes', { board: bId, shapes: [{ type: 'ellipse', x: 0, y: 0, width: 50, height: 50 }] });
            expect(server.rooms.getRoom(bId)!.shapes.size).toBe(1);

            const listed = (await call(client, 'list_boards')).structuredContent!.boards as { name: string; role: string }[];
            expect(listed.map((x) => x.name).sort()).toEqual(['Board A', 'Board B']);
            expect(text(await call(client, 'get_board', { board: 'Board' }))).toMatch(/Several boards match/);
            await call(client, 'rename_board', { board: bId, name: 'Renamed B' });
            expect((await api(`/boards/${bId}`, { token: erin.token })).body.board.title).toBe('Renamed B');

            // Someone else's private board is off limits; a view-only one can be read but not changed.
            const frank = await signIn('frank@example.com');
            const secret = (await api('/boards', { method: 'POST', token: frank.token, body: { title: 'Secret' } })).body.board.id as string;
            await api(`/boards/${secret}`, { method: 'PATCH', token: frank.token, body: { linkAccess: 'off' } });
            expect(text(await call(client, 'get_board', { board: secret }))).toMatch(/don't have access/);
            const readOnly = (await api('/boards', { method: 'POST', token: frank.token, body: { title: 'Read only' } })).body.board.id as string;
            await api(`/boards/${readOnly}/members`, { method: 'POST', token: frank.token, body: { email: 'erin@example.com', role: 'viewer' } });
            expect((await call(client, 'get_board', { board: 'Read only' })).isError).toBeFalsy();
            expect(text(await call(client, 'add_shapes', { board: 'Read only', shapes: [{ type: 'rect', x: 0, y: 0, width: 10, height: 10 }] }))).toMatch(/view-only/);

            // Connected apps can be listed and revoked.
            const conns = await api('/connections', { token: erin.token });
            expect(conns.body.connections).toEqual([expect.objectContaining({ name: 'Claude', clientId: tokens.client_id })]);

            // Refresh tokens rotate.
            const refresh = async (t: string) =>
                fetch(`${server.url}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: t }) });
            const next = (await (await refresh(tokens.refresh_token)).json()) as { access_token: string };
            expect(next.access_token).toMatch(/^ssat_/);
            expect((await refresh(tokens.refresh_token)).status).toBe(400);

            await api(`/connections/${tokens.client_id}`, { method: 'DELETE', token: erin.token });
            const revoked = await fetch(`${server.url}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${next.access_token}`, 'content-type': 'application/json' }, body: '{}' });
            expect(revoked.status).toBe(401);
        });

        it('keeps board links working without sign-in while the board is shared by link', async () => {
            const gina = await signIn('gina@example.com');
            const id = (await api('/boards', { method: 'POST', token: gina.token, body: { title: 'Linked' } })).body.board.id as string;
            const client = await mcp(undefined, `/mcp/${id}`);
            expect((await call(client, 'add_shapes', { shapes: [{ type: 'rect', x: 0, y: 0, width: 10, height: 10 }] })).isError).toBeFalsy();
            expect((await client.listTools()).tools.map((t) => t.name)).not.toContain('list_boards');
            await api(`/boards/${id}`, { method: 'PATCH', token: gina.token, body: { linkAccess: 'off' } });
            expect(text(await call(client, 'get_board'))).toMatch(/don't have access/);
        });
    });
});

