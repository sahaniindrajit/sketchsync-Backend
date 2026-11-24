## SketchSync Backend

Realtime collaboration server and **MCP server** for [SketchSync](https://github.com/sahaniindrajit/sketchsync), a collaborative whiteboard that people *and their AI assistants* can draw on together.

- **Realtime rooms (Socket.IO):** every board is a room. The server holds the board state, validates every change, and broadcasts it to everyone in the room.
- **MCP endpoint (`/mcp`, `/mcp/<boardId>`):** lets Claude, Cursor, VS Code, ChatGPT or any MCP client read and edit a board. Tools cover reading the board, adding/updating/deleting shapes, looking at a rendered PNG (so the AI can see hand drawings), auto-laid-out flowcharts, LaTeX math, and step-by-step worked solutions.
- **Server-side rendering:** boards are rendered to SVG/PNG with resvg, the Inter font and MathJax, matching what users see on the canvas.

### Quick start

```bash
npm install
npm run dev        # http://localhost:3000 (tsx watch)
```

Connect an AI to a board that is open in your browser:

```bash
claude mcp add --transport http sketchsync http://localhost:3000/mcp/<boardId>
```

### Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Start with auto-reload (TypeScript via tsx) |
| `npm run build` | Compile to `dist/` |
| `npm start` | Run the compiled server |
| `npm test` | Unit + integration tests (Vitest: rooms, sockets, MCP tools, rendering) |
| `TEST_DATABASE_URL=postgres://… npm test` | Also runs the accounts, sharing and MCP OAuth tests against a real Postgres (the database is wiped) |
| `npm run typecheck` / `npm run lint` | Type-check / lint |

### Deploying (e.g. Render)

- Build command: `npm ci && npm run build`
- Start command: `npm start`
- Node 20+

| Env var | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `CORS_ORIGINS` | production frontend + localhost dev ports | Comma-separated origins allowed for Socket.IO |
| `FRONTEND_URL` | `https://sketchsync.onrender.com` | Used in board links returned to AI clients |
| `MAX_ROOMS` | `2000` | Rooms kept in memory |
| `IDLE_ROOM_TTL_HOURS` | `48` | Idle rooms (no connections) are evicted after this |
| `MAX_TOTAL_MB` | `256` | Memory budget for all boards |
| `SOCKET_OPS_PER_SECOND` | `120` | Per-connection op rate limit |
| `SOCKET_JOINS_PER_MINUTE` | `30` | Per-connection join rate limit |
| `MAX_CONNECTIONS_PER_IP` | `50` | Concurrent Socket.IO connections per IP |
| `MCP_REQUESTS_PER_SECOND` | `20` | MCP requests per IP |
| `DATABASE_URL` | unset | Postgres (Neon, Supabase, Render…). Turns on accounts, saved boards, sharing and the personal MCP connector. Tables are created on start. |
| `PUBLIC_URL` | `http://localhost:$PORT` | This server's public URL: OAuth issuer and sign-in callbacks (`$PUBLIC_URL/api/auth/google/callback`, `…/github/callback`) |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | unset | Google sign-in |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | unset | GitHub sign-in |
| `DEV_LOGIN` | unset | `1` allows signing in with any email and no password. Local development and tests only; ignored when `NODE_ENV=production` |
| `SESSION_TTL_DAYS` | `60` | How long a sign-in lasts |
| `SNAPSHOT_INTERVAL_MS` | `1500` | How often changed boards are written to Postgres |
| `API_REQUESTS_PER_SECOND` | `30` | REST API requests per IP |

Without `DATABASE_URL`, board state lives **in memory** only (the original mode): after a restart, the first browser that opens a board re-uploads its cached copy. With it, boards are kept in memory while open and saved to Postgres every couple of seconds. Keep `/ping` pinged on free hosting to avoid sleeps.

### Accounts, boards and the personal MCP

- **Sign-in:** Google or GitHub. The web app keeps a bearer token (no cross-site cookies). The provider callback hands the app a one-time code, which it exchanges at `POST /api/auth/exchange`.
- **Boards:** `GET/POST /api/boards`, `GET/PATCH/DELETE /api/boards/:id`, `POST /api/boards/import` (adds boards made in this browser before signing in), `GET /api/boards/:id/thumbnail.svg`.
- **Sharing:** each board has an owner, collaborators (`editor` / `viewer`, invited by email: `/api/boards/:id/members`) and a link setting: `edit` (default, guests can edit), `view`, or `off`. Changes apply to open sessions right away (`room:access` socket event).
- **Personal MCP:** `$PUBLIC_URL/mcp` asks the AI app to sign in with OAuth 2.1 (discovery, dynamic client registration, PKCE, rotating refresh tokens). It can reach every board the person can: `list_boards`, `create_board`, `rename_board`, and every drawing tool takes `board` as a name or id. The old per-board URLs (`/mcp/<boardId>`) keep working without sign-in while the board is shared by link.

### How it works

```
src/
  shared/        protocol types, geometry and the board reducer (copied into the frontend)
  protocol/      zod schemas for validating ops
  rooms/         RoomStore (in-memory) + RoomService (validate → apply → broadcast)
  db/            Postgres pool and migrations
  auth/          sign-in (Google, GitHub), sessions
  boards/        saved boards, roles, collaborators, REST API, Postgres snapshots
  oauth/         OAuth 2.1 authorization server for the personal MCP connector
  realtime/      Socket.IO handlers
  mcp/           MCP HTTP transport, tools and AI-friendly input schemas
  layout/        flowchart auto-layout (dagre)
  render/        SVG/PNG rendering, fonts, MathJax
```

**Sync protocol.** Clients send ops (`add`, `update`, `append-points`, `delete`, `clear`) with ids `"<clientId>:<n>"`:
- The server applies each client's ops strictly in order and echoes every op to all members, including the sender. All clients converge on one order.
- Each reconnect uses a new client id and retires the old ones, so replays are always safe.
- Errors come back with codes. Permanent ones (`invalid`, `limit`) drop the op; temporary ones (`rate_limited`, `unavailable`, `out_of_order`) are retried in order.

**Shared code.** `src/shared/` is the source of truth. After changing it, run `npm run sync-protocol` in the frontend repo.

### Known limitations

- **Storage without a database:** boards live in memory. A board that no browser has open is lost if the server restarts or evicts it, until someone reopens it with a cached copy.
- **One server instance:** open boards live in that instance's memory, so run a single instance (no horizontal scaling yet).
- **Server renders (`get_board_image`):** only the Inter font is bundled. Non-Latin scripts (e.g. CJK) may render as missing glyphs, and their sizes can differ slightly from the browser's.
- **LaTeX:** equation numbering (`\tag`, `\label`, `\ref`) isn't supported, and very large or complex formulas are refused.

### Security notes

Without accounts, the board id (an unguessable UUID) is the only credential: anyone with a board link or MCP URL can edit that board. With accounts, owners can make a link view-only or turn it off. Session, OAuth and sign-in secrets are stored only as SHA-256 hashes. All input is validated and size-limited per op, per room and globally.
