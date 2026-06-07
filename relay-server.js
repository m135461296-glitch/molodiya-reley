'use strict';

/**
 * relay-server.js
 * ───────────────
 * Deploy this once to Railway / Render / Fly.io.
 * It brokers WebSocket messages between the Melodiya PC (host) and
 * any number of phone clients (guests) using a shared session token.
 *
 * Message flow:
 *   PC  →  relay: { type: 'register-host', token }
 *   Phone → relay: { type: 'join', token }
 *   PC  →  relay: { type: 'deck-state', ... }       ← forwarded to all phones
 *   Phone → relay: { type: 'toggle-play', ... }     ← forwarded to host PC
 *
 * Health check: GET / → 200 OK  (for Railway/Render uptime checks)
 */

const { WebSocketServer } = require('ws');
const http = require('http');

const PORT = process.env.PORT || 8080;

// token → { host: WebSocket | null, guests: Set<WebSocket> }
const sessions = new Map();

// ── Helpers ───────────────────────────────────────────────────────────────────
const send = (ws, obj) => {
    if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify(obj));
    }
};

const getOrCreateSession = (token) => {
    if (!sessions.has(token)) {
        sessions.set(token, { host: null, guests: new Set() });
    }
    return sessions.get(token);
};

const cleanupSession = (token) => {
    const s = sessions.get(token);
    if (!s) return;
    if (!s.host && s.guests.size === 0) {
        sessions.delete(token);
        console.log(`[Relay] Session removed: ${token.slice(0, 8)}… (${sessions.size} active)`);
    }
};

// ── HTTP server (health check + WebSocket upgrade) ────────────────────────────
const httpServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(`Melodiya Relay OK — ${sessions.size} active session(s)\n`);
});

// ── WebSocket server ──────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws, req) => {
    const url   = new URL(req.url, `http://localhost`);
    const token = url.searchParams.get('token');

    if (!token) {
        ws.close(4000, 'Missing token');
        return;
    }

    let role       = null;   // 'host' | 'guest'
    let myToken    = token;

    console.log(`[Relay] New WS connection, token: ${token.slice(0, 8)}…`);

    ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }

        // ── Host registration ─────────────────────────────────────────────────
        if (msg.type === 'register-host') {
            const session = getOrCreateSession(token);

            // Kick any stale host
            if (session.host && session.host !== ws) {
                session.host.close(4001, 'Replaced by new host');
            }

            session.host = ws;
            role = 'host';

            console.log(`[Relay] Host registered for ${token.slice(0, 8)}… (${session.guests.size} guests waiting)`);
            send(ws, { type: 'host-registered', guestCount: session.guests.size });

            // If guests were already waiting, tell them the host arrived
            for (const g of session.guests) {
                send(g, { type: 'host-ready' });
            }
            return;
        }

        // ── Guest join ────────────────────────────────────────────────────────
        if (msg.type === 'join') {
            const session = getOrCreateSession(token);
            session.guests.add(ws);
            role = 'guest';

            console.log(`[Relay] Guest joined ${token.slice(0, 8)}… (${session.guests.size} total guests)`);

            if (session.host) {
                // Ask host for a fresh deck-state push
                send(session.host, { type: 'guest-joined', guestCount: session.guests.size });
                send(ws, { type: 'connected', message: 'Connected via relay' });
            } else {
                send(ws, { type: 'waiting', message: 'Waiting for host PC…' });
            }
            return;
        }

        // ── Host → broadcast to all guests ───────────────────────────────────
        if (role === 'host') {
            const session = sessions.get(token);
            if (!session) return;

            // Handle host session-end
            if (msg.type === 'session-ended') {
                for (const g of session.guests) {
                    send(g, { type: 'session-ended' });
                }
                return;
            }

            const outgoing = JSON.stringify(msg);
            for (const g of session.guests) {
                if (g.readyState === 1) g.send(outgoing);
            }
            return;
        }

        // ── Guest → forward to host ───────────────────────────────────────────
        if (role === 'guest') {
            const session = sessions.get(token);
            if (!session || !session.host) return;
            send(session.host, msg);
            return;
        }
    });

    ws.on('close', () => {
        const session = sessions.get(myToken);
        if (!session) return;

        if (role === 'host') {
            session.host = null;
            console.log(`[Relay] Host disconnected from ${myToken.slice(0, 8)}…`);
            for (const g of session.guests) {
                send(g, { type: 'host-disconnected' });
            }
        } else if (role === 'guest') {
            session.guests.delete(ws);
            console.log(`[Relay] Guest left ${myToken.slice(0, 8)}… (${session.guests.size} remaining)`);
            if (session.host) {
                send(session.host, { type: 'guest-left', guestCount: session.guests.size });
            }
        }

        cleanupSession(myToken);
    });

    ws.on('error', (err) => {
        console.error('[Relay] WS error:', err.message);
    });
});

httpServer.listen(PORT, () => {
    console.log(`[Relay] Listening on port ${PORT}`);
});

// ── Periodic stale-session cleanup (every 30 min) ────────────────────────────
setInterval(() => {
    for (const [token, s] of sessions.entries()) {
        const hostDead  = !s.host || s.host.readyState > 1;
        const guestsDead = [...s.guests].every(g => g.readyState > 1);
        if (hostDead && guestsDead) {
            sessions.delete(token);
            console.log(`[Relay] Pruned dead session ${token.slice(0, 8)}…`);
        }
    }
}, 30 * 60 * 1000);

// ── Self-ping keep-alive (every 4 min) ───────────────────────────────────────
// Prevents Railway/Render from sleeping the service due to inactivity.
const SELF_URL = process.env.RAILWAY_PUBLIC_DOMAIN
    ? `http://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : null;

if (SELF_URL) {
    setInterval(() => {
        http.get(SELF_URL, (res) => {
            console.log(`[KeepAlive] Ping → ${res.statusCode}`);
        }).on('error', (err) => {
            console.warn('[KeepAlive] Ping failed:', err.message);
        });
    }, 4 * 60 * 1000); // every 4 minutes
    console.log(`[KeepAlive] Self-ping enabled → ${SELF_URL}`);
} else {
    console.log('[KeepAlive] No RAILWAY_PUBLIC_DOMAIN set — self-ping disabled');
}