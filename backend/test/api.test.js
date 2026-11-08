import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { createApp } from '../src/server.js';

const env = { NETSWITCH_MODE: 'sim', NETSWITCH_DB: 'memory', NETSWITCH_FAILOVER_ENABLED: 'true', NETSWITCH_AUTO_FAILOVER_ENABLED: 'true' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ctx; let base; let token; let adminToken;
const call = async (method, path, body, tok = token) => {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};

test('boot, auth, REST surface', async () => {
  ctx = await createApp({ env, log: () => {} });
  await new Promise((r) => ctx.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${ctx.server.address().port}`;
  assert.equal((await call('GET', '/api/health', null, null)).body.ok, true);
  assert.equal((await call('GET', '/api/interfaces', null, null)).status, 401);
  assert.equal((await call('POST', '/api/auth/register', { email: 'bad', name: 'x', password: 'short' }, null)).status, 400);
  const reg = await call('POST', '/api/auth/register', { email: 'admin@example.com', name: 'Admin', password: 'password123' }, null);
  assert.equal(reg.status, 201); assert.equal(reg.body.user.role, 'admin'); adminToken = reg.body.token;
  assert.equal((await call('POST', '/api/auth/register', { email: 'admin@example.com', name: 'Admin', password: 'password123' }, null)).status, 409);
  const viewer = await call('POST', '/api/auth/register', { email: 'v@example.com', name: 'View', password: 'password123' }, null);
  assert.equal(viewer.body.user.role, 'viewer'); token = adminToken;
  assert.equal((await call('POST', '/api/auth/login', { email: 'admin@example.com', password: 'wrong-pass' }, null)).status, 401);
  assert.equal((await call('GET', '/api/auth/me')).body.email, 'admin@example.com');
  assert.equal((await call('POST', '/api/control/switch', { to: 'wifi' }, viewer.body.token)).status, 403);
  assert.equal((await call('PUT', '/api/config', { decide: { holdDownMs: 1000 } }, viewer.body.token)).status, 403);
  assert.equal((await call('POST', '/api/control/switch', { to: 'bad name; calc' })).status, 400);
});

test('WebSocket: rejects bad token, sends hello with real handshake, then snapshots every second', async () => {
  await new Promise((resolve) => { const w = new WebSocket(`ws://127.0.0.1:${ctx.server.address().port}/ws?token=nope`); w.on('error', resolve); w.on('unexpected-response', (q, res) => { assert.equal(res.statusCode, 401); resolve(); }); });
  const ws = new WebSocket(`ws://127.0.0.1:${ctx.server.address().port}/ws?token=${adminToken}`);
  const msgs = []; ws.on('message', (m) => msgs.push(JSON.parse(m)));
  await new Promise((r) => ws.on('open', r));
  await sleep(2300);
  assert.equal(msgs[0].type, 'hello');
  assert.ok(msgs[0].handshake.response.some((l) => /Sec-WebSocket-Accept/i.test(l)));
  assert.ok(msgs.filter((m) => m.type === 'snapshot').length >= 2);
  ws.send(JSON.stringify({ type: 'ping' })); await sleep(200);
  assert.ok(msgs.some((m) => m.type === 'pong'));
  ctx.ws = ws; ctx.msgs = msgs;
});

test('end to end in sim: warm-up -> UNVERIFIED -> healthy; blackhole on active adapter triggers hard-failure failover', async () => {
  const warm = (await call('GET', '/api/interfaces')).body;
  assert.equal(warm.adapters.length, 2);
  assert.equal(warm.activeId, 'usb'); // lowest metric in the S1 setup (USB = 5)
  // wait for the 10 s window to fill (>=20 probes)
  await sleep(6000);
  const snap = ctx.msgs.filter((m) => m.type === 'snapshot').at(-1);
  const usb = snap.adapters.find((a) => a.id === 'usb'); const wifi = snap.adapters.find((a) => a.id === 'wifi');
  assert.ok(usb.score > 80 && wifi.score > 80, `healthy scores expected, got ${usb.score}/${wifi.score}`);
  const t0 = Date.now();
  assert.equal((await call('POST', '/api/sim/impair', { adapter: 'usb', blackhole: true })).status, 200);
  const ev = await new Promise((resolve, reject) => { const to = setTimeout(() => reject(new Error('no failover within 15 s')), 15000); ctx.ws.on('message', (m) => { const o = JSON.parse(m); if (o.type === 'failover') { clearTimeout(to); resolve(o.event); } }); });
  const elapsed = Date.now() - t0;
  assert.equal(ev.from, 'usb'); assert.equal(ev.to, 'wifi'); assert.equal(ev.reason, 'hard_failure'); assert.equal(ev.success, true);
  assert.ok(elapsed < 10000, `failover took ${elapsed} ms`);
  console.log(`      sim hard-failure failover measured ${elapsed} ms (event totalMs ${ev.totalMs})`);
  const list = (await call('GET', '/api/failovers')).body.events; assert.equal(list[0].to, 'wifi');
  assert.equal((await call('GET', '/api/interfaces')).body.activeId, 'wifi');
});

test('manual switch, lock, config edit validation, readings query', async () => {
  await call('POST', '/api/sim/reset', {});
  const r = await call('POST', '/api/control/switch', { to: 'usb' }); assert.equal(r.status, 200); assert.equal(r.body.ok, true);
  assert.equal((await call('POST', '/api/control/switch', { to: 'nope' })).status, 422);
  assert.equal((await call('PUT', '/api/config', { decide: { degradeChecks: -1 } })).status, 400);
  const ok = await call('PUT', '/api/config', { decide: { degradeChecks: 4 } }); assert.equal(ok.body.decide.degradeChecks, 4);
  const h = await call('GET', '/api/readings?interface=wifi&minutes=15'); assert.equal(h.status, 200); assert.ok(Array.isArray(h.body.rows));
  assert.equal((await call('GET', '/api/readings?interface=../x')).status, 400);
  assert.equal((await call('GET', '/api/interfaces/wifi')).body.subnet.network, '192.168.1.0');
  assert.equal((await call('GET', '/api/wifi/scan')).body.simulated, true);
});

test('REST API integration with MySQL persistence', async () => {
  // Test MySQL API integration against isolated test database
  const mysqlEnv = {
    ...process.env,
    NETSWITCH_MODE: 'sim',
    NETSWITCH_DB: 'mysql',
    MYSQL_DATABASE: 'netswitch_phase3_api_test_db',
  };

  let myCtx;
  try {
    myCtx = await createApp({ env: mysqlEnv, log: () => {} });
    await new Promise((r) => myCtx.server.listen(0, '127.0.0.1', r));
    const myBase = `http://127.0.0.1:${myCtx.server.address().port}`;

    const myCall = async (method, path, body, tok) => {
      const res = await fetch(myBase + path, {
        method,
        headers: {
          'content-type': 'application/json',
          ...(tok ? { authorization: `Bearer ${tok}` } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    };

    // 1. Health endpoint reports MySQL and dbUp = true
    const health = await myCall('GET', '/api/health');
    assert.equal(health.body.ok, true);
    assert.equal(health.body.db, 'mysql');
    assert.equal(health.body.dbUp, true);

    // 2. User registration and login in MySQL
    const reg = await myCall('POST', '/api/auth/register', {
      email: 'mysql_admin@example.com',
      name: 'MySQL Admin',
      password: 'password123',
    });
    assert.equal(reg.status, 201);
    assert.equal(reg.body.user.role, 'admin');
    const myToken = reg.body.token;

    // 3. Authenticated me endpoint
    const me = await myCall('GET', '/api/auth/me', null, myToken);
    assert.equal(me.status, 200);
    assert.equal(me.body.email, 'mysql_admin@example.com');

    // 4. Readings endpoint returns real SQL query text
    const readings = await myCall('GET', '/api/readings?interface=wifi&minutes=15', null, myToken);
    assert.equal(readings.status, 200);
    assert.ok(readings.body.sql.includes('TIMESTAMPDIFF'));
    assert.ok(Array.isArray(readings.body.rows));
  } finally {
    if (myCtx) await myCtx.close();
    // Drop the temporary API test database
    try {
      const mysql = (await import('mysql2/promise')).default;
      const conn = await mysql.createConnection({
        host: process.env.MYSQL_HOST || '127.0.0.1',
        port: Number(process.env.MYSQL_PORT || 3306),
        user: process.env.MYSQL_USER || 'root',
        password: process.env.MYSQL_PASSWORD || '',
      });
      await conn.query('DROP DATABASE IF EXISTS `netswitch_phase3_api_test_db`');
      await conn.end();
    } catch { /* ignore */ }
  }
});

test.after(async () => { ctx?.ws?.close(); await ctx?.close(); });
