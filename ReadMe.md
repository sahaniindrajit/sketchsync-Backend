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

Board state lives **in memory**. After a restart, the first browser that opens a board re-uploads its cached copy. Keep `/ping` pinged on free hosting to avoid sleeps.

### How it works

```
src/
  shared/        protocol types, geometry and the board reducer (copied into the frontend)
  protocol/      zod schemas for validating ops
  rooms/         RoomStore (in-memory) + RoomService (validate → apply → broadcast)
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

- **Storage:** boards live in memory. A board that no browser has open is lost if the server restarts or evicts it, until someone reopens it with a cached copy.
- **Server renders (`get_board_image`):** only the Inter font is bundled. Non-Latin scripts (e.g. CJK) may render as missing glyphs, and their sizes can differ slightly from the browser's.
- **LaTeX:** equation numbering (`\tag`, `\label`, `\ref`) isn't supported, and very large or complex formulas are refused.

### Security notes

The board id (an unguessable UUID) is the only credential. Anyone with a board link or MCP URL can edit that board. All input is validated and size-limited per op, per room and globally.
