import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** A random secret with a readable prefix (e.g. "sss_…" for sessions). */
export const newToken = (prefix: string) => `${prefix}_${randomBytes(32).toString('base64url')}`;

/** Secrets are stored only as hashes. */
export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export const pkceS256 = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');

export function safeEqual(a: string, b: string): boolean {
    const x = Buffer.from(a);
    const y = Buffer.from(b);
    return x.length === y.length && timingSafeEqual(x, y);
}

/** "Bearer <token>" → token. */
export function bearer(header: string | undefined): string | null {
    const match = /^Bearer\s+(\S+)$/i.exec(header ?? '');
    return match ? match[1] : null;
}
