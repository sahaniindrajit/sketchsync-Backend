import express, { type NextFunction, type Request, type Response } from 'express';
import type { Config } from '../config.js';
import type { Platform } from '../platform.js';
import type { ProviderProfile, User } from './AuthService.js';
import { bearer, newToken, safeEqual } from './tokens.js';

type Provider = 'google' | 'github';

const STATE_COOKIE = 'ss_oauth_state';
const STATE_TTL_MS = 10 * 60 * 1000;
const HANDOFF_TTL_MS = 2 * 60 * 1000;

/** Only same-site paths, so a sign-in link can't send people elsewhere afterwards. */
export function safeNext(next: unknown): string {
    if (typeof next !== 'string' || !next.startsWith('/') || next.startsWith('//') || next.includes('\\') || next.length > 1000) return '/boards';
    return next;
}

export const publicUser = (u: User) => ({ id: u.id, name: u.name, email: u.email, avatarUrl: u.avatarUrl });

function readCookie(req: Request, name: string): string | null {
    for (const part of (req.get('cookie') ?? '').split(';')) {
        const [k, ...v] = part.trim().split('=');
        if (k === name) return decodeURIComponent(v.join('='));
    }
    return null;
}

export function providersEnabled(config: Config) {
    return {
        google: !!(config.googleClientId && config.googleClientSecret),
        github: !!(config.githubClientId && config.githubClientSecret),
        dev: config.devLogin,
    };
}

/** Sets `res.locals.user` from the Authorization header (null for guests). */
export function loadUser(platform: Platform) {
    return async (req: Request, res: Response, next: NextFunction) => {
        try {
            res.locals.user = await platform.auth.userForSession(bearer(req.get('authorization')));
            next();
        } catch (err) {
            next(err);
        }
    };
}

export function requireUser(_req: Request, res: Response, next: NextFunction) {
    if (!res.locals.user) return res.status(401).json({ error: 'Sign in first' });
    next();
}

async function fetchJson<T>(url: string, init: RequestInit): Promise<T> {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`${url} responded ${res.status}`);
    return (await res.json()) as T;
}

async function profileFrom(provider: Provider, code: string, config: Config): Promise<ProviderProfile> {
    const redirectUri = `${config.publicUrl}/api/auth/${provider}/callback`;
    if (provider === 'google') {
        const token = await fetchJson<{ access_token: string }>('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ code, client_id: config.googleClientId, client_secret: config.googleClientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code' }),
        });
        const info = await fetchJson<{ sub: string; email?: string; email_verified?: boolean; name?: string; picture?: string }>('https://openidconnect.googleapis.com/v1/userinfo', {
            headers: { authorization: `Bearer ${token.access_token}` },
        });
        return {
            provider,
            providerUserId: info.sub,
            email: info.email ?? null,
            emailVerified: !!info.email_verified,
            name: info.name || info.email?.split('@')[0] || 'Someone',
            avatarUrl: info.picture ?? null,
        };
    }
    const token = await fetchJson<{ access_token?: string; error?: string }>('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ code, client_id: config.githubClientId, client_secret: config.githubClientSecret, redirect_uri: redirectUri }),
    });
    if (!token.access_token) throw new Error(`GitHub sign-in failed: ${token.error ?? 'no token'}`);
    const headers = { authorization: `Bearer ${token.access_token}`, accept: 'application/vnd.github+json', 'user-agent': 'SketchSync' };
    const user = await fetchJson<{ id: number; login: string; name?: string | null; avatar_url?: string }>('https://api.github.com/user', { headers });
    const emails = await fetchJson<{ email: string; primary: boolean; verified: boolean }[]>('https://api.github.com/user/emails', { headers }).catch(() => []);
    const primary = emails.find((e) => e.primary && e.verified) ?? emails.find((e) => e.verified);
    return {
        provider,
        providerUserId: String(user.id),
        email: primary?.email ?? null,
        emailVerified: !!primary,
        name: user.name || user.login,
        avatarUrl: user.avatar_url ?? null,
    };
}

function authorizeUrl(provider: Provider, state: string, config: Config): string {
    const redirectUri = `${config.publicUrl}/api/auth/${provider}/callback`;
    if (provider === 'google') {
        return `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
            client_id: config.googleClientId,
            redirect_uri: redirectUri,
            response_type: 'code',
            scope: 'openid email profile',
            state,
            prompt: 'select_account',
        })}`;
    }
    return `https://github.com/login/oauth/authorize?${new URLSearchParams({ client_id: config.githubClientId, redirect_uri: redirectUri, scope: 'read:user user:email', state })}`;
}

/**
 * Sign-in. The browser app keeps a bearer token (no cross-site cookies): provider callbacks hand
 * the app a one-time code, which it exchanges for a session token. The exchange also needs the
 * nonce the app generated when it started, so a code can't be used to sign someone else in.
 */
export function authRouter(platform: Platform, config: Config) {
    const router = express.Router();
    const { auth } = platform;
    const frontend = config.frontendUrl.replace(/\/+$/, '');
    const secure = config.publicUrl.startsWith('https://');

    const handoff = async (res: Response, user: User, next: string, nonce: string) => {
        const code = await auth.putCode('handoff', { userId: user.id, nonce }, HANDOFF_TTL_MS);
        res.redirect(`${frontend}/auth/callback?${new URLSearchParams({ code, next })}`);
    };
    const failed = (res: Response, reason: string) => res.redirect(`${frontend}/signin?${new URLSearchParams({ error: reason })}`);

    router.get('/auth/providers', (_req, res) => {
        res.json(providersEnabled(config));
    });

    router.get('/auth/:provider/start', async (req, res, next) => {
        try {
            const provider = req.params.provider as Provider;
            if (provider !== 'google' && provider !== 'github') return res.status(404).json({ error: 'Unknown sign-in provider' });
            if (!providersEnabled(config)[provider]) return failed(res, `${provider === 'google' ? 'Google' : 'GitHub'} sign-in isn't set up on this server`);
            const nonce = typeof req.query.nonce === 'string' ? req.query.nonce.slice(0, 100) : '';
            if (nonce.length < 16) return failed(res, 'Sign-in could not start. Please try again.');
            const state = newToken('sst');
            await auth.putCode('state', { provider, nonce, next: safeNext(req.query.next) }, STATE_TTL_MS, state);
            // The state must come back in the same browser that started (stops sign-in links being forwarded).
            res.cookie(STATE_COOKIE, state, { httpOnly: true, secure, sameSite: 'lax', maxAge: STATE_TTL_MS, path: '/api/auth' });
            res.redirect(authorizeUrl(provider, state, config));
        } catch (err) {
            next(err);
        }
    });

    router.get('/auth/:provider/callback', async (req, res) => {
        const provider = req.params.provider as Provider;
        if (provider !== 'google' && provider !== 'github') return res.status(404).json({ error: 'Unknown sign-in provider' });
        const state = typeof req.query.state === 'string' ? req.query.state : '';
        const cookie = readCookie(req, STATE_COOKIE);
        res.clearCookie(STATE_COOKIE, { path: '/api/auth' });
        if (typeof req.query.error === 'string') return failed(res, 'Sign-in was cancelled');
        if (!state || !cookie || !safeEqual(state, cookie)) return failed(res, 'Sign-in expired. Please try again.');
        const flow = await auth.takeCode<{ provider: Provider; nonce: string; next: string }>('state', state).catch(() => null);
        if (!flow || flow.provider !== provider) return failed(res, 'Sign-in expired. Please try again.');
        try {
            const profile = await profileFrom(provider, String(req.query.code ?? ''), config);
            const user = await auth.upsertFromProfile(profile);
            await handoff(res, user, flow.next, flow.nonce);
        } catch (err) {
            console.error('Sign-in failed', err);
            failed(res, 'Sign-in failed. Please try again.');
        }
    });

    router.post('/auth/exchange', express.json({ limit: '4kb' }), async (req, res, next) => {
        try {
            const { code, nonce } = (req.body ?? {}) as { code?: unknown; nonce?: unknown };
            const data = await auth.takeCode<{ userId: string; nonce: string }>('handoff', typeof code === 'string' ? code : null);
            if (!data || typeof nonce !== 'string' || !safeEqual(data.nonce, nonce)) return res.status(400).json({ error: 'This sign-in link expired. Please sign in again.' });
            const user = await auth.getUser(data.userId);
            if (!user) return res.status(400).json({ error: 'Account not found' });
            res.json({ token: await auth.createSession(user.id), user: publicUser(user) });
        } catch (err) {
            next(err);
        }
    });

    // Development only: sign in as anyone by email.
    router.post('/auth/dev', express.json({ limit: '4kb' }), async (req, res, next) => {
        try {
            if (!config.devLogin) return res.status(404).json({ error: 'Not found' });
            const { name, email } = (req.body ?? {}) as { name?: unknown; email?: unknown };
            if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email' });
            const clean = email.trim().toLowerCase();
            const user = await auth.upsertFromProfile({
                provider: 'dev',
                providerUserId: clean,
                email: clean,
                emailVerified: true,
                name: typeof name === 'string' && name.trim() ? name.trim() : clean.split('@')[0],
                avatarUrl: null,
            });
            res.json({ token: await auth.createSession(user.id), user: publicUser(user) });
        } catch (err) {
            next(err);
        }
    });

    router.post('/auth/logout', async (req, res, next) => {
        try {
            const token = bearer(req.get('authorization'));
            if (token) await auth.deleteSession(token);
            res.json({ ok: true });
        } catch (err) {
            next(err);
        }
    });

    router.get('/me', loadUser(platform), requireUser, (_req, res) => {
        res.json({ user: publicUser(res.locals.user as User) });
    });

    return router;
}
