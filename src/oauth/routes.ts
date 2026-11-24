import cors from 'cors';
import express, { type Request, type Response } from 'express';
import type { User } from '../auth/AuthService.js';
import { loadUser, requireUser } from '../auth/routes.js';
import { hashToken, newToken, pkceS256, safeEqual } from '../auth/tokens.js';
import type { Config } from '../config.js';
import type { Platform } from '../platform.js';

/**
 * OAuth 2.1 for the personal MCP connector: metadata discovery, dynamic client registration,
 * authorization code + PKCE (S256) and rotating refresh tokens. Public clients only.
 *
 * Signing in and the consent screen live in the web app (the account session is a bearer token
 * there), so /oauth/authorize validates the request and forwards it to the app's /authorize page,
 * which posts the decision back to /api/oauth/decision.
 */
export const ACCESS_TTL_MS = 60 * 60 * 1000;
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CODE_TTL_MS = 5 * 60 * 1000;
export const SCOPE = 'boards';

interface AuthorizeParams {
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    state?: string;
    scope: string;
}

interface CodeData extends AuthorizeParams {
    userId: string;
}

export interface McpAuth {
    user: User;
    clientId: string;
    clientName: string;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** https anywhere, http only on this machine, or an app's own scheme (cursor://, vscode://…). */
export function validRedirectUri(uri: unknown): uri is string {
    if (typeof uri !== 'string' || uri.length > 2000) return false;
    let url: URL;
    try {
        url = new URL(uri);
    } catch {
        return false;
    }
    if (url.hash) return false;
    if (url.protocol === 'https:') return true;
    if (url.protocol === 'http:') return LOOPBACK.has(url.hostname);
    return /^[a-z][a-z0-9+.-]*:$/.test(url.protocol) && !['javascript:', 'data:', 'file:', 'vbscript:', 'blob:', 'about:'].includes(url.protocol);
}

const oauthError = (res: Response, status: number, error: string, description: string) => res.status(status).json({ error, error_description: description });

export function oauthRouter(platform: Platform, config: Config) {
    const router = express.Router();
    const issuer = config.publicUrl;
    const frontend = config.frontendUrl.replace(/\/+$/, '');
    const { db } = platform;
    const open = cors({ origin: '*', allowedHeaders: ['Content-Type', 'Authorization', 'Mcp-Protocol-Version'] });

    const metadata = {
        issuer,
        authorization_endpoint: `${issuer}/oauth/authorize`,
        token_endpoint: `${issuer}/oauth/token`,
        registration_endpoint: `${issuer}/oauth/register`,
        revocation_endpoint: `${issuer}/oauth/revoke`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
        scopes_supported: [SCOPE],
    };
    const resource = {
        resource: `${issuer}/mcp`,
        authorization_servers: [issuer],
        scopes_supported: [SCOPE],
        bearer_methods_supported: ['header'],
        resource_name: 'SketchSync boards',
    };
    router.get(['/.well-known/oauth-authorization-server', '/.well-known/oauth-authorization-server/mcp', '/.well-known/openid-configuration'], open, (_req, res) => res.json(metadata));
    router.get(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'], open, (_req, res) => res.json(resource));

    router.options(['/oauth/register', '/oauth/token', '/oauth/revoke'], open);

    router.post('/oauth/register', open, express.json({ limit: '16kb' }), async (req, res, next) => {
        try {
            const body = (req.body ?? {}) as { redirect_uris?: unknown; client_name?: unknown };
            const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
            if (!uris.length || uris.length > 10 || !uris.every(validRedirectUri)) {
                return oauthError(res, 400, 'invalid_redirect_uri', 'redirect_uris must be https URLs, loopback http URLs or app URLs');
            }
            const name = typeof body.client_name === 'string' && body.client_name.trim() ? body.client_name.trim().slice(0, 80) : 'AI app';
            const clientId = newToken('ssmc');
            await db.query('INSERT INTO oauth_clients (client_id, client_name, redirect_uris) VALUES ($1, $2, $3)', [clientId, name, JSON.stringify(uris)]);
            res.status(201).json({
                client_id: clientId,
                client_id_issued_at: Math.floor(Date.now() / 1000),
                client_name: name,
                redirect_uris: uris,
                grant_types: ['authorization_code', 'refresh_token'],
                response_types: ['code'],
                token_endpoint_auth_method: 'none',
                scope: SCOPE,
            });
        } catch (err) {
            next(err);
        }
    });

    async function client(clientId: unknown): Promise<{ client_id: string; client_name: string; redirect_uris: string[] } | null> {
        if (typeof clientId !== 'string' || clientId.length > 200) return null;
        const { rows } = await db.query<{ client_id: string; client_name: string; redirect_uris: string[] }>('SELECT client_id, client_name, redirect_uris FROM oauth_clients WHERE client_id = $1', [
            clientId,
        ]);
        return rows[0] ?? null;
    }

    /** Validates an authorization request. Errors before the redirect URI is trusted are shown, not redirected. */
    async function checkAuthorize(q: Record<string, unknown>): Promise<{ ok: true; params: AuthorizeParams; clientName: string } | { ok: false; error: string; redirect?: string }> {
        const c = await client(q.client_id);
        if (!c) return { ok: false, error: 'Unknown app. Remove the connector and add it again.' };
        const redirectUri = typeof q.redirect_uri === 'string' ? q.redirect_uri : c.redirect_uris.length === 1 ? c.redirect_uris[0] : '';
        if (!c.redirect_uris.includes(redirectUri)) return { ok: false, error: 'This app sent an unregistered redirect address.' };
        const fail = (error: string, description: string) => {
            const url = new URL(redirectUri);
            url.searchParams.set('error', error);
            url.searchParams.set('error_description', description);
            if (typeof q.state === 'string') url.searchParams.set('state', q.state);
            url.searchParams.set('iss', issuer);
            return { ok: false as const, error: description, redirect: url.toString() };
        };
        if (q.response_type !== 'code') return fail('unsupported_response_type', 'response_type must be code');
        if (typeof q.code_challenge !== 'string' || !/^[A-Za-z0-9_-]{43,128}$/.test(q.code_challenge)) return fail('invalid_request', 'PKCE code_challenge is required');
        if (q.code_challenge_method !== 'S256') return fail('invalid_request', 'code_challenge_method must be S256');
        return {
            ok: true,
            clientName: c.client_name,
            params: {
                clientId: c.client_id,
                redirectUri,
                codeChallenge: q.code_challenge,
                state: typeof q.state === 'string' ? q.state.slice(0, 1000) : undefined,
                scope: SCOPE,
            },
        };
    }

    router.get('/oauth/authorize', async (req, res, next) => {
        try {
            const result = await checkAuthorize(req.query as Record<string, unknown>);
            if (!result.ok) {
                if (result.redirect) return res.redirect(result.redirect);
                return res.status(400).type('text/plain').send(`Could not connect: ${result.error}`);
            }
            const params = new URLSearchParams();
            for (const [k, v] of Object.entries(req.query)) if (typeof v === 'string') params.set(k, v);
            res.redirect(`${frontend}/authorize?${params}`);
        } catch (err) {
            next(err);
        }
    });

    // The web app's consent screen: what is asking, and the decision.
    const api = express.Router();
    api.use(loadUser(platform));
    api.get('/oauth/request', async (req, res, next) => {
        try {
            const result = await checkAuthorize(req.query as Record<string, unknown>);
            if (!result.ok) return res.status(400).json({ error: result.error });
            res.json({ clientName: result.clientName, redirectHost: new URL(result.params.redirectUri).host || result.params.redirectUri });
        } catch (err) {
            next(err);
        }
    });
    api.post('/oauth/decision', requireUser, express.json({ limit: '16kb' }), async (req, res, next) => {
        try {
            const body = (req.body ?? {}) as { params?: Record<string, unknown>; approve?: unknown };
            const result = await checkAuthorize(body.params ?? {});
            if (!result.ok) return res.status(400).json({ error: result.error, redirect: result.redirect });
            const url = new URL(result.params.redirectUri);
            if (result.params.state !== undefined) url.searchParams.set('state', result.params.state);
            url.searchParams.set('iss', issuer);
            if (body.approve !== true) {
                url.searchParams.set('error', 'access_denied');
                url.searchParams.set('error_description', 'The user declined');
                return res.json({ redirect: url.toString() });
            }
            const data: CodeData = { ...result.params, userId: (res.locals.user as User).id };
            const code = await platform.auth.putCode('oauth-code', data as unknown as Record<string, unknown>, CODE_TTL_MS, newToken('ssac'));
            url.searchParams.set('code', code);
            res.json({ redirect: url.toString() });
        } catch (err) {
            next(err);
        }
    });

    // Connected AI apps, for the account page.
    api.get('/connections', requireUser, async (_req, res, next) => {
        try {
            const { rows } = await db.query<{ client_id: string; client_name: string; connected_at: Date; last_used_at: Date }>(
                `SELECT c.client_id, c.client_name, min(t.created_at) AS connected_at, max(t.last_used_at) AS last_used_at
                 FROM oauth_tokens t JOIN oauth_clients c ON c.client_id = t.client_id
                 WHERE t.user_id = $1 AND t.expires_at > now() GROUP BY c.client_id, c.client_name ORDER BY last_used_at DESC`,
                [(res.locals.user as User).id],
            );
            res.json({
                connections: rows.map((r) => ({ clientId: r.client_id, name: r.client_name, connectedAt: r.connected_at.toISOString(), lastUsedAt: r.last_used_at.toISOString() })),
            });
        } catch (err) {
            next(err);
        }
    });
    api.delete('/connections/:clientId', requireUser, async (req, res, next) => {
        try {
            await db.query('DELETE FROM oauth_tokens WHERE user_id = $1 AND client_id = $2', [(res.locals.user as User).id, req.params.clientId]);
            res.json({ ok: true });
        } catch (err) {
            next(err);
        }
    });

    async function issueTokens(clientId: string, userId: string) {
        const access = newToken('ssat');
        const refresh = newToken('ssrt');
        await db.query(
            `INSERT INTO oauth_tokens (token_hash, kind, client_id, user_id, expires_at) VALUES ($1, 'access', $3, $4, $5), ($2, 'refresh', $3, $4, $6)`,
            [hashToken(access), hashToken(refresh), clientId, userId, new Date(Date.now() + ACCESS_TTL_MS), new Date(Date.now() + REFRESH_TTL_MS)],
        );
        return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_MS / 1000, refresh_token: refresh, scope: SCOPE };
    }

    router.post('/oauth/token', open, express.urlencoded({ extended: false, limit: '16kb' }), express.json({ limit: '16kb' }), async (req: Request, res: Response, next) => {
        try {
            res.setHeader('Cache-Control', 'no-store');
            const b = (req.body ?? {}) as Record<string, unknown>;
            const str = (k: string) => (typeof b[k] === 'string' ? (b[k] as string) : '');
            if (b.grant_type === 'authorization_code') {
                const data = await platform.auth.takeCode<CodeData>('oauth-code', str('code'));
                if (!data) return oauthError(res, 400, 'invalid_grant', 'The authorization code is invalid or expired');
                if (str('client_id') && str('client_id') !== data.clientId) return oauthError(res, 400, 'invalid_grant', 'Code was issued to another client');
                if (str('redirect_uri') && str('redirect_uri') !== data.redirectUri) return oauthError(res, 400, 'invalid_grant', 'redirect_uri does not match');
                if (!str('code_verifier') || !safeEqual(pkceS256(str('code_verifier')), data.codeChallenge)) return oauthError(res, 400, 'invalid_grant', 'PKCE verification failed');
                return res.json(await issueTokens(data.clientId, data.userId));
            }
            if (b.grant_type === 'refresh_token') {
                // Rotation: each refresh token works once.
                const { rows } = await db.query<{ client_id: string; user_id: string }>(
                    "DELETE FROM oauth_tokens WHERE token_hash = $1 AND kind = 'refresh' AND expires_at > now() RETURNING client_id, user_id",
                    [hashToken(str('refresh_token'))],
                );
                const row = rows[0];
                if (!row || (str('client_id') && str('client_id') !== row.client_id)) return oauthError(res, 400, 'invalid_grant', 'The refresh token is invalid or expired');
                return res.json(await issueTokens(row.client_id, row.user_id));
            }
            return oauthError(res, 400, 'unsupported_grant_type', 'Use authorization_code or refresh_token');
        } catch (err) {
            next(err);
        }
    });

    router.post('/oauth/revoke', open, express.urlencoded({ extended: false, limit: '16kb' }), express.json({ limit: '16kb' }), async (req, res, next) => {
        try {
            const token = (req.body as { token?: unknown })?.token;
            if (typeof token === 'string') await db.query('DELETE FROM oauth_tokens WHERE token_hash = $1', [hashToken(token)]);
            res.status(200).json({});
        } catch (err) {
            next(err);
        }
    });

    return { router, api };
}

/** Resolves an MCP access token to its account. */
export async function mcpAuthFor(platform: Platform, token: string | null): Promise<McpAuth | null> {
    if (!token || token.length > 200) return null;
    const { rows } = await platform.db.query<{ user_id: string; client_id: string; client_name: string; last_used_at: Date }>(
        `SELECT t.user_id, t.client_id, c.client_name, t.last_used_at FROM oauth_tokens t JOIN oauth_clients c ON c.client_id = t.client_id
         WHERE t.token_hash = $1 AND t.kind = 'access' AND t.expires_at > now()`,
        [hashToken(token)],
    );
    const row = rows[0];
    if (!row) return null;
    const user = await platform.auth.getUser(row.user_id);
    if (!user) return null;
    if (Date.now() - row.last_used_at.getTime() > 60_000) void platform.db.query('UPDATE oauth_tokens SET last_used_at = now() WHERE token_hash = $1', [hashToken(token)]).catch(() => undefined);
    return { user, clientId: row.client_id, clientName: row.client_name };
}
