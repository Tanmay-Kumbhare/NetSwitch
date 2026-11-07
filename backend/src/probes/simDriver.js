// Simulated probe driver for development on any OS and for the automated end-to-end test.
// Behaviour is controlled by a mutable profile shared with the sim controller.
const KEEP_MS = 30000;
const prune = (arr, now) => { while (arr.length && arr[0].t < now - KEEP_MS) arr.shift(); };

export class SimProbeDriver {
  constructor(adapter, profile, cfg) {
    this.adapter = adapter; this.profile = profile; this.cfg = cfg;
    this.udp = []; this.icmp = []; this.tcp = null; this.timers = [];
  }

  start() {
    const every = Math.round(1000 / this.cfg.probe.udpPerSec);
    const sample = () => {
      const p = this.profile;
      const t = Date.now();
      const lost = p.down || p.blackhole || Math.random() * 100 < p.lossPct;
      const rtt = Math.max(1, p.latencyMs + (Math.random() - 0.5) * 2 * p.jitterMs);
      return { t, lost, rtt };
    };
    this.timers.push(setInterval(() => {
      const s = sample();
      setTimeout(() => { // a reply arrives after rtt; a timeout is only known after udpTimeoutMs
        this.udp.push({ t: s.t, ok: !s.lost, rtt: s.lost ? undefined : s.rtt }); prune(this.udp, Date.now());
      }, s.lost ? this.cfg.probe.udpTimeoutMs : s.rtt);
    }, every));
    this.timers.push(setInterval(() => {
      const s = sample(); const ok = !s.lost && Math.random() > this.profile.lossPct / 40;
      this.tcp = { ok, ms: ok ? s.rtt * 2 : null, at: Date.now() };
      this.icmp.push({ t: s.t, ok: !s.lost, rtt: s.lost ? undefined : s.rtt }); prune(this.icmp, Date.now());
    }, this.cfg.probe.tcpEveryMs));
  }

  read() { return { udp: this.udp, icmp: this.icmp, tcp: this.tcp }; }
  stop() { this.timers.forEach(clearInterval); this.timers = []; }
}
