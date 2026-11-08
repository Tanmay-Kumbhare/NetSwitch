// Simulated controller + discovery, so the whole stack runs on any OS (and in CI).
export const SIM_ADAPTERS = [
  { id: 'wifi', kind: 'wifi', alias: 'Wi-Fi (sim)', index: 12, description: 'Synthetic Wi-Fi 6 Adapter (simulated)', mac: '02-00-00-00-00-01', guid: '{00000000-0000-4000-8000-000000000001}', pnpId: 'SWD\\NETSWITCH\\SIM_WIFI_01', ip: '192.168.1.100', prefix: 24, gateway: '192.168.1.1', metric: 75, autoMetric: false },
  { id: 'usb', kind: 'usb', alias: 'Ethernet 2 (sim)', index: 17, description: 'Synthetic USB Ethernet Adapter (simulated)', mac: '02-00-00-00-00-02', guid: '{00000000-0000-4000-8000-000000000002}', pnpId: 'SWD\\NETSWITCH\\SIM_USB_02', ip: '192.168.2.100', prefix: 24, gateway: '192.168.2.1', metric: 5, autoMetric: false },
];

export class SimController {
  constructor({ cfg, failoverEnabled, probeRoutePinning } = {}) {
    this.mode = 'sim'; this.canControl = true; this.lock = false;
    this.cfg = cfg;
    this.failoverEnabled = failoverEnabled ?? cfg?.failoverEnabled ?? false;
    this.probeRoutePinning = probeRoutePinning ?? cfg?.probeRoutePinning ?? false;
    this.profiles = Object.fromEntries(SIM_ADAPTERS.map((a) => [a.id, { lossPct: 0, latencyMs: a.id === 'wifi' ? 35 : 45, jitterMs: 6, blackhole: false, down: false }]));
    this.metrics = Object.fromEntries(SIM_ADAPTERS.map((a) => [a.id, a.metric]));
  }
  async init() { return true; }
  async discover() {
    return SIM_ADAPTERS.filter((a) => !this.profiles[a.id].down).map((a) => ({ ...a, metric: this.metrics[a.id] }));
  }
  async pin() {
    if (!this.probeRoutePinning) throw new Error('probe route pinning disabled by configuration');
  }
  async unpin() {}
  async setActive(adapters, id) {
    if (!this.failoverEnabled) return { ok: false, note: 'failover disabled by configuration (monitor-only mode)' };
    if (this.lock) return { ok: false, busy: true, note: 'switch already in progress' };
    if (!adapters.find((a) => a.id === id && a.up !== false)) return { ok: false, note: `adapter ${id} not available` };
    this.lock = true;
    try {
      await new Promise((r) => setTimeout(r, 150)); // pretend PowerShell took a moment
      for (const a of SIM_ADAPTERS) this.metrics[a.id] = a.id === id ? 5 : 75;
      return { ok: true, verified: true, note: 'simulated switch', setMs: 150, verifyMs: 160 };
    } finally { this.lock = false; }
  }
  async restoreAll() { for (const a of SIM_ADAPTERS) this.metrics[a.id] = a.metric; return { restored: SIM_ADAPTERS.length }; }
  impair(id, patch) {
    const p = this.profiles[id]; if (!p) throw new Error('unknown adapter');
    for (const k of ['lossPct', 'latencyMs', 'jitterMs']) if (typeof patch[k] === 'number') p[k] = Math.max(0, patch[k]);
    for (const k of ['blackhole', 'down']) if (typeof patch[k] === 'boolean') p[k] = patch[k];
    return p;
  }
  resetImpairments() { for (const a of SIM_ADAPTERS) Object.assign(this.profiles[a.id], { lossPct: 0, latencyMs: a.id === 'wifi' ? 35 : 45, jitterMs: 6, blackhole: false, down: false }); }
}
