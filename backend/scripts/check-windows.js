// Windows bring-up check. Run from an ADMINISTRATOR PowerShell:  npm run check
// 1) admin? 2) adapters discovered? 3) pin probe routes, probe each adapter alone for 12 s, print stats, unpin.
// Validates physical probe driver and routing behavior through real code paths.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS } from '../src/config.js';
import { WinController } from '../src/control/winController.js';
import { RealProbeDriver as DefaultRealProbeDriver } from '../src/probes/driver.js';
import { windowStats } from '../src/core/stats.js';
import { computeScore } from '../src/core/score.js';

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function runCheckWindows({
  ctl,
  ProbeDriver = DefaultRealProbeDriver,
  log = console.log,
  errorLog = console.error,
  sleep = defaultSleep,
  probeDurationMs = 12000,
} = {}) {
  const drivers = [];
  let cleanedUp = false;
  let cleanupError = null;

  const cleanup = async (reason = 'normal') => {
    if (cleanedUp) return;
    cleanedUp = true;
    for (const { d } of drivers) {
      try { d.stop(); } catch { /* ignore stop error */ }
    }
    try {
      const res = await ctl.restoreAll();
      if (res && res.verified === false) {
        log(`[check-windows] WARNING: Cleanup verification reported issues: ${res.verifyErrors?.join('; ') || 'unverified'}`);
      } else {
        log('[check-windows] Cleanup completed and independently verified.');
      }
      return res;
    } catch (err) {
      cleanupError = err;
      errorLog(`[check-windows] ERROR during cleanup (${reason}):`, err.message);
      throw err;
    }
  };

  const onSignal = async (sig) => {
    log(`\n[check-windows] Received ${sig}: initiating safe emergency cleanup...`);
    try {
      await cleanup(sig);
    } catch (e) {
      errorLog('[check-windows] Emergency cleanup failed:', e.message);
    }
    process.exit(1);
  };

  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  let runError = null;

  try {
    const isAdmin = await ctl.init();
    log('Administrator:', isAdmin);
    if (!ctl.canControl) {
      throw new Error('Not running as Administrator. Re-run from an elevated Administrator PowerShell.');
    }

    const adapters = await ctl.discover();
    console.table(
      adapters.map(({ id, alias, index, mac, guid, ip, prefix, gateway, metric, autoMetric }) => ({
        id,
        alias,
        index,
        mac: mac || '—',
        ip: `${ip}/${prefix}`,
        gateway,
        metric,
        autoMetric,
      }))
    );

    if (adapters.length < 2) {
      log('WARNING: fewer than two adapters with a default gateway. Connect Wi-Fi and the USB tether.');
    }

    for (const a of adapters) {
      const targets = DEFAULTS.targets[a.kind] ?? DEFAULTS.targets.other;
      await ctl.pin(a, targets);
      const verifiedIf = await ctl.routeInterface(targets[0]).catch(() => null);
      log(`pinned ${targets.join(', ')} via ${a.id} (if ${a.index}, gw ${a.gateway}); Windows route: if ${verifiedIf}`);
      const d = new ProbeDriver(a, targets, DEFAULTS);
      d.start();
      drivers.push({ a, d, targets });
    }

    log(`probing for ${Math.round(probeDurationMs / 1000)} s ...`);
    await sleep(probeDurationMs);

    const now = Date.now();
    for (const { a, d } of drivers) {
      const r = d.read();
      const st = windowStats(r.udp, now, DEFAULTS.probe.windowMs);
      const tcp = r.tcp ? { ok: r.tcp.ok, ms: r.tcp.ms, ageMs: now - r.tcp.at } : null;
      const sc = computeScore(st, tcp, DEFAULTS.score, {
        minSamples: DEFAULTS.probe.minSamples,
        tcpMaxAgeMs: DEFAULTS.probe.tcpMaxAgeMs,
      });
      log(
        a.id.padEnd(5),
        `udp sent=${st.sent} loss=${st.lossPct?.toFixed(0)}% rtt=${st.medianRtt?.toFixed(0)}ms jitter=${st.jitter?.toFixed(1)}ms`,
        `| tcp=${tcp?.ok ? tcp.ms.toFixed(0) + 'ms' : 'FAIL'}`,
        `| icmp ok=${r.icmp.filter((x) => x.ok).length}/${r.icmp.length}`,
        `| score=${sc.score} (${sc.band})`
      );
    }

    return { ok: true, adaptersCount: adapters.length };
  } catch (err) {
    runError = err;
    throw err;
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    try {
      await cleanup('finally');
    } catch (cErr) {
      if (runError) {
        errorLog('[check-windows] Both execution and cleanup failed:', {
          executionError: runError.message,
          cleanupError: cErr.message,
        });
      }
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const ctl = new WinController({
    stateFile: path.resolve(here, '..', '..', 'netswitch-state.json'),
    cfg: DEFAULTS,
    probeRoutePinning: true,
  });

  runCheckWindows({ ctl })
    .then(() => {
      console.log('Done. Routes removed and independently verified.');
      process.exit(0);
    })
    .catch((err) => {
      console.error('Check failed:', err.message);
      process.exit(1);
    });
}
