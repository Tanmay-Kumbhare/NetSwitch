import { UdpProber } from './udp.js';
import { probeTcp } from './tcp.js';
import { probeIcmp } from './icmp.js';

const KEEP_MS = 30000;
const prune = (arr, now) => { while (arr.length && arr[0].t < now - KEEP_MS) arr.shift(); };

/**
 * Real probe driver for one adapter. All concurrency is asynchronous I/O on the Node event loop
 * (UDP socket + net sockets + ping child processes). No worker threads: the work is I/O-bound.
 */
export class RealProbeDriver {
  constructor(adapter, targets, cfg) {
    this.adapter = adapter; this.targets = targets; this.cfg = cfg;
    this.udp = []; this.icmp = []; this.tcp = null;
    this.timers = []; this.prober = null; this.i = 0;
  }

  start() {
    const { probe } = this.cfg;
    this.prober = new UdpProber(this.adapter.ip);
    const every = Math.round(1000 / probe.udpPerSec);
    this.timers.push(setInterval(() => this.#udpOnce(), every));
    this.timers.push(setInterval(() => this.#tcpOnce(), probe.tcpEveryMs));
    this.timers.push(setInterval(() => this.#icmpOnce(), probe.icmpEveryMs));
    this.#tcpOnce(); this.#icmpOnce();
  }

  async #udpOnce() {
    const target = this.targets[this.i++ % this.targets.length];
    const t = Date.now();
    const r = await this.prober.probe(target, this.cfg.probe.udpTimeoutMs);
    this.udp.push({ t, ok: r.ok, rtt: r.rtt }); prune(this.udp, Date.now());
  }

  async #tcpOnce() {
    const target = this.targets[this.i % this.targets.length];
    const r = await probeTcp(this.adapter.ip, target, this.cfg.probe.tcpPort, this.cfg.probe.tcpTimeoutMs);
    this.tcp = { ok: r.ok, ms: r.ms, at: Date.now() };
  }

  async #icmpOnce() {
    const target = this.targets[this.i % this.targets.length];
    const t = Date.now();
    const r = await probeIcmp(this.adapter.ip, target, this.cfg.probe.icmpTimeoutMs);
    this.icmp.push({ t, ok: r.ok, rtt: r.rtt }); prune(this.icmp, Date.now());
  }

  read() { return { udp: this.udp, icmp: this.icmp, tcp: this.tcp }; }

  stop() {
    this.timers.forEach(clearInterval); this.timers = [];
    this.prober?.close();
  }
}
