import { EventEmitter } from 'node:events';
import { DEFAULTS, mergeConfig, EDITABLE } from './config.js';
import { windowStats } from './core/stats.js';
import { computeScore } from './core/score.js';
import { decide, initialState } from './core/decide.js';
import { subnetInfo } from './core/subnet.js';
import { RealProbeDriver } from './probes/driver.js';
import { SimProbeDriver } from './probes/simDriver.js';

const FAIL_COOLDOWN_MS = 5000;

/** trailing run of lost samples -> send time of the first lost probe in that run (or null) */
export function trailingLostSince(samples) {
  const s = [...samples].sort((a, b) => a.t - b.t);
  let since = null;
  for (let i = s.length - 1; i >= 0 && !s[i].ok; i--) since = s[i].t;
  return since;
}

export class Agent extends EventEmitter {
  constructor({ controller, repo, cfg = DEFAULTS, ProbeDriver, log = console.log }) {
    super();
    this.controller = controller; this.repo = repo; this.cfg = structuredClone(cfg); this.log = log;
    this.ProbeDriver = ProbeDriver;
    this.failoverEnabled = !!(this.cfg.failoverEnabled && this.controller.failoverEnabled !== false);
    this.autoFailoverEnabled = !!(this.cfg.autoFailoverEnabled && this.failoverEnabled);
    this.probeRoutePinning = !!(this.cfg.probeRoutePinning && this.controller.probeRoutePinning !== false);
    this.adapters = new Map(); // id -> adapter + driver
    this.state = null; this.phase = !this.failoverEnabled ? 'MONITOR_ONLY' : (!this.autoFailoverEnabled ? 'MANUAL_ONLY' : 'UNVERIFIED');
    this.switching = false; this.failCooldownUntil = 0;
    this.timers = []; this.pendingRows = []; this.lastSnapshot = null; this.startedAt = Date.now();
    this.recent = []; // recent failover events (memory copy for the dashboard)
  }

  get mode() { return this.controller.mode; }
  get canControl() { return this.controller.canControl; }
  #targets(a) { return this.cfg.targets[a.kind] ?? this.cfg.targets.other; }

  #makeDriver(a) {
    if (this.ProbeDriver) return new this.ProbeDriver(a, this.mode === 'sim' ? this.controller.profiles?.[a.id] : this.#targets(a), this.cfg);
    return this.mode === 'sim'
      ? new SimProbeDriver(a, this.controller.profiles[a.id], this.cfg)
      : new RealProbeDriver(a, this.#targets(a), this.cfg);
  }

  async refreshDiscovery() {
    return this.#refreshDiscovery();
  }

  async #addAdapter(d) {
    const isEligible = d.eligible !== false && (d.kind === 'wifi' || d.kind === 'usb');
    const a = {
      ...d,
      mac: d.mac || null,
      guid: d.guid || null,
      pnpId: d.pnpId || null,
      ambiguous: false,
      eligible: isEligible,
      up: true,
      pathVerified: false,
      pinError: null,
      pinNote: null,
      currentMetric: d.metric
    };
    if (this.mode === 'sim') {
      a.pathVerified = true;
    } else if (this.probeRoutePinning && this.canControl && isEligible) {
      try {
        await this.controller.pin(a, this.#targets(a));
        a.pathVerified = true;
      } catch (e) {
        a.pinError = e.message;
        this.log(`[agent] pin failed for ${a.id}: ${e.message}`);
      }
    } else if (!this.probeRoutePinning) {
      a.pathVerified = false;
      a.pinNote = 'unpinned: probe route pinning disabled; measurements subject to Windows default route selection';
    } else if (!isEligible) {
      a.pinError = 'ineligible adapter type';
    } else {
      a.pinError = 'not administrator';
    }
    a.driver = this.#makeDriver(a);
    a.driver.start();
    this.adapters.set(a.id, a);
    await this.repo.upsertInterface(a).catch((e) => this.log('[db] upsertInterface', e.message));
    this.log(`[agent] adapter ${a.id}: ${a.alias} ${a.ip} gw ${a.gateway} metric ${a.metric} eligible=${a.eligible} pathVerified=${a.pathVerified}${a.pinNote ? ' (' + a.pinNote + ')' : ''}`);
  }

  async start() {
    await this.controller.init();
    this.recoveryPending = !!this.controller.recoveryPending;
    const saved = await this.repo.getConfig().catch(() => ({}));
    this.cfg = mergeConfig(this.cfg, saved);
    const found = await this.controller.discover();
    for (const d of found) await this.#addAdapter(d);
    const up = [...this.adapters.values()].sort((x, y) => x.metric - y.metric);
    if (!up.length) this.log('[agent] no active adapters found');
    this.state = initialState(up[0]?.id ?? null, up[0]?.id ?? null);
    const { probe } = this.cfg;
    this.#evaluate();
    this.timers.push(setInterval(() => this.#evaluate(), probe.evalEveryMs));
    this.timers.push(setInterval(() => this.#refreshDiscovery().catch((e) => this.log('[agent] discovery', e.message)), 5000));
    this.timers.push(setInterval(() => this.#persist().catch(() => {}), probe.snapshotEveryMs));
  }

  async stop() {
    this.timers.forEach(clearInterval); this.timers = [];
    for (const a of this.adapters.values()) a.driver.stop();
    if (this.probeRoutePinning || this.failoverEnabled) {
      await this.controller.restoreAll().catch(() => {}); // restore on exit
    }
  }

  async #refreshDiscovery() {
    const found = await this.controller.discover();
    const foundIds = new Set(found.map((d) => d.id));

    // Handle disconnected adapters: stop probe driver promptly to prevent resource leaks
    for (const a of this.adapters.values()) {
      if (!foundIds.has(a.id)) {
        if (a.up) {
          a.up = false;
          if (a.driver && typeof a.driver.stop === 'function') {
            a.driver.stop();
          }
          this.log(`[agent] adapter ${a.id} went offline (${a.alias}); stopped probe driver`);
        }
      }
    }

    for (const d of found) {
      const a = this.adapters.get(d.id);
      if (!a) { await this.#addAdapter(d); continue; }

      // Validate hardware identity
      if (a.mac && d.mac && a.mac.toLowerCase() !== d.mac.toLowerCase()) {
        this.log(`[agent] WARNING: adapter ${d.id} hardware identity conflict: expected MAC ${a.mac}, observed ${d.mac}. Marking unavailable.`);
        a.ambiguous = true;
        a.up = false;
        if (a.driver && typeof a.driver.stop === 'function') a.driver.stop();
        continue;
      }

      a.ambiguous = false;
      a.mac = d.mac || a.mac || null;
      a.guid = d.guid || a.guid || null;
      a.pnpId = d.pnpId || a.pnpId || null;

      const wasDown = !a.up;
      a.up = true;
      a.currentMetric = d.metric;
      a.metric = d.metric;

      if (a.ip !== d.ip || a.gateway !== d.gateway || a.index !== d.index) { // address or index changed: rebuild probes and pins
        this.log(`[agent] ${a.id} changed address/gateway/index; re-pinning and rebuilding driver`);
        if (a.driver && typeof a.driver.stop === 'function') a.driver.stop();
        if (this.probeRoutePinning && this.canControl) {
          await this.controller.unpin(this.#targets(a), a).catch(() => {});
        }
        this.adapters.delete(d.id);
        await this.#addAdapter(d);
      } else if (wasDown) {
        this.log(`[agent] adapter ${a.id} reconnected (${a.alias}); restarting probe driver`);
        a.driver = this.#makeDriver(a);
        a.driver.start();
      }
    }
    // Sync with reality if somebody changed metrics outside NetSwitch.
    if (!this.switching && this.state) {
      const observed = [...this.adapters.values()].filter((a) => a.up).sort((x, y) => x.currentMetric - y.currentMetric)[0];
      if (observed && observed.id !== this.state.activeId && Date.now() > this.failCooldownUntil) {
        this.log(`[agent] active adapter changed outside NetSwitch: ${this.state.activeId} -> ${observed.id}`);
        this.state = { ...this.state, activeId: observed.id };
      }
    }
  }

  #measure(a, now) {
    const p = this.cfg.probe;
    const d = a.driver.read();
    let stats = windowStats(d.udp, now, p.windowMs);
    const icmpStats = windowStats(d.icmp, now, p.windowMs);
    const tcp = d.tcp ? { ok: d.tcp.ok, ms: d.tcp.ms, ageMs: now - d.tcp.at } : null;
    const tcpFresh = tcp && tcp.ageMs <= p.tcpMaxAgeMs;
    let udpFiltered = false; let minSamples = p.minSamples;
    if (stats.sent >= p.minSamples && stats.lossPct === 100 && icmpStats.received > 0 && tcpFresh && tcp.ok) {
      udpFiltered = true; stats = icmpStats; minSamples = 4; // UDP :53 blocked on this network: fall back to ICMP
    }
    const newest = d.udp.length ? Math.max(...d.udp.map((s) => s.t)) : null;
    const stalled = !udpFiltered && newest != null && now - newest > p.udpTimeoutMs + 3000;
    const r = stalled ? { score: null, band: 'unverified', parts: {}, missing: ['stalled'] } : computeScore(stats, tcp, this.cfg.score, { minSamples, tcpMaxAgeMs: p.tcpMaxAgeMs });
    return { stats, tcp, tcpFresh, udpFiltered, stalled, result: r, lostSince: trailingLostSince(udpFiltered ? d.icmp : d.udp) };
  }

  #evaluate() {
    const now = Date.now();
    const inputs = { adapters: {} }; const view = [];
    for (const a of this.adapters.values()) {
      const m = this.#measure(a, now);
      a.m = m;
      const band = !a.up ? 'down' : m.result.band;
      const isEligible = a.eligible !== false && (a.kind === 'wifi' || a.kind === 'usb');
      inputs.adapters[a.id] = { up: a.up, score: (a.up && isEligible) ? m.result.score : null, consecutiveLost: m.stats.consecutiveLost, tcpOk: m.tcpFresh ? m.tcp.ok : null };
      let net = null; try { net = subnetInfo(a.ip, a.prefix); } catch { /* ignore */ }
      view.push({ id: a.id, kind: a.kind, eligible: isEligible, alias: a.alias, description: a.description, index: a.index, ip: a.ip, prefix: a.prefix, gateway: a.gateway, network: net?.network ?? null,
        metric: a.currentMetric, up: a.up, band, score: a.up ? m.result.score : null, lossPct: m.stats.lossPct, rttMs: m.stats.medianRtt, lastRttMs: m.stats.lastRtt, jitterMs: m.stats.jitter,
        tcpMs: m.tcp?.ok ? m.tcp.ms : null, tcpOk: m.tcpFresh ? m.tcp.ok : null, consecutiveLost: m.stats.consecutiveLost, samples: m.stats.sent,
        udpFiltered: m.udpFiltered, parts: m.result.parts, missing: m.result.missing, pathVerified: a.pathVerified, pinError: a.pinError, pinNote: a.pinNote || null, targets: this.mode === 'sim' ? [] : this.#targets(a) });
    }
    if (this.failoverEnabled && this.autoFailoverEnabled && this.state && this.canControl && !this.switching && this.state.activeId) {
      if (now >= this.failCooldownUntil) {
        const res = decide(this.state, inputs, now, this.cfg.decide);
        this.phase = res.phase;
        if (res.action) { const prev = this.state; this.state = res.state; this.#doSwitch(prev.activeId, res.action.to, res.action.reason, now); }
        else this.state = res.state;
      }
    } else {
      this.phase = !this.failoverEnabled ? 'MONITOR_ONLY' : (!this.canControl ? 'NOT_ADMIN' : (!this.autoFailoverEnabled ? 'MANUAL_ONLY' : this.phase));
    }
    this.lastSnapshot = {
      type: 'snapshot', ts: now, mode: this.mode, canControl: this.canControl,
      recoveryPending: !!this.recoveryPending,
      failoverEnabled: this.failoverEnabled,
      autoFailoverEnabled: this.autoFailoverEnabled,
      probeRoutePinning: this.probeRoutePinning, switching: this.switching,
      activeId: this.state?.activeId ?? null, preferredId: this.state?.preferredId ?? null,
      phase: !this.failoverEnabled ? 'MONITOR_ONLY' : (this.switching ? 'FAILING_OVER' : this.phase),
      holdRemainingMs: Math.max(0, (this.state?.holdUntil ?? 0) - now), adapters: view,
    };
    this.emit('snapshot', this.lastSnapshot);
  }

  async #doSwitch(from, to, reason, decidedAt) {
    if (!this.failoverEnabled) {
      this.log(`[agent] switch ${from} -> ${to} blocked: failover disabled (monitor-only mode)`);
      return { ok: false, note: 'failover disabled by configuration (monitor-only mode)' };
    }
    this.switching = true;
    const a = this.adapters.get(from);
    const lostSince = reason === 'hard_failure' || reason === 'adapter_down' ? a?.m?.lostSince ?? null : null;
    const res = await this.controller.setActive([...this.adapters.values()], to);
    const done = Date.now();
    if (!res.ok) { // roll back our belief; try again only after a cooldown
      this.state = { ...this.state, activeId: from, holdUntil: 0 }; this.failCooldownUntil = done + FAIL_COOLDOWN_MS;
    } else for (const x of this.adapters.values()) x.currentMetric = x.id === to ? this.cfg.activeMetric : this.cfg.standbyMetric;
    const ev = { ts: done, from, to, reason, detectMs: lostSince ? decidedAt - lostSince : null, switchMs: res.verifyMs ?? done - decidedAt,
      totalMs: lostSince ? done - lostSince : null, success: !!res.ok, note: res.note || '' };
    this.recent.unshift(ev); this.recent.length = Math.min(this.recent.length, 20);
    this.log(`[agent] failover ${from} -> ${to} (${reason}) ${res.ok ? 'OK' : 'FAILED'} ${res.note || ''}`);
    this.emit('failover', ev);
    this.repo.insertFailover(ev).catch((e) => this.log('[db] insertFailover', e.message));
    this.switching = false;
    return { ...res, event: ev };
  }

  /** Manual switch from the Control page. */
  async switchTo(to) {
    if (!this.failoverEnabled) return { ok: false, note: 'failover disabled by configuration (monitor-only mode)' };
    if (!this.canControl) return { ok: false, note: 'control disabled (not administrator)' };
    if (this.switching) return { ok: false, busy: true, note: 'switch already in progress' };
    const from = this.state.activeId;
    if (from === to) return { ok: true, note: 'already active' };
    const target = this.adapters.get(to);
    if (!target?.up) return { ok: false, note: `adapter ${to} is not up` };
    if (target.eligible === false || (target.kind !== 'wifi' && target.kind !== 'usb')) {
      return { ok: false, note: `adapter ${to} is not eligible for switching` };
    }
    this.state = { ...this.state, activeId: to, holdUntil: Date.now() + this.cfg.decide.holdDownMs, degradeCount: 0, switchBackCount: 0 };
    return this.#doSwitch(from, to, 'manual', Date.now());
  }

  async restore() { const r = await this.controller.restoreAll(); for (const a of this.adapters.values()) a.currentMetric = a.metric; return r; }

  async updateConfig(patch) {
    const clean = {};
    for (const [g, keys] of Object.entries(EDITABLE)) {
      for (const k of keys) {
        const v = patch?.[g]?.[k]; if (v === undefined) continue;
        if (typeof v === 'number' ? !(v >= 0 && Number.isFinite(v)) : typeof v !== 'object') throw new Error(`invalid value for ${g}.${k}`);
        (clean[g] ||= {})[k] = v;
      }
    }
    const next = mergeConfig(this.cfg, clean);
    const w = Object.values(next.score.weights); if (!(w.every((x) => x >= 0) && w.reduce((x, y) => x + y, 0) > 0)) throw new Error('weights must be non-negative and not all zero');
    for (const v of Object.values(next.score.limits)) if (!(v > 0)) throw new Error('limits must be > 0');
    this.cfg = next;
    for (const a of this.adapters.values()) a.driver.cfg = next;
    await this.repo.setConfig({ decide: next.decide, score: next.score }).catch(() => {});
    return { decide: next.decide, score: next.score };
  }

  async #persist() {
    const snap = this.lastSnapshot; if (!snap) return;
    const rows = snap.adapters.map((a) => ({ key: a.id, ts: snap.ts, score: a.score, lossPct: a.lossPct, rttMs: a.rttMs, jitterMs: a.jitterMs, tcpMs: a.tcpMs, state: a.band }));
    this.pendingRows.push(...rows);
    try { await this.repo.insertReadings(this.pendingRows); this.pendingRows = []; this.dbOk = true; }
    catch (e) { this.dbOk = false; if (this.pendingRows.length > 1000) this.pendingRows.splice(0, this.pendingRows.length - 1000); this.log('[db] buffered writes:', this.pendingRows.length, e.message); }
  }
}
