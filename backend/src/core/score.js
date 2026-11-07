// Pure scoring: S = 100 * (1 - sum(w_i * p_i)), p_i = min(1, x_i / L_i).

const MIN_REPLIES = 3;
const clamp01 = (x) => Math.max(0, Math.min(1, x));

/**
 * stats: output of windowStats (sent, lossPct, medianRtt, jitter)
 * tcp:   { ok:boolean, ms:number|null, ageMs:number } | null
 * Returns { score:number|null, band, parts, missing:[] }
 *  - fewer than cfg.minSamples probes -> score null, band 'unverified'
 *  - all UDP lost -> latency and jitter get p = 1 (worst), not "missing"
 *  - TCP missing/stale -> its weight is redistributed over the other signals
 *  - TCP present but failed -> p = 1
 */
export function computeScore(stats, tcp, cfg, { minSamples, tcpMaxAgeMs }) {
  const { limits, weights, bands } = cfg;
  if (!stats || stats.sent < minSamples || stats.lossPct == null) {
    return { score: null, band: 'unverified', parts: {}, missing: ['window'] };
  }
  const parts = {};
  const missing = [];
  parts.loss = clamp01(stats.lossPct / limits.loss);
  // With almost no replies, median RTT and jitter are meaningless (one lucky packet on a dead link must not look fine).
  const sparse = (stats.received ?? Infinity) < MIN_REPLIES;
  parts.latency = stats.medianRtt == null || sparse ? 1 : clamp01(stats.medianRtt / limits.latency);
  parts.jitter = stats.jitter == null || sparse ? 1 : clamp01(stats.jitter / limits.jitter);
  if (tcp && tcp.ageMs != null && tcp.ageMs <= tcpMaxAgeMs) {
    parts.tcp = tcp.ok && tcp.ms != null ? clamp01(tcp.ms / limits.tcp) : 1;
  } else {
    missing.push('tcp');
  }
  let wSum = 0;
  let penalty = 0;
  for (const k of Object.keys(parts)) { wSum += weights[k]; penalty += weights[k] * parts[k]; }
  const score = Math.round(100 * (1 - penalty / wSum) * 10) / 10; // renormalised over present signals
  const band = score >= bands.healthy ? 'healthy' : score >= bands.degraded ? 'degraded' : 'unhealthy';
  return { score, band, parts, missing };
}
