import dgram from 'node:dgram';
import { buildQuery, parseResponse } from './dnsPacket.js';

/** One long-lived UDP socket per adapter, bound to the adapter's IPv4 source address. */
export class UdpProber {
  constructor(srcIp) {
    this.srcIp = srcIp;
    this.pending = new Map(); // id -> { resolve, t0, target, timer }
    this.nextId = Math.floor(Math.random() * 65535);
    this.sock = dgram.createSocket('udp4');
    this.ready = new Promise((resolve) => {
      this.sock.on('error', () => resolve(false));
      this.sock.bind({ address: srcIp, port: 0 }, () => resolve(true));
    });
    this.sock.on('message', (msg, rinfo) => {
      const r = parseResponse(msg);
      const p = r && r.isResponse ? this.pending.get(r.id) : null;
      if (!p || rinfo.address !== p.target) return;
      clearTimeout(p.timer);
      this.pending.delete(r.id);
      p.resolve({ ok: true, rtt: Number(process.hrtime.bigint() - p.t0) / 1e6 });
    });
  }

  async probe(target, timeoutMs) {
    if (!(await this.ready)) return { ok: false };
    const id = (this.nextId = (this.nextId + 1) & 0xffff);
    return new Promise((resolve) => {
      const t0 = process.hrtime.bigint();
      const timer = setTimeout(() => { this.pending.delete(id); resolve({ ok: false }); }, timeoutMs);
      this.pending.set(id, { resolve, t0, target, timer });
      this.sock.send(buildQuery(id), 53, target, (err) => {
        if (err) { clearTimeout(timer); this.pending.delete(id); resolve({ ok: false }); }
      });
    });
  }

  close() { try { this.sock.close(); } catch { /* already closed */ } }
}
