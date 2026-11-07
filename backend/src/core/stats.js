// Pure statistics over probe samples. A sample is { t, ok, rtt } where t = send time (ms),
// ok = reply received, rtt = round trip in ms (only when ok). A timed-out probe is `ok:false`, never rtt 0.

export function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Mean absolute difference of consecutive RTTs (not RFC 3550 interarrival jitter). */
export function meanAbsDiff(rtts) {
  if (rtts.length < 2) return rtts.length ? 0 : null;
  let sum = 0;
  for (let i = 1; i < rtts.length; i++) sum += Math.abs(rtts[i] - rtts[i - 1]);
  return sum / (rtts.length - 1);
}

/** Drops samples with impossible RTTs (negative / NaN / > 60 s). Returns {clean, dropped}. */
export function sanitize(samples) {
  const clean = [];
  let dropped = 0;
  for (const s of samples) {
    if (s.ok && !(Number.isFinite(s.rtt) && s.rtt >= 0 && s.rtt < 60000)) { dropped++; continue; }
    clean.push(s);
  }
  return { clean, dropped };
}

/**
 * Window statistics for one adapter.
 * samples: completed probes (any order). Only those with t in (now - windowMs, now] are used.
 * consecutiveLost counts lost probes from the newest completed sample backwards, over ALL given
 * samples (not only the window) so a long outage keeps counting.
 */
export function windowStats(samples, nowMs, windowMs) {
  const { clean } = sanitize(samples);
  const ordered = [...clean].sort((a, b) => a.t - b.t);
  const inWin = ordered.filter((s) => s.t > nowMs - windowMs && s.t <= nowMs);
  const ok = inWin.filter((s) => s.ok);
  const rtts = ok.map((s) => s.rtt);
  let consecutiveLost = 0;
  for (let i = ordered.length - 1; i >= 0 && !ordered[i].ok; i--) consecutiveLost++;
  const sent = inWin.length;
  return {
    sent,
    received: ok.length,
    lossPct: sent ? ((sent - ok.length) / sent) * 100 : null,
    medianRtt: median(rtts),
    jitter: meanAbsDiff(rtts),
    consecutiveLost,
    lastRtt: ok.length ? ok[ok.length - 1].rtt : null,
  };
}
