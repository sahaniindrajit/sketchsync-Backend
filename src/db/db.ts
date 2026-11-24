import pg from 'pg';

export type Db = pg.Pool;

/**
 * Schema, applied in order. Each entry runs once; the applied count is kept in `schema_version`.
 * Never edit an applied entry: add a new one.
 */
const MIGRATIONS: string[] = [
    `
    CREATE TABLE users (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        email text,
        email_verified boolean NOT NULL DEFAULT false,
        name text NOT NULL,
        avatar_url text,
        created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX users_email_verified ON users (lower(email)) WHERE email_verified;

    CREATE TABLE accounts (
        provider text NOT NULL,
        provider_user_id text NOT NULL,
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (provider, provider_user_id)
    );

    CREATE TABLE sessions (
        token_hash text PRIMARY KEY,
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at timestamptz NOT NULL DEFAULT now(),
        expires_at timestamptz NOT NULL
    );
    CREATE INDEX sessions_user ON sessions (user_id);

    -- Short-lived secrets: sign-in handoff codes, OAuth states.
    CREATE TABLE auth_codes (
        code_hash text PRIMARY KEY,
        kind text NOT NULL,
        data jsonb NOT NULL,
        expires_at timestamptz NOT NULL
    );

    CREATE TABLE boards (
        id text PRIMARY KEY,
        owner_id uuid REFERENCES users(id) ON DELETE SET NULL,
        title text NOT NULL DEFAULT '',
        title_at bigint NOT NULL DEFAULT 0,
        link_access text NOT NULL DEFAULT 'edit' CHECK (link_access IN ('edit', 'view', 'off')),
        shapes jsonb,
        seq bigint NOT NULL DEFAULT 0,
        shape_count integer NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX boards_owner ON boards (owner_id, updated_at DESC);

    CREATE TABLE board_members (
        board_id text NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role text NOT NULL CHECK (role IN ('editor', 'viewer')),
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (board_id, user_id)
    );
    CREATE INDEX board_members_user ON board_members (user_id);

    CREATE TABLE board_invites (
        board_id text NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
        email text NOT NULL,
        role text NOT NULL CHECK (role IN ('editor', 'viewer')),
        invited_by uuid REFERENCES users(id) ON DELETE SET NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (board_id, email)
    );
    CREATE INDEX board_invites_email ON board_invites (email);

    -- Boards a signed-in person opened through a shared link (their "Shared with me" list).
    CREATE TABLE board_visits (
        board_id text NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        visited_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (board_id, user_id)
    );
    CREATE INDEX board_visits_user ON board_visits (user_id, visited_at DESC);

    -- MCP clients (dynamic client registration) and the tokens issued to them.
    CREATE TABLE oauth_clients (
        client_id text PRIMARY KEY,
        client_name text NOT NULL,
        redirect_uris jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE oauth_tokens (
        token_hash text PRIMARY KEY,
        kind text NOT NULL CHECK (kind IN ('access', 'refresh')),
        client_id text NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at timestamptz NOT NULL DEFAULT now(),
        last_used_at timestamptz NOT NULL DEFAULT now(),
        expires_at timestamptz NOT NULL
    );
    CREATE INDEX oauth_tokens_user ON oauth_tokens (user_id, client_id);
    `,
];

export function createDb(url: string): Db {
    const ssl = /sslmode=(require|verify)/.test(url) || /\.(neon\.tech|supabase\.co|supabase\.com|render\.com)/.test(url) ? { rejectUnauthorized: false } : undefined;
    const pool = new pg.Pool({ connectionString: url, max: 10, ssl });
    pool.on('error', (err) => console.error('Postgres pool error', err));
    return pool;
}

export async function migrate(db: Db) {
    const client = await db.connect();
    try {
        await client.query('SELECT pg_advisory_lock(727274)');
        await client.query('CREATE TABLE IF NOT EXISTS schema_version (version integer NOT NULL)');
        const { rows } = await client.query<{ version: number }>('SELECT version FROM schema_version');
        let version = rows[0]?.version ?? 0;
        if (!rows.length) await client.query('INSERT INTO schema_version VALUES (0)');
        for (; version < MIGRATIONS.length; version++) {
            await client.query('BEGIN');
            try {
                await client.query(MIGRATIONS[version]);
                await client.query('UPDATE schema_version SET version = $1', [version + 1]);
                await client.query('COMMIT');
            } catch (err) {
                await client.query('ROLLBACK');
                throw err;
            }
        }
    } finally {
        await client.query('SELECT pg_advisory_unlock(727274)').catch(() => undefined);
        client.release();
    }
}

/** Deletes expired secrets. */
export async function cleanupExpired(db: Db) {
    await db.query('DELETE FROM auth_codes WHERE expires_at < now()');
    await db.query('DELETE FROM sessions WHERE expires_at < now()');
    await db.query('DELETE FROM oauth_tokens WHERE expires_at < now()');
}
