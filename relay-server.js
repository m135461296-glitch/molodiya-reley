'use strict';

/**
 * Melodiya Relay Server v2
 * ─────────────────────────
 * Changes from v1:
 *   - WebSocket server now listens on path /ws  (fixes Railway 404)
 *   - HTTP server serves /join page using the HTML sent by the PC host
 *   - HTTP server serves /cover and /api/search proxied through host WS
 *   - PC sends htmlPage in register-host message; relay caches and serves it
 */

const http      = require('http');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = process.env.PORT || 8080;

// ── Session store ──────────────────────────────────────────────────────────
// sessions: token → { host: WebSocket|null, guests: Set<WebSocket>, htmlPage: string|null }
const sessions = new Map();

const getOrCreate = (token) => {
    if (!sessions.has(token)) {
        sessions.set(token, { host: null, guests: new Set(), htmlPage: null });
    }
    return sessions.get(token);
};

const cleanup = (token) => {
    const s = sessions.get(token);
    if (!s) return;
    if (s.host === null && s.guests.size === 0) {
        sessions.delete(token);
        console.log(`[relay] Session ${token.slice(0, 8)}… cleaned up. Active: ${sessions.size}`);
    }
};

const send = (ws, obj) => {
    try {
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
    } catch { }
};

const broadcast = (set, obj) => { for (const ws of set) send(ws, obj); };

// ── HTTP server ────────────────────────────────────────────────────────────
// Serves health check, /join page, /api/search, and /cover proxied via host WS
const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost`);

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    // ── Health check ───────────────────────────────────────────────────────
    if (url.pathname === '/' || url.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: 'ok',
            service: 'Melodiya Relay',
            sessions: sessions.size,
            uptime: Math.round(process.uptime()),
        }));
        return;
    }

    // ── /join — serve controller HTML page ────────────────────────────────
    if (url.pathname === '/join') {
        const token = url.searchParams.get('token') || '';
        const session = sessions.get(token);

        if (!token || !session) {
            res.writeHead(404, { 'Content-Type': 'text/html' });
            res.end(`<!DOCTYPE html><html><body style="background:#09090b;color:#fff;font-family:monospace;display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;gap:12px">
                <p style="color:#ef4444;font-size:13px;letter-spacing:2px;text-transform:uppercase">Session not found or expired</p>
                <p style="color:#52525b;font-size:11px">Generate a new QR code in Melodiya</p>
            </body></html>`);
            return;
        }

        if (!session.htmlPage) {
            // Host hasn't connected yet — serve a waiting page that auto-refreshes
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(`<!DOCTYPE html><html><head><meta http-equiv="refresh" content="3"></head>
                <body style="background:#09090b;color:#fff;font-family:monospace;display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;gap:12px">
                <div style="width:36px;height:36px;border:3px solid #27272a;border-top-color:#10b981;border-radius:50%;animation:spin .8s linear infinite"></div>
                <p style="color:#71717a;font-size:11px;letter-spacing:2px;text-transform:uppercase">Waiting for DJ PC…</p>
                <style>@keyframes spin{to{transform:rotate(360deg)}}</style>
            </body></html>`);
            return;
        }

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(session.htmlPage);
        return;
    }

    // ── /api/search — proxied through host WS ─────────────────────────────
    if (url.pathname === '/api/search') {
        const token = url.searchParams.get('token') || '';
        const q     = url.searchParams.get('q') || '';
        const session = sessions.get(token);

        if (!token || !session || !session.host || session.host.readyState !== WebSocket.OPEN) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Host not connected' }));
            return;
        }

        const reqId = `search-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const timeout = setTimeout(() => {
            pendingRequests.delete(reqId);
            if (!res.headersSent) {
                res.writeHead(504, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Request timeout' }));
            }
        }, 10000);

        pendingRequests.set(reqId, (data, error) => {
            clearTimeout(timeout);
            pendingRequests.delete(reqId);
            if (!res.headersSent) {
                if (error) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error })); }
                else        { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); }
            }
        });

        send(session.host, { type: 'http-request', reqId, path: 'api/search', token, q });
        return;
    }

    // ── /cover — proxied through host WS ──────────────────────────────────
    if (url.pathname === '/cover') {
        const token     = url.searchParams.get('token') || '';
        const coverPath = url.searchParams.get('path') || '';
        const session   = sessions.get(token);

        if (!token || !session || !session.host || session.host.readyState !== WebSocket.OPEN) {
            res.writeHead(404); res.end(); return;
        }

        const reqId = `cover-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const timeout = setTimeout(() => {
            pendingRequests.delete(reqId);
            if (!res.headersSent) { res.writeHead(404); res.end(); }
        }, 8000);

        pendingRequests.set(reqId, (data, error, mime) => {
            clearTimeout(timeout);
            pendingRequests.delete(reqId);
            if (!res.headersSent) {
                if (error || !data) { res.writeHead(404); res.end(); }
                else {
                    const buf = Buffer.from(data, 'base64');
                    res.writeHead(200, { 'Content-Type': mime || 'image/jpeg', 'Cache-Control': 'public, max-age=86400', 'Content-Length': buf.length });
                    res.end(buf);
                }
            }
        });

        send(session.host, { type: 'http-request', reqId, path: 'cover', token, coverPath });
        return;
    }

    res.writeHead(404); res.end('Not found');
});

// ── Pending HTTP-over-WS requests ─────────────────────────────────────────
// reqId → callback(data, error, mime)
const pendingRequests = new Map();

// ── WebSocket server on /ws ────────────────────────────────────────────────
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
    const url   = new URL(req.url, `http://localhost`);
    const token = url.searchParams.get('token') || '';

    if (!token) { ws.close(4000, 'No token'); return; }

    let role = null;
    console.log(`[relay] New WS connection, token: ${token.slice(0, 8)}…`);

    ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }

        const session = getOrCreate(token);

        // ── PC registers as host ──────────────────────────────────────────
        if (msg.type === 'register-host') {
            if (session.host && session.host !== ws && session.host.readyState === WebSocket.OPEN) {
                session.host.close(4001, 'Replaced by new host');
            }
            session.host = ws;
            role = 'host';

            // Cache the controller HTML page sent by the PC
            if (msg.htmlPage) session.htmlPage = msg.htmlPage;

            send(ws, { type: 'host-registered', guestCount: session.guests.size });
            broadcast(session.guests, { type: 'host-ready' });
            console.log(`[relay] Host registered for ${token.slice(0, 8)}… (htmlPage: ${!!msg.htmlPage})`);
            return;
        }

        // ── Phone joins as guest ──────────────────────────────────────────
        if (msg.type === 'join') {
            session.guests.add(ws);
            role = 'guest';
            if (session.host && session.host.readyState === WebSocket.OPEN) {
                send(session.host, { type: 'guest-joined', guestCount: session.guests.size });
                send(ws, { type: 'connected' });
            } else {
                send(ws, { type: 'waiting' });
            }
            console.log(`[relay] Guest joined ${token.slice(0, 8)}…, total: ${session.guests.size}`);
            return;
        }

        // ── Host → resolve pending HTTP-over-WS requests ──────────────────
        if (role === 'host' && msg.type === 'http-response') {
            const cb = pendingRequests.get(msg.reqId);
            if (cb) cb(msg.data, msg.error, msg.mime);
            return;
        }

        // ── Host → all guests ─────────────────────────────────────────────
        if (role === 'host') {
            if (msg.type === 'session-ended') {
                broadcast(session.guests, { type: 'session-ended' });
                session.guests.clear();
                session.host = null;
                session.htmlPage = null;
                cleanup(token);
                return;
            }
            broadcast(session.guests, msg);
            return;
        }

        // ── Guest → host ──────────────────────────────────────────────────
        if (role === 'guest') {
            if (session.host && session.host.readyState === WebSocket.OPEN) {
                send(session.host, msg);
            }
            return;
        }
    });

    ws.on('close', () => {
        const session = sessions.get(token);
        if (!session) return;

        if (role === 'host') {
            session.host = null;
            broadcast(session.guests, { type: 'host-disconnected' });
            console.log(`[relay] Host disconnected from ${token.slice(0, 8)}…`);
        } else if (role === 'guest') {
            session.guests.delete(ws);
            if (session.host && session.host.readyState === WebSocket.OPEN) {
                send(session.host, { type: 'guest-left', guestCount: session.guests.size });
            }
            console.log(`[relay] Guest left ${token.slice(0, 8)}…, remaining: ${session.guests.size}`);
        }

        cleanup(token);
    });

    ws.on('error', (err) => {
        console.error(`[relay] WS error (${role ?? 'unknown'}):`, err.message);
    });
});

server.listen(PORT, () => {
    console.log(`[relay] Melodiya Relay Server v2 running on port ${PORT}`);
});

// ── Periodic cleanup of orphaned sessions (every 10 min) ──────────────────
setInterval(() => {
    for (const [token, session] of sessions.entries()) {
        const hostDead = !session.host || session.host.readyState !== WebSocket.OPEN;
        const noGuests = session.guests.size === 0;
        if (hostDead && noGuests) sessions.delete(token);
    }
    console.log(`[relay] Cleanup done. Active sessions: ${sessions.size}`);
}, 10 * 60 * 1000);