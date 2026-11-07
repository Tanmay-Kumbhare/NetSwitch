import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import { DEFAULTS } from './config.js';
import { Agent } from './agent.js';
import { createRepo } from './db/index.js';
import { makeAuth, httpErr } from './auth.js';
import { WinController } from './control/winController.js';
import { SimController } from './control/simController.js';
import { scanWifi } from './windows/wifiScan.js';
import { subnetInfo } from './core/subnet.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export async function createApp({ env = process.env, repo = createRepo(env), controller, log = console.log } = {}) {
  const mode = env.NETSWITCH_MODE || (process.platform === 'win32' ? 'windows' : 'sim');
  controller ||= mode === 'sim' ? new SimController()
    : new WinController({ stateFile: path.resolve(env.NETSWITCH_STATE || path.join(here, '..', '..', 'netswitch-state.json')), cfg: DEFAULTS, log });
  await repo.init();
  const agent = new Agent({ controller, repo, log });
  await agent.start();
  const auth = makeAuth(repo);

  const app = express();
  app.use(cors({ origin: [/^http:\/\/(localhost|127\.0\.0\.1):\d+$/] }));
  app.use(express.json({ limit: '50kb' }));
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  const admin = auth.middleware('admin'); const any = auth.middleware();

  // 1-2-3 auth
  app.post('/api/auth/register', wrap(async (req, res) => res.status(201).json(await auth.register(req.body || {}))));
  app.post('/api/auth/login', wrap(async (req, res) => res.json(await auth.login(req.body || {}))));
  app.get('/api/auth/me', any, wrap(async (req, res) => { const u = await repo.findUserById(req.user.sub); if (!u) throw httpErr(401, 'unknown user'); res.json({ id: u.id, email: u.email, name: u.name, role: u.role }); }));
  // 4 health
  app.get('/api/health', wrap(async (req, res) => res.json({ ok: true, mode, db: repo.kind, dbUp: await repo.ping(), canControl: agent.canControl, uptimeSec: Math.round((Date.now() - agent.startedAt) / 1000), clients: wss.clients.size })));
  // 5-6 interfaces
  app.get('/api/interfaces', any, (req, res) => res.json({ mode, activeId: agent.state?.activeId ?? null, adapters: agent.lastSnapshot?.adapters ?? [] }));
  app.get('/api/interfaces/:key', any, wrap(async (req, res) => {
    const a = agent.lastSnapshot?.adapters.find((x) => x.id === req.params.key); if (!a) throw httpErr(404, 'unknown interface');
    const to = Date.now(); const r = await repo.queryReadings({ key: a.id, fromMs: to - 5 * 60000, toMs: to, bucketSec: 5 });
    res.json({ adapter: a, subnet: subnetInfo(a.ip, a.prefix), recent: r.rows });
  }));
  // 7 history (SQL aggregation; the SQL text is returned for the "Show SQL" button)
  app.get('/api/readings', any, wrap(async (req, res) => {
    const key = String(req.query.interface || ''); const minutes = Math.min(1440, Math.max(1, Number(req.query.minutes) || 15));
    if (!/^[a-z0-9]{1,40}$/.test(key)) throw httpErr(400, 'interface required');
    const bucketSec = Math.max(5, Math.ceil((minutes * 60) / 200)); const to = Date.now();
    res.json({ interface: key, minutes, bucketSec, ...(await repo.queryReadings({ key, fromMs: to - minutes * 60000, toMs: to, bucketSec })) });
  }));
  // 8 failovers
  app.get('/api/failovers', any, wrap(async (req, res) => res.json({ events: await repo.listFailovers(Number(req.query.limit) || 50) })));
  // 9-10 control (admin only)
  app.post('/api/control/switch', admin, wrap(async (req, res) => {
    const to = req.body?.to; if (typeof to !== 'string' || !/^[a-z0-9]{1,40}$/.test(to)) throw httpErr(400, 'to required');
    const r = await agent.switchTo(to); res.status(r.busy ? 409 : r.ok ? 200 : 422).json(r);
  }));
  app.post('/api/control/restore', admin, wrap(async (req, res) => res.json(await agent.restore())));
  // 11-12 config
  app.get('/api/config', any, (req, res) => res.json({ decide: agent.cfg.decide, score: agent.cfg.score, probe: agent.cfg.probe, targets: agent.cfg.targets }));
  app.put('/api/config', admin, wrap(async (req, res) => { try { res.json(await agent.updateConfig(req.body)); } catch (e) { throw httpErr(400, e.message); } }));
  // optional: read-only Wi-Fi scan (never connects)
  app.get('/api/wifi/scan', any, wrap(async (req, res) => {
    if (mode === 'sim') return res.json({ simulated: true, networks: [{ ssid: 'Moto g64 5G (sim)', authentication: 'WPA3-Personal', encryption: 'CCMP', bssids: [{ bssid: '66:71:2f:94:31:f9', signal: 97, radio: '802.11ac', band: '2.4 GHz', channel: 1 }] }] });
    try { res.json({ simulated: false, networks: await scanWifi() }); } catch (e) { throw httpErr(503, `scan unavailable: ${e.message}`); }
  }));
  // sim-only fault injection (the Windows demo uses Clumsy instead)
  if (mode === 'sim') {
    app.post('/api/sim/impair', admin, (req, res) => { try { res.json(controller.impair(String(req.body?.adapter), req.body || {})); } catch (e) { throw httpErr(400, e.message); } });
    app.post('/api/sim/reset', admin, (req, res) => { controller.resetImpairments(); res.json({ ok: true }); });
  }

  const dist = path.resolve(here, '..', '..', 'frontend', 'dist');
  if (fs.existsSync(dist)) { app.use(express.static(dist)); app.get(/^\/(?!api|ws).*/, (req, res) => res.sendFile(path.join(dist, 'index.html'))); }
  app.use((req, res) => res.status(404).json({ error: 'not found' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => { if (!err.status) log('[http]', err); res.status(err.status || 500).json({ error: err.status ? err.message : 'internal error' }); });

  // ---- WebSocket: authenticated upgrade, 1 s snapshots, failover events ----
  // SECURITY & PRODUCTION HARDENING NOTE:
  // Standard browser WebSocket API does not support custom headers (e.g. 'Authorization: Bearer <tok>'),
  // so JWT tokens are passed via the '?token=' query parameter during HTTP upgrade.
  // Query parameters are never logged by the application or included in handshake debug headers.
  // For production environments exposed beyond localhost, a short-lived single-use ticket pattern
  // (e.g. POST /api/auth/ws-ticket) is recommended to prevent token leakage in external proxy logs.
  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname === '/ws' ? auth.verify(url.searchParams.get('token') || '') : null;
    if (!p) { socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => { ws.user = p; wss.emit('connection', ws, req); });
  });
  wss.on('headers', (headers, req) => { req._wsResponse = headers; });
  wss.on('connection', (ws, req) => {
    const pick = (h) => ['host', 'upgrade', 'connection', 'sec-websocket-key', 'sec-websocket-version', 'origin'].filter((k) => h[k]).map((k) => `${k}: ${h[k]}`);
    ws.send(JSON.stringify({ type: 'hello', serverTime: Date.now(), mode, user: ws.user.name, handshake: { request: [`GET /ws HTTP/1.1`, ...pick(req.headers)], response: req._wsResponse || [] } }));
    if (agent.lastSnapshot) ws.send(JSON.stringify(agent.lastSnapshot));
    ws.on('message', (m) => { try { if (JSON.parse(m).type === 'ping') ws.send(JSON.stringify({ type: 'pong', t: Date.now() })); } catch { /* ignore bad frames */ } });
  });
  const broadcast = (obj) => { const s = JSON.stringify(obj); for (const c of wss.clients) if (c.readyState === 1) c.send(s); };
  agent.on('snapshot', broadcast);
  agent.on('failover', (event) => broadcast({ type: 'failover', event }));

  const close = async () => { await agent.stop(); wss.close(); await new Promise((r) => server.close(r)); await repo.close(); };
  return { app, server, agent, repo, controller, close, mode };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 4000); const host = process.env.HOST || '127.0.0.1';
  const ctx = await createApp();
  ctx.server.listen(port, host, () => console.log(`[netswitch] ${ctx.mode} mode, db=${ctx.repo.kind}, http://${host}:${port}`));
  let closing = false;
  const bye = async () => { if (closing) return; closing = true; console.log('[netswitch] shutting down, restoring network settings'); await ctx.close().catch(() => {}); process.exit(0); };
  process.on('SIGINT', bye); process.on('SIGTERM', bye);
}
