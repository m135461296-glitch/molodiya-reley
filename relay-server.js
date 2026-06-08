'use strict';

/**
 * relay-server.js
 * ───────────────
 * Deploy to Railway / Render / Fly.io.
 *
 * What it does:
 *   1. Serves the controller HTML page at GET /join?token=xxx
 *      (so phones on ANY network can load it — no local IP needed)
 *   2. Brokers WebSocket messages between PC (host) and phones (guests)
 *   3. Proxies /api/search and /cover requests to the PC via WebSocket
 *
 * Flow:
 *   Phone opens https://relay.railway.app/join?token=xxx  ← loads page
 *   Phone WS  → relay → PC  (commands: play, pause, seek…)
 *   PC    WS  → relay → phones (deck-state updates)
 *   Phone fetch /api/search → relay asks PC → PC responds → relay returns JSON
 *   Phone fetch /cover      → relay asks PC → PC sends image bytes → relay returns image
 */

const { WebSocketServer } = require('ws');
const http = require('http');

const PORT = process.env.PORT || 8080;

// token → { host: WebSocket|null, guests: Set<WebSocket>, htmlPage: string|null }
const sessions = new Map();

// pending HTTP requests waiting for PC response
// requestId → { res, timer }
const pendingRequests = new Map();
let requestIdCounter = 0;

// ── Helpers ───────────────────────────────────────────────────────────────────
const send = (ws, obj) => {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
};

const getOrCreateSession = (token) => {
    if (!sessions.has(token)) {
        sessions.set(token, { host: null, guests: new Set(), htmlPage: null });
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

// ── HTTP server ───────────────────────────────────────────────────────────────
const httpServer = http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost`);

    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    // ── Health check ─────────────────────────────────────────────────────────
    if (url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(`Melodiya Relay OK — ${sessions.size} active session(s)\n`);
        return;
    }

    // ── Serve controller page ─────────────────────────────────────────────────
    // Phone opens this URL from QR code — works on ANY network
    if (url.pathname === '/join') {
        const token = url.searchParams.get('token') || '';
        const session = sessions.get(token);

        if (!session || !session.htmlPage) {
            // PC not connected yet or page not sent — show waiting page
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(`<!DOCTYPE html><html><head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width,initial-scale=1">
                <title>Melodiya Remote</title>
                <style>
                  body{background:#09090b;color:#fff;font-family:-apple-system,sans-serif;
                  display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
                  .wrap{text-align:center;padding:32px}
                  .spinner{width:36px;height:36px;border:3px solid #27272a;border-top-color:#10b981;
                  border-radius:50%;animation:spin .8s linear infinite;margin:0 auto 20px}
                  @keyframes spin{to{transform:rotate(360deg)}}
                  p{color:#71717a;font-size:12px;letter-spacing:2px;text-transform:uppercase}
                  button{margin-top:20px;padding:12px 24px;border-radius:10px;border:1px solid #27272a;
                  background:#18181b;color:#fff;font-size:11px;font-weight:900;letter-spacing:2px;
                  text-transform:uppercase;cursor:pointer}
                </style>
            </head><body><div class="wrap">
                <div class="spinner"></div>
                <p>${session ? 'Waiting for DJ PC to connect…' : 'Invalid or expired session'}</p>
                <button onclick="location.reload()">Retry</button>
            </div></body></html>`);
            return;
        }

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(session.htmlPage);
        return;
    }

    // ── Proxy /api/search to PC ───────────────────────────────────────────────
    if (url.pathname === '/api/search') {
        const token = url.searchParams.get('token') || '';
        const session = sessions.get(token);

        if (!session || !session.host || session.host.readyState !== 1) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'PC not connected' }));
            return;
        }

        const reqId = ++requestIdCounter;
        const q = url.searchParams.get('q') || '';

        const timer = setTimeout(() => {
            pendingRequests.delete(reqId);
            res.writeHead(504, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'PC did not respond in time' }));
        }, 10000);

        pendingRequests.set(reqId, { res, timer, type: 'json' });
        send(session.host, { type: 'http-request', reqId, path: 'api/search', q, token });
        return;
    }

    // ── Proxy /cover to PC ────────────────────────────────────────────────────
    if (url.pathname === '/cover') {
        const token = url.searchParams.get('token') || '';
        const coverPath = url.searchParams.get('path') || '';
        const session = sessions.get(token);

        if (!session || !session.host || session.host.readyState !== 1) {
            res.writeHead(503); res.end(); return;
        }

        const reqId = ++requestIdCounter;

        const timer = setTimeout(() => {
            pendingRequests.delete(reqId);
            res.writeHead(504); res.end();
        }, 10000);

        pendingRequests.set(reqId, { res, timer, type: 'image' });
        send(session.host, { type: 'http-request', reqId, path: 'cover', coverPath, token });
        return;
    }

    res.writeHead(404); res.end('Not found');
});

// ── WebSocket server ──────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws, req) => {
    const url   = new URL(req.url, `http://localhost`);
    const token = url.searchParams.get('token');

    if (!token) { ws.close(4000, 'Missing token'); return; }

    let role    = null;
    let myToken = token;

    console.log(`[Relay] New WS connection, token: ${token.slice(0, 8)}…`);

    ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }

        // ── Host registration ─────────────────────────────────────────────────
        if (msg.type === 'register-host') {
            const session = getOrCreateSession(token);
            if (session.host && session.host !== ws) {
                session.host.close(4001, 'Replaced by new host');
            }
            session.host = ws;
            role = 'host';

            // Store the HTML page so relay can serve it to phones
            if (msg.htmlPage) session.htmlPage = msg.htmlPage;

            console.log(`[Relay] Host registered for ${token.slice(0, 8)}…`);
            send(ws, { type: 'host-registered', guestCount: session.guests.size });

            for (const g of session.guests) send(g, { type: 'host-ready' });
            return;
        }

        // ── Host sends updated HTML page ──────────────────────────────────────
        if (msg.type === 'update-html') {
            const session = sessions.get(token);
            if (session && msg.htmlPage) session.htmlPage = msg.htmlPage;
            return;
        }

        // ── Host responds to a proxied HTTP request ───────────────────────────
        if (msg.type === 'http-response') {
            const pending = pendingRequests.get(msg.reqId);
            if (!pending) return;
            clearTimeout(pending.timer);
            pendingRequests.delete(msg.reqId);

            if (msg.error) {
                pending.res.writeHead(500, { 'Content-Type': 'application/json' });
                pending.res.end(JSON.stringify({ error: msg.error }));
                return;
            }

            if (pending.type === 'json') {
                pending.res.writeHead(200, { 'Content-Type': 'application/json' });
                pending.res.end(JSON.stringify(msg.data));
            } else if (pending.type === 'image') {
                const buf = Buffer.from(msg.data, 'base64');
                pending.res.writeHead(200, {
                    'Content-Type': msg.mime || 'image/jpeg',
                    'Cache-Control': 'public, max-age=86400',
                });
                pending.res.end(buf);
            }
            return;
        }

        // ── Guest join ────────────────────────────────────────────────────────
        if (msg.type === 'join') {
            const session = getOrCreateSession(token);
            session.guests.add(ws);
            role = 'guest';

            console.log(`[Relay] Guest joined ${token.slice(0, 8)}… (${session.guests.size} total)`);

            if (session.host) {
                send(session.host, { type: 'guest-joined', guestCount: session.guests.size });
                send(ws, { type: 'connected', message: 'Connected via relay' });
            } else {
                send(ws, { type: 'waiting', message: 'Waiting for host PC…' });
            }
            return;
        }

        // ── Host → broadcast to guests ────────────────────────────────────────
        if (role === 'host') {
            const session = sessions.get(token);
            if (!session) return;

            if (msg.type === 'session-ended') {
                for (const g of session.guests) send(g, { type: 'session-ended' });
                session.htmlPage = null;
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
            session.htmlPage = null;
            console.log(`[Relay] Host disconnected from ${myToken.slice(0, 8)}…`);
            for (const g of session.guests) send(g, { type: 'host-disconnected' });
        } else if (role === 'guest') {
            session.guests.delete(ws);
            console.log(`[Relay] Guest left ${myToken.slice(0, 8)}… (${session.guests.size} remaining)`);
            if (session.host) send(session.host, { type: 'guest-left', guestCount: session.guests.size });
        }

        cleanupSession(myToken);
    });

    ws.on('error', (err) => console.error('[Relay] WS error:', err.message));
});

httpServer.listen(PORT, () => console.log(`[Relay] Listening on port ${PORT}`));

// ── Stale session cleanup (every 30 min) ─────────────────────────────────────
setInterval(() => {
    for (const [token, s] of sessions.entries()) {
        const hostDead   = !s.host || s.host.readyState > 1;
        const guestsDead = [...s.guests].every(g => g.readyState > 1);
        if (hostDead && guestsDead) {
            sessions.delete(token);
            console.log(`[Relay] Pruned dead session ${token.slice(0, 8)}…`);
        }
    }
}, 30 * 60 * 1000);

// ── Self-ping keep-alive (every 4 min) ───────────────────────────────────────
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
    }, 4 * 60 * 1000);
    console.log(`[KeepAlive] Self-ping enabled → ${SELF_URL}`);
} else {
    console.log('[KeepAlive] No RAILWAY_PUBLIC_DOMAIN set — self-ping disabled');
}