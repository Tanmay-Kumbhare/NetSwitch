// Single source of truth for every tunable constant. Values are starting points;
// calibrate with Clumsy (see docs/CALIBRATION.md). Nothing else may hard-code these.
export const DEFAULTS = Object.freeze({
  probe: {
    udpPerSec: 5,          // UDP-DNS probes per second per adapter (alternating the two pinned targets)
    udpTimeoutMs: 1000,
    tcpEveryMs: 2000,
    tcpTimeoutMs: 2000,
    tcpPort: 443,
    icmpEveryMs: 2000,
    icmpTimeoutMs: 1000,
    windowMs: 10000,       // scoring window
    evalEveryMs: 1000,
    snapshotEveryMs: 5000, // DB persistence cadence
    minSamples: 20,        // below this many completed UDP probes in the window, the score is null (UNVERIFIED)
    tcpMaxAgeMs: 5000,     // older TCP result counts as missing
  },
  score: {
    // x_i / L_i, capped at 1; S = 100 * (1 - sum(w_i * p_i))
    limits: { loss: 10, latency: 300, jitter: 50, tcp: 500 }, // loss in %, others in ms
    weights: { loss: 0.40, latency: 0.30, jitter: 0.15, tcp: 0.15 },
    bands: { healthy: 70, degraded: 50 },
  },
  decide: {
    hardFailLost: 15,        // consecutive lost UDP probes (about 3 s at 5/s) plus failed TCP
    degradeMargin: 20,       // candidate must lead by this many points...
    degradeChecks: 5,        // ...for this many consecutive 1-s evaluations
    holdDownMs: 30000,
    switchBackMargin: 5,
    switchBackChecks: 10,
    switchBackMinScore: 60,
    minHealthyScore: 50,
  },
  // Pinned probe targets per adapter slot. Probes to these /32 addresses are forced through that adapter.
  targets: {
    wifi: ['1.1.1.1', '1.0.0.1'],
    usb: ['8.8.8.8', '8.8.4.4'],
    other: ['9.9.9.10', '149.112.112.10'],
  },
  verifyTarget: '9.9.9.9',   // NEVER pinned; used to verify that default traffic really leaves via the new adapter
  activeMetric: 5,
  standbyMetric: 75,
  // Safety flags: default to FALSE unless explicitly authorized in environment
  failoverEnabled: false,
  autoFailoverEnabled: false,
  probeRoutePinning: false,
});

/** Explicit and safe boolean environment variable parser */
export function parseBoolEnv(val, defaultVal = false) {
  if (val === undefined || val === null || val === '') return defaultVal;
  const s = String(val).trim().toLowerCase();
  return s === 'true' || s === '1' || s === 'yes';
}

/** Parses NetSwitch application-level safety environment variables */
export function parseAppEnv(env = process.env) {
  return {
    failoverEnabled: parseBoolEnv(env?.NETSWITCH_FAILOVER_ENABLED, false),
    autoFailoverEnabled: parseBoolEnv(env?.NETSWITCH_AUTO_FAILOVER_ENABLED, false),
    probeRoutePinning: parseBoolEnv(env?.NETSWITCH_PROBE_ROUTE_PINNING, false),
  };
}

export function mergeConfig(base, patch) {
  const out = structuredClone(base);
  for (const [group, vals] of Object.entries(patch || {})) {
    if (!(group in out) || typeof out[group] !== 'object') continue;
    for (const [k, v] of Object.entries(vals || {})) {
      if (k in out[group] && typeof out[group][k] === typeof v) {
        if (typeof v === 'object' && v !== null) Object.assign(out[group][k], v);
        else out[group][k] = v;
      }
    }
  }
  return out;
}

// Only these groups/keys may be edited at runtime through PUT /api/config.
export const EDITABLE = {
  decide: ['hardFailLost', 'degradeMargin', 'degradeChecks', 'holdDownMs', 'switchBackMargin', 'switchBackChecks', 'switchBackMinScore', 'minHealthyScore'],
  score: ['limits', 'weights'],
};
