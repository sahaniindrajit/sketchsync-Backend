import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import cors from 'cors';
import express, { type Express, type Request, type Response } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import { randomUUID } from 'node:crypto';
import { bearer } from '../auth/tokens.js';
import type { Config } from '../config.js';
import { mcpAuthFor, type McpAuth } from '../oauth/routes.js';
import type { Platform } from '../platform.js';
import type { RoomService } from '../rooms/RoomService.js';
import { isValidRoomId } from '../shared/protocol.js';
import { createMcpServer, type McpContext } from './server.js';

const KNOWN_CLIENTS: [RegExp, string][] = [
    [/claude[-_ ]?code/i, 'Claude Code'],
    [/claude/i, 'Claude'],
    [/anthropic/i, 'Claude'],
    [/cursor/i, 'Cursor'],
    [/windsurf|codeium/i, 'Windsurf'],
    [/openai|chatgpt/i, 'ChatGPT'],
    [/copilot|vscode|visual studio code/i, 'VS Code'],
    [/gemini/i, 'Gemini'],
    [/mcp-inspector|inspector/i, 'MCP Inspector'],
];

/**
 * The transport is stateless, so the client's name (sent only in `initialize`) is remembered
 * per IP + user agent for later tool calls.
 */
const rememberedNames = new Map<string, { name: string; at: number }>();
const NAME_TTL_MS = 24 * 60 * 60 * 1000;

function friendly(name: string | undefined, ua: string): string | undefined {
    return KNOWN_CLIENTS.find(([re]) => re.test(name ?? '') || re.test(ua))?.[1] ?? name;
}

function friendlyName(name: string): string {
    return (friendly(name, '') ?? name).replace(/[^A-Za-z0-9 ._-]/g, '').trim().slice(0, 40) || 'AI';
}

/** Friendly AI name shown to board viewers ("Claude is drawing…"). */
export function clientNameFor(req: Request): string {
    const ua = req.get('user-agent') ?? '';
    const key = `${req.ip ?? ''}|${ua}`;
    const explicit = typeof req.query.client === 'string' ? req.query.client : undefined;
    const body = req.body as { method?: string; params?: { clientInfo?: { name?: string } } } | undefined;
    const fromInit = body?.method === 'initialize' ? body.params?.clientInfo?.name : undefined;
    let candidate = explicit ?? friendly(fromInit, ua);
    if (fromInit && candidate) {
        rememberedNames.delete(key);
        rememberedNames.set(key, { name: candidate, at: Date.now() });
        if (rememberedNames.size > 10_000) rememberedNames.delete(rememberedNames.keys().next().value!);
    } else if (!candidate) {
        const remembered = rememberedNames.get(key);
        if (remembered && Date.now() - remembered.at < NAME_TTL_MS) candidate = remembered.name;
    }
    const clean = (candidate ?? 'AI').replace(/[^A-Za-z0-9 ._-]/g, '').trim().slice(0, 40);
    return clean || 'AI';
}

// Rate limits are per client IP (across boards).
const jsonRpcError = (res: Response, status: number, message: string, code = -32000) =>
    res.status(status).json({ jsonrpc: '2.0', error: { code, message }, id: null });

/** What a request may reach on a server with accounts: everything the signed-in person can, or one link-shared board. */
function accountContext(platform: Platform, auth: McpAuth | null): Partial<McpContext> {
    const { boards } = platform;
    if (!auth) {
        return {
            access: async (roomId) => {
                const { board, role } = await boards.access(roomId, null);
                if (board) return role;
                const created = await boards.ensure(roomId);
                return created ? linkRoleOfNew(created) : null;
            },
            load: (roomId) => platform.store.load(roomId),
        };
    }
    const { user } = auth;
    return {
        access: async (roomId) => (await boards.access(roomId, user)).role,
        load: (roomId) => platform.store.load(roomId),
        account: {
            userName: user.name,
            listBoards: (query) => boards.listForUser(user, query),
            createBoard: async (title) => {
                const board = await boards.create(randomUUID(), user.id, title);
                return { id: board.id, title: board.title };
            },
            renameBoard: async (roomId, title) => {
                const at = Date.now();
                if (await boards.setTitle(roomId, title, at)) platform.live.broadcastTitle(roomId, title.trim().slice(0, 60), at);
            },
        },
    };
}

const linkRoleOfNew = (b: { linkAccess: string }) => (b.linkAccess === 'edit' ? 'editor' : b.linkAccess === 'view' ? 'viewer' : null);

export function attachMcp(app: Express, rooms: RoomService, config: Config, extra: Partial<McpContext> = {}, platform?: Platform) {
    const unauthorized = (res: Response, invalid: boolean) => {
        res.setHeader(
            'WWW-Authenticate',
            `Bearer resource_metadata="${config.publicUrl}/.well-known/oauth-protected-resource/mcp"${invalid ? ', error="invalid_token", error_description="Sign in again"' : ''}`,
        );
        return jsonRpcError(res, 401, invalid ? 'Your SketchSync sign-in expired. Reconnect to continue.' : 'Sign in to SketchSync to use your boards.');
    };
    const paths = ['/mcp', '/mcp/:roomId'];
    // MCP clients may run in browsers; the board id is the credential, no cookies are used.
    app.use(paths, cors({ origin: '*', exposedHeaders: ['Mcp-Session-Id'], allowedHeaders: ['Content-Type', 'Authorization', 'Mcp-Session-Id', 'Mcp-Protocol-Version', 'Last-Event-ID'] }));
    app.use(
        paths,
        rateLimit({
            windowMs: 1000,
            limit: config.mcpRequestsPerSecond,
            standardHeaders: 'draft-7',
            legacyHeaders: false,
            keyGenerator: (req) => ipKeyGenerator(req.ip ?? 'unknown'),
            handler: (_req, res) => jsonRpcError(res, 429, 'Too many requests, slow down'),
        }),
    );

    app.post(paths, express.json({ limit: '4mb' }), async (req: Request, res: Response) => {
        const roomId = typeof req.params.roomId === 'string' ? req.params.roomId : undefined;
        if (roomId !== undefined && !isValidRoomId(roomId)) return jsonRpcError(res, 404, 'Unknown board link');
        let accountCtx: Partial<McpContext> = {};
        let clientName = clientNameFor(req);
        if (platform) {
            // The personal connector (/mcp) needs a sign-in; board links (/mcp/<id>) work without one while the board is shared by link.
            const token = bearer(req.get('authorization'));
            let auth: McpAuth | null;
            try {
                auth = token ? await mcpAuthFor(platform, token) : null;
            } catch (err) {
                console.error('MCP auth failed', err);
                return jsonRpcError(res, 503, 'Could not check your sign-in right now');
            }
            if (token && !auth) return unauthorized(res, true);
            if (!auth && roomId === undefined) return unauthorized(res, false);
            if (auth && clientName === 'AI') clientName = friendlyName(auth.clientName);
            accountCtx = accountContext(platform, auth);
        }
        const server = createMcpServer({
            rooms,
            defaultRoomId: roomId?.toLowerCase(),
            clientName,
            frontendUrl: config.frontendUrl,
            ...extra,
            ...accountCtx,
        });
        // Some clients omit `arguments` for tools whose inputs are all optional; treat that as {}.
        for (const message of Array.isArray(req.body) ? req.body : [req.body]) {
            if (message && typeof message === 'object' && message.method === 'tools/call' && message.params && message.params.arguments === undefined) {
                message.params.arguments = {};
            }
        }
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        res.on('close', () => {
            void transport.close();
            void server.close();
        });
        try {
            await server.connect(transport);
            await transport.handleRequest(req, res, req.body);
        } catch (err) {
            console.error('MCP request failed', err);
            if (!res.headersSent) jsonRpcError(res, 500, 'Internal server error', -32603);
        }
    });

    app.all(paths, (_req, res) => {
        res.setHeader('Allow', 'POST');
        jsonRpcError(res, 405, 'Method not allowed. This MCP endpoint uses Streamable HTTP POST requests.');
    });

    // Friendly JSON error for malformed bodies instead of Express' HTML page.
    app.use(paths, (err: unknown, _req: Request, res: Response, next: (e?: unknown) => void) => {
        if (err && typeof err === 'object' && 'type' in err && (err as { type: string }).type === 'entity.parse.failed') {
            return jsonRpcError(res, 400, 'Parse error: invalid JSON', -32700);
        }
        if (err && typeof err === 'object' && 'type' in err && (err as { type: string }).type === 'entity.too.large') {
            return jsonRpcError(res, 413, 'Request too large');
        }
        next(err);
    });
}
