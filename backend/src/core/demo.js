import { DEFAULTS } from '../config.js';
import { computeScore } from './score.js';
import { decide, initialState } from './decide.js';

export const SCENARIO_DEFS = {
  degradation: {
    id: 'degradation',
    name: 'Gradual Degradation',
    description: 'Wi-Fi link quality gradually degrades (loss and latency rise). Once USB leads by 20+ points for 5 consecutive evaluations, NetSwitch safely fails over to USB.',
  },
  hard_failure: {
    id: 'hard_failure',
    name: 'Hard Failure (Outage)',
    description: 'Active Wi-Fi link suffers sudden blackout (15 consecutive lost probes + failed TCP connect). NetSwitch bypasses hold-down and immediately switches to USB.',
  },
  flapping: {
    id: 'flapping',
    name: 'Link Flapping & Hold-Down',
    description: 'After a switch to USB, Wi-Fi link quality fluctuates wildly. The 30-second hold-down timer suppresses rapid flip-flopping, keeping the network connection stable.',
  },
  recovery_switch_back: {
    id: 'recovery_switch_back',
    name: 'Recovery & Switch-Back',
    description: 'After a prior failover to USB, the preferred Wi-Fi adapter heals (score >= 60, lead >= 5 points). After 10 consecutive healthy evaluations, traffic safely returns to Wi-Fi.',
  },
  no_internet: {
    id: 'no_internet',
    name: 'Complete Loss / No Internet',
    description: 'Active Wi-Fi fails completely, but the backup USB link is also degraded (score < 50). NetSwitch enters NO_INTERNET state and refuses to switch to an unusable candidate.',
  },
};

function makeStats({ sent = 30, lossPct = 0, medianRtt = 25, jitter = 5, tcpOk = true, tcpMs = 35 }) {
  const received = Math.round(sent * (1 - lossPct / 100));
  return {
    stats: { sent, received, lossPct, medianRtt, jitter },
    tcp: { ok: !!tcpOk, ms: tcpMs, ageMs: 200 },
  };
}

export function buildScenarioFrames(scenarioId) {
  const frames = [];
  const baseWifi = { sent: 30, lossPct: 0, medianRtt: 25, jitter: 5, tcpOk: true, tcpMs: 35 };
  const baseUsb = { sent: 30, lossPct: 0, medianRtt: 28, jitter: 6, tcpOk: true, tcpMs: 38 };

  if (scenarioId === 'degradation') {
    // 12 seconds: sec 1-3 stable, sec 4-12 degraded Wi-Fi (loss 5%, rtt 180ms, jitter 30ms -> score drops to ~64)
    for (let t = 1; t <= 12; t++) {
      if (t <= 3) {
        frames.push({
          second: t,
          wifi: { ...baseWifi, consecutiveLost: 0, up: true },
          usb: { ...baseUsb, consecutiveLost: 0, up: true },
        });
      } else {
        // Degraded Wi-Fi: ~63-65 score vs USB ~91 score (lead 26-28 points >= 20 margin)
        frames.push({
          second: t,
          wifi: { sent: 30, lossPct: 5, medianRtt: 180, jitter: 35, tcpOk: true, tcpMs: 220, consecutiveLost: 1, up: true },
          usb: { ...baseUsb, consecutiveLost: 0, up: true },
        });
      }
    }
  } else if (scenarioId === 'hard_failure') {
    // 8 seconds: sec 1-2 stable, sec 3 Wi-Fi blackout (15 lost, tcpOk: false), sec 4-8 USB active
    for (let t = 1; t <= 8; t++) {
      if (t <= 2) {
        frames.push({
          second: t,
          wifi: { ...baseWifi, consecutiveLost: 0, up: true },
          usb: { ...baseUsb, consecutiveLost: 0, up: true },
        });
      } else {
        frames.push({
          second: t,
          wifi: { sent: 30, lossPct: 100, medianRtt: null, jitter: null, tcpOk: false, tcpMs: null, consecutiveLost: 15, up: true },
          usb: { ...baseUsb, consecutiveLost: 0, up: true },
        });
      }
    }
  } else if (scenarioId === 'flapping') {
    // 12 seconds: sec 1 stable, sec 2 degradation triggers switch to USB with 30s hold-down.
    // sec 3-12 Wi-Fi fluctuates wildly between 95 and 30, but hold-down prevents all switching.
    frames.push({
      second: 1,
      wifi: { ...baseWifi, consecutiveLost: 0, up: true },
      usb: { ...baseUsb, consecutiveLost: 0, up: true },
    });
    // Trigger switch at sec 2 by starting with 4 accumulated degrade counts or sudden failover
    for (let t = 2; t <= 12; t++) {
      const flapHigh = t % 2 === 0;
      frames.push({
        second: t,
        wifi: flapHigh
          ? { sent: 30, lossPct: 0, medianRtt: 15, jitter: 2, tcpOk: true, tcpMs: 20, consecutiveLost: 0, up: true }
          : { sent: 30, lossPct: 15, medianRtt: 250, jitter: 45, tcpOk: false, tcpMs: 550, consecutiveLost: 4, up: true },
        usb: { ...baseUsb, consecutiveLost: 0, up: true },
      });
    }
  } else if (scenarioId === 'recovery_switch_back') {
    // Initial active USB, preferred Wi-Fi.
    // Sec 1-2: Wi-Fi degraded (score ~52), USB active (score ~76).
    // Sec 3-14: Wi-Fi heals completely (score ~92, lead >= 5 and score >= 60).
    // After 10 evaluations (sec 3-12), switch-back triggers at sec 12!
    for (let t = 1; t <= 14; t++) {
      if (t <= 2) {
        frames.push({
          second: t,
          wifi: { sent: 30, lossPct: 7, medianRtt: 160, jitter: 30, tcpOk: true, tcpMs: 180, consecutiveLost: 1, up: true },
          usb: { sent: 30, lossPct: 2, medianRtt: 55, jitter: 12, tcpOk: true, tcpMs: 70, consecutiveLost: 0, up: true },
        });
      } else {
        frames.push({
          second: t,
          wifi: { ...baseWifi, consecutiveLost: 0, up: true },
          usb: { sent: 30, lossPct: 2, medianRtt: 55, jitter: 12, tcpOk: true, tcpMs: 70, consecutiveLost: 0, up: true },
        });
      }
    }
  } else if (scenarioId === 'no_internet') {
    // 6 seconds: USB is degraded (loss 20%, rtt 350ms -> score < 50).
    // At sec 2, Wi-Fi suffers hard failure. Since USB has score < 50, decide enters NO_INTERNET.
    for (let t = 1; t <= 6; t++) {
      frames.push({
        second: t,
        wifi: t === 1
          ? { ...baseWifi, consecutiveLost: 0, up: true }
          : { sent: 30, lossPct: 100, medianRtt: null, jitter: null, tcpOk: false, tcpMs: null, consecutiveLost: 16, up: true },
        usb: { sent: 30, lossPct: 20, medianRtt: 350, jitter: 60, tcpOk: false, tcpMs: 800, consecutiveLost: 2, up: true },
      });
    }
  } else {
    throw new Error(`Unknown demo scenario: ${scenarioId}`);
  }

  return frames;
}

export function runDemoScenario(scenarioId, cfg = DEFAULTS) {
  const def = SCENARIO_DEFS[scenarioId];
  if (!def) {
    throw new Error(`Invalid scenario: ${scenarioId}. Expected one of: ${Object.keys(SCENARIO_DEFS).join(', ')}`);
  }

  const frames = buildScenarioFrames(scenarioId);
  const timeline = [];

  const baseNow = 100000;

  let state;
  if (scenarioId === 'recovery_switch_back') {
    // Active is USB, Preferred is Wi-Fi, holdUntil is 0
    state = initialState('usb', 'wifi');
  } else if (scenarioId === 'flapping') {
    // Active is USB, with hold-down active for 30 seconds
    state = { ...initialState('usb', 'wifi'), holdUntil: baseNow + cfg.decide.holdDownMs };
  } else {
    state = initialState('wifi', 'wifi');
  }

  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    const nowMs = baseNow + frame.second * 1000;

    // 1. Compute scores through real pure computeScore
    const wifiData = makeStats(frame.wifi);
    const usbData = makeStats(frame.usb);

    const wifiScoreRes = computeScore(wifiData.stats, wifiData.tcp, cfg.score, {
      minSamples: cfg.probe.minSamples,
      tcpMaxAgeMs: cfg.probe.tcpMaxAgeMs,
    });
    const usbScoreRes = computeScore(usbData.stats, usbData.tcp, cfg.score, {
      minSamples: cfg.probe.minSamples,
      tcpMaxAgeMs: cfg.probe.tcpMaxAgeMs,
    });

    const inputs = {
      adapters: {
        wifi: {
          up: frame.wifi.up !== false,
          score: wifiScoreRes.score,
          consecutiveLost: frame.wifi.consecutiveLost || 0,
          tcpOk: wifiData.tcp.ok,
        },
        usb: {
          up: frame.usb.up !== false,
          score: usbScoreRes.score,
          consecutiveLost: frame.usb.consecutiveLost || 0,
          tcpOk: usbData.tcp.ok,
        },
      },
    };

    const prevActive = state.activeId;
    const res = decide(state, inputs, nowMs, cfg.decide);
    state = res.state;

    // Plain-English explanation
    let explanation = '';
    if (res.action) {
      if (res.action.reason === 'hard_failure') {
        explanation = `HARD FAILURE: 15 lost probes + failed TCP connect on ${prevActive}. Immediate failover to ${res.action.to} (bypasses hold-down).`;
      } else if (res.action.reason === 'degradation') {
        explanation = `DEGRADATION FAILOVER: Candidate ${res.action.to} sustained a 20+ point lead for ${cfg.decide.degradeChecks} consecutive evaluations. Switched to ${res.action.to}.`;
      } else if (res.action.reason === 'switch_back') {
        explanation = `SWITCH-BACK: Preferred adapter ${res.action.to} recovered (score >= ${cfg.decide.switchBackMinScore}) for ${cfg.decide.switchBackChecks} consecutive evaluations. Traffic returned to ${res.action.to}.`;
      } else {
        explanation = `Switched from ${prevActive} to ${res.action.to} (${res.action.reason}).`;
      }
    } else if (res.phase === 'HOLD_DOWN') {
      const remainingSec = Math.max(0, Math.ceil((state.holdUntil - nowMs) / 1000));
      explanation = `Hold-down active (${remainingSec}s remaining). Flapping switch suppressed to ensure network stability.`;
    } else if (res.phase === 'NO_INTERNET') {
      explanation = `NO INTERNET: Active adapter failed, but backup adapter score (${usbScoreRes.score ?? 0}) is below minHealthyScore (${cfg.decide.minHealthyScore}). Switch refused.`;
    } else if (state.degradeCount > 0) {
      const diff = Math.round(((usbScoreRes.score || 0) - (wifiScoreRes.score || 0)) * 10) / 10;
      explanation = `USB leads Wi-Fi by ${diff} points (${state.degradeCount}/${cfg.decide.degradeChecks} consecutive evaluations towards failover).`;
    } else if (state.switchBackCount > 0) {
      explanation = `Wi-Fi is healthy again (${state.switchBackCount}/${cfg.decide.switchBackChecks} evaluations towards switch-back).`;
    } else {
      explanation = `Stable link state. Active adapter (${state.activeId}) is healthy.`;
    }

    timeline.push({
      second: frame.second,
      activeId: state.activeId,
      preferredId: state.preferredId,
      phase: res.phase,
      action: res.action,
      explanation,
      note: res.note,
      holdRemainingSec: Math.max(0, Math.ceil(((state.holdUntil || 0) - nowMs) / 1000)),
      degradeCount: state.degradeCount,
      switchBackCount: state.switchBackCount,
      scores: {
        wifi: wifiScoreRes.score,
        usb: usbScoreRes.score,
      },
      bands: {
        wifi: wifiScoreRes.band,
        usb: usbScoreRes.band,
      },
      metrics: {
        wifi: {
          lossPct: frame.wifi.lossPct,
          rttMs: frame.wifi.medianRtt,
          jitterMs: frame.wifi.jitter,
          tcpOk: frame.wifi.tcpOk,
          consecutiveLost: frame.wifi.consecutiveLost,
        },
        usb: {
          lossPct: frame.usb.lossPct,
          rttMs: frame.usb.medianRtt,
          jitterMs: frame.usb.jitter,
          tcpOk: frame.usb.tcpOk,
          consecutiveLost: frame.usb.consecutiveLost,
        },
      },
    });
  }

  return {
    scenario: scenarioId,
    name: def.name,
    description: def.description,
    timeline,
  };
}
