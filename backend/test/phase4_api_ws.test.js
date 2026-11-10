import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { createApp } from '../src/server.js';

const env = { NETSWITCH_MODE: 'sim', NETSWITCH_DB: 'memory', NETSWITCH_FAILOVER_ENABLED: 'true' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let ctx;
let base;
let adminToken;
let viewerToken;

const call = async (method, path, body, tok = adminToken) => {
  const r = await fetch(base + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(tok ? { authorization: `Bearer ${tok}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};

test('Phase 4.1: Server bootstrap and /api/health endpoint', async () => {
  ctx = await createApp({ env, log: () => {} });
  await new Promise((r) => ctx.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${ctx.server.address().port}`;

  const h = await call('GET', '/api/health', null, null);
  assert.equal(h.status, 200);
  assert.equal(h.body.ok, true);
  assert.equal(h.body.mode, 'sim');
  assert.equal(h.body.db, 'memory');
  assert.equal(h.body.dbUp, true);
  assert.equal(h.body.canControl, true);
  assert.equal(typeof h.body.uptimeSec, 'number');
  assert.equal(h.body.clients, 0);
});

test('Phase 4.2: Authentication & RBAC (register, login, me, role enforcement)', async () => {
  // Input validations
  assert.equal((await call('POST', '/api/auth/register', { email: 'invalid-email', name: 'Test', password: 'password123' }, null)).status, 400);
  assert.equal((await call('POST', '/api/auth/register', { email: 'valid@test.com', name: '', password: 'password123' }, null)).status, 400);
  assert.equal((await call('POST', '/api/auth/register', { email: 'valid@test.com', name: 'Test', password: 'short' }, null)).status, 400);

  // 1st registered user -> Admin
  const regAdmin = await call('POST', '/api/auth/register', { email: 'admin@netswitch.io', name: 'System Admin', password: 'password1234' }, null);
  assert.equal(regAdmin.status, 201);
  assert.equal(regAdmin.body.user.role, 'admin');
  assert.ok(regAdmin.body.token);
  adminToken = regAdmin.body.token;

  // Duplicate registration -> 409
  assert.equal((await call('POST', '/api/auth/register', { email: 'admin@netswitch.io', name: 'Duplicate', password: 'password1234' }, null)).status, 409);

  // 2nd registered user -> Viewer
  const regViewer = await call('POST', '/api/auth/register', { email: 'viewer@netswitch.io', name: 'Observer', password: 'password1234' }, null);
  assert.equal(regViewer.status, 201);
  assert.equal(regViewer.body.user.role, 'viewer');
  viewerToken = regViewer.body.token;

  // Login verification
  assert.equal((await call('POST', '/api/auth/login', { email: 'admin@netswitch.io', password: 'wrongpassword' }, null)).status, 401);
  assert.equal((await call('POST', '/api/auth/login', { email: 'nonexistent@netswitch.io', password: 'password1234' }, null)).status, 401);
  const loginOk = await call('POST', '/api/auth/login', { email: 'admin@netswitch.io', password: 'password1234' }, null);
  assert.equal(loginOk.status, 200);
  assert.equal(loginOk.body.user.email, 'admin@netswitch.io');

  // /api/auth/me token validation
  assert.equal((await call('GET', '/api/auth/me', null, null)).status, 401);
  assert.equal((await call('GET', '/api/auth/me', null, 'invalid-jwt-token')).status, 401);
  const meAdmin = await call('GET', '/api/auth/me', null, adminToken);
  assert.equal(meAdmin.status, 200);
  assert.equal(meAdmin.body.role, 'admin');
  const meViewer = await call('GET', '/api/auth/me', null, viewerToken);
  assert.equal(meViewer.status, 200);
  assert.equal(meViewer.body.role, 'viewer');
});

test('Phase 4.3: Adapter status & details (/api/interfaces, /api/interfaces/:key)', async () => {
  // Requires auth
  assert.equal((await call('GET', '/api/interfaces', null, null)).status, 401);

  const ifaces = await call('GET', '/api/interfaces', null, viewerToken);
  assert.equal(ifaces.status, 200);
  assert.equal(ifaces.body.mode, 'sim');
  assert.ok(Array.isArray(ifaces.body.adapters));
  assert.equal(ifaces.body.adapters.length, 2);

  const wifi = ifaces.body.adapters.find((a) => a.id === 'wifi');
  assert.ok(wifi);
  assert.equal(wifi.kind, 'wifi');
  assert.equal(wifi.eligible, true);
  assert.equal(wifi.up, true);

  // Detail endpoint: /api/interfaces/:key
  assert.equal((await call('GET', '/api/interfaces/unknown-adapter', null, viewerToken)).status, 404);

  const detail = await call('GET', '/api/interfaces/wifi', null, viewerToken);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.adapter.id, 'wifi');
  assert.equal(detail.body.subnet.network, '192.168.1.0');
  assert.equal(detail.body.subnet.mask, '255.255.255.0');
  assert.equal(detail.body.subnet.broadcast, '192.168.1.255');
  assert.equal(detail.body.subnet.hosts, 254);
  assert.ok(Array.isArray(detail.body.recent));
});

test('Phase 4.4: Readings and historical queries (/api/readings, /api/failovers)', async () => {
  // Parameter validation
  assert.equal((await call('GET', '/api/readings', null, viewerToken)).status, 400); // missing interface
  assert.equal((await call('GET', '/api/readings?interface=bad/id', null, viewerToken)).status, 400); // invalid characters
  assert.equal((await call('GET', '/api/readings?interface=wifi;drop', null, viewerToken)).status, 400);

  const readings = await call('GET', '/api/readings?interface=wifi&minutes=15', null, viewerToken);
  assert.equal(readings.status, 200);
  assert.equal(readings.body.interface, 'wifi');
  assert.equal(readings.body.minutes, 15);
  assert.equal(readings.body.bucketSec, 5);
  assert.ok(Array.isArray(readings.body.rows));

  // Failovers endpoint
  const failovers = await call('GET', '/api/failovers?limit=10', null, viewerToken);
  assert.equal(failovers.status, 200);
  assert.ok(Array.isArray(failovers.body.events));
});

test('Phase 4.5: Configuration endpoints (/api/config GET & PUT)', async () => {
  const getCfg = await call('GET', '/api/config', null, viewerToken);
  assert.equal(getCfg.status, 200);
  assert.ok(getCfg.body.decide);
  assert.ok(getCfg.body.score);
  assert.ok(getCfg.body.probe);

  // Viewer cannot edit config (403)
  assert.equal((await call('PUT', '/api/config', { decide: { holdDownMs: 20000 } }, viewerToken)).status, 403);

  // Validation on PUT: negative values rejected
  assert.equal((await call('PUT', '/api/config', { decide: { holdDownMs: -5000 } }, adminToken)).status, 400);
  assert.equal((await call('PUT', '/api/config', { score: { weights: { loss: -1 } } }, adminToken)).status, 400);

  // Admin successful update
  const updated = await call('PUT', '/api/config', { decide: { holdDownMs: 25000, degradeChecks: 4 } }, adminToken);
  assert.equal(updated.status, 200);
  assert.equal(updated.body.decide.holdDownMs, 25000);
  assert.equal(updated.body.decide.degradeChecks, 4);

  // Verified updated config reflects on GET
  const verifyCfg = await call('GET', '/api/config', null, viewerToken);
  assert.equal(verifyCfg.body.decide.holdDownMs, 25000);
});

test('Phase 4.6: Manual switching & restoration permissions (/api/control/*)', async () => {
  // Viewer blocked with 403
  assert.equal((await call('POST', '/api/control/switch', { to: 'wifi' }, viewerToken)).status, 403);
  assert.equal((await call('POST', '/api/control/restore', {}, viewerToken)).status, 403);

  // Invalid payload validation
  assert.equal((await call('POST', '/api/control/switch', {}, adminToken)).status, 400);
  assert.equal((await call('POST', '/api/control/switch', { to: '' }, adminToken)).status, 400);
  assert.equal((await call('POST', '/api/control/switch', { to: 'invalid;shell' }, adminToken)).status, 400);

  // Unknown adapter -> 422
  const unk = await call('POST', '/api/control/switch', { to: 'nonexistent' }, adminToken);
  assert.equal(unk.status, 422);
  assert.equal(unk.body.ok, false);

  // Restore endpoint succeeds
  const rst = await call('POST', '/api/control/restore', {}, adminToken);
  assert.equal(rst.status, 200);
  assert.ok(rst.body.restored >= 0);
});

test('Phase 4.7: WebSocket real-time protocol & push events (/ws)', async () => {
  const wsUrl = `ws://127.0.0.1:${ctx.server.address().port}/ws`;

  // 1. Rejects connection with missing or bad token (HTTP 401)
  await new Promise((resolve) => {
    const badWs = new WebSocket(`${wsUrl}?token=invalid-token`);
    badWs.on('error', resolve);
    badWs.on('unexpected-response', (req, res) => {
      assert.equal(res.statusCode, 401);
      resolve();
    });
  });

  // 2. Connect with valid admin token
  const ws = new WebSocket(`${wsUrl}?token=${encodeURIComponent(adminToken)}`);
  const frames = [];
  ws.on('message', (data) => frames.push(JSON.parse(data.toString())));

  await new Promise((r) => ws.on('open', r));

  // Client count in /api/health should now be 1
  const h1 = await call('GET', '/api/health', null, null);
  assert.equal(h1.body.clients, 1);

  // Wait 2.2 seconds to collect hello and at least 2 snapshot frames
  await sleep(2200);

  // 3. Verify hello frame structure
  assert.equal(frames[0].type, 'hello');
  assert.equal(frames[0].mode, 'sim');
  assert.equal(frames[0].user, 'System Admin');
  assert.ok(Array.isArray(frames[0].handshake.request));
  assert.ok(Array.isArray(frames[0].handshake.response));

  // 4. Verify snapshot frames
  const snapshots = frames.filter((f) => f.type === 'snapshot');
  assert.ok(snapshots.length >= 2);
  const snap = snapshots[snapshots.length - 1];
  assert.equal(snap.type, 'snapshot');
  assert.ok(snap.activeId);
  assert.ok(Array.isArray(snap.adapters));
  assert.equal(snap.adapters.length, 2);

  // 5. Ping/Pong latency check
  const pingTime = Date.now();
  ws.send(JSON.stringify({ type: 'ping', t: pingTime }));
  await sleep(150);
  const pong = frames.find((f) => f.type === 'pong');
  assert.ok(pong);
  assert.ok(pong.t >= pingTime);

  // 6. Malformed JSON handling: client sending invalid string does not crash WS or server
  ws.send('invalid-non-json-string');
  await sleep(100);
  assert.equal(ws.readyState, WebSocket.OPEN);

  // 7. Live failover event push: trigger manual switch via API
  const failoverPromise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Failover event not received via WS within 5s')), 5000);
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'failover') {
          clearTimeout(timeout);
          resolve(msg.event);
        }
      } catch { /* ignore */ }
    });
  });

  const sw = await call('POST', '/api/control/switch', { to: 'wifi' }, adminToken);
  assert.equal(sw.status, 200);

  const failoverEv = await failoverPromise;
  assert.ok(failoverEv);
  assert.equal(failoverEv.to, 'wifi');
  assert.equal(failoverEv.reason, 'manual');
  assert.equal(failoverEv.success, true);

  // 8. Disconnection cleanup
  ws.close();
  await sleep(200);
  const h2 = await call('GET', '/api/health', null, null);
  assert.equal(h2.body.clients, 0);
});

test.after(async () => {
  if (ctx) await ctx.close();
});

