// In-memory repository with the same interface as MysqlRepo. Used for `npm run start:sim` and tests
// when MySQL is not running. The graded demo uses MysqlRepo.
export const BUCKET_SQL_NOTE = 'memory repository (no SQL)';

export class MemoryRepo {
  constructor() { this.kind = 'memory'; this.users = []; this.ifaces = new Map(); this.readings = []; this.failovers = []; this.config = {}; }
  async init() {}
  async ping() { return true; }
  async createUser({ email, name, passwordHash }) {
    if (this.users.find((u) => u.email === email)) { const e = new Error('duplicate'); e.code = 'DUP'; throw e; }
    const u = { id: this.users.length + 1, email, name, passwordHash, role: this.users.length ? 'viewer' : 'admin' };
    this.users.push(u); return u;
  }
  async findUserByEmail(email) { return this.users.find((u) => u.email === email) || null; }
  async findUserById(id) { return this.users.find((u) => u.id === id) || null; }
  async upsertInterface(a) {
    const now = new Date();
    const cur = this.ifaces.get(a.id) || { id: this.ifaces.size + 1, first_seen: now };
    this.ifaces.set(a.id, { ...cur, adapter_key: a.id, alias: a.alias, kind: a.kind, if_index: a.index, ipv4: a.ip, gateway: a.gateway, last_seen: now });
    return cur.id;
  }
  async insertReadings(rows) { this.readings.push(...rows); if (this.readings.length > 50000) this.readings.splice(0, 10000); }
  async queryReadings({ key, fromMs, toMs, bucketSec }) {
    const by = new Map();
    for (const r of this.readings) {
      if (r.key !== key || r.ts < fromMs || r.ts > toMs) continue;
      const b = Math.floor(r.ts / 1000 / bucketSec) * bucketSec;
      const g = by.get(b) || { bucket: b, n: 0, s: [], l: [], r: [], j: [] };
      g.n++; for (const [k, v] of [['s', r.score], ['l', r.lossPct], ['r', r.rttMs], ['j', r.jitterMs]]) if (v != null) g[k].push(v);
      by.set(b, g);
    }
    const avg = (a) => (a.length ? Math.round((a.reduce((x, y) => x + y, 0) / a.length) * 10) / 10 : null);
    const rows = [...by.values()].sort((a, b) => a.bucket - b.bucket).map((g) => ({ bucket: g.bucket, score: avg(g.s), loss_pct: avg(g.l), rtt_ms: avg(g.r), jitter_ms: avg(g.j), samples: g.n }));
    return { sql: BUCKET_SQL_NOTE, params: [], rows };
  }
  async insertFailover(e) { this.failovers.unshift({ id: this.failovers.length + 1, ...e }); }
  async listFailovers(limit = 50) { return this.failovers.slice(0, limit); }
  async getConfig() { return this.config; }
  async setConfig(c) { this.config = c; }
  async close() {}
}
