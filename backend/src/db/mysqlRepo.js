import fs from 'node:fs';
import mysql from 'mysql2/promise';

export const BUCKET_SQL = `SELECT FLOOR(TIMESTAMPDIFF(SECOND, '1970-01-01 00:00:00', r.ts) / ?) * ? AS bucket,
       ROUND(AVG(r.score), 1)     AS score,
       ROUND(AVG(r.loss_pct), 1)  AS loss_pct,
       ROUND(AVG(r.rtt_ms), 1)    AS rtt_ms,
       ROUND(AVG(r.jitter_ms), 1) AS jitter_ms,
       COUNT(*)                   AS samples
FROM readings r
JOIN interfaces i ON i.id = r.interface_id
WHERE i.adapter_key = ? AND r.ts BETWEEN ? AND ?
GROUP BY bucket
ORDER BY bucket`;

export class MysqlRepo {
  constructor(opts = {}) {
    this.kind = 'mysql';
    this.opts = opts;
    this.ifaceIds = new Map();
    this.pool = null;
  }

  async init() {
    if (this.pool) return;
    const { database = 'netswitch', ...conn } = this.opts;
    const safeDb = database.replace(/[^\w]/g, '');
    if (!safeDb) throw new Error(`Invalid database name: ${database}`);

    const baseOpts = {
      ...conn,
      connectTimeout: 5000,
    };

    // 1. Ensure the target database exists using an admin connection
    let admin;
    try {
      admin = await mysql.createConnection({ ...baseOpts, multipleStatements: true });
      await admin.query(`CREATE DATABASE IF NOT EXISTS \`${safeDb}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    } catch (err) {
      throw new Error(`Failed to connect to MySQL server at ${conn.host || '127.0.0.1'}:${conn.port || 3306}: ${err.message}`);
    } finally {
      if (admin) await admin.end().catch(() => {});
    }

    // 2. Initialize connection pool with keepalive and automatic reconnection
    this.pool = mysql.createPool({
      ...baseOpts,
      database: safeDb,
      connectionLimit: 10,
      waitForConnections: true,
      queueLimit: 0,
      enableKeepAlive: true,
      keepAliveInitialDelay: 10000,
      timezone: 'Z',
      multipleStatements: true,
      dateStrings: false,
    });

    // 3. Execute repeatable schema initialization
    const ddl = fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
    await this.pool.query(ddl);

    // 4. Pre-populate interface ID cache from existing database records
    try {
      const [rows] = await this.pool.query('SELECT id, adapter_key FROM interfaces');
      for (const r of rows) this.ifaceIds.set(r.adapter_key, r.id);
    } catch {
      // Ignore if interfaces table is empty
    }
  }

  async ping() {
    if (!this.pool) return false;
    try {
      await this.pool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  async createUser({ email, name, passwordHash }) {
    const [[{ n }]] = await this.pool.query('SELECT COUNT(*) AS n FROM users');
    const role = n === 0 ? 'admin' : 'viewer';
    try {
      const [r] = await this.pool.execute(
        'INSERT INTO users (email, name, password_hash, role) VALUES (?, ?, ?, ?)',
        [email, name, passwordHash, role]
      );
      return { id: r.insertId, email, name, passwordHash, role };
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY') {
        e.code = 'DUP';
      }
      throw e;
    }
  }

  async #user(where, v) {
    const [rows] = await this.pool.execute(
      `SELECT id, email, name, password_hash AS passwordHash, role FROM users WHERE ${where} = ?`,
      [v]
    );
    return rows[0] || null;
  }

  findUserByEmail(email) {
    return this.#user('email', email);
  }

  findUserById(id) {
    return this.#user('id', id);
  }

  async upsertInterface(a) {
    const now = new Date();
    await this.pool.execute(
      `INSERT INTO interfaces (adapter_key, alias, kind, if_index, ipv4, gateway, first_seen, last_seen)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         alias = VALUES(alias),
         kind = VALUES(kind),
         if_index = VALUES(if_index),
         ipv4 = VALUES(ipv4),
         gateway = VALUES(gateway),
         last_seen = VALUES(last_seen)`,
      [
        a.id,
        a.alias,
        ['wifi', 'usb'].includes(a.kind) ? a.kind : 'other',
        a.index,
        a.ip,
        a.gateway,
        now,
        now,
      ]
    );
    const [[row]] = await this.pool.execute('SELECT id FROM interfaces WHERE adapter_key = ?', [a.id]);
    this.ifaceIds.set(a.id, row.id);
    return row.id;
  }

  async insertReadings(rows) {
    if (!rows || !rows.length) return;

    // Resolve any interface IDs that are not yet in the memory cache
    for (const r of rows) {
      if (!this.ifaceIds.has(r.key)) {
        const [[found]] = await this.pool.execute(
          'SELECT id FROM interfaces WHERE adapter_key = ?',
          [r.key]
        );
        if (found) this.ifaceIds.set(r.key, found.id);
      }
    }

    const vals = rows
      .map((r) => [
        this.ifaceIds.get(r.key),
        new Date(r.ts),
        r.score,
        r.lossPct,
        r.rttMs,
        r.jitterMs,
        r.tcpMs,
        r.state,
      ])
      .filter((v) => v[0] != null);

    if (!vals.length) return;
    await this.pool.query(
      'INSERT INTO readings (interface_id, ts, score, loss_pct, rtt_ms, jitter_ms, tcp_ms, state) VALUES ?',
      [vals]
    );
  }

  async queryReadings({ key, fromMs, toMs, bucketSec }) {
    const params = [bucketSec, bucketSec, key, new Date(fromMs), new Date(toMs)];
    const [rows] = await this.pool.execute(BUCKET_SQL, params);
    return {
      sql: BUCKET_SQL,
      params: params.map((p) => (p instanceof Date ? p.toISOString() : p)),
      rows: rows.map((r) => ({
        bucket: Number(r.bucket),
        score: r.score == null ? null : Number(r.score),
        loss_pct: r.loss_pct == null ? null : Number(r.loss_pct),
        rtt_ms: r.rtt_ms == null ? null : Number(r.rtt_ms),
        jitter_ms: r.jitter_ms == null ? null : Number(r.jitter_ms),
        samples: Number(r.samples),
      })),
    };
  }

  async insertFailover(e) {
    await this.pool.execute(
      `INSERT INTO failover_events (ts, from_key, to_key, reason, detect_ms, switch_ms, total_ms, success, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        new Date(e.ts),
        e.from,
        e.to,
        e.reason,
        e.detectMs ?? null,
        e.switchMs ?? null,
        e.totalMs ?? null,
        e.success ? 1 : 0,
        String(e.note || '').slice(0, 255),
      ]
    );
  }

  async listFailovers(limit = 50) {
    const [rows] = await this.pool.query(
      `SELECT id, ts, from_key AS \`from\`, to_key AS \`to\`, reason,
              detect_ms AS detectMs, switch_ms AS switchMs, total_ms AS totalMs, success, note
       FROM failover_events
       ORDER BY ts DESC
       LIMIT ?`,
      [Math.min(200, Math.max(1, limit))]
    );
    return rows.map((r) => ({
      ...r,
      ts: new Date(r.ts).getTime(),
      success: !!r.success,
    }));
  }

  async getConfig() {
    const [rows] = await this.pool.query("SELECT v FROM config WHERE k = 'runtime'");
    const v = rows[0]?.v;
    return v == null ? {} : typeof v === 'string' ? JSON.parse(v) : v;
  }

  async setConfig(c) {
    await this.pool.execute(
      "INSERT INTO config (k, v) VALUES ('runtime', ?) ON DUPLICATE KEY UPDATE v = VALUES(v)",
      [JSON.stringify(c)]
    );
  }

  async close() {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }
}
