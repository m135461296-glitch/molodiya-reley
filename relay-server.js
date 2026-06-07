'use strict';

/**
 * relay-server.js — Melodiya Relay v2
 * Deploy to Railway. Brokers WebSocket messages between
 * the Melodiya PC (host) and phone clients (guests).
 */

const { WebSocketServer } = require('ws');
const http = require('http');

const PORT = process.env.PORT || 8080;

// token → { host: WebSocket | null, guests: Set<WebSocket>, createdAt }
const sessions = new Map();

const send = (ws, obj) => {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
};

const getOrCreateSession = (token) => {
    if (!sessions.has(token)) {
        sessions.set(token, { host: null, guests: new Set(), createdAt: Date.now() });
    }
    return sessions.get(token);
};

const cleanupSession = (token) => {
    const s = sessions.get(token);
    if (!s) return;
    if (!s.host && s.guests.size === 0) {
        sessions.delete(token);
        console.log(`[Relay] Session cleaned: ${token.slice(0,8)}… (${sessions.size} active)`);
    }
};

// ── HTTP server ───────────────────────────────────────────────────────────────
const httpServer = http.createServer((req, res) => {
    // Health check — Railway needs this to confirm the service is up
    if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: 'ok',
            service: 'Melodiya Relay',
            sessions: sessions.size,
            uptime: Math.floor(process.uptime()),
        }));
        return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
});

// ── WebSocket server ──────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws, req) => {
    const url   = new URL(req.url, 'http://localhost');
    const token = url.searchParams.get('token');

    if (!token) { ws.close(4000, 'Missing token'); return; }

    let role    = null;
    let myToken = token;

    console.log(`[Relay] Connection — token: ${token.slice(0,8)}…`);

    // Heartbeat — keep connection alive through Railway's idle timeout
    const pingInterval = setInterval(() => {
        if (ws.readyState === 1) ws.ping();
    }, 25000);

    ws.on('pong', () => { /* alive */ });

    ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }

        // ── Host registration ─────────────────────────────────────────────
        if (msg.type === 'register-host') {
            const session = getOrCreateSession(token);
            if (session.host && session.host !== ws) {
                session.host.close(4001, 'Replaced by new host');
            }
            session.host = ws;
            role = 'host';
            console.log(`[Relay] Host registered ${token.slice(0,8)}… (${session.guests.size} guests)`);
            send(ws, { type: 'host-registered', guestCount: session.guests.size });
            for (const g of session.guests) send(g, { type: 'host-ready' });
            return;
        }

        // ── Guest join ────────────────────────────────────────────────────
        if (msg.type === 'join') {
            const session = getOrCreateSession(token);
            session.guests.add(ws);
            role = 'guest';
            console.log(`[Relay] Guest joined ${token.slice(0,8)}… (${session.guests.size} total)`);
            if (session.host) {
                send(session.host, { type: 'guest-joined', guestCount: session.guests.size });
                send(ws, { type: 'connected', message: 'Connected via relay' });
            } else {
                send(ws, { type: 'waiting', message: 'Waiting for host PC…' });
            }
            return;
        }

        // ── Host → broadcast to guests ────────────────────────────────────
        if (role === 'host') {
            const session = sessions.get(token);
            if (!session) return;
            if (msg.type === 'session-ended') {
                for (const g of session.guests) send(g, { type: 'session-ended' });
                return;
            }
            const outgoing = JSON.stringify(msg);
            for (const g of session.guests) {
                if (g.readyState === 1) g.send(outgoing);
            }
            return;
        }

        // ── Guest → forward to host ───────────────────────────────────────
        if (role === 'guest') {
            const session = sessions.get(token);
            if (!session || !session.host) return;
            send(session.host, msg);
            return;
        }
    });

    ws.on('close', () => {
        clearInterval(pingInterval);
        const session = sessions.get(myToken);
        if (!session) return;
        if (role === 'host') {
            session.host = null;
            console.log(`[Relay] Host left ${myToken.slice(0,8)}…`);
            for (const g of session.guests) send(g, { type: 'host-disconnected' });
        } else if (role === 'guest') {
            session.guests.delete(ws);
            console.log(`[Relay] Guest left ${myToken.slice(0,8)}… (${session.guests.size} remaining)`);
            if (session.host) send(session.host, { type: 'guest-left', guestCount: session.guests.size });
        }
        cleanupSession(myToken);
    });

    ws.on('error', (err) => console.error('[Relay] WS error:', err.message));
});

httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`[Relay] Listening on 0.0.0.0:${PORT}`);
});

// ── Stale session cleanup every 30 min ───────────────────────────────────────
setInterval(() => {
    for (const [token, s] of sessions.entries()) {
        const hostDead   = !s.host || s.host.readyState > 1;
        const guestsDead = [...s.guests].every(g => g.readyState > 1);
        if (hostDead && guestsDead) {
            sessions.delete(token);
            console.log(`[Relay] Pruned dead session ${token.slice(0,8)}…`);
        }
    }
}, 30 * 60 * 1000);

// ── Self-ping keep-alive every 4 min ─────────────────────────────────────────
const SELF_URL = process.env.RAILWAY_PUBLIC_DOMAIN
    ? `http://${process.env.RAILWAY_PUBLIC_DOMAIN}/health`
    : null;

if (SELF_URL) {
    setInterval(() => {
        http.get(SELF_URL, (res) => {
            console.log(`[KeepAlive] ${res.statusCode}`);
        }).on('error', (err) => {
            console.warn('[KeepAlive] Failed:', err.message);
        });
    }, 4 * 60 * 1000);
    console.log(`[KeepAlive] Pinging ${SELF_URL}`);
}