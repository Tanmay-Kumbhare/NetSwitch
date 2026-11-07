import test from 'node:test';
import assert from 'node:assert/strict';
import { MysqlRepo } from '../src/db/mysqlRepo.js';
import { MemoryRepo } from '../src/db/memoryRepo.js';
import { createRepo } from '../src/db/index.js';

const TEST_DB = 'netswitch_phase3_test_db';

const getDbConfig = () => ({
  host: process.env.MYSQL_HOST || '127.0.0.1',
  port: Number(process.env.MYSQL_PORT || 3306),
  user: process.env.MYSQL_USER || 'root',
  password: process.env.MYSQL_PASSWORD || '',
  database: TEST_DB,
});

let testRepo = null;

// Cleanup helper to drop test database
async function dropTestDatabase() {
  const { database, ...conn } = getDbConfig();
  try {
    const mysql = (await import('mysql2/promise')).default;
    const admin = await mysql.createConnection(conn);
    await admin.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
    await admin.end();
  } catch { /* ignore if already dropped */ }
}

test('1. Successful database connection and ping', async () => {
  await dropTestDatabase();
  testRepo = new MysqlRepo(getDbConfig());
  await testRepo.init();
  const up = await testRepo.ping();
  assert.equal(up, true, 'Database ping must succeed');
});

test('2. Connection failure handling', async () => {
  const badRepo = new MysqlRepo({
    host: '127.0.0.1',
    port: 59999, // Unreachable port
    user: 'invalid_user',
    password: 'wrong_password',
    database: 'nonexistent',
  });

  await assert.rejects(
    () => badRepo.init(),
    /Failed to connect to MySQL server/i,
    'init() must reject with an informative error'
  );
  assert.equal(await badRepo.ping(), false, 'ping() must return false on failed connection');
  await badRepo.close();
});

test('3. Schema initialization: creates all 5 tables safely and repeatably', async () => {
  const [rows] = await testRepo.pool.query('SHOW TABLES');
  const tableNames = rows.map((r) => Object.values(r)[0]).sort();

  const expected = ['config', 'failover_events', 'interfaces', 'readings', 'users'].sort();
  assert.deepEqual(tableNames, expected, 'All 5 tables must exist in schema');

  // Second init() call must be idempotent and succeed without error
  await assert.doesNotReject(() => testRepo.init());
});

test('4. User registration and login persistence', async () => {
  // First user must automatically receive admin role
  const admin = await testRepo.createUser({
    email: 'admin@netswitch.local',
    name: 'Admin User',
    passwordHash: '$2a$10$abcdefghijklmnopqrstuvwxyz0123456789',
  });
  assert.equal(admin.role, 'admin');
  assert.ok(admin.id > 0);

  // Second user must receive viewer role
  const viewer = await testRepo.createUser({
    email: 'viewer@netswitch.local',
    name: 'Viewer User',
    passwordHash: '$2a$10$abcdefghijklmnopqrstuvwxyz0123456789',
  });
  assert.equal(viewer.role, 'viewer');

  // Lookup by email
  const found = await testRepo.findUserByEmail('admin@netswitch.local');
  assert.equal(found.id, admin.id);
  assert.equal(found.email, 'admin@netswitch.local');
  assert.equal(found.role, 'admin');

  // Lookup by ID
  const foundById = await testRepo.findUserById(viewer.id);
  assert.equal(foundById.name, 'Viewer User');

  // Duplicate email must throw DUP error code
  await assert.rejects(
    () => testRepo.createUser({ email: 'admin@netswitch.local', name: 'Other', passwordHash: 'hash' }),
    (err) => err.code === 'DUP'
  );
});

test('5. Interface insertion and updating (ON DUPLICATE KEY UPDATE)', async () => {
  const ifaceA = {
    id: 'wifi',
    alias: 'Wi-Fi 6',
    kind: 'wifi',
    index: 12,
    ip: '10.97.128.167',
    gateway: '10.97.128.135',
  };

  const id1 = await testRepo.upsertInterface(ifaceA);
  assert.ok(id1 > 0);

  // Update interface with modified IP and index
  const ifaceUpdated = {
    ...ifaceA,
    alias: 'Intel Wi-Fi 6 AX203',
    ip: '10.97.128.200',
    index: 14,
  };

  const id2 = await testRepo.upsertInterface(ifaceUpdated);
  assert.equal(id2, id1, 'Upsert must update existing record and maintain primary key');

  const [[row]] = await testRepo.pool.execute('SELECT * FROM interfaces WHERE adapter_key = ?', ['wifi']);
  assert.equal(row.ipv4, '10.97.128.200');
  assert.equal(row.if_index, 14);
  assert.equal(row.alias, 'Intel Wi-Fi 6 AX203');
});

test('6. Reading persistence with foreign key integrity', async () => {
  const now = Date.now();
  const readings = [
    { key: 'wifi', ts: now - 4000, score: 92.5, lossPct: 0, rttMs: 35.2, jitterMs: 4.1, tcpMs: 38.0, state: 'healthy' },
    { key: 'wifi', ts: now - 2000, score: 88.0, lossPct: 2, rttMs: 42.1, jitterMs: 5.5, tcpMs: 44.0, state: 'healthy' },
    { key: 'wifi', ts: now, score: 85.0, lossPct: 0, rttMs: 39.8, jitterMs: 6.2, tcpMs: 40.5, state: 'healthy' },
  ];

  await testRepo.insertReadings(readings);

  const [[count]] = await testRepo.pool.query('SELECT COUNT(*) AS n FROM readings');
  assert.equal(count.n, 3, 'Readings must be persisted');
});

test('7. Failover event persistence and retrieval', async () => {
  const ev = {
    ts: Date.now(),
    from: 'usb',
    to: 'wifi',
    reason: 'hard_failure',
    detectMs: 3100,
    switchMs: 240,
    totalMs: 3340,
    success: true,
    note: 'route and source address verified',
  };

  await testRepo.insertFailover(ev);

  const list = await testRepo.listFailovers(10);
  assert.ok(list.length >= 1);
  const latest = list[0];
  assert.equal(latest.from, 'usb');
  assert.equal(latest.to, 'wifi');
  assert.equal(latest.reason, 'hard_failure');
  assert.equal(latest.detectMs, 3100);
  assert.equal(latest.switchMs, 240);
  assert.equal(latest.totalMs, 3340);
  assert.equal(latest.success, true);
});

test('8. Historical aggregation correctness (5-second time buckets)', async () => {
  const baseTime = Math.floor(Date.now() / 10000) * 10000;
  // Clear readings table
  await testRepo.pool.query('DELETE FROM readings');

  // Insert two readings within the same 5-second bucket
  await testRepo.insertReadings([
    { key: 'wifi', ts: baseTime + 1000, score: 90.0, lossPct: 0, rttMs: 30.0, jitterMs: 4.0, tcpMs: 25.0, state: 'healthy' },
    { key: 'wifi', ts: baseTime + 2000, score: 80.0, lossPct: 10, rttMs: 50.0, jitterMs: 6.0, tcpMs: 35.0, state: 'healthy' },
  ]);

  const result = await testRepo.queryReadings({
    key: 'wifi',
    fromMs: baseTime,
    toMs: baseTime + 5000,
    bucketSec: 5,
  });

  assert.ok(result.sql.includes('GROUP BY bucket'));
  assert.equal(result.rows.length, 1);

  const bucket = result.rows[0];
  assert.equal(bucket.samples, 2);
  assert.equal(bucket.score, 85.0); // (90 + 80) / 2
  assert.equal(bucket.loss_pct, 5.0); // (0 + 10) / 2
  assert.equal(bucket.rtt_ms, 40.0); // (30 + 50) / 2
  assert.equal(bucket.jitter_ms, 5.0); // (4 + 6) / 2
});

test('9. Configuration persistence', async () => {
  const runtimeCfg = {
    decide: { holdDownMs: 45000, degradeChecks: 6 },
    score: { limits: { loss: 12, latency: 350 } },
  };

  await testRepo.setConfig(runtimeCfg);
  const loaded = await testRepo.getConfig();
  assert.deepEqual(loaded, runtimeCfg);
});

test('10. Database restart and reconnection behavior', async () => {
  // Gracefully close pool
  await testRepo.close();
  assert.equal(await testRepo.ping(), false);

  // Re-instantiate repo to simulate application reconnect
  testRepo = new MysqlRepo(getDbConfig());
  await testRepo.init();
  assert.equal(await testRepo.ping(), true);

  // Verify previously saved configuration survived the connection restart
  const loaded = await testRepo.getConfig();
  assert.equal(loaded.decide?.holdDownMs, 45000);
});

test('11. Graceful shutdown', async () => {
  await testRepo.close();
  assert.equal(testRepo.pool, null);
  assert.equal(await testRepo.ping(), false);
  // Cleanup test database
  await dropTestDatabase();
});

test('12. Explicit memory mode operation', async () => {
  const memRepo = createRepo({ NETSWITCH_DB: 'memory' });
  assert.equal(memRepo.kind, 'memory');

  await memRepo.init();
  assert.equal(await memRepo.ping(), true);

  // Test full memory repository contract
  const admin = await memRepo.createUser({ email: 'mem@netswitch.local', name: 'Mem User', passwordHash: 'hash' });
  assert.equal(admin.role, 'admin');

  await memRepo.upsertInterface({ id: 'usb', alias: 'Ethernet 2', kind: 'usb', index: 17, ip: '10.41.171.54', gateway: '10.41.171.250' });
  await memRepo.insertReadings([{ key: 'usb', ts: Date.now(), score: 95.0, lossPct: 0, rttMs: 28.0, jitterMs: 3.0, tcpMs: 25.0, state: 'healthy' }]);

  const q = await memRepo.queryReadings({ key: 'usb', fromMs: Date.now() - 60000, toMs: Date.now() + 1000, bucketSec: 5 });
  assert.ok(q.rows.length >= 1);

  await memRepo.insertFailover({ ts: Date.now(), from: 'wifi', to: 'usb', reason: 'manual', success: true });
  const fails = await memRepo.listFailovers(5);
  assert.equal(fails[0].to, 'usb');

  await memRepo.setConfig({ testKey: 123 });
  assert.deepEqual(await memRepo.getConfig(), { testKey: 123 });

  await memRepo.close();
});

