import type { Db } from '../db/db.js';
import { hashToken, newToken } from './tokens.js';

export interface User {
    id: string;
    email: string | null;
    name: string;
    avatarUrl: string | null;
}

export interface ProviderProfile {
    provider: 'google' | 'github' | 'dev';
    providerUserId: string;
    email: string | null;
    emailVerified: boolean;
    name: string;
    avatarUrl: string | null;
}

type UserRow = { id: string; email: string | null; name: string; avatar_url: string | null };
const toUser = (r: UserRow): User => ({ id: r.id, email: r.email, name: r.name, avatarUrl: r.avatar_url });

const NAME_MAX = 80;

export class AuthService {
    constructor(
        private readonly db: Db,
        private readonly sessionTtlMs: number,
    ) {}

    /**
     * Finds or creates the user for a provider sign-in. A verified email already used by another
     * provider links to the same person, so Google and GitHub sign-ins share one account.
     */
    async upsertFromProfile(p: ProviderProfile): Promise<User> {
        const client = await this.db.connect();
        try {
            await client.query('BEGIN');
            const linked = await client.query<UserRow>(
                'SELECT u.id, u.email, u.name, u.avatar_url FROM accounts a JOIN users u ON u.id = a.user_id WHERE a.provider = $1 AND a.provider_user_id = $2',
                [p.provider, p.providerUserId],
            );
            let row = linked.rows[0];
            const email = p.email?.trim().toLowerCase() || null;
            if (!row && email && p.emailVerified) {
                row = (await client.query<UserRow>('SELECT id, email, name, avatar_url FROM users WHERE lower(email) = $1 AND email_verified', [email])).rows[0];
            }
            if (!row) {
                row = (
                    await client.query<UserRow>(
                        'INSERT INTO users (email, email_verified, name, avatar_url) VALUES ($1, $2, $3, $4) RETURNING id, email, name, avatar_url',
                        [email, !!(email && p.emailVerified), p.name.slice(0, NAME_MAX) || 'Someone', p.avatarUrl],
                    )
                ).rows[0];
            } else if (!row.avatar_url && p.avatarUrl) {
                await client.query('UPDATE users SET avatar_url = $2 WHERE id = $1', [row.id, p.avatarUrl]);
                row = { ...row, avatar_url: p.avatarUrl };
            }
            await client.query('INSERT INTO accounts (provider, provider_user_id, user_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [
                p.provider,
                p.providerUserId,
                row.id,
            ]);
            await client.query('COMMIT');
            return toUser(row);
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    }

    async createSession(userId: string): Promise<string> {
        const token = newToken('sss');
        await this.db.query('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)', [
            hashToken(token),
            userId,
            new Date(Date.now() + this.sessionTtlMs),
        ]);
        return token;
    }

    async userForSession(token: string | null | undefined): Promise<User | null> {
        if (!token || token.length > 200) return null;
        const { rows } = await this.db.query<UserRow>(
            'SELECT u.id, u.email, u.name, u.avatar_url FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1 AND s.expires_at > now()',
            [hashToken(token)],
        );
        return rows[0] ? toUser(rows[0]) : null;
    }

    async deleteSession(token: string) {
        await this.db.query('DELETE FROM sessions WHERE token_hash = $1', [hashToken(token)]);
    }

    async getUser(id: string): Promise<User | null> {
        const { rows } = await this.db.query<UserRow>('SELECT id, email, name, avatar_url FROM users WHERE id = $1', [id]);
        return rows[0] ? toUser(rows[0]) : null;
    }

    async findUserByEmail(email: string): Promise<User | null> {
        const { rows } = await this.db.query<UserRow>('SELECT id, email, name, avatar_url FROM users WHERE lower(email) = lower($1) AND email_verified', [email]);
        return rows[0] ? toUser(rows[0]) : null;
    }

    /** Stores a short-lived secret and returns it. */
    async putCode(kind: string, data: Record<string, unknown>, ttlMs: number, code = newToken('ssc')): Promise<string> {
        await this.db.query('INSERT INTO auth_codes (code_hash, kind, data, expires_at) VALUES ($1, $2, $3, $4)', [
            hashToken(code),
            kind,
            JSON.stringify(data),
            new Date(Date.now() + ttlMs),
        ]);
        return code;
    }

    /** Returns and deletes a short-lived secret (one use only). */
    async takeCode<T>(kind: string, code: string | null | undefined): Promise<T | null> {
        if (!code || code.length > 200) return null;
        const { rows } = await this.db.query<{ data: T }>('DELETE FROM auth_codes WHERE code_hash = $1 AND kind = $2 AND expires_at > now() RETURNING data', [
            hashToken(code),
            kind,
        ]);
        return rows[0]?.data ?? null;
    }
}
