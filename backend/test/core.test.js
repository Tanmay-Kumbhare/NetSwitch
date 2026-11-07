import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS } from '../src/config.js';
import { windowStats, median, meanAbsDiff, sanitize } from '../src/core/stats.js';
import { computeScore } from '../src/core/score.js';
import { decide, initialState } from '../src/core/decide.js';
import { subnetInfo, isIPv4 } from '../src/core/subnet.js';

const D = DEFAULTS.decide;
const opts = { minSamples: DEFAULTS.probe.minSamples, tcpMaxAgeMs: DEFAULTS.probe.tcpMaxAgeMs };
const mk = (n, f) => Array.from({ length: n }, (_, i) => f(i));

test('median and jitter', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(meanAbsDiff([10, 20, 10]), 10);
  assert.equal(meanAbsDiff([5]), 0);
});

test('sanitize drops negative / absurd RTT but keeps timeouts as lost', () => {
  const { clean, dropped } = sanitize([{ t: 1, ok: true, rtt: -5 }, { t: 2, ok: false }, { t: 3, ok: true, rtt: 20 }]);
  assert.equal(dropped, 1);
  assert.equal(clean.length, 2);
});

test('windowStats: loss, median, consecutive lost over all samples', () => {
  const now = 20000;
  const s = [
    ...mk(40, (i) => ({ t: 10000 + i * 200 + 1, ok: i % 10 !== 0, rtt: 30 })),
    ...mk(16, (i) => ({ t: 18000 + i * 100 + 1, ok: false })), // tail outage (t up to 19601)
  ].filter((x) => x.t <= now);
  const w = windowStats(s, now, 10000);
  assert.ok(w.lossPct > 0);
  assert.equal(w.medianRtt, 30);
  assert.ok(w.consecutiveLost >= 15);
});

test('score: perfect link ~100, bad link low, missing window -> null', () => {
  const good = computeScore({ sent: 50, received: 50, lossPct: 0, medianRtt: 0, jitter: 0 }, { ok: true, ms: 0, ageMs: 100 }, DEFAULTS.score, opts);
  assert.equal(good.score, 100);
  const bad = computeScore({ sent: 50, lossPct: 20, medianRtt: 380, jitter: 60 }, { ok: true, ms: 600, ageMs: 100 }, DEFAULTS.score, opts);
  assert.equal(bad.score, 0);
  const few = computeScore({ sent: 5, lossPct: 0, medianRtt: 10, jitter: 1 }, null, DEFAULTS.score, opts);
  assert.equal(few.score, null);
  assert.equal(few.band, 'unverified');
});

test('score: stale TCP is missing and weights renormalise; failed TCP counts as worst', () => {
  const base = { sent: 50, lossPct: 0, medianRtt: 0, jitter: 0 };
  const stale = computeScore(base, { ok: true, ms: 10, ageMs: 9000 }, DEFAULTS.score, opts);
  assert.equal(stale.score, 100);
  assert.deepEqual(stale.missing, ['tcp']);
  const failed = computeScore(base, { ok: false, ms: null, ageMs: 100 }, DEFAULTS.score, opts);
  assert.equal(failed.score, 85); // loses the 0.15 TCP weight
});

test('score: total UDP loss gives worst loss/latency/jitter', () => {
  const r = computeScore({ sent: 50, lossPct: 100, medianRtt: null, jitter: null }, { ok: true, ms: 0, ageMs: 0 }, DEFAULTS.score, opts);
  assert.equal(r.score, 15);
});

test('score: a dead link with one lucky reply is not scored as healthy', () => {
  const r = computeScore({ sent: 50, received: 1, lossPct: 98, medianRtt: 45, jitter: 0 }, null, DEFAULTS.score, opts);
  assert.equal(r.score, 0);
});

test('Clumsy-like impairment (20% loss, ~380 ms) lands in unhealthy band', () => {
  const r = computeScore({ sent: 50, lossPct: 20, medianRtt: 378, jitter: 20 }, { ok: true, ms: 120, ageMs: 500 }, DEFAULTS.score, opts);
  assert.equal(r.band, 'unhealthy');
});

// ---- decide(): the 8 required tests + extras ----
const ad = (o = {}) => ({ up: true, score: 90, consecutiveLost: 0, tcpOk: true, ...o });
const base = (over = {}) => ({ state: initialState('wifi', 'wifi'), ...over });
const run = (state, a, b, now = 100000) => decide(state, { adapters: { wifi: ad(a), usb: ad(b) } }, now, D);

test('decide 1: stable when both healthy', () => {
  const r = run(initialState('wifi', 'wifi'), {}, {});
  assert.equal(r.action, null);
  assert.equal(r.phase, 'STABLE');
});

test('decide 2: hard failure switches immediately, even inside hold-down', () => {
  const st = { ...initialState('wifi', 'wifi'), holdUntil: 999999 };
  const r = run(st, { consecutiveLost: 15, tcpOk: false, score: 5 }, { score: 80 }, 100000);
  assert.deepEqual(r.action, { type: 'switch', to: 'usb', reason: 'hard_failure' });
  assert.equal(r.state.activeId, 'usb');
});

test('decide 3: hard failure but no eligible candidate -> NO_INTERNET, no action', () => {
  const r = run(initialState('wifi', 'wifi'), { consecutiveLost: 20, tcpOk: false, score: 0 }, { score: 30 });
  assert.equal(r.action, null);
  assert.equal(r.phase, 'NO_INTERNET');
});

test('decide 4: degradation needs degradeChecks consecutive evaluations', () => {
  let st = initialState('wifi', null);
  let r;
  for (let i = 1; i <= D.degradeChecks; i++) {
    r = run(st, { score: 50 }, { score: 90 }, 100000 + i * 1000);
    st = r.state;
    if (i < D.degradeChecks) assert.equal(r.action, null);
  }
  assert.equal(r.action.reason, 'degradation');
  assert.equal(r.action.to, 'usb');
});

test('decide 5: degradation counter resets when the lead disappears', () => {
  let st = initialState('wifi', null);
  for (let i = 0; i < 3; i++) st = run(st, { score: 50 }, { score: 90 }).state;
  assert.equal(st.degradeCount, 3);
  st = run(st, { score: 80 }, { score: 90 }).state;
  assert.equal(st.degradeCount, 0);
});

test('decide 6: hold-down blocks degradation and switch-back switches', () => {
  const st = { ...initialState('usb', 'wifi'), holdUntil: 200000, degradeCount: 4 };
  const r = decide(st, { adapters: { wifi: ad({ score: 95 }), usb: ad({ score: 40 }) } }, 100000, D);
  assert.equal(r.action, null);
  assert.equal(r.phase, 'HOLD_DOWN');
  assert.equal(r.state.degradeCount, 0);
});

test('decide 7: switch-back after switchBackChecks evaluations and score >= switchBackMinScore', () => {
  let st = initialState('usb', 'wifi');
  let r;
  for (let i = 1; i <= D.switchBackChecks; i++) {
    r = decide(st, { adapters: { wifi: ad({ score: 80 }), usb: ad({ score: 70 }) } }, 100000 + i * 1000, D);
    st = r.state;
    if (i < D.switchBackChecks) assert.equal(r.action, null);
  }
  assert.equal(r.action.reason, 'switch_back');
  assert.equal(r.action.to, 'wifi');
  // a preferred adapter scoring below switchBackMinScore never triggers switch-back
  const low = decide(initialState('usb', 'wifi'), { adapters: { wifi: ad({ score: 55 }), usb: ad({ score: 20 }) } }, 100000, D);
  assert.equal(low.state.switchBackCount, 0);
});

test('decide 8: null score never switches (UNVERIFIED)', () => {
  const r = run(initialState('wifi', 'wifi'), { score: null }, { score: 95 });
  assert.equal(r.action, null);
  assert.equal(r.phase, 'UNVERIFIED');
});

test('decide 9: adapter down switches immediately to a healthy candidate', () => {
  const r = run(initialState('usb', 'wifi'), { score: 90 }, { up: false, score: null });
  assert.deepEqual(r.action, { type: 'switch', to: 'wifi', reason: 'adapter_down' });
});

test('decide 10: is pure (does not mutate inputs)', () => {
  const st = initialState('wifi', null);
  const inp = { adapters: { wifi: ad({ score: 50 }), usb: ad({ score: 90 }) } };
  const a = JSON.stringify([st, inp]);
  decide(st, inp, 1, D);
  assert.equal(JSON.stringify([st, inp]), a);
});

test('subnet maths', () => {
  const s = subnetInfo('10.97.128.167', 24);
  assert.equal(s.network, '10.97.128.0');
  assert.equal(s.broadcast, '10.97.128.255');
  assert.equal(s.mask, '255.255.255.0');
  assert.equal(s.hosts, 254);
  assert.equal(subnetInfo('10.41.171.54', 28).network, '10.41.171.48');
  assert.ok(isIPv4('1.1.1.1') && !isIPv4('1.1.1.256') && !isIPv4('1.1.1'));
});
