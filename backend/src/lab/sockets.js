// Berkeley-socket client/server pair, written with Node's net (TCP) and dgram (UDP) modules.
// Primitive mapping (what Node does for you):
//   TCP server: net.createServer().listen()  = socket() + bind() + listen();  'connection' event = accept()
//   TCP client: net.connect()                = socket() + connect()           (3-way handshake happens here)
//   UDP both:   dgram.createSocket + bind()  = socket(SOCK_DGRAM) + bind();   send()/'message' = sendto()/recvfrom()
import net from 'node:net';
import dgram from 'node:dgram';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkerPool } from './pool.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FILES_DIR = path.join(here, 'files');
// If a port is taken (EADDRINUSE) fall back to an OS-chosen free port instead of failing to boot.
export const listenOrFallback = (srv, port, host) => new Promise((res, rej) => { const go = (p) => { const onErr = (e) => (e.code === 'EADDRINUSE' && p !== 0 ? go(0) : rej(e)); srv.once('error', onErr); srv.listen(p, host, () => { srv.off('error', onErr); res(); }); }; go(port); });
export const bindOrFallback = (sock, port, host) => new Promise((res, rej) => { const go = (p) => { const onErr = (e) => (e.code === 'EADDRINUSE' && p !== 0 ? go(0) : rej(e)); sock.once('error', onErr); sock.bind(p, host, () => { sock.off('error', onErr); res(); }); }; go(port); });
const hr = () => process.hrtime.bigint();
const msSince = (t0) => Math.round((Number(hr() - t0) / 1e6) * 100) / 100;
const listFiles = () => fs.readdirSync(FILES_DIR).filter((f) => /^[\w.-]+$/.test(f));

export class SocketLab {
  constructor({ tcpPort = 5051, udpPort = 5052, host = '127.0.0.1', poolSize = 2, log = () => {} } = {}) {
    Object.assign(this, { tcpPort, udpPort, host, log });
    this.pool = new WorkerPool(path.join(here, 'calc.worker.js'), poolSize);
    this.tcpStats = { active: 0, total: 0, commands: 0, bytesOut: 0, peakActive: 0 };
    this.udpStats = { received: 0, replied: 0, dropped: 0, errors: 0 };
    this.udpDropPct = 0; this.events = [];
  }
  #ev(proto, text) { this.events.unshift({ t: Date.now(), proto, text }); this.events.length = Math.min(this.events.length, 30); }

  // ---- TCP server: one text command per line, many clients at the same time ----
  async #tcpCommand(line, sock) {
    const [cmd, ...rest] = line.trim().split(/\s+/); const arg = rest.join(' ');
    switch ((cmd || '').toUpperCase()) {
      case 'HELLO': return `200 Hello ${arg || 'client'}, this is the NetSwitch TCP server (connection #${sock._id})`;
      case 'ECHO': return `200 ${arg}`;
      case 'TIME': return `200 ${new Date().toISOString()}`;
      case 'LIST': return `200 ${listFiles().join(',')}`;
      case 'SLEEP': { const ms = Math.min(2000, Math.max(0, Number(arg) || 0)); await new Promise((r) => setTimeout(r, ms)); return `200 slept ${ms} ms`; }
      case 'PRIME': { const n = Number(arg); const r = await this.pool.run('primes', n); return r.ok ? `200 primes<=${n} = ${r.value} (computed on worker thread #${r.threadId} in ${r.ms.toFixed(0)} ms)` : `400 ${r.error}`; }
      case 'GET': {
        if (!/^[\w.-]+$/.test(arg) || !listFiles().includes(arg)) return '404 no such file';
        const data = fs.readFileSync(path.join(FILES_DIR, arg));
        sock.write(`200 FILE ${arg} ${data.length}\n`); sock.write(data); this.tcpStats.bytesOut += data.length; return null;
      }
      case 'QUIT': return '221 Bye';
      default: return '400 unknown command (HELLO, ECHO, TIME, LIST, GET <file>, SLEEP <ms>, PRIME <n>, QUIT)';
    }
  }

  async start() {
    this.tcp = net.createServer((sock) => {
      sock._id = ++this.tcpStats.total; this.tcpStats.active++; this.tcpStats.peakActive = Math.max(this.tcpStats.peakActive, this.tcpStats.active);
      this.#ev('TCP', `accept() connection #${sock._id} from ${sock.remoteAddress}:${sock.remotePort}`);
      sock.setTimeout(15000, () => sock.destroy()); sock.setEncoding('utf8');
      let buf = ''; let chain = Promise.resolve();
      sock.on('data', (d) => {
        buf += d; if (buf.length > 2048) return sock.destroy();
        let i; while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          chain = chain.then(async () => { // commands on ONE connection stay in order; different connections run concurrently
            this.tcpStats.commands++;
            const reply = await this.#tcpCommand(line, sock);
            if (reply != null) { sock.write(`${reply}\n`); this.tcpStats.bytesOut += reply.length + 1; }
            if (reply?.startsWith('221')) sock.end();
          }).catch(() => sock.destroy());
        }
      });
      sock.on('close', () => { this.tcpStats.active--; this.#ev('TCP', `close() connection #${sock._id}`); });
      sock.on('error', () => {});
    });
    await listenOrFallback(this.tcp, this.tcpPort, this.host);
    this.tcpPort = this.tcp.address().port;

    // ---- UDP server: connectionless, one datagram = one request = one reply ----
    this.udp = dgram.createSocket('udp4');
    this.udp.on('message', async (msg, rinfo) => {
      this.udpStats.received++;
      if (Math.random() * 100 < this.udpDropPct) { this.udpStats.dropped++; this.#ev('UDP', `datagram from ${rinfo.address}:${rinfo.port} DROPPED (simulated loss)`); return; }
      const [op, ...rest] = msg.toString('utf8').trim().split(/\s+/); const arg = Number(rest[0]);
      let reply;
      if (/^(sin|cos|tan|sqrt|log|primes)$/i.test(op)) {
        const r = await this.pool.run(op.toLowerCase(), arg).catch((e) => ({ ok: false, error: e.message }));
        reply = r.ok ? `${op}(${rest[0]}) = ${Number(r.value.toPrecision(10))}  [worker thread #${r.threadId}]` : `error: ${r.error}`;
      } else if (/^hello$/i.test(op)) reply = `Hello ${rest.join(' ') || 'client'} from the NetSwitch UDP server`;
      else if (/^time$/i.test(op)) reply = new Date().toISOString();
      else reply = 'commands: hello <name> | time | sin|cos|tan <deg> | sqrt <x> | log <x> | primes <n>';
      this.udp.send(reply, rinfo.port, rinfo.address, (err) => { if (err) this.udpStats.errors++; else { this.udpStats.replied++; this.#ev('UDP', `${msg.toString().trim()} -> reply to ${rinfo.address}:${rinfo.port}`); } });
    });
    await bindOrFallback(this.udp, this.udpPort, this.host);
    this.udpPort = this.udp.address().port;
    this.log(`[lab] TCP server ${this.host}:${this.tcpPort}, UDP server ${this.host}:${this.udpPort}, ${this.pool.size} worker threads`);
    return this;
  }

  status() { return { host: this.host, files: listFiles(), tcp: { port: this.tcpPort, ...this.tcpStats }, udp: { port: this.udpPort, dropPct: this.udpDropPct, ...this.udpStats }, pool: this.pool.stats(), events: this.events }; }
  setDrop(pct) { this.udpDropPct = Math.max(0, Math.min(90, Number(pct) || 0)); return this.udpDropPct; }

  // ---- clients (used by the REST layer; they open real sockets to the servers above) ----
  /** One TCP connection, several commands. Returns replies plus a primitive-by-primitive trace with timings. */
  async tcpSession(commands) {
    const t0 = hr(); const trace = []; const replies = [];
    const mark = (step, note = '') => trace.push({ step, ms: msSince(t0), note });
    mark('socket()', 'create a TCP endpoint');
    const sock = await new Promise((res, rej) => { const s = net.connect({ host: this.host, port: this.tcpPort }); s.once('connect', () => res(s)); s.once('error', rej); });
    mark('connect()', `3-way handshake done; local port ${sock.localPort} -> ${this.host}:${this.tcpPort}`);
    const connectMs = msSince(t0);
    let buf = Buffer.alloc(0); let waiter = null;
    sock.on('data', (d) => { buf = Buffer.concat([buf, d]); waiter?.(); });
    const until = (pred) => new Promise((res, rej) => { const to = setTimeout(() => rej(new Error('timeout')), 6000); const check = () => { if (pred()) { clearTimeout(to); waiter = null; res(); } }; waiter = check; check(); });
    const readLine = async () => { await until(() => buf.includes(10)); const i = buf.indexOf(10); const l = buf.subarray(0, i).toString('utf8'); buf = buf.subarray(i + 1); return l; };
    try {
      for (const c of commands) {
        sock.write(`${c}\n`); mark('send()', c);
        const first = await readLine(); mark('recv()', first);
        const m = /^200 FILE (\S+) (\d+)$/.exec(first);
        if (m) { const n = Number(m[2]); await until(() => buf.length >= n); const body = buf.subarray(0, n).toString('utf8'); buf = buf.subarray(n); replies.push({ command: c, reply: first, body }); }
        else replies.push({ command: c, reply: first });
      }
      sock.end(); mark('close()', 'FIN sent (connection release)');
    } finally { sock.destroy(); }
    return { connectMs, totalMs: msSince(t0), local: { address: sock.localAddress, port: sock.localPort }, server: { host: this.host, port: this.tcpPort }, trace, replies };
  }

  /** N clients at once, each on its own connection. Total time ~ slowest client (concurrent), not the sum (serial). */
  async concurrency(clients, command) {
    const t0 = hr();
    const runs = await Promise.all(Array.from({ length: clients }, async (_, i) => {
      const s = hr(); const r = await this.tcpSession([command]).catch((e) => ({ replies: [{ reply: `error ${e.message}` }] }));
      return { client: i + 1, finishedAtMs: msSince(t0), ownMs: msSince(s), reply: r.replies?.[0]?.reply };
    }));
    const sumOwn = runs.reduce((a, r) => a + r.ownMs, 0);
    return { clients, command, wallClockMs: msSince(t0), sumOfIndividualMs: Math.round(sumOwn), peakActiveConnections: this.tcpStats.peakActive, runs };
  }

  async udpRequest(message, timeoutMs = 1500) {
    const t0 = hr(); const sock = dgram.createSocket('udp4');
    try {
      await new Promise((res) => sock.bind({ address: this.host, port: 0 }, res));
      const local = sock.address();
      const reply = await new Promise((res) => {
        const to = setTimeout(() => res(null), timeoutMs);
        sock.once('message', (m) => { clearTimeout(to); res(m.toString('utf8')); });
        sock.send(message, this.udpPort, this.host);
      });
      return { sent: message, reply, lost: reply == null, rttMs: reply == null ? null : msSince(t0), local: { address: local.address, port: local.port }, server: { host: this.host, port: this.udpPort }, note: reply == null ? 'No reply within the timeout: UDP does not retransmit, the application must decide what to do.' : 'One datagram out, one datagram back. No handshake, no connection state.' };
    } finally { sock.close(); }
  }

  async close() { const closing = new Promise((r) => this.tcp?.close(r)); this.tcp?.closeAllConnections?.(); await closing; await new Promise((r) => { try { this.udp?.close(r); } catch { r(); } }); await this.pool.close(); }
}
